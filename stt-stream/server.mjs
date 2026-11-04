/**
 * Local streaming Uzbek STT — the sherpa-onnx transducer from
 * huggingface.co/Bahrom1996/uzbek-streaming-stt-punct, served two ways:
 *
 *   • WS  /stream      — the Playground streams mic audio (16 kHz mono float32
 *                        frames) and gets the transcript back word by word:
 *                        {"type":"partial","text":…} while speech goes on,
 *                        {"type":"final","text":…} at each endpoint (a pause).
 *   • POST /transcribe — one finished utterance (16-bit PCM WAV) → {"text":…},
 *                        the same contract as Kotib, so `src/lib/speech/stt.ts`
 *                        treats it as just another engine.
 *   • GET  /health     — {"ok":true,"model":…}
 *
 * The model is ~70 MB of int8 ONNX and runs on the CPU at ~25× real time, so
 * one process serves the console comfortably. It writes lowercase Latin Uzbek
 * with . , ? punctuation; sentence capitals are added here.
 *
 * Env: STT_STREAM_PORT (8095), STT_STREAM_HOST (127.0.0.1),
 *      STT_STREAM_MODEL_DIR (./model), STT_STREAM_THREADS (2),
 *      STT_STREAM_ORIGINS (comma list; default http://localhost:3000).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STT_STREAM_PORT || 8095);
const HOST = process.env.STT_STREAM_HOST || '127.0.0.1';
const MODEL_DIR = path.resolve(here, process.env.STT_STREAM_MODEL_DIR || 'model');
const THREADS = Number(process.env.STT_STREAM_THREADS || 2);
const ORIGINS = new Set(
  (process.env.STT_STREAM_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const SAMPLE_RATE = 16000;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

const log = (...args) => console.log(new Date().toISOString(), '[stt-stream]', ...args);

/* ── model ───────────────────────────────────────────────────── */

/** Find encoder/decoder/joiner, preferring the int8 builds (the CPU ones). */
function findModel(dir) {
  if (!fs.existsSync(dir)) throw new Error(`model directory not found: ${dir}`);
  const files = fs.readdirSync(dir);
  const pick = (part) =>
    files.find((f) => f.startsWith(part) && f.endsWith('.int8.onnx')) ??
    files.find((f) => f.startsWith(part) && f.endsWith('.onnx'));
  const encoder = pick('encoder');
  const decoder = pick('decoder');
  const joiner = pick('joiner');
  if (!encoder || !decoder || !joiner || !files.includes('tokens.txt')) {
    throw new Error(`expected encoder/decoder/joiner *.onnx and tokens.txt in ${dir}`);
  }
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    joiner: path.join(dir, joiner),
    tokens: path.join(dir, 'tokens.txt'),
    name: encoder.replace(/^encoder-|\.int8\.onnx$|\.onnx$/g, ''),
  };
}

const model = findModel(MODEL_DIR);
const started = Date.now();
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
    tokens: model.tokens,
    numThreads: THREADS,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
  // Endpoints split a long monologue into sentences on the live stream.
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 0.8,
  rule3MinUtteranceLength: 20,
});
log(`model ${model.name} loaded in ${Date.now() - started} ms (${THREADS} threads)`);

/** The model writes lowercase; give each sentence its capital. */
function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[.?!]\s+)(\p{Ll})/gu, (_, lead, ch) => lead + ch.toUpperCase());
}

function drain(stream) {
  while (recognizer.isReady(stream)) recognizer.decode(stream);
}

/** Decode one complete utterance. */
function transcribeSamples(samples, sampleRate) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  // Trailing silence lets the last word clear the model's look-ahead.
  stream.acceptWaveform({ samples: new Float32Array(Math.round(sampleRate * 0.5)), sampleRate });
  stream.inputFinished();
  drain(stream);
  return tidy(recognizer.getResult(stream).text);
}

/* ── WAV ─────────────────────────────────────────────────────── */

/** 16-bit PCM WAV → mono float32 samples. Throws on anything else. */
function decodeWav(buf) {
  const tag = (at) => buf.toString('ascii', at, at + 4);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not_wav');
  let offset = 12;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
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

/* ── HTTP ────────────────────────────────────────────────────── */

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The WAV from a raw body or the `file` part of a multipart upload. */
function extractWav(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundary) return body;
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  let at = body.indexOf(marker);
  while (at !== -1) {
    const next = body.indexOf(marker, at + marker.length);
    if (next === -1) break;
    const part = body.subarray(at + marker.length, next);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1 && /name="file"/i.test(part.subarray(0, split).toString('utf8'))) {
      return part.subarray(split + 4, part.length - 2); // drop the CRLF before the next marker
    }
    at = next;
  }
  throw new Error('no_file_part');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, model: model.name });
  }
  if (req.method !== 'POST' || req.url !== '/transcribe') return send(res, 404, { error: 'not_found' });

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD_BYTES) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    try {
      const wav = extractWav(Buffer.concat(chunks), req.headers['content-type']);
      const { samples, sampleRate } = decodeWav(wav);
      const t0 = performance.now();
      const text = transcribeSamples(samples, sampleRate);
      log(`transcribe ${(samples.length / sampleRate).toFixed(1)}s → ${Math.round(performance.now() - t0)} ms`);
      send(res, 200, { text, language: 'uz' });
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : 'bad_audio' });
    }
  });
});

/* ── WebSocket streaming ─────────────────────────────────────── */

const wss = new WebSocketServer({
  server,
  path: '/stream',
  // Browsers always send Origin; only the console may open a stream.
  verifyClient: ({ origin }) => !origin || ORIGINS.has(origin),
});

wss.on('connection', (ws) => {
  let stream = recognizer.createStream();
  let last = '';

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // {"type":"reset"} starts a fresh utterance; {"type":"flush"} finishes this one.
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === 'flush') {
        stream.acceptWaveform({ samples: new Float32Array(SAMPLE_RATE / 2), sampleRate: SAMPLE_RATE });
        drain(stream);
        const text = tidy(recognizer.getResult(stream).text);
        if (text) ws.send(JSON.stringify({ type: 'final', text }));
      }
      if (msg.type === 'reset' || msg.type === 'flush') {
        stream = recognizer.createStream();
        last = '';
      }
      return;
    }

    const bytes = data instanceof Buffer ? data : Buffer.from(data);
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
    stream.acceptWaveform({ samples: Float32Array.from(samples), sampleRate: SAMPLE_RATE });
    drain(stream);

    const text = tidy(recognizer.getResult(stream).text);
    if (recognizer.isEndpoint(stream)) {
      if (text) ws.send(JSON.stringify({ type: 'final', text }));
      recognizer.reset(stream);
      last = '';
    } else if (text !== last) {
      last = text;
      ws.send(JSON.stringify({ type: 'partial', text }));
    }
  });
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (ws /stream, POST /transcribe)`);
  log(`allowed origins: ${[...ORIGINS].join(', ')}`);
});
