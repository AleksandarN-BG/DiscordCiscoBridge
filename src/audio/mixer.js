// Sums several Discord speakers into the one mono stream the phone can carry.
//
// A phone call has no concept of multiple simultaneous participants, so when
// more than one person talks their audio has to be combined before it leaves
// for the handset. Buffering is per-user because their packets arrive
// independently and rarely frame-aligned with each other.

/** 20 ms at 48 kHz, the frame both Opus and the RTP sender work in. */
const SAMPLES_PER_FRAME = 960;
const FRAME_BYTES = SAMPLES_PER_FRAME * 2;

class Mixer {
  constructor({ frameBytes = FRAME_BYTES } = {}) {
    this.frameBytes = frameBytes;
    this.samplesPerFrame = frameBytes / 2;
    /** @type {Map<string, Buffer>} */
    this.buffers = new Map();
  }

  /** Queue PCM (48 kHz mono s16le) from one speaker. */
  push(userId, pcm) {
    const existing = this.buffers.get(userId);
    this.buffers.set(userId, existing ? Buffer.concat([existing, pcm]) : pcm);
  }

  /**
   * Take one frame from every speaker that has a whole one and sum them.
   *
   * Partial buffers are left in place for the next call -- emitting them short
   * would put a gap in that speaker's audio. Returns null when nobody has a
   * full frame yet, which the caller uses to decide whether to keep ticking.
   *
   * @returns {Buffer|null}
   */
  pullFrame() {
    const frames = [];

    for (const [userId, buffer] of this.buffers) {
      if (buffer.length >= this.frameBytes) {
        frames.push(buffer.subarray(0, this.frameBytes));
        this.buffers.set(userId, buffer.subarray(this.frameBytes));
      }
      if (this.buffers.get(userId).length === 0) {
        this.buffers.delete(userId);
      }
    }

    if (frames.length === 0) return null;
    if (frames.length === 1) return frames[0];

    // Additive mixing, clamped. Averaging instead would make everyone quieter
    // the moment a second person joins, which sounds like a fault.
    const mixed = Buffer.alloc(this.frameBytes);
    for (let i = 0; i < this.samplesPerFrame; i++) {
      let sum = 0;
      for (const frame of frames) sum += frame.readInt16LE(i * 2);
      mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i * 2);
    }
    return mixed;
  }

  /** True when there is nothing queued at all, whole frames or partials. */
  isIdle() {
    return this.buffers.size === 0;
  }

  get speakers() {
    return this.buffers.size;
  }

  clear() {
    this.buffers.clear();
  }
}

module.exports = { Mixer, SAMPLES_PER_FRAME, FRAME_BYTES };
