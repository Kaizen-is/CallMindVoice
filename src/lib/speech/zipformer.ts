/**
 * Zipformer — the streaming Uzbek STT model, running inside this server.
 *
 * The sherpa-onnx transducer from huggingface.co/Bahrom1996/uzbek-streaming-stt-punct
 * (Apache-2.0) ships with the repo in `models/uzbek-zipformer/` (~70 MB of
 * int8 ONNX), so there is no extra service to deploy: the model loads on first
 * use and decodes on the CPU at roughly 25× real time.
 *
 * Two ways in:
 *   • `transcribeWav` — one finished utterance (16-bit PCM WAV), the same
 *     contract as the other engines in `./stt`.
 *   • live sessions (`feedLive`, `finishLive`, `resetLive`) — the Playground
 *     posts its microphone in quarter-second pieces while the caller speaks
 *     and gets the growing transcript back, so the words are ready the moment
 *     they stop. Ordinary HTTP requests: no WebSocket, nothing for the proxy.
 *
 * The model writes lowercase Latin Uzbek with . , ? — sentence capitals are
 * added here. Env (optional): ZIPFORMER_MODEL_DIR overrides the model folder,
 * ZIPFORMER_THREADS (default 2).
 */
import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

export const ZIPFORMER_RATE = 16000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Recognizer = any;
type Stream = any;

interface ModelFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

function modelDir(): string {
  // A fixed sub-folder, so the build traces only the model, not the whole project.
  const override = process.env.ZIPFORMER_MODEL_DIR;
  if (override) return path.resolve(/* turbopackIgnore: true */ override);
  return path.join(process.cwd(), 'models', 'uzbek-zipformer');
}

/** encoder/decoder/joiner, preferring the int8 builds (the CPU ones). */
function findModel(dir: string): ModelFiles | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const pick = (part: string) =>
    files.find((f) => f.startsWith(part) && f.endsWith('.int8.onnx')) ??
    files.find((f) => f.startsWith(part) && f.endsWith('.onnx'));
  const encoder = pick('encoder');
  const decoder = pick('decoder');
  const joiner = pick('joiner');
  if (!encoder || !decoder || !joiner || !files.includes('tokens.txt')) return null;
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    joiner: path.join(dir, joiner),
    tokens: path.join(dir, 'tokens.txt'),
  };
}

/* One recognizer per process, kept across dev-server reloads. */
const state = ((globalThis as Record<string, unknown>).__callmindZipformer ??= {}) as {
  recognizer?: Recognizer | null;
  failed?: string;
  sessions?: Map<string, LiveSession>;
};

/** Whether the model files are present; cheap, for the model picker. */
export function zipformerAvailable(): boolean {
  if (state.failed) return false;
  return findModel(modelDir()) !== null;
}

function recognizer(): Recognizer {
  if (state.recognizer) return state.recognizer;
  if (state.failed) throw new Error(state.failed);
  const files = findModel(modelDir());
  if (!files) {
    state.failed = `zipformer model not found in ${modelDir()}`;
    throw new Error(state.failed);
  }
  try {
    // A native addon, listed in serverExternalPackages: required here, on first
    // use, so a server without its binary (e.g. Alpine) only loses Zipformer.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sherpa = require('sherpa-onnx-node');
    const started = Date.now();
    state.recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: ZIPFORMER_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
        tokens: files.tokens,
        numThreads: Number(process.env.ZIPFORMER_THREADS || 2),
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      // Endpoints split a long monologue into sentences on a live session.
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });
    console.log(`[zipformer] model loaded in ${Date.now() - started} ms`);
    return state.recognizer;
  } catch (err) {
    state.failed = `zipformer failed to load: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[zipformer] ${state.failed}`);
    throw new Error(state.failed);
  }
}

/** The model writes lowercase; give each sentence its capital. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[.?!]\s+)(\p{Ll})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

function drain(rec: Recognizer, stream: Stream) {
  while (rec.isReady(stream)) rec.decode(stream);
}

/** Half a second of silence lets the last word clear the model's look-ahead. */
const tail = () => new Float32Array(ZIPFORMER_RATE / 2);

/* ── one-shot ────────────────────────────────────────────────── */

/** 16-bit PCM WAV → mono float32 samples. Throws on anything else. */
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  const tag = (at: number) => buf.toString('ascii', at, at + 4);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not_wav');
  let offset = 12;
  let channels = 1;
  let sampleRate = ZIPFORMER_RATE;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = tag(offset);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('wav_not_16bit');
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        out[i] = sum / channels / 32768;
      }
      return { samples: out, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('wav_no_data');
}

/** Transcribe one finished utterance. */
export function transcribeWav(audio: ArrayBuffer | Buffer): string {
  const rec = recognizer();
  const { samples, sampleRate } = decodeWav(Buffer.isBuffer(audio) ? audio : Buffer.from(audio));
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  stream.acceptWaveform({ samples: new Float32Array(Math.round(sampleRate / 2)), sampleRate });
  stream.inputFinished();
  drain(rec, stream);
  return tidy(rec.getResult(stream).text);
}

/* ── live sessions ───────────────────────────────────────────── */

interface LiveSession {
  owner: string;
  stream: Stream;
  /** Sentences already closed by an endpoint (a pause). */
  finals: string;
  seen: number;
}

/** A session nobody has fed for this long belongs to a closed tab. */
const SESSION_IDLE_MS = 2 * 60_000;
const MAX_SESSIONS = 200;

const sessions = (state.sessions ??= new Map<string, LiveSession>());

function sweep() {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) if (s.seen < cutoff) sessions.delete(id);
}

function session(owner: string, id: string): LiveSession {
  let s = sessions.get(id);
  if (s && s.owner !== owner) throw new Error('session_owner');
  if (!s) {
    sweep();
    if (sessions.size >= MAX_SESSIONS) throw new Error('too_many_sessions');
    s = { owner, stream: recognizer().createStream(), finals: '', seen: Date.now() };
    sessions.set(id, s);
  }
  s.seen = Date.now();
  return s;
}

const joined = (a: string, b: string) => `${a} ${b}`.trim();

/** 16-bit little-endian PCM at 16 kHz → float32. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Add a piece of live audio; returns the whole utterance heard so far. */
export function feedLive(owner: string, id: string, samples: Float32Array): string {
  const rec = recognizer();
  const s = session(owner, id);
  if (samples.length) {
    s.stream.acceptWaveform({ samples, sampleRate: ZIPFORMER_RATE });
    drain(rec, s.stream);
  }
  const current = tidy(rec.getResult(s.stream).text);
  if (rec.isEndpoint(s.stream)) {
    s.finals = joined(s.finals, current);
    rec.reset(s.stream);
    return s.finals;
  }
  return joined(s.finals, current);
}

/** The phrase ended: decode the last few hundred ms, return it all, start fresh. */
export function finishLive(owner: string, id: string, samples?: Float32Array): string {
  const rec = recognizer();
  const s = session(owner, id);
  if (samples?.length) s.stream.acceptWaveform({ samples, sampleRate: ZIPFORMER_RATE });
  s.stream.acceptWaveform({ samples: tail(), sampleRate: ZIPFORMER_RATE });
  drain(rec, s.stream);
  const text = joined(s.finals, tidy(rec.getResult(s.stream).text));
  sessions.set(id, { owner, stream: rec.createStream(), finals: '', seen: Date.now() });
  return text;
}

/** Forget what was heard (the agent started speaking). */
export function resetLive(owner: string, id: string) {
  const s = sessions.get(id);
  if (!s || s.owner !== owner) return;
  sessions.set(id, { owner, stream: recognizer().createStream(), finals: '', seen: Date.now() });
}

/** The tab closed or the call ended. */
export function closeLive(owner: string, id: string) {
  const s = sessions.get(id);
  if (s && s.owner === owner) sessions.delete(id);
}
