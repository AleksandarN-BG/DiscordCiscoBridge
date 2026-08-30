// G.711 mu-law codec and the 8k <-> 48k rate change, as pure functions.
//
// Decoding is a 256-entry table lookup rather than the arithmetic form of the
// standard: it is one indexed read per sample, which matters when this runs on
// every packet of a live call.

/** ITU-T G.711 mu-law, expanded to signed 16-bit. Index by the encoded byte. */
const MULAW_DECODE_TABLE = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0,
]);

/** Phone side is 8 kHz, Discord side is 48 kHz. */
const UPSAMPLE_FACTOR = 6;

/**
 * mu-law bytes -> signed 16-bit little-endian PCM at the same sample rate.
 * @param {Buffer} mulaw
 * @returns {Buffer} twice the length of the input
 */
function decodeMulaw(mulaw) {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE_TABLE[mulaw[i]], i * 2);
  }
  return pcm;
}

/**
 * 8 kHz -> 48 kHz by linear interpolation between neighbouring samples.
 *
 * Linear rather than a windowed filter on purpose: the source is band-limited
 * to 3.4 kHz by the phone already, so there is little above the 4 kHz image
 * for a better filter to recover, and this costs almost nothing per packet.
 *
 * @param {Buffer} pcm8k signed 16-bit LE
 * @returns {Buffer} six times the length
 */
function upsample8to48(pcm8k) {
  const samples = pcm8k.length / 2;
  const out = Buffer.alloc(samples * UPSAMPLE_FACTOR * 2);

  for (let i = 0; i < samples; i++) {
    const current = pcm8k.readInt16LE(i * 2);
    // Hold the last sample rather than interpolating toward silence, which
    // would put a downward ramp on the tail of every packet.
    const next = i < samples - 1 ? pcm8k.readInt16LE((i + 1) * 2) : current;

    for (let j = 0; j < UPSAMPLE_FACTOR; j++) {
      const t = j / UPSAMPLE_FACTOR;
      out.writeInt16LE(Math.round(current * (1 - t) + next * t), (i * UPSAMPLE_FACTOR + j) * 2);
    }
  }

  return out;
}

module.exports = { decodeMulaw, upsample8to48, UPSAMPLE_FACTOR, MULAW_DECODE_TABLE };
