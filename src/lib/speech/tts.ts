/**
 * The TTS layer — one place that knows how to turn text into telephone audio.
 *
 * Every voice in the product — demo, logistics, Playground, phone bridge, the
 * TTS lab, cloned and designed voices — is rendered here, through one endpoint:
 * the TTS server's `generate_v2/stream`, which takes the same voices as
 * generate_v2 and sends the audio as it is generated. On top of it:
 *
 *   1. **A disk cache.** Greetings, re-prompts and filler lines are the same
 *      bytes on every single call. Rendering them once removes a full TTS
 *      round-trip from the most latency-sensitive moment of the call — the
 *      first second, before the caller has heard anything at all.
 *
 *   2. **Streaming.** `synthesizeStream` splits the reply into sentences and
 *      hands each one on in pieces as the server produces them, so the caller
 *      hears the first words about a second after the text is ready, and each
 *      next sentence renders while the last one plays.
 *
 *   3. **Telephone-native output.** Everything is converted to 8 kHz mono
 *      signed-16 PCM here, so nothing downstream has to parse WAV containers or
 *      resample mid-call.
 */
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildTtsForm, resolveVoice, type ResolvedVoice } from '@/lib/voices';
import { normalizeForSpeech, splitForSpeech } from './normalize';
import type { Locale } from '@/lib/types';

/** Telephony is narrowband. Everything in the voice path is this format. */
export const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

const CACHE_DIR = path.join(process.cwd(), 'data', 'tts-cache');

export class TtsError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/* ── configuration ───────────────────────────────────────────── */

export function ttsConfigured(): boolean {
  return Boolean(
    process.env.TTS_BASE_URL && (process.env.TTS_CLIENT_SECRET || process.env.TTS_JWT_TOKEN),
  );
}

function baseUrl(): string {
  const base = process.env.TTS_BASE_URL;
  if (!base) throw new TtsError('tts_not_configured', 503);
  return base.replace(/\/+$/, '');
}

/* ── auth: mint and cache the service JWT ────────────────────── */

let tokenCache: { token: string; exp: number } | null = null;

async function ttsToken(): Promise<string> {
  const secret = process.env.TTS_CLIENT_SECRET;
  if (!secret) {
    const fixed = process.env.TTS_JWT_TOKEN?.trim();
    if (!fixed) throw new TtsError('tts_not_configured', 503);
    return fixed;
  }
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;

  const res = await fetch(`${baseUrl()}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.TTS_CLIENT_ID || 'frontend', client_secret: secret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[tts] auth ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    throw new TtsError('tts_auth_failed', 502);
  }
  const d = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh two minutes early so a token never expires mid-call.
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return tokenCache.token;
}

/* ── the one real network call ───────────────────────────────── */

/**
 * Render one piece of text whole, as 8 kHz mono PCM — the stream below,
 * collected. `text` must already be normalised (see `normalizeForSpeech`).
 */
async function renderPcm(text: string, voice: ResolvedVoice): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of streamPcm(text, voice)) parts.push(piece);
  if (!parts.length) throw new TtsError('tts_empty_audio', 502);
  return Buffer.concat(parts);
}

/* ── streaming render: generate_v2/stream ────────────────────── */

/**
 * `generate_v2/stream`: the same voices as generate_v2 (speaker, clone,
 * design), with the audio sent as it is generated — raw 8 kHz s16le
 * (`format=l16`) — so the first sound plays in about a second instead of
 * after the whole sentence renders. It is the only TTS endpoint used.
 */
/** The first piece goes out as soon as there is a little audio; then half-second pieces. */
const FIRST_PIECE_BYTES = 4000; // 0.25 s
const PIECE_BYTES = 8000; // 0.5 s

async function* streamPcm(text: string, voice: ResolvedVoice): AsyncGenerator<Buffer, void, unknown> {
  const token = await ttsToken();
  const form = buildTtsForm({ userId: 'stream', text, voice });
  // The stream keeps no file to download, so it needs no user_id or phone.
  form.delete('user_id');
  form.delete('phone');
  form.set('format', 'l16');
  // Smaller pieces start sooner; the server's default is 2 s.
  if (process.env.TTS_STREAM_CHUNK_SEC) form.set('chunk_sec', process.env.TTS_STREAM_CHUNK_SEC);

  const res = await fetch(`${baseUrl()}/api/v1/tts/generate_v2/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok || !res.body) {
    console.warn(`[tts] stream ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    throw new TtsError('tts_stream_failed', 502);
  }

  // A stream cut short mid-way makes the read throw (the chunked body never
  // ends properly), so reaching `done` means the audio is complete.
  const reader = res.body.getReader();
  let held = Buffer.alloc(0);
  let first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    held = held.length ? Buffer.concat([held, Buffer.from(value)]) : Buffer.from(value);
    if (held.length >= (first ? FIRST_PIECE_BYTES : PIECE_BYTES)) {
      const whole = held.length - (held.length % 2); // never split a 16-bit sample
      yield held.subarray(0, whole);
      held = held.subarray(whole);
      first = false;
    }
  }
  const whole = held.length - (held.length % 2);
  if (whole) yield held.subarray(0, whole);
}

/* ── the disk cache ──────────────────────────────────────────── */

/**
 * Cache key: the exact text plus the exact voice. A clone voice is keyed by its
 * reference sample path *and* that file's mtime, so replacing the sample
 * invalidates every line rendered from the old one.
 */
function cacheKey(text: string, voice: ResolvedVoice): string {
  const h = createHash('sha1');
  h.update(text);
  h.update(' ');
  if (voice.kind === 'speaker') h.update(`speaker:${voice.speaker}`);
  else if (voice.kind === 'design') h.update(`design:${voice.design}`);
  else {
    let stamp = '';
    try {
      stamp = String(fs.statSync(voice.refAudioPath).mtimeMs);
    } catch {
      /* a missing sample falls through to a stable key; the render will fail loudly */
    }
    h.update(`clone:${voice.refAudioPath}:${stamp}:${voice.refText}`);
  }
  return h.digest('hex');
}

function cacheRead(key: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(CACHE_DIR, `${key}.pcm`));
  } catch {
    return null;
  }
}

function cacheWrite(key: string, pcm: Buffer): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = path.join(CACHE_DIR, `${key}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, pcm);
    fs.renameSync(tmp, path.join(CACHE_DIR, `${key}.pcm`));
  } catch (err) {
    console.warn('[tts] cache write failed:', err instanceof Error ? err.message : err);
  }
}

/* ── public API ──────────────────────────────────────────────── */

export interface SynthOptions {
  tenantId: string;
  voiceId?: string | null;
  language?: Locale;
  /** Short label used to build the upstream user_id; helps server-side tracing. */
  tag?: string;
  /**
   * Cache the result on disk. Correct for fixed lines (greeting, re-prompt,
   * fillers) and for individual sentences that recur across calls; harmless but
   * pointless for one-off text.
   */
  cache?: boolean;
}

/** Render `text` to 8 kHz mono PCM, consulting the disk cache when asked. */
export async function synthesizePcm(text: string, opts: SynthOptions): Promise<Buffer> {
  const spoken = normalizeForSpeech(text, opts.language ?? 'uz');
  if (!spoken) throw new TtsError('empty_text', 400);
  const voice = resolveVoice(opts.tenantId, opts.voiceId);

  if (opts.cache) {
    const key = cacheKey(spoken, voice);
    const hit = cacheRead(key);
    if (hit) return hit;
    const pcm = await renderPcm(spoken, voice);
    cacheWrite(key, pcm);
    return pcm;
  }
  return renderPcm(spoken, voice);
}

/** The disk-cached rendering of `text`, or null. Never renders. */
export function cachedPcm(text: string, opts: SynthOptions): Buffer | null {
  const spoken = normalizeForSpeech(text, opts.language ?? 'uz');
  if (!spoken) return null;
  return cacheRead(cacheKey(spoken, resolveVoice(opts.tenantId, opts.voiceId)));
}

/** Render `text` and return a complete WAV — for the browser playground. */
export async function synthesizeWav(text: string, opts: SynthOptions): Promise<Buffer> {
  return pcmToWav(await synthesizePcm(text, opts));
}

/**
 * Render `text` as a stream of PCM pieces, in reading order: sentence by
 * sentence, each handed on as the server produces it. Callers should start
 * playing the first piece immediately; that is the whole point. Cached
 * sentences come straight from disk; a streamed one is cached once complete
 * (a stream cut short throws instead of finishing, so a partial line is never
 * cached).
 */
export async function* synthesizeStream(
  text: string,
  opts: SynthOptions,
): AsyncGenerator<Buffer, void, unknown> {
  const spoken = normalizeForSpeech(text, opts.language ?? 'uz');
  if (!spoken) return;
  const voice = resolveVoice(opts.tenantId, opts.voiceId);

  for (const chunk of splitForSpeech(spoken)) {
    const key = opts.cache ? cacheKey(chunk, voice) : null;
    const hit = key ? cacheRead(key) : null;
    if (hit) {
      yield hit;
      continue;
    }
    const parts: Buffer[] = [];
    for await (const piece of streamPcm(chunk, voice)) {
      parts.push(piece);
      yield piece;
    }
    if (key && parts.length) cacheWrite(key, Buffer.concat(parts));
  }
}

/* ── container helpers ───────────────────────────────────────── */

/** Wrap raw 8 kHz mono 16-bit PCM in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Decode any WAV the TTS service returns to 8 kHz mono 16-bit PCM. It normally
 * returns exactly that already, but the fmt chunk is parsed defensively so a
 * server-side voice change can never make the line sound chipmunked.
 */
export function wavToPcm8k(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf; // not a WAV — assume it is already raw slin
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (chunkId === 'fmt ' && body.length >= 16) {
      fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (chunkId === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
    if (fmt && data) break;
  }
  if (!data) return Buffer.alloc(0);
  if (!fmt || fmt.bits !== 16) return data;

  let pcm = data;
  if (fmt.channels === 2) pcm = downmixStereo16(pcm);
  if (fmt.sampleRate !== SAMPLE_RATE) pcm = resample16(pcm, fmt.sampleRate, SAMPLE_RATE);
  return pcm;
}

function downmixStereo16(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    out.writeInt16LE((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  }
  return out;
}

/** Linear-interpolation resample of 16-bit mono PCM. */
function resample16(pcm: Buffer, srcRate: number, dstRate: number): Buffer {
  const srcSamples = Math.floor(pcm.length / 2);
  if (srcSamples < 2) return pcm;
  const dstSamples = Math.max(1, Math.floor((srcSamples * dstRate) / srcRate));
  const out = Buffer.allocUnsafe(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const pos = (i * srcRate) / dstRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, srcSamples - 1);
    const frac = pos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}
