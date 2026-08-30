// RTP header construction (RFC 3550, section 5.1).
//
// Only the fixed header is emitted: no padding, no extension, no CSRC list.
// That is all a single-source G.711 stream needs, and the phone expects
// nothing more.
//
//    0                   1                   2                   3
//    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   |V=2|P|X|  CC   |M|     PT      |       sequence number         |
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   |                           timestamp                           |
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   |             synchronization source (SSRC) identifier           |
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

const HEADER_BYTES = 12;

/** V=2, no padding, no extension, no CSRCs. */
const FIRST_OCTET = 0x80;

const random32 = () => Math.floor(Math.random() * 0x100000000) >>> 0;

class RtpPacketizer {
  /**
   * @param {{payloadType: number, samplesPerPacket: number}} spec
   *
   * Sequence number, timestamp and SSRC all start random, as RFC 3550 asks:
   * a predictable starting point makes a stream trivial to spoof or to
   * confuse with a previous one on the same port.
   */
  constructor({ payloadType, samplesPerPacket }) {
    this.payloadType = payloadType;
    this.samplesPerPacket = samplesPerPacket;
    this.seq = Math.floor(Math.random() * 0x10000);
    this.timestamp = random32();
    this.ssrc = random32();
  }

  /**
   * Wrap one payload, advancing sequence and timestamp.
   *
   * The timestamp advances by the sample count, not by the byte count -- for
   * G.711 they happen to be equal, which is a coincidence worth not relying on.
   *
   * @param {Buffer} payload
   * @returns {Buffer}
   */
  packetize(payload) {
    const header = Buffer.alloc(HEADER_BYTES);

    header[0] = FIRST_OCTET;
    header[1] = this.payloadType & 0x7f;
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);

    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + this.samplesPerPacket) >>> 0;

    return Buffer.concat([header, payload]);
  }
}

module.exports = { RtpPacketizer, HEADER_BYTES };
