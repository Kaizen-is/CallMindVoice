/**
 * The last moments of microphone sound, always kept (Q10): a phrase's recorder starts only once the
 * voice detector hears speech, so its first syllable used to be lost. The page prepends this to the
 * recording, and the recording's own silence trim drops whatever was only quiet.
 *
 * Plain class (no Web Audio): `tests/web/preroll.test.mjs` runs it directly.
 */
export class PreRoll {
  private frames: Float32Array[] = [];
  private total = 0;
  private readonly keep: number;

  /** `keepSamples`: how much sound to hold (e.g. 0.4 s × the context's sample rate). */
  constructor(keepSamples: number) {
    this.keep = Math.max(0, Math.floor(keepSamples));
  }

  push(frame: Float32Array): void {
    if (!frame.length || !this.keep) return;
    this.frames.push(frame);
    this.total += frame.length;
    // Drop whole old frames while what is left still covers `keep`.
    while (this.frames.length > 1 && this.total - this.frames[0].length >= this.keep) {
      this.total -= this.frames.shift()!.length;
    }
  }

  /** The newest `keep` samples (fewer right after the microphone opened), oldest first. */
  snapshot(): Float32Array {
    const length = Math.min(this.keep, this.total);
    const out = new Float32Array(length);
    let at = length;
    for (let i = this.frames.length - 1; i >= 0 && at > 0; i--) {
      const frame = this.frames[i];
      const take = Math.min(frame.length, at);
      out.set(frame.subarray(frame.length - take), at - take);
      at -= take;
    }
    return out;
  }

  clear(): void {
    this.frames = [];
    this.total = 0;
  }
}
