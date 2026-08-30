// Discord -> phone: encodes 48 kHz PCM to G.711 and paces it out as RTP.
//
// FFmpeg does the resample and mu-law encode only; the RTP framing is ours
// (see rtp-packet.js). Letting FFmpeg emit RTP directly was tried and gives up
// control of the send cadence, which is the one thing a handset notices.
//
// Events: 'started', 'error' (Error).

const { spawn } = require('child_process');
const dgram = require('dgram');
const EventEmitter = require('events');
const { RtpPacketizer } = require('./rtp-packet');

const PAYLOAD_TYPE_PCMU = 0;
/** 20 ms at 8 kHz, one byte per sample in mu-law. */
const SAMPLES_PER_PACKET = 160;
const PACKET_INTERVAL_MS = 20;

/**
 * Above this much queued audio, send extra packets per tick to catch up.
 * Latency is more noticeable on a phone call than a few dropped milliseconds.
 */
const MAX_BUFFERED_PACKETS = 5;
const CATCHUP_PACKETS_PER_TICK = 3;

/** Audio that arrives before FFmpeg is up is held, not dropped -- ~1 second. */
const MAX_STARTUP_CHUNKS = 50;

const FFMPEG_ARGS = [
  '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
  '-acodec', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-f', 'mulaw', 'pipe:1',
];

class RtpStreamer extends EventEmitter {
  constructor() {
    super();
    this.ffmpeg = null;
    this.socket = null;
    this.phoneIp = null;
    this.phonePort = null;
    this.started = false;
    this.ffmpegReady = false;

    this.packetizer = new RtpPacketizer({
      payloadType: PAYLOAD_TYPE_PCMU,
      samplesPerPacket: SAMPLES_PER_PACKET,
    });

    this.encoded = Buffer.alloc(0);
    this.sendInterval = null;
    this.startupBuffer = [];
  }

  start(phoneIp, phonePort) {
    if (this.started) {
      console.log('[RtpStreamer] Already started');
      return;
    }

    this.phoneIp = phoneIp;
    this.phonePort = phonePort;
    console.log(`[RtpStreamer] Streaming to ${phoneIp}:${phonePort}`);

    this.socket = dgram.createSocket('udp4');
    this.socket.on('error', (err) => console.error('[RtpStreamer] Socket error:', err.message));

    this._spawnEncoder();
    this._startPacing();
  }

  _spawnEncoder() {
    this.ffmpeg = spawn('ffmpeg', FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpeg.on('spawn', () => {
      this.started = true;
      this.ffmpegReady = true;

      if (this.startupBuffer.length > 0) {
        console.log(`[RtpStreamer] Flushing ${this.startupBuffer.length} buffered chunks`);
        for (const chunk of this.startupBuffer) this.ffmpeg.stdin.write(chunk);
        this.startupBuffer = [];
      }

      this.emit('started');
    });

    this.ffmpeg.on('error', (err) => {
      console.error('[RtpStreamer] FFmpeg spawn failed:', err.message);
      this.emit('error', err);
    });

    this.ffmpeg.on('close', (code) => {
      console.log(`[RtpStreamer] FFmpeg exited (${code})`);
      this.started = false;
      this.ffmpegReady = false;
    });

    this.ffmpeg.stdout.on('data', (mulaw) => {
      this.encoded = Buffer.concat([this.encoded, mulaw]);
    });

    // FFmpeg reports progress on stderr; only surface the lines that aren't it.
    this.ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg.includes('size=') && !msg.includes('time=')) {
        console.log('[RtpStreamer] FFmpeg:', msg);
      }
    });

    // EPIPE is what a killed FFmpeg looks like from this side; not worth a log.
    this.ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('[RtpStreamer] stdin error:', err.message);
    });
  }

  /** Fixed-cadence sender. A handset expects a packet every 20 ms, not a burst. */
  _startPacing() {
    const maxBufferedBytes = SAMPLES_PER_PACKET * MAX_BUFFERED_PACKETS;

    this.sendInterval = setInterval(() => {
      const behind = this.encoded.length > maxBufferedBytes;
      const budget = behind
        ? Math.min(CATCHUP_PACKETS_PER_TICK, Math.floor(this.encoded.length / SAMPLES_PER_PACKET))
        : 1;

      for (let i = 0; i < budget && this.encoded.length >= SAMPLES_PER_PACKET; i++) {
        const payload = this.encoded.subarray(0, SAMPLES_PER_PACKET);
        this.encoded = this.encoded.subarray(SAMPLES_PER_PACKET);
        this._send(this.packetizer.packetize(payload));
      }
    }, PACKET_INTERVAL_MS);
  }

  _send(packet) {
    if (!this.socket || !this.phoneIp || !this.phonePort) return;
    this.socket.send(packet, 0, packet.length, this.phonePort, this.phoneIp, (err) => {
      if (err) console.error('[RtpStreamer] Send error:', err.message);
    });
  }

  /**
   * Feed 48 kHz mono s16le in. Returns false when the audio was buffered or
   * dropped rather than encoded.
   */
  write(pcm) {
    if (!this.ffmpegReady) {
      if (this.startupBuffer.length < MAX_STARTUP_CHUNKS) this.startupBuffer.push(pcm);
      return false;
    }

    if (!this.ffmpeg || !this.ffmpeg.stdin.writable) return false;

    try {
      this.ffmpeg.stdin.write(pcm);
      return true;
    } catch (err) {
      console.error('[RtpStreamer] Write error:', err.message);
      return false;
    }
  }

  stop() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }

    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdin.end();
        this.ffmpeg.kill('SIGTERM');
      } catch (err) {
        console.error('[RtpStreamer] Error stopping FFmpeg:', err.message);
      }
      this.ffmpeg = null;
    }

    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        console.error('[RtpStreamer] Error closing socket:', err.message);
      }
      this.socket = null;
    }

    this.started = false;
    this.ffmpegReady = false;
    this.encoded = Buffer.alloc(0);
    this.startupBuffer = [];
  }

  isStarted() {
    return this.started;
  }
}

module.exports = RtpStreamer;
