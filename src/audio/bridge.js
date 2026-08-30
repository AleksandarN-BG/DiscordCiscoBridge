// Coordinator for the two audio directions.
//
//   phone -> RtpReceiver -> [PCM 48k] -> Opus encoder -> Discord
//   Discord -> Mixer -> [PCM 48k] -> RtpStreamer -> phone
//
// Neither direction knows about the other; this class owns the wiring, the
// lifecycle, and the decision of when the phone counts as present.
//
// Events: 'phoneConnected' ({ip, port}), 'error' (Error).

const EventEmitter = require('events');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const RtpStreamer = require('./rtp-streamer');
const RtpReceiver = require('./rtp-receiver');
const { Mixer, SAMPLES_PER_FRAME, FRAME_BYTES } = require('./mixer');

/** Drain the mixer on the same 20 ms grid the RTP sender uses. */
const MIXER_INTERVAL_MS = 20;

const OPUS_OPTIONS = { rate: 48000, channels: 1, frameSize: SAMPLES_PER_FRAME };

class AudioBridge extends EventEmitter {
  constructor(listenPort) {
    super();
    this.listenPort = listenPort;

    this.streamer = new RtpStreamer();
    this.receiver = new RtpReceiver(listenPort);
    this.mixer = new Mixer({ frameBytes: FRAME_BYTES });

    /** Phone-side PCM, waiting to be Opus encoded for Discord. */
    this.phoneToDiscordPcm = new PassThrough();
    this.opusEncoder = null;

    this.phoneDetected = false;
    this.mixerInterval = null;
    this._warnedNoPhone = false;

    this._wireReceiver();
  }

  _wireReceiver() {
    // The phone's first packet is what reveals its address, so the outbound
    // direction cannot start until the inbound one has heard something.
    this.receiver.on('phoneDetected', ({ ip, port }) => {
      console.log(`[AudioBridge] Phone at ${ip}:${port}`);
      this.phoneDetected = true;

      // Send to the port we asked the phone to listen on, not the ephemeral
      // port it happens to be sending from.
      this.streamer.start(ip, this.listenPort);
      this.emit('phoneConnected', { ip, port });
    });

    this.receiver.on('pcm', (pcm) => {
      if (this.phoneToDiscordPcm.writable) this.phoneToDiscordPcm.write(pcm);
    });

    const forwardError = (source) => (err) => {
      console.error(`[AudioBridge] ${source} error:`, err.message);
      this.emit('error', err);
    };
    this.receiver.on('error', forwardError('Receiver'));
    this.streamer.on('error', forwardError('Streamer'));
  }

  start() {
    console.log(`[AudioBridge] Starting on port ${this.listenPort}`);
    this.receiver.start();
  }

  /**
   * Queue PCM from one Discord speaker (48 kHz mono s16le).
   *
   * Audio arriving before the phone has been detected is discarded: there is
   * nowhere to send it, and buffering it would only play a backlog at the user
   * once the call connects.
   */
  handlePcmFromDiscord(pcm, userId = 'default') {
    if (!this.phoneDetected) {
      if (!this._warnedNoPhone) {
        console.log('[AudioBridge] Discord audio arriving before the phone; dropping');
        this._warnedNoPhone = true;
      }
      return;
    }

    this.mixer.push(userId, pcm);
    if (!this.mixerInterval) this._startMixer();
  }

  /** Runs only while there is audio to mix, and stops itself once drained. */
  _startMixer() {
    this.mixerInterval = setInterval(() => {
      const frame = this.mixer.pullFrame();

      if (frame) {
        this.streamer.write(frame);
        return;
      }

      if (this.mixer.isIdle()) this._stopMixer();
    }, MIXER_INTERVAL_MS);
  }

  _stopMixer() {
    if (this.mixerInterval) {
      clearInterval(this.mixerInterval);
      this.mixerInterval = null;
    }
  }

  /**
   * The Opus stream Discord plays from us, carrying the phone's audio.
   *
   * The PCM is re-framed to exactly 960 samples before it reaches the encoder:
   * RTP packets are 20 ms at 8 kHz, so after upsampling they do not line up
   * with Opus frames, and prism's encoder needs whole frames.
   *
   * @returns {PassThrough} Opus packets
   */
  getDiscordInputStream() {
    const opusOutput = new PassThrough();
    this.opusEncoder = new prism.opus.Encoder(OPUS_OPTIONS);

    this.opusEncoder.on('data', (packet) => {
      if (opusOutput.writable) opusOutput.write(packet);
    });

    this.opusEncoder.on('error', (err) => {
      console.error('[AudioBridge] Opus encoder error:', err.message);
    });

    let pending = Buffer.alloc(0);

    this.phoneToDiscordPcm.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        if (this.opusEncoder.writable) this.opusEncoder.write(frame);
      }
    });

    console.log('[AudioBridge] Discord input stream ready (phone -> Opus -> Discord)');
    return opusOutput;
  }

  isPhoneConnected() {
    return this.phoneDetected;
  }

  getPhoneInfo() {
    return this.receiver.getPhoneInfo();
  }

  stop() {
    console.log('[AudioBridge] Stopping');
    this._teardown();
    if (this.phoneToDiscordPcm) this.phoneToDiscordPcm.end();
  }

  /**
   * Reset for a new call.
   *
   * The RTP components and the PCM stream are replaced rather than reused: a
   * closed UDP socket cannot be rebound, and an ended PassThrough will not
   * accept writes again.
   */
  restart() {
    console.log('[AudioBridge] Restarting for a new call');

    this._teardown();

    this.streamer = new RtpStreamer();
    this.receiver = new RtpReceiver(this.listenPort);
    this.phoneToDiscordPcm = new PassThrough();
    this.opusEncoder = null;

    this._wireReceiver();
    this.receiver.start();
  }

  _teardown() {
    this._stopMixer();
    this.mixer.clear();
    this.streamer.stop();
    this.receiver.stop();
    this.phoneDetected = false;
    this._warnedNoPhone = false;
  }
}

module.exports = AudioBridge;
