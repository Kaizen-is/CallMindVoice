/**
 * The STT layer — one place that knows how to turn caller audio into text.
 *
 * Two engines, chosen per call rather than per deployment:
 *
 *   • **Kotib** (`STT_TRANSCRIBE_URL`) — the internal Uzbek model. Far better
 *     than anything general-purpose on Uzbek, and the reason this product can
 *     exist at all. It knows only Uzbek.
 *   • **Whisper turbo** (`WHISPER_TRANSCRIBE_URL`) — OpenAI-compatible
 *     `/audio/transcriptions`. Covers Russian, English and everything else.
 *
 * The interesting case is a caller who code-switches, which in Uzbekistan is
 * the *normal* case, not an edge case. For an Uzbek-primary agent both engines
 * are run **concurrently on the same audio** and the better transcript wins.
 * Because they run in parallel, using two engines costs no more wall-clock than
 * using the slower one alone — the caller waits for max(a, b), never a + b.
 *
 * Without Whisper, **Gemini** (`GEMINI_API_KEY`) covers the non-Uzbek side
 * instead, and stands in for Kotib if the internal model is unreachable.
 */
import 'server-only';
import { geminiTranscribe, hasGemini } from '@/lib/llm/gemini';
import type { Locale } from '@/lib/types';
import { uzbekNumbersToDigits } from './numbers';

export class SttError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface Transcript {
  text: string;
  /** Which engine produced this text — surfaced in logs to debug bad turns. */
  engine: 'kotib' | 'whisper' | 'gemini' | 'none';
  language: string | null;
}

const EMPTY: Transcript = { text: '', engine: 'none', language: null };

const TIMEOUT_MS = 20000;

export function sttConfigured(): boolean {
  return Boolean(process.env.STT_TRANSCRIBE_URL || process.env.WHISPER_TRANSCRIBE_URL);
}

/* ── the two engines ─────────────────────────────────────────── */

async function kotib(audio: ArrayBuffer): Promise<Transcript> {
  const url = process.env.STT_TRANSCRIBE_URL;
  if (!url) return EMPTY;

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');

  const res = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Thrown rather than returned as EMPTY, so "Kotib is down" can be told apart
  // from "the caller said nothing".
  if (!res.ok) {
    throw new SttError(`kotib ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  }
  const data = (await res.json()) as { text?: string; language?: string };
  const text = (data.text ?? '').trim();
  return text ? { text, engine: 'kotib', language: data.language ?? 'uz' } : EMPTY;
}

async function whisper(audio: ArrayBuffer, language?: Locale): Promise<Transcript> {
  const url = process.env.WHISPER_TRANSCRIBE_URL;
  if (!url) return EMPTY;

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', process.env.WHISPER_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // Pinning the language is worth ~100 ms and stops short utterances being
  // mis-detected. Omitted for Uzbek-primary agents, where the caller may switch.
  if (language && language !== 'uz') form.append('language', language);

  const key = process.env.WHISPER_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    console.warn(`[stt] whisper ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return EMPTY;
  }
  const data = (await res.json()) as { text?: string; language?: string };
  const text = (data.text ?? '').trim();
  return text ? { text, engine: 'whisper', language: data.language ?? language ?? null } : EMPTY;
}

const LANGUAGE_NAME: Record<Locale, string> = {
  uz: 'Uzbek (Latin script)',
  ru: 'Russian',
  en: 'English',
};

/** Gemini's transcript; EMPTY when it heard no speech, null when it failed. */
async function gemini(audio: ArrayBuffer, language: Locale): Promise<Transcript | null> {
  const text = await geminiTranscribe(audio, LANGUAGE_NAME[language] ?? 'Russian');
  if (text === null) return null;
  return text && !isHallucination(text) ? { text, engine: 'gemini', language } : EMPTY;
}

/**
 * True for a WAV whose samples are all (near) zero: a muted or dead input.
 * There are no words in it, but a model asked to transcribe it may invent
 * some — Gemini answers digital silence with "Здравствуйте". Anything that is
 * not a 16-bit WAV is passed through to the engines untouched.
 */
function isSilent(audio: ArrayBuffer): boolean {
  const view = new DataView(audio);
  const tag = (at: number) =>
    at + 4 <= view.byteLength ? String.fromCharCode(...new Uint8Array(audio, at, 4)) : '';
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return false;

  let offset = 12;
  let bits = 0;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) bits = view.getUint16(body + 14, true);
    if (id === 'data') {
      if (bits !== 16) return false;
      const end = Math.min(view.byteLength, body + size) - 1;
      for (let i = body; i < end; i += 2) if (Math.abs(view.getInt16(i, true)) > 64) return false;
      return true;
    }
    offset = body + size + (size % 2);
  }
  return false;
}

/* ── choosing between two transcripts ────────────────────────── */

/**
 * Whisper hallucinates fixed phrases on silence or noise ("Thank you.",
 * "Субтитры сделал DimaTorzok", …). A transcript that is only one of these is
 * worse than no transcript at all — it would send the turn engine chasing a
 * question the caller never asked.
 */
const HALLUCINATIONS = [
  'thank you',
  'thanks for watching',
  'you',
  'bye',
  'субтитры',
  'продолжение следует',
  'спасибо за просмотр',
];

function isHallucination(text: string): boolean {
  const t = text.toLowerCase().replace(/[.!?…]/g, '').trim();
  return t.length <= 30 && HALLUCINATIONS.some((h) => t === h || t.startsWith(h));
}

/** Fraction of letters that belong to the Uzbek Latin alphabet's extras. */
function uzbekness(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return 0;
  const markers = text.match(/[oʻgʻʼ']|\b(va|bilan|uchun|qanday|nechta|bor|yoq|kerak|soat)\b/giu)?.length ?? 0;
  return markers / letters;
}

/**
 * Pick the transcript to act on. Both engines are trusted on their home turf;
 * the tie-breaks only matter for the mixed-language middle ground.
 */
function pick(a: Transcript, b: Transcript, primary: Locale): Transcript {
  const good = [a, b].filter((t) => t.text && !isHallucination(t.text));
  if (good.length === 0) return EMPTY;
  if (good.length === 1) return good[0];

  const [kot, whi] = good[0].engine === 'kotib' ? [good[0], good[1]] : [good[1], good[0]];

  // A non-Uzbek agent has no reason to prefer the Uzbek-only model.
  if (primary !== 'uz') return whi;

  // Whisper reporting a non-Uzbek language it is confident about (and that
  // reads like it) means the caller genuinely switched — take Whisper.
  if (whi.language && whi.language !== 'uz' && uzbekness(whi.text) < 0.02) return whi;

  // A near-empty result from either side is usually a truncated decode; prefer
  // whichever heard more of the utterance.
  if (kot.text.length < whi.text.length * 0.5) return whi;
  return kot;
}

/* ── public entry point ──────────────────────────────────────── */

/**
 * Transcribe one complete utterance. Never throws on a single engine failing —
 * only when nothing is configured, or when every configured engine errored.
 */
export async function transcribe(
  audio: ArrayBuffer,
  opts: { language?: Locale } = {},
): Promise<Transcript> {
  if (!audio.byteLength) throw new SttError('empty_audio', 400);
  const hasKotib = Boolean(process.env.STT_TRANSCRIBE_URL);
  const hasWhisper = Boolean(process.env.WHISPER_TRANSCRIBE_URL);
  if (!hasKotib && !hasWhisper) throw new SttError('stt_not_configured', 503);

  if (isSilent(audio)) return EMPTY;

  const primary = opts.language ?? 'uz';
  const geminiEar = !hasWhisper && hasGemini();

  // With no Whisper, Kotib would be the only ear — and it knows only Uzbek:
  // Russian comes back as Latin transliteration with the numbers garbled
  // ("ya tysyach to'qson to'qson…"). Gemini hears it properly. Kotib's version
  // stays the fallback for when Gemini fails, not for when it heard nothing.
  if (geminiEar && primary !== 'uz') {
    const heard = await gemini(audio, primary);
    if (heard) return heard;
  }

  // Kotib only earns its round-trip on an Uzbek-primary agent (or when it is
  // the only engine there is). Whisper runs whenever it is configured — in the
  // racing case it costs nothing, since both requests are in flight together.
  const useKotib = hasKotib && (primary === 'uz' || !hasWhisper);
  const useWhisper = hasWhisper;

  let kotibDown = false;
  const [k, w] = await Promise.all([
    useKotib
      ? kotib(audio).catch((err: unknown) => {
          kotibDown = true;
          return sttFailed('kotib')(err);
        })
      : Promise.resolve(EMPTY),
    useWhisper ? whisper(audio, primary).catch(sttFailed('whisper')) : Promise.resolve(EMPTY),
  ]);

  const picked = pick(k, w, primary);
  // Kotib unreachable on an Uzbek turn: Gemini is slower and less exact on
  // Uzbek, but a caller who is heard late beats one who is not heard at all.
  if (!picked.text && kotibDown && geminiEar) return (await gemini(audio, primary)) ?? EMPTY;
  // Kotib spells numbers out; the model compares a year of birth reliably
  // only as digits. Done after `pick`, which weighs transcripts by length.
  return picked.engine === 'kotib' ? { ...picked, text: uzbekNumbersToDigits(picked.text) } : picked;
}

function sttFailed(engine: string) {
  return (err: unknown): Transcript => {
    console.warn(`[stt] ${engine} failed:`, err instanceof Error ? err.message : err);
    return EMPTY;
  };
}
