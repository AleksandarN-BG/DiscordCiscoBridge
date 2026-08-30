// Client for the phone's CGI/Execute endpoint.
//
// Every call is the same shape -- URL-encoded form body with a single `XML`
// parameter, HTTP basic auth, short timeout -- so the transport lives in one
// place and the public methods are just the documents they send.

const axios = require('axios');
const xml = require('./xml');

const TIMEOUT_MS = 5000;

class PhoneApi {
  constructor({ ip, username, password }) {
    this.ip = ip;
    this.username = username;
    this.password = password;
    this.baseUrl = `http://${ip}/CGI/Execute`;
  }

  /**
   * POST one XML document to the phone.
   *
   * The phone rejects a raw XML body: it must arrive URL-encoded as the value
   * of an `XML` form field.
   */
  async _execute(document) {
    const options = {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT_MS,
    };

    if (this.username && this.password) {
      options.auth = { username: this.username, password: this.password };
    }

    const res = await axios.post(this.baseUrl, `XML=${encodeURIComponent(document)}`, options);
    return res.data;
  }

  /** As above, but for calls where a failure should not abort the caller. */
  async _tryExecute(document, what) {
    try {
      await this._execute(document);
      console.log(`[PhoneApi] ${what}`);
      return true;
    } catch (e) {
      console.error(`[PhoneApi] Failed to ${what.toLowerCase()}:`, e.message);
      return false;
    }
  }

  /**
   * Ask the phone to open a G.711 stream to us, and to notify `onStoppedUrl`
   * when it hangs up. Resolves to the phone's stream id, needed to stop it.
   */
  async startMedia(bridgeIp, port, onStoppedUrl) {
    // Cisco wants the callback as `Notify:http:host:port:path` -- colon
    // separated, no scheme slashes, no leading slash on the path.
    const url = new URL(onStoppedUrl);
    const notify = `Notify:http:${url.hostname}:${url.port || 80}:${url.pathname.replace(/^\//, '')}`;

    // G.711 without a variant defaults to mu-law (PCMU) on Cisco handsets,
    // which is what rtp-receiver decodes.
    const document =
      `<startMedia><mediaStream onStopped="${xml.escape(notify)}" receiveVolume="100">` +
      `<type>audio</type><codec>G.711</codec><mode>sendReceive</mode>` +
      `<address>${xml.escape(bridgeIp)}</address><port>${port}</port>` +
      `</mediaStream></startMedia>`;

    console.log(`[PhoneApi] startMedia -> ${bridgeIp}:${port} (G.711, notify ${url.pathname})`);

    const data = await this._execute(document);
    const match = String(data).match(/id="([^"]+)"/);
    if (!match) {
      throw new Error(`No stream ID in phone response: ${String(data).slice(0, 200)}`);
    }
    return match[1];
  }

  async stopMedia(streamId) {
    console.log('[PhoneApi] stopMedia for stream:', streamId);
    await this._execute(`<stopMedia><mediaStream id="${xml.escape(streamId)}"/></stopMedia>`);
  }

  /** Push a text page to the phone's screen. */
  async sendDisplay(title, body) {
    return this._tryExecute(xml.textPage({ title, body }), `Display updated: ${title}`);
  }

  /** Return the phone to its idle services screen. */
  async clearDisplay() {
    return this._tryExecute(xml.execute('Init:Services'), 'Display cleared');
  }
}

module.exports = PhoneApi;
