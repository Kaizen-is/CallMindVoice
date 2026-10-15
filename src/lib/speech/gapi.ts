/**
 * GAPI speech-to-text (console.gapi.uz) — the engine behind the logistics demo.
 *
 * One short utterance per request through the synchronous `/v1/transcribe`.
 * Everything GAPI does by default that a live turn does not need is switched
 * off: speaker recognition and enrolment (it would store every caller's
 * voiceprint), PII redaction, gender, call-outcome detection, diarization.
 * Numbers come back as digits (`itn`), which is what the tracking-number
 * lookup reads.
 *
 * GAPI does not clean noise or report it, so noisy audio goes through our
 * CleanVoice step (`./denoise`) first.
 */
import 'server-only';
import type { Locale } from '@/lib/types';
import { denoise } from './denoise';
import type { Transcript } from './stt';

const TIMEOUT_MS = 12_000;

const SETTINGS = {
  diarization: false,
  itn: true,
  formatting: true,
  pii: false,
  gender: false,
  call_outcome: false,
  speaker_identification: false,
  enroll: 'off',
  language_detection: true,
};

export function gapiConfigured(): boolean {
  return Boolean(gapiKey());
}

function gapiKey(): string {
  return (process.env.GAPI_API_KEY || process.env.GAPIAPI || '').trim();
}

interface GapiResult {
  text?: string;
  segments?: Array<{ text?: string }>;
  language?: { code?: string };
}

/**
 * Transcribe one utterance. Returns an empty transcript for silence and throws
 * on failure, like `transcribe` in `./stt`, so callers handle both the same way.
 */
export async function gapiTranscribe(
  audio: ArrayBuffer,
  opts: { language?: Locale; vocabulary?: readonly string[]; denoise?: boolean } = {},
): Promise<Transcript> {
  const key = gapiKey();
  if (!key) throw new Error('gapi_not_configured');
  const clean = opts.denoise ? await denoise(audio) : audio;

  const form = new FormData();
  form.append('file', new Blob([clean], { type: 'audio/wav' }), 'speech.wav');
  form.append('settings', JSON.stringify(SETTINGS));
  if (opts.vocabulary?.length) form.append('vocabulary', JSON.stringify(opts.vocabulary.slice(0, 20)));

  const base = (process.env.GAPI_BASE_URL || 'https://console.gapi.uz').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 240);
    console.warn(`[gapi] ${res.status}: ${body}`);
    throw new Error(`gapi_${res.status}`);
  }
  const data = (await res.json()) as GapiResult;
  const text = (data.text ?? data.segments?.map((s) => s.text ?? '').join(' ') ?? '').replace(/\s+/g, ' ').trim();
  return { text, engine: 'gapi', language: data.language?.code ?? opts.language ?? null };
}
