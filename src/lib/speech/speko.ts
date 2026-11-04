/**
 * Speko Router TTS (router.speko.dev) — ElevenLabs voices, one API key.
 *
 * Speko fronts many speech vendors behind one endpoint; we pin ElevenLabs
 * explicitly (`routing.mode: explicit`) so a request never silently fails over
 * to a vendor that cannot speak Uzbek. The audio comes back as raw 8 kHz mono
 * signed-16 PCM — exactly the telephone format the rest of `./tts` uses — so
 * nothing downstream needs to know which engine rendered it.
 *
 * Env: SPEKO_API_KEY (required), SPEKO_BASE_URL (default
 * https://router.speko.dev/v1), SPEKO_TTS_VOICE (an ElevenLabs voice id used
 * when a request names none of `ELEVEN_VOICES`; omitted ⇒ Nadya).
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Locale } from '@/lib/types';

/** The ElevenLabs models Speko routes. Both are multilingual; v3 lists Uzbek. */
export const SPEKO_TTS_MODELS = ['eleven_v3_conversational', 'eleven_v4_turbo'] as const;
export type SpekoTtsModel = (typeof SPEKO_TTS_MODELS)[number];

/**
 * The ElevenLabs voices offered in the Playground. Both are native Russian
 * voices — the accent Uzbek callers hear most. Measured on 3 Uzbek sentences
 * transcribed back by GAPI (`npm run bench:uz-tts -- --only nadya,miron`):
 * 0% WER for both on eleven_v4_turbo and eleven_v3_conversational, first audio
 * ~0.5–1.0 s once warm (the first request of a session can take ~3 s).
 * The first is the default.
 */
export const ELEVEN_VOICES = [
  { id: 'lZSeoYcz4phdvms888pn', name: 'Nadya', gender: 'female', note: 'Calm & meditative' },
  { id: 'VlXLedwkU4YDM3HBGpiI', name: 'Miron', gender: 'male', note: 'Charismatic storyteller' },
] as const;

/** `voiceId` when it is one of ours, else SPEKO_TTS_VOICE, else the first voice. */
export function elevenVoice(voiceId?: string | null): string {
  if (voiceId && ELEVEN_VOICES.some((v) => v.id === voiceId)) return voiceId;
  return process.env.SPEKO_TTS_VOICE?.trim() || ELEVEN_VOICES[0].id;
}

const SAMPLE_RATE = 8000;
const FIRST_PIECE_BYTES = 4000; // 0.25 s
const PIECE_BYTES = 8000; // 0.5 s

export function spekoConfigured(): boolean {
  return Boolean(spekoKey());
}

function spekoKey(): string {
  return (process.env.SPEKO_API_KEY || '').trim();
}

function spekoBase(): string {
  return (process.env.SPEKO_BASE_URL || 'https://router.speko.dev/v1').replace(/\/+$/, '');
}

export class SpekoError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Render `text` with one ElevenLabs model, yielding PCM pieces as they arrive.
 * Like `streamPcm` in `./tts`: the first piece goes out after a quarter second
 * of audio, then half-second pieces, never splitting a 16-bit sample.
 */
export async function* spekoStreamPcm(
  text: string,
  model: SpekoTtsModel,
  language: Locale,
  voice: string,
): AsyncGenerator<Buffer, void, unknown> {
  const key = spekoKey();
  if (!key) throw new SpekoError('speko_not_configured', 503);

  const res = await fetch(`${spekoBase()}/tts/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      routing: { mode: 'explicit', provider: 'elevenlabs', model },
      input: text,
      language,
      voice,
      audio: { encoding: 'pcm_s16le', sample_rate_hz: SAMPLE_RATE, channels: 1 },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 240);
    console.warn(`[speko] ${model} ${res.status}: ${body}`);
    throw new SpekoError(`speko_${res.status}`, res.status === 401 ? 503 : 502);
  }

  const reader = res.body.getReader();
  let held = Buffer.alloc(0);
  let first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    held = held.length ? Buffer.concat([held, Buffer.from(value)]) : Buffer.from(value);
    if (held.length >= (first ? FIRST_PIECE_BYTES : PIECE_BYTES)) {
      const whole = held.length - (held.length % 2);
      yield held.subarray(0, whole);
      held = held.subarray(whole);
      first = false;
    }
  }
  const whole = held.length - (held.length % 2);
  if (whole) yield held.subarray(0, whole);
}

/* ── speech-to-text ──────────────────────────────────────────── */

/**
 * Google Gemini Transcribe through Speko (`gemini-3.5-transcribe`, pinned like
 * the voices above). One finished utterance as 16 kHz mono 16-bit PCM. Measured
 * on Uzbek: accurate, numbers written as digits, but ~5 s per phrase — a model
 * to compare quality with, not the fastest for live calls.
 */
export const SPEKO_STT_MODEL = 'gemini-3.5-transcribe';

export async function spekoTranscribe(pcm16k: Buffer, language: Locale | undefined): Promise<string> {
  const key = spekoKey();
  if (!key) throw new SpekoError('speko_not_configured', 503);

  // Speko wants the parts in this order: the request, then the audio.
  const form = new FormData();
  const request = {
    routing: { mode: 'explicit', provider: 'gemini', model: SPEKO_STT_MODEL },
    language: language ?? 'uz',
    audio: { encoding: 'pcm_s16le', sample_rate_hz: 16000, channels: 1 },
  };
  form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(pcm16k)], { type: 'application/octet-stream' }), 'speech.pcm');

  const res = await fetch(`${spekoBase()}/stt/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': randomUUID() },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 240);
    console.warn(`[speko] ${SPEKO_STT_MODEL} ${res.status}: ${body}`);
    throw new SpekoError(`speko_${res.status}`, res.status === 401 ? 503 : 502);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
