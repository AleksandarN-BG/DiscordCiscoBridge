// Joining, leaving, and the audio plumbing on the Discord side.
//
// Two transports, because Discord treats them as different things:
//
//   guild voice channels -> @discordjs/voice, an AudioPlayer and a receiver
//   DMs and group DMs    -> the selfbot's own VoiceConnection, with .play()
//
// Both ends up in the same place: outbound Opus comes from the AudioBridge,
// and each speaker's inbound Opus is decoded to PCM and handed back to it.

const {
  joinVoiceChannel,
  createAudioResource,
  createAudioPlayer,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const prism = require('prism-media');

const CONNECTION_TIMEOUT_MS = 30_000;

/** How long a speaker must be quiet before their stream is closed. */
const SILENCE_END_MS = 1000;

const DECODER_OPTIONS = { rate: 48000, channels: 1, frameSize: 960 };

const VOICE_CHANNEL_TYPES = new Set([2, 'GUILD_VOICE']);
const DM_CHANNEL_TYPES = new Set([1, 'DM', 3, 'GROUP_DM']);

class VoiceSession {
  /** @param {import('discord.js-selfbot-v13').Client} client */
  constructor(client) {
    this.client = client;

    /** Guild voice, via @discordjs/voice. */
    this.connection = null;
    this.player = null;

    /** DM/group calls, via the selfbot's voice manager. */
    this.selfbotConnection = null;
    this.dispatcher = null;

    this.channelId = null;
    this.guildId = null;

    /** @type {Map<string, {opusStream: any, decoder: any, ended: boolean}>} */
    this.speakers = new Map();
  }

  async joinGuildChannel(guildId, channelId, bridge) {
    const channel = await this.client.channels.fetch(channelId);
    if (!VOICE_CHANNEL_TYPES.has(channel?.type)) {
      throw new Error(`Channel ${channelId} is not a voice channel`);
    }

    console.log('[Voice] Joining guild channel:', channelId);

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.channelId = channelId;
    this.guildId = guildId;

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, CONNECTION_TIMEOUT_MS);
    } catch (err) {
      this.connection.destroy();
      this.connection = null;
      throw new Error(`Voice connection never became ready: ${err.message}`);
    }

    this._attachGuildAudio(bridge);
    return this.connection;
  }

  async joinDirectCall(channelId, bridge) {
    const channel = await this.client.channels.fetch(channelId);
    if (!DM_CHANNEL_TYPES.has(channel?.type)) {
      throw new Error(`Channel ${channelId} is not a DM or group DM`);
    }

    console.log('[Voice] Starting DM call:', channelId);

    // Do not ring() first. The voice state update from joinChannel() is what
    // makes Discord create the call, and ringing beforehand races it into a
    // session conflict that leaves the call unjoinable.
    const connection = await this.client.voice.joinChannel(channel, {
      selfMute: false,
      selfDeaf: false,
      selfVideo: false,
    });

    if (!connection) throw new Error('joinChannel returned no connection');

    this.selfbotConnection = connection;
    this.channelId = channelId;
    this.guildId = null;

    this._attachDirectAudio(connection, bridge);
    return connection;
  }

  /** Outbound and inbound audio for a guild voice connection. */
  _attachGuildAudio(bridge) {
    this.player = createAudioPlayer();
    this.connection.subscribe(this.player);

    this.player.on('error', (err) => console.error('[Voice] Player error:', err.message));
    this.player.play(
      createAudioResource(bridge.getDiscordInputStream(), { inputType: StreamType.Opus }),
    );

    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      if (this._alreadyPiped(userId)) return;

      this._pipeSpeaker({
        userId,
        bridge,
        opusStream: receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
        }),
      });
    });

    this.connection.on('error', (err) => console.error('[Voice] Connection error:', err.message));
  }

  /** The same, for the selfbot connection a DM call gives us. */
  _attachDirectAudio(connection, bridge) {
    try {
      this.dispatcher = connection.play(bridge.getDiscordInputStream(), {
        type: 'opus',
        bitrate: 'auto',
      });
      this.dispatcher.on('error', (err) =>
        console.error('[Voice] Dispatcher error:', err.message),
      );
    } catch (err) {
      console.error('[Voice] Could not start DM audio output:', err.message);
    }

    // The DM path exposes the older receiver API, which yields a stream per
    // user on demand rather than a subscribe() call.
    const receiver = connection.receiver;
    if (!receiver?.createStream) {
      console.warn('[Voice] DM receiver has no createStream; inbound audio unavailable');
      return;
    }

    connection.on('speaking', (user, speaking) => {
      if (!speaking?.bitfield) return;
      if (this._alreadyPiped(user.id)) return;

      this._pipeSpeaker({
        userId: user.id,
        bridge,
        opusStream: receiver.createStream(user, { mode: 'opus', end: 'silence' }),
      });
    });

    connection.on('error', (err) => console.error('[Voice] DM connection error:', err.message));
  }

  /** True if this user has a live stream already; clears a finished one. */
  _alreadyPiped(userId) {
    const existing = this.speakers.get(userId);
    if (!existing) return false;
    if (!existing.ended) return true;
    this.speakers.delete(userId);
    return false;
  }

  /**
   * Decode one speaker's Opus into PCM and hand it to the bridge.
   *
   * Shared by both transports -- the only difference between them is how the
   * stream is obtained, which is why it is passed in.
   */
  _pipeSpeaker({ opusStream, userId, bridge }) {
    console.log('[Voice] Speaker started:', userId);

    const decoder = new prism.opus.Decoder(DECODER_OPTIONS);
    const speaker = { opusStream, decoder, ended: false };
    this.speakers.set(userId, speaker);

    decoder.on('data', (pcm) => bridge.handlePcmFromDiscord(pcm, userId));
    decoder.on('error', (err) => console.error('[Voice] Decoder error:', err.message));
    opusStream.on('error', (err) => console.error('[Voice] Opus stream error:', err.message));

    // 'end' and 'close' can both fire; the flag keeps teardown to once.
    const finish = () => {
      if (speaker.ended) return;
      speaker.ended = true;
      console.log('[Voice] Speaker stopped:', userId);
      this.speakers.delete(userId);
      try {
        decoder.destroy();
      } catch {
        // Already destroyed.
      }
    };

    opusStream.on('end', finish);
    opusStream.on('close', finish);

    opusStream.pipe(decoder);
  }

  leave() {
    console.log('[Voice] Leaving');

    for (const { opusStream, decoder } of this.speakers.values()) {
      try {
        opusStream.destroy();
        decoder.destroy();
      } catch {
        // Already gone.
      }
    }
    this.speakers.clear();

    if (this.player) {
      this.player.stop();
      this.player = null;
    }

    if (this.dispatcher) {
      try {
        this.dispatcher.destroy();
      } catch {
        // Already destroyed.
      }
      this.dispatcher = null;
    }

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    if (this.selfbotConnection) {
      try {
        this.selfbotConnection.disconnect();
      } catch {
        // Already disconnected.
      }
      this.selfbotConnection = null;
    }

    this.channelId = null;
    this.guildId = null;
  }
}

module.exports = VoiceSession;
