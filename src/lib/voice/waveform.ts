/**
 * Drawing real audio: min/max peaks per pixel column, and a small STFT
 * spectrogram. Computed from the decoded samples themselves — nothing here is
 * decorative. Unit-tested in tests/web/waveform.test.mjs.
 */

/** [min, max] of each of `columns` equal slices of `samples[from, to)`. */
export function peaks(samples: Float32Array, columns: number, from = 0, to = samples.length): Float32Array {
  const out = new Float32Array(columns * 2);
  const span = Math.max(1, to - from);
  for (let c = 0; c < columns; c++) {
    const a = from + Math.floor((c * span) / columns);
    const b = Math.max(a + 1, from + Math.floor(((c + 1) * span) / columns));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b && i < to; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[c * 2] = lo;
    out[c * 2 + 1] = hi;
  }
  return out;
}

/** In-place radix-2 FFT (re, im of length 2^k). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/**
 * Magnitudes in dB, `frames` columns × (size/2) bins (row-major per frame),
 * Hann-windowed, up to `maxHz`.
 */
export function spectrogram(
  samples: Float32Array,
  sampleRate: number,
  frames: number,
  size = 512,
  maxHz = 8000,
): { db: Float32Array; bins: number } {
  const bins = Math.min(size / 2, Math.ceil((maxHz / (sampleRate / 2)) * (size / 2)));
  const db = new Float32Array(frames * bins);
  const hop = Math.max(1, Math.floor((samples.length - size) / Math.max(1, frames - 1)));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let f = 0; f < frames; f++) {
    const at = f * hop;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      re[i] = (samples[at + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]) / size;
      db[f * bins + b] = 20 * Math.log10(mag + 1e-9);
    }
  }
  return { db, bins };
}

/** Sample rate written in a WAV header, or null for anything that is not a WAV. */
export function wavSampleRate(head: ArrayBuffer): number | null {
  if (head.byteLength < 28) return null;
  const v = new DataView(head);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  return v.getUint32(24, true);
}
