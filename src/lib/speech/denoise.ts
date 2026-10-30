/**
 * Noise cleaning in front of STT — the internal CleanVoice service
 * (`DENOISE_URL`).
 *
 * `POST /process` measures the utterance's SNR first and only runs the
 * DPDFNet-2 cleaner when it is below the threshold, so clean audio costs just
 * the measurement. It answers with a 16-bit mono WAV at the input's sample
 * rate, which the STT engines take as-is.
 *
 * Cleaning is a nicety, never a dependency: unset, unreachable, slow or
 * erroring, the original audio goes to STT unchanged.
 */
import 'server-only';

/** SNR (dB) at or above which the service leaves the audio untouched. */
const THRESHOLD_DB = 30;
/** Cap on how far noise is pushed down, so speech keeps a natural floor. */
const ATTN_LIMIT_DB = 40;
/** ~0.8 s for a 12 s utterance; a caller should never wait on a stuck cleaner. */
const TIMEOUT_MS = 3000;

export function denoiseConfigured(): boolean {
  return Boolean(process.env.DENOISE_URL);
}

/** The cleaned utterance, or `audio` itself whenever cleaning is not possible. */
export async function denoise(audio: ArrayBuffer): Promise<ArrayBuffer> {
  const base = process.env.DENOISE_URL;
  if (!base) return audio;

  const url = new URL('/process', base);
  url.searchParams.set('threshold_db', String(THRESHOLD_DB));
  url.searchParams.set('model', 'auto');
  url.searchParams.set('attn_limit_db', String(ATTN_LIMIT_DB));

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');

  try {
    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[denoise] ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
      return audio;
    }
    const cleaned = await res.arrayBuffer();
    if (!cleaned.byteLength) return audio;
    if (res.headers.get('x-cleaned') === 'true') {
      console.info(
        `[denoise] cleaned: snr ${res.headers.get('x-snr-db')} dB, ${res.headers.get('x-processing-ms')} ms`,
      );
    }
    return cleaned;
  } catch (err) {
    console.warn('[denoise] unavailable, using original audio:', err instanceof Error ? err.message : err);
    return audio;
  }
}
