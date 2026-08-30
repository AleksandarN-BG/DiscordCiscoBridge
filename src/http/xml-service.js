// The HTTP surface the phone browses.
//
// This assembles it and owns its lifecycle; the pages themselves live in
// routes/, the documents in cisco/xml.js, and the call state in session.js.
// Nothing below builds XML or talks to Discord directly.

const express = require('express');
const { buildUrls } = require('./urls');
const { clientAllowlist } = require('./allowlist');
const CallSession = require('./session');
const browseRoutes = require('./routes/browse');
const callRoutes = require('./routes/call');
const statusRoutes = require('./routes/status');

class XmlService {
  /**
   * @param {{http: {host: string, port: number, publicUrl: string, allowedClients?: string[]}, rtp: {bridgeIp: string, listenPort: number}, phoneIp: string, discord: object, phone: object, bridge: object}} deps
   */
  constructor({ http, rtp, discord, phone, bridge, phoneIp }) {
    this.http = http;
    this.phone = phone;
    this.session = new CallSession();
    this.server = null;

    const urls = buildUrls(http.publicUrl);
    const { session } = this;

    this.app = express();

    // Before anything else: only the handset may reach these routes.
    this.app.use(clientAllowlist({ phoneIp, extra: http.allowedClients }));

    this.app.use(browseRoutes({ discord, urls }));
    this.app.use(callRoutes({ discord, phone, bridge, session, urls, rtp }));
    this.app.use(statusRoutes({ session, urls }));
  }

  start() {
    this.server = this.app.listen(this.http.port, this.http.host, () => {
      console.log(`[XmlService] Listening on ${this.http.host}:${this.http.port}`);
    });
  }

  /**
   * Close down, leaving the handset usable.
   *
   * A phone whose stream is never stopped keeps showing an in-call screen with
   * no way out, so this runs even if the individual steps fail.
   */
  async stop() {
    if (this.session.active && this.session.streamId) {
      await this._quietly('stop the phone stream', () =>
        this.phone.stopMedia(this.session.streamId),
      );
      await this._quietly('clear the phone display', () => this.phone.clearDisplay());
      this.session.reset();
    }

    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async _quietly(what, action) {
    try {
      await action();
    } catch (e) {
      console.error(`[XmlService] Could not ${what}:`, e.message);
    }
  }
}

module.exports = XmlService;
