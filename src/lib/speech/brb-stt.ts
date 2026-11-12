/**
 * BRB Whisper — our own speech-to-text model: Whisper served by Triton at
 * `BRB_STT_URL` (https://stt-service.brb.uz, port 443, through the BRB VPN),
 * model `BRB_STT_MODEL` (default `stt`).
 *
 * Triton speaks the KServe v2 inference protocol over gRPC (HTTP/2 + TLS, no
 * login). Two calls, made with Node's own http2 and a minimal protobuf codec
 * for just their messages:
 *
 *   ModelMetadata {name}               → the model's input and output tensors
 *   ModelInfer {name, inputs, raw data} → the transcript
 *
 * Which tensors the model takes is not documented, so it is read from
 * ModelMetadata (once per process; read again after a failed call) and each
 * input is filled by its type:
 *
 *   FP32 [-1] or [1,-1]   the utterance as 16 kHz mono samples in [-1, 1)
 *   INT32 / INT64         its length in samples
 *   BYTES named language  the language code ("uz")
 *   BYTES named like a prompt (prefix, prompt, task, text)
 *                         Whisper's task prefix, <|startoftranscript|><|uz|><|transcribe|><|notimestamps|>
 *   BYTES / UINT8 otherwise
 *                         the utterance as a 16 kHz mono 16-bit WAV file
 *
 * Anything else is refused as `brb_stt_input_<name>_<type>`, so a model that
 * wants something else (log-mel features, say) says so instead of hearing
 * noise. The first BYTES output is the text, with Whisper's <|…|> markers removed.
 *
 * `http://` in BRB_STT_URL talks gRPC without TLS (local test servers only).
 */
import 'server-only';
import http2 from 'node:http2';
import type { Locale } from '@/lib/types';

const CONNECT_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 20000;
/** The model's tensors are read again after this long, in case it was redeployed. */
const META_TTL_MS = 10 * 60_000;
const SERVICE = '/inference.GRPCInferenceService';

export class BrbSttError extends Error {}

function url(): string {
  return (process.env.BRB_STT_URL || '').trim();
}

export function brbSttConfigured(): boolean {
  return Boolean(url());
}

export function brbSttModel(): string {
  return (process.env.BRB_STT_MODEL || '').trim() || 'stt';
}

/** `https://host[:port]` (the default when no scheme is given) or `http://host:port`. */
function origin(): string {
  const raw = url();
  const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  return `${parsed.protocol}//${parsed.host}`;
}

/* ── protobuf, just enough ───────────────────────────────────── */

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 127) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

class Writer {
  private parts: Buffer[] = [];
  bytes(field: number, value: Buffer): this {
    this.parts.push(varint((field << 3) | 2), varint(value.length), value);
    return this;
  }
  /** proto3 leaves an empty string out. */
  string(field: number, value: string): this {
    return value ? this.bytes(field, Buffer.from(value, 'utf8')) : this;
  }
  packed(field: number, values: number[]): this {
    return values.length ? this.bytes(field, Buffer.concat(values.map(varint))) : this;
  }
  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.at >= this.buf.length;
  }
  varint(): bigint {
    let value = BigInt(0);
    let shift = BigInt(0);
    for (;;) {
      if (this.at >= this.buf.length) throw new BrbSttError('brb_stt_bad_message');
      const byte = this.buf[this.at++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
      shift += BigInt(7);
    }
  }
  tag(): { field: number; wire: number } {
    const key = Number(this.varint());
    return { field: key >>> 3, wire: key & 7 };
  }
  bytes(): Buffer {
    const len = Number(this.varint());
    if (this.at + len > this.buf.length) throw new BrbSttError('brb_stt_bad_message');
    const out = this.buf.subarray(this.at, this.at + len);
    this.at += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.at += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.at += 4;
    else throw new BrbSttError('brb_stt_bad_message');
  }
}

/** A repeated int64, packed or not. */
function readInt64s(r: Reader, wire: number, into: number[]): void {
  if (wire === 2) {
    const inner = new Reader(r.bytes());
    while (!inner.done) into.push(Number(BigInt.asIntN(64, inner.varint())));
  } else into.push(Number(BigInt.asIntN(64, r.varint())));
}

export interface Tensor {
  name: string;
  datatype: string;
  shape: number[];
}

export interface ModelMeta {
  inputs: Tensor[];
  outputs: Tensor[];
}

export function encodeMetadataRequest(model: string): Buffer {
  return new Writer().string(1, model).finish();
}

function readTensor(buf: Buffer): Tensor {
  const r = new Reader(buf);
  const t: Tensor = { name: '', datatype: '', shape: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) t.name = r.bytes().toString('utf8');
    else if (field === 2 && wire === 2) t.datatype = r.bytes().toString('utf8');
    else if (field === 3 && (wire === 0 || wire === 2)) readInt64s(r, wire, t.shape);
    else r.skip(wire);
  }
  return t;
}

/** ModelMetadataResponse: inputs (4) and outputs (5). */
export function decodeMetadata(buf: Buffer): ModelMeta {
  const r = new Reader(buf);
  const meta: ModelMeta = { inputs: [], outputs: [] };
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 4 && wire === 2) meta.inputs.push(readTensor(r.bytes()));
    else if (field === 5 && wire === 2) meta.outputs.push(readTensor(r.bytes()));
    else r.skip(wire);
  }
  return meta;
}

/* ── what goes into each input ───────────────────────────────── */

const LANGUAGE_INPUT = /^lang(uage)?$/i;
const PROMPT_INPUT = /prefix|prompt|task|text/i;

export function whisperPrefix(language?: Locale): string {
  return `<|startoftranscript|><|${language ?? 'uz'}|><|transcribe|><|notimestamps|>`;
}

/** 16 kHz mono 16-bit PCM in a 44-byte WAV header. */
function wavFile(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** BYTES tensor contents: each element as a 4-byte little-endian length, then the bytes. */
function bytesElement(value: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(value.length, 0);
  return Buffer.concat([len, value]);
}

/**
 * The shape to send for `t` holding `count` values along its last dimension:
 * the last dimension is `count`, every other one 1 (a batch of one). A fixed
 * dimension that does not fit is refused.
 */
function shapeFor(t: Tensor, count: number): number[] {
  if (!t.shape.length) {
    if (count === 1) return [];
    throw new BrbSttError(`brb_stt_input_${t.name}_${t.datatype}`);
  }
  return t.shape.map((d, i) => {
    const want = i === t.shape.length - 1 ? count : 1;
    if (d === -1 || d === want) return want;
    throw new BrbSttError(`brb_stt_input_${t.name}_${t.datatype}`);
  });
}

function fill(t: Tensor, pcm: Buffer, language?: Locale): { shape: number[]; raw: Buffer } {
  const n = Math.floor(pcm.length / 2);
  switch (t.datatype) {
    case 'FP32': {
      const raw = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) raw.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4);
      return { shape: shapeFor(t, n), raw };
    }
    case 'INT32': {
      const raw = Buffer.alloc(4);
      raw.writeInt32LE(n, 0);
      return { shape: shapeFor(t, 1), raw };
    }
    case 'INT64': {
      const raw = Buffer.alloc(8);
      raw.writeBigInt64LE(BigInt(n), 0);
      return { shape: shapeFor(t, 1), raw };
    }
    case 'BYTES': {
      const value = LANGUAGE_INPUT.test(t.name)
        ? Buffer.from(language ?? 'uz', 'utf8')
        : PROMPT_INPUT.test(t.name)
          ? Buffer.from(whisperPrefix(language), 'utf8')
          : wavFile(pcm);
      return { shape: shapeFor(t, 1), raw: bytesElement(value) };
    }
    case 'UINT8': {
      const raw = wavFile(pcm);
      return { shape: shapeFor(t, raw.length), raw };
    }
    default:
      throw new BrbSttError(`brb_stt_input_${t.name}_${t.datatype}`);
  }
}

/**
 * ModelInferRequest for the utterance (`pcm`: 16 kHz mono 16-bit): the model
 * name (1), one tensor per model input (5) and their data, in the same order,
 * as raw_input_contents (7). No outputs are named, so all of them come back.
 */
export function encodeInferRequest(model: string, meta: ModelMeta, pcm: Buffer, language?: Locale): Buffer {
  const w = new Writer().string(1, model);
  const raws: Buffer[] = [];
  for (const t of meta.inputs) {
    const { shape, raw } = fill(t, pcm, language);
    w.bytes(5, new Writer().string(1, t.name).string(2, t.datatype).packed(3, shape).finish());
    raws.push(raw);
  }
  for (const raw of raws) w.bytes(7, raw);
  return w.finish();
}

/** Whisper's text without its <|…|> markers. */
export function cleanTranscript(text: string): string {
  return text.replace(/<\|[^|>]*\|>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ModelInferResponse → the first BYTES output's first element, cleaned. */
export function decodeTranscript(buf: Buffer): string {
  const r = new Reader(buf);
  const outputs: Array<{ datatype: string; contents: Buffer[] }> = [];
  const raws: Buffer[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 5 && wire === 2) {
      const o = new Reader(r.bytes());
      const out = { datatype: '', contents: [] as Buffer[] };
      while (!o.done) {
        const tag = o.tag();
        if (tag.field === 2 && tag.wire === 2) out.datatype = o.bytes().toString('utf8');
        else if (tag.field === 5 && tag.wire === 2) {
          // InferTensorContents: bytes_contents (8)
          const c = new Reader(o.bytes());
          while (!c.done) {
            const ct = c.tag();
            if (ct.field === 8 && ct.wire === 2) out.contents.push(c.bytes());
            else c.skip(ct.wire);
          }
        } else o.skip(tag.wire);
      }
      outputs.push(out);
    } else if (field === 6 && wire === 2) raws.push(r.bytes());
    else r.skip(wire);
  }
  const at = outputs.findIndex((o) => o.datatype === 'BYTES');
  if (at < 0) throw new BrbSttError('brb_stt_no_text_output');
  const raw = raws[at];
  if (raw) {
    if (raw.length < 4) return '';
    const len = raw.readUInt32LE(0);
    return cleanTranscript(raw.subarray(4, 4 + len).toString('utf8'));
  }
  return cleanTranscript(outputs[at].contents[0]?.toString('utf8') ?? '');
}

/* ── gRPC over HTTP/2 ────────────────────────────────────────── */

let session: http2.ClientHttp2Session | null = null;
let sessionOrigin = '';

function connect(target: string): Promise<http2.ClientHttp2Session> {
  if (session && sessionOrigin === target && !session.closed && !session.destroyed) return Promise.resolve(session);
  return new Promise((resolve, reject) => {
    const s = http2.connect(target);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      s.destroy();
      reject(new BrbSttError('brb_stt_connect_timeout'));
    }, CONNECT_TIMEOUT_MS);
    const forget = () => {
      if (session === s) session = null;
    };
    s.on('error', (err) => {
      forget();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BrbSttError(`brb_stt_unreachable: ${err.message}`));
    });
    s.on('close', forget);
    s.on('goaway', forget);
    s.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // An idle connection is closed after a minute; the next call opens a new one.
      s.setTimeout(60_000, () => s.close());
      s.unref();
      session = s;
      sessionOrigin = target;
      resolve(s);
    });
  });
}

/** Close the connection (tests, shutdown). */
export function brbSttClose(): void {
  session?.close();
  session = null;
}

function rpcError(status: string | undefined, detail: string): BrbSttError {
  if (status === '14') return new BrbSttError(`brb_stt_unreachable: ${detail}`);
  if (status === '4') return new BrbSttError('brb_stt_timeout');
  return new BrbSttError(`brb_stt_grpc_${status ?? 'none'}${detail ? `: ${detail}` : ''}`);
}

async function unary(method: 'ModelMetadata' | 'ModelInfer', message: Buffer): Promise<Buffer> {
  const s = await connect(origin());
  return new Promise((resolve, reject) => {
    const req = s.request({
      ':method': 'POST',
      ':path': `${SERVICE}/${method}`,
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const chunks: Buffer[] = [];
    let httpStatus = 0;
    let status: string | undefined;
    let detail = '';
    let done = false;
    const finish = (err: BrbSttError | null, value?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      finish(new BrbSttError('brb_stt_timeout'));
    }, READ_TIMEOUT_MS);
    const readStatus = (headers: http2.IncomingHttpHeaders) => {
      if (headers['grpc-status'] === undefined) return;
      status = String(headers['grpc-status']);
      try {
        detail = decodeURIComponent(String(headers['grpc-message'] ?? ''));
      } catch {
        detail = String(headers['grpc-message'] ?? '');
      }
    };
    req.on('response', (headers) => {
      httpStatus = Number(headers[':status']);
      readStatus(headers);
    });
    req.on('trailers', readStatus);
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', (err) => finish(new BrbSttError(`brb_stt_unreachable: ${err.message}`)));
    req.on('end', () => {
      if (httpStatus !== 200) return finish(new BrbSttError(`brb_stt_http_${httpStatus}`));
      if (status !== '0') return finish(rpcError(status, detail));
      const body = Buffer.concat(chunks);
      // One length-prefixed, uncompressed message.
      if (body.length < 5 || body[0] !== 0 || body.length < 5 + body.readUInt32BE(1)) {
        return finish(new BrbSttError('brb_stt_bad_frame'));
      }
      finish(null, body.subarray(5, 5 + body.readUInt32BE(1)));
    });
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1);
    message.copy(frame, 5);
    req.end(frame);
  });
}

/* ── the call ────────────────────────────────────────────────── */

let meta: { key: string; at: number; value: ModelMeta } | null = null;

async function metadata(model: string): Promise<ModelMeta> {
  const key = `${origin()}|${model}`;
  if (meta && meta.key === key && Date.now() - meta.at < META_TTL_MS) return meta.value;
  const value = decodeMetadata(await unary('ModelMetadata', encodeMetadataRequest(model)));
  meta = { key, at: Date.now(), value };
  return value;
}

/**
 * Transcribe one utterance (`pcm`: 16 kHz mono 16-bit). Resolves to the text
 * ('' when nothing was said); throws BrbSttError when the service fails.
 */
export async function brbTranscribe(pcm: Buffer, language?: Locale): Promise<string> {
  if (!brbSttConfigured()) throw new BrbSttError('brb_stt_not_configured');
  const model = brbSttModel();
  try {
    const m = await metadata(model);
    return decodeTranscript(await unary('ModelInfer', encodeInferRequest(model, m, pcm, language)));
  } catch (err) {
    meta = null; // a redeployed model may take other inputs: read them again next time
    throw err instanceof BrbSttError ? err : new BrbSttError(err instanceof Error ? err.message : String(err));
  }
}
