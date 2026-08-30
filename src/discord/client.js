// The Discord side: login, and read-only queries for what the phone can browse.
//
// Voice lives in voice.js. This class owns the connection and delegates to a
// VoiceSession, so callers have one object to hold and the HTTP layer never
// touches discord.js types directly -- every method here returns plain data.
//
// This uses a *user* token, not a bot token. Bots cannot be placed in a DM
// call, which is half of what the bridge exists to do. It is against Discord's
// terms of service; see the README.

const { Client } = require('discord.js-selfbot-v13');
const VoiceSession = require('./voice');

const DM_TYPES = new Set([1, 'DM']);
const GROUP_DM_TYPES = new Set([3, 'GROUP_DM']);
const VOICE_TYPES = new Set([2, 'GUILD_VOICE']);

const RELATIONSHIP_FRIEND = 1;

class DiscordClient {
  constructor(token) {
    this.token = token;
    this.client = new Client();
    this.voice = new VoiceSession(this.client);
    this.ready = false;
  }

  async login() {
    return new Promise((resolve, reject) => {
      this.client.once('ready', () => {
        console.log('[Discord] Logged in as', this.client.user.tag);
        this.ready = true;
        resolve();
      });
      this.client.on('error', reject);
      this.client.login(this.token).catch(reject);
    });
  }

  // --- directory -----------------------------------------------------------

  /** @returns {Promise<Array<{id: string, name: string}>>} */
  async getGuilds() {
    return [...this.client.guilds.cache].map(([id, guild]) => ({ id, name: guild.name }));
  }

  async getGuild(guildId) {
    try {
      return await this.client.guilds.fetch(guildId);
    } catch (e) {
      console.error('[Discord] Could not fetch guild:', e.message);
      return null;
    }
  }

  async getChannel(channelId) {
    try {
      return await this.client.channels.fetch(channelId);
    } catch (e) {
      console.error('[Discord] Could not fetch channel:', e.message);
      return null;
    }
  }

  /**
   * DMs and group DMs, most recently active first.
   *
   * Three sources, because no single one is complete: the channel cache only
   * holds conversations this session has seen, the relationship list covers
   * friends who have a channel but no recent traffic, and the user cache
   * catches the rest. Ordering matters -- earlier sources carry better names.
   *
   * @returns {Promise<Array<{id: string, name: string, type: 1|3, recipient: any, lastMessageId: string}>>}
   */
  async getDMChannels() {
    const found = new Map();

    const add = (entry) => {
      if (entry.id && !found.has(entry.id)) found.set(entry.id, entry);
    };

    for (const [id, channel] of this.client.channels.cache) {
      const isGroup = GROUP_DM_TYPES.has(channel.type);
      if (!isGroup && !DM_TYPES.has(channel.type)) continue;

      add({
        id,
        name: isGroup ? groupDmName(channel) : dmName(channel),
        type: isGroup ? 3 : 1,
        recipient: channel.recipient,
        lastMessageId: channel.lastMessageId || '0',
      });
    }

    for (const [, relationship] of this.client.relationships?.cache ?? []) {
      if (relationship.type !== RELATIONSHIP_FRIEND) continue;
      const user = relationship.user;
      if (!user?.dmChannel) continue;

      add({
        id: user.dmChannel.id,
        name: user.username || user.tag || 'Friend',
        type: 1,
        recipient: user,
        lastMessageId: user.dmChannel.lastMessageId || '0',
      });
    }

    for (const [, user] of this.client.users.cache) {
      if (!user.dmChannel) continue;

      add({
        id: user.dmChannel.id,
        name: user.username || user.tag || 'User',
        type: 1,
        recipient: user,
        lastMessageId: user.dmChannel.lastMessageId || '0',
      });
    }

    // Snowflakes embed a timestamp, so a plain descending sort by id is a
    // sort by recency. They exceed Number's safe range, hence BigInt.
    const channels = [...found.values()].sort((a, b) => {
      const left = BigInt(a.lastMessageId || '0');
      const right = BigInt(b.lastMessageId || '0');
      return right > left ? 1 : right < left ? -1 : 0;
    });

    const groups = channels.filter((c) => c.type === 3).length;
    console.log(`[Discord] ${channels.length} conversations (${groups} group)`);
    return channels;
  }

  /**
   * Joinable voice channels in a guild.
   * @returns {Promise<Array<{id: string, name: string, memberCount: number}>>}
   */
  async getVoiceChannels(guildId) {
    const guild = await this.client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const joinable = [];

    for (const [id, channel] of channels) {
      if (!VOICE_TYPES.has(channel?.type)) continue;

      // Listing a channel we cannot enter only produces a failed join later.
      if (channel.permissionsFor && this.client.user) {
        const permissions = channel.permissionsFor(this.client.user);
        if (!permissions?.has('CONNECT')) continue;
      }

      joinable.push({ id, name: channel.name, memberCount: channel.members?.size ?? 0 });
    }

    if (joinable.length === 0) console.warn(`[Discord] No joinable voice channels in ${guildId}`);
    return joinable;
  }

  /** @returns {Promise<Array<{id: string, username: string, displayName: string}>>} */
  async getVoiceChannelMembers(channelId) {
    const channel = await this.getChannel(channelId);
    if (!channel?.members) return [];

    return [...channel.members].map(([id, member]) => ({
      id,
      username: member.user?.username || 'Unknown',
      displayName: member.displayName || member.user?.username || 'Unknown',
    }));
  }

  // --- voice, delegated ----------------------------------------------------

  async joinVoiceChannel(guildId, channelId, bridge) {
    this._requireReady();
    return this.voice.joinGuildChannel(guildId, channelId, bridge);
  }

  async joinDMCall(channelId, bridge) {
    this._requireReady();
    return this.voice.joinDirectCall(channelId, bridge);
  }

  leaveVoiceChannel() {
    this.voice.leave();
  }

  _requireReady() {
    if (!this.ready) throw new Error('Discord client is not ready yet');
  }
}

/** Best available label for a one-to-one DM. */
function dmName(channel) {
  return channel.recipient?.username || channel.recipient?.tag || 'DM';
}

/** Group DMs are often unnamed, in which case Discord shows the member list. */
function groupDmName(channel) {
  if (channel.name) return channel.name;
  if (channel.recipients?.size > 0) {
    return [...channel.recipients.values()].map((r) => r.username).join(', ');
  }
  return 'Group DM';
}

module.exports = DiscordClient;
