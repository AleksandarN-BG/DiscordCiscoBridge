// Phone -> Discord: receives RTP from the handset and emits 48 kHz PCM.
//
// The RTP parsing is done by hand because the payload is the simplest case the
// protocol has -- fixed 12-byte header, no extensions, no CSRCs, one codec --
// and a library for it would be more surface than the eight lines below.
//
// Events: 'phoneDetected' ({ip, port}), 'pcm' (Buffer), 'error' (Error).

const dgram = require('dgram');
const EventEmitter = require('events');
const { decodeMulaw, upsample8to48 } = require('./g711');

const RTP_HEADER_BYTES = 12;
const RTP_VERSION = 2;
const PAYLOAD_TYPE_PCMU = 0;

/** Log every Nth packet rather than each one; a call is 50 packets a second. */
const PACKET_LOG_INTERVAL = 500;

class RtpReceiver extends EventEmitter {
  constructor(listenPort) {
    super();
    this.listenPort = listenPort;
    this.socket = null;
    this.phoneIp = null;
    this.phonePort = null;
    this.packetsReceived = 0;
    this.started = false;
  }

  start() {
    if (this.started) {
      console.log('[RtpReceiver] Already started');
      return;
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => this._handlePacket(msg, rinfo));

    this.socket.on('listening', () => {
      const addr = this.socket.address();
      console.log(`[RtpReceiver] Listening on ${addr.address}:${addr.port}`);
    });

    this.socket.on('error', (err) => {
      console.error('[RtpReceiver] Socket error:', err.message);
      this.emit('error', err);
    });

    this.socket.bind(this.listenPort);
    this.started = true;
  }

  /**
   * The first packet to arrive tells us where the phone is. There is no
   * signalling channel to ask -- startMedia only says where to send, so the
   * return path is discovered from the source address of what comes back.
   */
  _handlePacket(msg, rinfo) {
    if (!this.phoneIp) {
      this.phoneIp = rinfo.address;
      this.phonePort = rinfo.port;
      console.log(`[RtpReceiver] Phone detected: ${rinfo.address}:${rinfo.port}`);
      this.emit('phoneDetected', { ip: rinfo.address, port: rinfo.port });
    }

    this.packetsReceived++;
    if (this.packetsReceived % PACKET_LOG_INTERVAL === 0) {
      console.log(`[RtpReceiver] ${this.packetsReceived} packets received`);
    }

    if (msg.length <= RTP_HEADER_BYTES) return;
    if (((msg[0] >> 6) & 0x03) !== RTP_VERSION) {
      console.warn('[RtpReceiver] Not RTP version 2, dropping packet');
      return;
    }

    // Warn once at the start if the phone picked something other than PCMU,
    // but keep going: the payload is very likely still mu-law.
    const payloadType = msg[1] & 0x7f;
    if (payloadType !== PAYLOAD_TYPE_PCMU && this.packetsReceived <= 5) {
      console.warn(`[RtpReceiver] Payload type ${payloadType}, expected ${PAYLOAD_TYPE_PCMU} (PCMU)`);
    }

    const pcm8k = decodeMulaw(msg.subarray(RTP_HEADER_BYTES));
    this.emit('pcm', upsample8to48(pcm8k));
  }

  getPhoneInfo() {
    return { ip: this.phoneIp, port: this.phonePort };
  }

  stop() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        console.error('[RtpReceiver] Error closing socket:', err.message);
      }
      this.socket = null;
    }

    this.started = false;
    this.phoneIp = null;
    this.phonePort = null;
    this.packetsReceived = 0;
  }
}

module.exports = RtpReceiver;
