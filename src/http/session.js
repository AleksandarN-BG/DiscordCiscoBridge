// The one call the bridge can have in progress.
//
// A single session rather than a collection: there is one handset and one RTP
// listen port, so a second concurrent call has nowhere to go.
//
// This exists as a class mainly so that reset() is written once. It used to be
// an object literal repeated at three call sites, two of which forgot to clear
// guildId -- leaving a stale guild id behind after a hangup.

class CallSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.channelId = null;
    this.guildId = null;
    this.streamId = null;
    this.channelName = null;
    /** @type {'dm'|'server'|null} */
    this.channelType = null;
    /** @type {string[]} Display names, refreshed while connected. */
    this.users = [];
  }

  /** @param {{channelId: string, guildId?: string|null, streamId: string, channelName: string, channelType: 'dm'|'server', users?: string[]}} call */
  start({ channelId, guildId = null, streamId, channelName, channelType, users = [] }) {
    this.active = true;
    this.channelId = channelId;
    this.guildId = guildId;
    this.streamId = streamId;
    this.channelName = channelName;
    this.channelType = channelType;
    this.users = users;
  }

  setUsers(users) {
    this.users = users;
  }

  /** Only guild channels have a roster worth re-reading. */
  get isRefreshable() {
    return this.active && this.channelType === 'server' && Boolean(this.channelId);
  }
}

module.exports = CallSession;
