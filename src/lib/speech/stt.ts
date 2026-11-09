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
 *
 * Two more engines can be asked for by name (`opts.engine`) — the Playground's
 * model picker uses this to compare them on the same microphone:
 *
 *   • **GAPI** (`GAPIAPI`) — hosted, one shot per utterance (see `./gapi`).
 *   • **Zipformer** (`local`) — the streaming Uzbek model that runs inside
 *     this server from `models/uzbek-zipformer/` (see `./zipformer`); it
 *     also streams words live to the Playground.
 *   • **gemini-3.5** (`gemini`, `SPEKO_API_KEY`) — Google Gemini Transcribe
 *     through Speko (see `./speko`).
 *   • **ElevenLabs Scribe** (`scribe`, `SPEKO_API_KEY`) — ElevenLabs Scribe v2
 *     through Speko, one shot per utterance.
 */
import 'server-only';
import { geminiTranscribe, hasGemini } from '@/lib/llm/gemini';
import type { Locale } from '@/lib/types';
import { recordUsage } from '@/lib/usage-log';
import { denoise } from './denoise';
import { gapiConfigured, gapiTranscribe } from './gapi';
import {
  SPEKO_GEMINI_ROUTE,
  SPEKO_SCRIBE_MODEL,
  SPEKO_SCRIBE_ROUTE,
  SPEKO_STT_MODEL,
  spekoConfigured,
  spekoTranscribe,
} from './speko';
import { decodeWav, transcribeWav, zipformerAvailable } from './zipformer';
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
  engine: 'kotib' | 'whisper' | 'gemini' | 'gapi' | 'local' | 'speko' | 'scribe' | 'none';
  language: string | null;
}

/** What a caller can ask for: `auto` is the Kotib/Whisper/Gemini logic below. */
export type SttEngine = 'auto' | 'gapi' | 'local' | 'gemini' | 'scribe';

export const STT_ENGINES: readonly SttEngine[] = ['auto', 'gapi', 'local', 'gemini', 'scribe'];

export function isSttEngine(value: unknown): value is SttEngine {
  return typeof value === 'string' && (STT_ENGINES as readonly string[]).includes(value);
}

const EMPTY: Transcript = { text: '', engine: 'none', language: null };

const TIMEOUT_MS = 20000;

/** Which engines this deployment can run, for the Playground's model picker. */
export function sttEngines(): Record<SttEngine, boolean> {
  return {
    auto: Boolean(process.env.STT_TRANSCRIBE_URL || process.env.WHISPER_TRANSCRIBE_URL),
    gapi: gapiConfigured(),
    local: zipformerAvailable(),
    gemini: spekoConfigured(),
    scribe: spekoConfigured(),
  };
}

export function sttConfigured(): boolean {
  return Object.values(sttEngines()).some(Boolean);
}

/* ── single engines, by name (the model lab) ─────────────────── */

/** Every engine on its own, as the usage log and the model lab name them. */
export type SttEngineId = 'kotib' | 'whisper' | 'gapi' | 'local' | 'speko' | 'gemini' | 'scribe';

/** Which single engines this deployment can run. */
export function sttEngineIds(): Record<SttEngineId, boolean> {
  return {
    kotib: Boolean(process.env.STT_TRANSCRIBE_URL),
    whisper: Boolean(process.env.WHISPER_TRANSCRIBE_URL),
    gapi: gapiConfigured(),
    local: zipformerAvailable(),
    speko: spekoConfigured(),
    gemini: hasGemini(),
    scribe: spekoConfigured(),
  };
}

/**
 * One engine, nothing else: no race, no fallback, no noise cleaning. Throws
 * when the engine fails, so a comparison can show the error. Numbers come back
 * as digits from every engine that spells them out, as on a live call.
 */
export async function transcribeOne(
  engine: SttEngineId,
  audio: ArrayBuffer,
  language?: Locale,
): Promise<Transcript> {
  if (!audio.byteLength) throw new SttError('empty_audio', 400);
  if (!sttEngineIds()[engine]) throw new SttError(`${engine}_not_configured`, 503);
  if (isSilent(audio)) return EMPTY;
  switch (engine) {
    case 'kotib': {
      const heard = await kotib(audio);
      return heard.text ? { ...heard, text: uzbekNumbersToDigits(heard.text) } : heard;
    }
    case 'whisper':
      return whisper(audio, language);
    case 'gapi':
      return gapiOne(audio, language);
    case 'local':
      return localZipformer(audio);
    case 'speko':
      return spekoGemini(audio, language);
    case 'scribe':
      return spekoScribe(audio, language);
    case 'gemini': {
      const heard = await gemini(audio, language ?? 'uz');
      if (!heard) throw new SttError('gemini_failed');
      return heard;
    }
  }
}

/* ── usage logging ───────────────────────────────────────────── */

/** Length of a 16-bit PCM WAV in ms, or null for anything else. */
function wavDurationMs(audio: ArrayBuffer): number | null {
  const view = new DataView(audio);
  const tag = (at: number) =>
    at + 4 <= view.byteLength ? String.fromCharCode(...new Uint8Array(audio, at, 4)) : '';
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12;
  let bytesPerSecond = 0;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && size >= 16) bytesPerSecond = view.getUint32(offset + 16, true);
    if (id === 'data') {
      const bytes = Math.min(size, view.byteLength - offset - 8);
      return bytesPerSecond ? (bytes / bytesPerSecond) * 1000 : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Run one engine and write its usage row (see `@/lib/usage-log`). */
async function logged(
  engine: SttEngineId,
  model: string | null,
  audio: ArrayBuffer,
  work: () => Promise<Transcript> | Transcript,
): Promise<Transcript> {
  const started = performance.now();
  const audioMs = wavDurationMs(audio);
  try {
    const heard = await work();
    recordUsage({ kind: 'stt', engine, model, ms: performance.now() - started, audioMs, ok: true });
    return heard;
  } catch (err) {
    recordUsage({
      kind: 'stt',
      engine,
      model,
      ms: performance.now() - started,
      audioMs,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** GAPI, numbers as digits; failures become SttError. */
function gapiOne(audio: ArrayBuffer, language?: Locale, clean = false): Promise<Transcript> {
  return logged('gapi', null, audio, async () => {
    try {
      const heard = await gapiTranscribe(audio, { language, denoise: clean });
      return heard.text ? { ...heard, text: uzbekNumbersToDigits(heard.text) } : EMPTY;
    } catch (err) {
      throw new SttError(err instanceof Error ? err.message : 'gapi_failed');
    }
  });
}

/* ── the two engines ─────────────────────────────────────────── */

function kotib(audio: ArrayBuffer): Promise<Transcript> {
  return logged('kotib', null, audio, () => kotibRequest(audio));
}

async function kotibRequest(audio: ArrayBuffer): Promise<Transcript> {
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

/** Zipformer, in this process; same contract as Kotib. */
function localZipformer(audio: ArrayBuffer): Promise<Transcript> {
  return logged('local', 'uzbek-zipformer', audio, () => {
    let text: string;
    try {
      text = transcribeWav(audio);
    } catch (err) {
      throw new SttError(`local: ${err instanceof Error ? err.message : 'failed'}`);
    }
    return text ? { text: uzbekNumbersToDigits(text), engine: 'local', language: 'uz' } : EMPTY;
  });
}

/** A WAV as 16 kHz mono 16-bit PCM — what Speko's Gemini model takes. */
function wavToPcm16k(audio: ArrayBuffer): Buffer {
  const { samples, sampleRate } = decodeWav(Buffer.from(audio));
  const ratio = sampleRate / 16000;
  const n = Math.floor(samples.length / ratio);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[Math.floor(i * ratio)]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

/** gemini-3.5 through Speko. */
function spekoGemini(audio: ArrayBuffer, language?: Locale): Promise<Transcript> {
  return logged('speko', SPEKO_STT_MODEL, audio, async () => {
    let text: string;
    try {
      text = await spekoTranscribe(wavToPcm16k(audio), language, SPEKO_GEMINI_ROUTE);
    } catch (err) {
      throw new SttError(`gemini-3.5: ${err instanceof Error ? err.message : 'failed'}`);
    }
    return text && !isHallucination(text) ? { text, engine: 'speko', language: language ?? 'uz' } : EMPTY;
  });
}

/** ElevenLabs Scribe through Speko; numbers as digits, like the other engines. */
function spekoScribe(audio: ArrayBuffer, language?: Locale): Promise<Transcript> {
  return logged('scribe', SPEKO_SCRIBE_MODEL, audio, async () => {
    let text: string;
    try {
      text = await spekoTranscribe(wavToPcm16k(audio), language, SPEKO_SCRIBE_ROUTE);
    } catch (err) {
      throw new SttError(`scribe: ${err instanceof Error ? err.message : 'failed'}`);
    }
    if (!text || isHallucination(text)) return EMPTY;
    return { text: uzbekNumbersToDigits(text), engine: 'scribe', language: language ?? 'uz' };
  });
}

/** Whisper; throws when the server answers with an error (callers in the race catch it). */
function whisper(audio: ArrayBuffer, language?: Locale): Promise<Transcript> {
  return logged('whisper', process.env.WHISPER_MODEL || 'whisper-large-v3-turbo', audio, () =>
    whisperRequest(audio, language),
  );
}

async function whisperRequest(audio: ArrayBuffer, language?: Locale): Promise<Transcript> {
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
    throw new SttError(`whisper ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
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
  const started = performance.now();
  const text = await geminiTranscribe(audio, LANGUAGE_NAME[language] ?? 'Russian');
  recordUsage({
    kind: 'stt',
    engine: 'gemini',
    model: process.env.GEMINI_STT_MODEL || null,
    ms: performance.now() - started,
    audioMs: wavDurationMs(audio),
    ok: text !== null,
    error: text === null ? 'gemini_failed' : null,
  });
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
  opts: {
    language?: Locale;
    /** Run the utterance through the noise cleaner first (see `./denoise`). */
    denoise?: boolean;
    /** Pin one engine instead of the automatic choice. */
    engine?: SttEngine;
  } = {},
): Promise<Transcript> {
  if (!audio.byteLength) throw new SttError('empty_audio', 400);

  if (opts.engine && opts.engine !== 'auto') {
    if (!sttEngines()[opts.engine]) throw new SttError(`${opts.engine}_not_configured`, 503);
    if (isSilent(audio)) return EMPTY;
    if (opts.engine === 'local') return localZipformer(opts.denoise ? await denoise(audio) : audio);
    if (opts.engine === 'gemini') return spekoGemini(opts.denoise ? await denoise(audio) : audio, opts.language);
    if (opts.engine === 'scribe') return spekoScribe(opts.denoise ? await denoise(audio) : audio, opts.language);
    return gapiOne(audio, opts.language, opts.denoise);
  }

  const hasKotib = Boolean(process.env.STT_TRANSCRIBE_URL);
  const hasWhisper = Boolean(process.env.WHISPER_TRANSCRIBE_URL);
  if (!hasKotib && !hasWhisper) throw new SttError('stt_not_configured', 503);

  if (isSilent(audio)) return EMPTY;
  if (opts.denoise) audio = await denoise(audio);

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
