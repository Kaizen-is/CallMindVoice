// Reference behaviour of the ORIGINAL TypeScript BRB Whisper client (src/lib/speech/brb-stt.ts and
// its engine in stt.ts) for the Python parity tests:
//   - codec: the protobuf it writes (metadata and inference requests, byte for byte) and how it
//     reads metadata and inference responses;
//   - calls: whole `transcribe(audio, {engine: 'brb'})` runs against a fake Triton (gRPC over
//     HTTP/2 without TLS on 127.0.0.1): the requests the server received, the result or error,
//     and the usage rows.
// Usage: node make-golden-brb-stt.cjs <output.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');
const http2 = require('http2');

const OUT = path.join(__dirname, 'out');

const usage = [];
const stubs = {
  'server-only': {},
  '@/lib/db': { all: () => [], get: () => undefined, run: () => ({ changes: 0 }), now: () => new Date().toISOString(), id: (p) => `${p}_x`, UPLOAD_DIR: '/nonexistent' },
  '@/lib/usage-log': { recordUsage: (e) => usage.push({ ...e }), withUsageSource: (_s, _t, fn) => fn() },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) {
  require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
}
function fresh(rel) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(OUT)) delete require.cache[k];
  return require(path.join(OUT, rel));
}
const ENV_KEYS = ['BRB_STT_URL', 'BRB_STT_MODEL', 'STT_TRANSCRIBE_URL', 'WHISPER_TRANSCRIBE_URL', 'GAPIAPI', 'GAPI_API_KEY', 'SPEKO_API_KEY', 'GEMINI_API_KEY', 'DENOISE_URL', 'ZIPFORMER_MODEL_DIR'];

/* ── protobuf for the fake server's answers (independent of the code under test) ── */
function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}
const field = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);
const str = (num, s) => (s ? field(num, Buffer.from(s, 'utf8')) : Buffer.alloc(0));
const packed = (num, values) => (values.length ? field(num, Buffer.concat(values.map(varint))) : Buffer.alloc(0));
const unpacked = (num, values) => Buffer.concat(values.map((v) => Buffer.concat([varint(num << 3), varint(v)])));
const tensor = (t) => Buffer.concat([str(1, t.name), str(2, t.datatype), (t.unpacked ? unpacked : packed)(3, t.shape)]);
function metadataResponse(m) {
  return Buffer.concat([
    str(1, m.name ?? 'stt'),
    ...(m.versions ?? ['1']).map((v) => str(2, v)),
    str(3, m.platform ?? 'ensemble'),
    ...m.inputs.map((t) => field(4, tensor(t))),
    ...m.outputs.map((t) => field(5, tensor(t))),
  ]);
}
const element = (s) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
};
/** outputs: [{name, datatype, shape, contents?: [string]}]; raw: [Buffer] (raw_output_contents). */
function inferResponse({ outputs, raw = [], model = 'stt' }) {
  return Buffer.concat([
    str(1, model),
    str(2, '1'),
    // a parameters map entry (4) the reader must skip
    field(4, Buffer.concat([str(1, 'sequence_id'), field(2, Buffer.concat([varint((2 << 3) | 0), varint(7)]))])),
    ...outputs.map((o) =>
      field(5, Buffer.concat([str(1, o.name), str(2, o.datatype), packed(3, o.shape), o.contents ? field(5, Buffer.concat(o.contents.map((c) => field(8, Buffer.from(c, 'utf8'))))) : Buffer.alloc(0)])),
    ),
    ...raw.map((r) => field(6, r)),
  ]);
}
const b64 = (buf) => Buffer.from(buf).toString('base64');

/* ── audio ── */
function wav({ rate = 16000, channels = 1, samples }) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const speech = (n, rate = 16000, channels = 1) =>
  wav({ rate, channels, samples: Array.from({ length: n * channels }, (_, i) => Math.round(Math.sin(i / 5) * 12000 + ((i * 7919) % 400) - 200)) });
const AUDIO = {
  speech16k: speech(3200),
  speech8kStereo: speech(1600, 8000, 2),
  silent: wav({ samples: Array.from({ length: 2000 }, (_, i) => (i % 5) * 10 - 20) }),
  notWav: Buffer.from('OggS not a wav at all'),
};
// 16 kHz mono PCM for the codec cases (what stt.ts hands the client).
const PCM = Buffer.alloc(1200);
for (let i = 0; i < 600; i++) PCM.writeInt16LE(Math.round(Math.cos(i / 3) * 20000) - (i % 7) * 900, i * 2);

/* ── model layouts ── */
const TRITON_WHISPER = {
  inputs: [{ name: 'TEXT_PREFIX', datatype: 'BYTES', shape: [-1, 1] }, { name: 'WAV', datatype: 'FP32', shape: [-1, -1] }, { name: 'WAV_LENS', datatype: 'INT32', shape: [-1, 1] }],
  outputs: [{ name: 'TRANSCRIPTS', datatype: 'BYTES', shape: [-1, 1] }],
};
const WAV_BYTES = { inputs: [{ name: 'audio', datatype: 'BYTES', shape: [1] }], outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }] };
const FILE_AND_LANGUAGE = {
  inputs: [{ name: 'language', datatype: 'BYTES', shape: [1], unpacked: true }, { name: 'audio_file', datatype: 'UINT8', shape: [-1] }, { name: 'num_samples', datatype: 'INT64', shape: [] }],
  outputs: [{ name: 'scores', datatype: 'FP32', shape: [-1] }, { name: 'transcript', datatype: 'BYTES', shape: [1] }],
};
const WAVEFORM_ONLY = { inputs: [{ name: 'waveform', datatype: 'FP32', shape: [-1] }, { name: 'task_prompt', datatype: 'BYTES', shape: [] }], outputs: [{ name: 'out', datatype: 'BYTES', shape: [1] }] };
const MEL = { inputs: [{ name: 'mel', datatype: 'FP32', shape: [1, 80, 3000] }], outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }] };
const FIXED_BATCH = { inputs: [{ name: 'WAV', datatype: 'FP32', shape: [4, -1] }], outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }] };
const FP16 = { inputs: [{ name: 'WAV', datatype: 'FP16', shape: [-1] }], outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }] };
const NO_TEXT = { inputs: [{ name: 'WAV', datatype: 'FP32', shape: [-1] }], outputs: [{ name: 'logits', datatype: 'FP32', shape: [-1] }] };
const strip = (m) => ({ inputs: m.inputs.map(({ unpacked: _u, ...t }) => t), outputs: m.outputs.map(({ unpacked: _u, ...t }) => t) });

/* ── the fake Triton ── */
let serverScript = [];
const received = [];
const server = http2.createServer();
server.on('stream', (stream, headers) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => {
    const body = Buffer.concat(chunks);
    received.push({ path: headers[':path'], contentType: headers['content-type'], te: headers.te, body: b64(body.subarray(5, 5 + body.readUInt32BE(1))) });
    const step = serverScript.shift() ?? { status: 12, message: 'unscripted' };
    if (step.status) {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(step.status), 'grpc-message': encodeURIComponent(step.message) }, { endStream: true });
      return;
    }
    const msg = Buffer.from(step.body, 'base64');
    const frame = Buffer.alloc(5 + msg.length);
    frame.writeUInt32BE(msg.length, 1);
    msg.copy(frame, 5);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(frame);
  });
});

const ok = (buf) => ({ status: 0, body: b64(buf) });
const text = (layout, s, viaContents = false) => {
  const outputs = layout.outputs.map((o) => ({ ...o, contents: viaContents && o.datatype === 'BYTES' ? [s] : undefined }));
  const raw = viaContents ? [] : layout.outputs.map((o) => (o.datatype === 'BYTES' ? element(s) : Buffer.alloc(8)));
  return ok(inferResponse({ outputs, raw }));
};

(async () => {
  console.warn = () => {};
  const out = { audio: {}, pcm: b64(PCM), codec: { metadataRequests: [], metadata: [], infer: [], transcripts: [], clean: [] }, calls: [] };
  for (const [k, v] of Object.entries(AUDIO)) out.audio[k] = b64(v);

  /* codec */
  const codec = fresh('lib/speech/brb-stt.js');
  for (const model of ['stt', 'whisper_uz', '']) out.codec.metadataRequests.push({ model, bytes: b64(codec.encodeMetadataRequest(model)) });
  for (const layout of [TRITON_WHISPER, WAV_BYTES, FILE_AND_LANGUAGE, WAVEFORM_ONLY, MEL]) {
    const bytes = metadataResponse(layout);
    out.codec.metadata.push({ bytes: b64(bytes), decoded: codec.decodeMetadata(bytes) });
  }
  const layouts = { TRITON_WHISPER, WAV_BYTES, FILE_AND_LANGUAGE, WAVEFORM_ONLY, MEL, FIXED_BATCH, FP16, NO_TEXT };
  for (const [name, layout] of Object.entries(layouts)) {
    for (const language of ['uz', 'ru', 'en', null]) {
      let bytes = null;
      let error = null;
      try {
        bytes = b64(codec.encodeInferRequest('stt', strip(layout), PCM, language ?? undefined));
      } catch (err) {
        error = err.message;
      }
      out.codec.infer.push({ layout: name, meta: strip(layout), language, bytes, error });
    }
  }
  const responses = [
    text(TRITON_WHISPER, '<|startoftranscript|><|uz|><|transcribe|><|notimestamps|> Assalomu alaykum, kredit haqida<|endoftext|>'),
    text(WAV_BYTES, '  Добрый   день\n', true),
    text(FILE_AND_LANGUAGE, 'ikki yuz ellik ming so‘m'),
    ok(inferResponse({ outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }], raw: [Buffer.from([1, 0])] })),
    ok(inferResponse({ outputs: [{ name: 'text', datatype: 'BYTES', shape: [1] }], raw: [Buffer.alloc(0)] })),
    ok(inferResponse({ outputs: [{ name: 'text', datatype: 'BYTES', shape: [1], contents: [] }] })),
    ok(inferResponse({ outputs: [{ name: 'logits', datatype: 'FP32', shape: [2] }], raw: [Buffer.alloc(8)] })),
    ok(inferResponse({ outputs: [{ name: 'a', datatype: 'BYTES', shape: [2] }], raw: [Buffer.concat([element('<|uz|>birinchi'), element('ikkinchi')])] })),
    { status: 0, body: b64(Buffer.from([0x2a, 0x05, 0x01])) },
  ];
  for (const r of responses) {
    let decoded = null;
    let error = null;
    try {
      decoded = codec.decodeTranscript(Buffer.from(r.body, 'base64'));
    } catch (err) {
      error = err.message;
    }
    out.codec.transcripts.push({ bytes: r.body, text: decoded, error });
  }
  for (const s of ['<|uz|>Salom<|0.00|>  dunyo ', ' x y﻿', '<|a|b|> c', 'no markers', '<||>']) out.codec.clean.push({ in: s, out: codec.cleanTranscript(s) });

  /* calls against the fake Triton */
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const FAKE = `http://127.0.0.1:${server.address().port}`;
  const CALLS = [
    { name: 'triton_whisper_uz', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb', language: 'uz' },
      server: [ok(metadataResponse(TRITON_WHISPER)), text(TRITON_WHISPER, '<|startoftranscript|><|uz|><|transcribe|><|notimestamps|> Kredit foizi qancha?<|endoftext|>')] },
    { name: 'wav_bytes_ru_8k_stereo_model_env', env: { BRB_STT_URL: 'FAKE', BRB_STT_MODEL: ' whisper_ru ' }, audio: 'speech8kStereo', opts: { engine: 'brb', language: 'ru' },
      server: [ok(metadataResponse({ ...WAV_BYTES, name: 'whisper_ru' })), text(WAV_BYTES, '  Сколько стоит кредит? ', true)] },
    { name: 'file_and_language_words_to_digits', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb' },
      server: [ok(metadataResponse(FILE_AND_LANGUAGE)), text(FILE_AND_LANGUAGE, 'ikki yuz ellik ming so‘m')] },
    { name: 'hallucination_is_nothing', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb', language: 'ru' },
      server: [ok(metadataResponse(WAVEFORM_ONLY)), text(WAVEFORM_ONLY, '<|ru|> Субтитры сделал DimaTorzok<|endoftext|>')] },
    { name: 'empty_text', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb', denoise: false },
      server: [ok(metadataResponse(WAVEFORM_ONLY)), text(WAVEFORM_ONLY, '<|endoftext|>')] },
    { name: 'mel_input_refused', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb' }, server: [ok(metadataResponse(MEL))] },
    { name: 'model_not_found', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb' },
      server: [{ status: 5, message: "Request for unknown model: 'stt' is not found" }] },
    { name: 'infer_fails', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb', language: 'uz' },
      server: [ok(metadataResponse(TRITON_WHISPER)), { status: 13, message: 'CUDA out of memory (50% used)' }] },
    { name: 'deadline_status', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb' }, server: [{ status: 4, message: 'Deadline Exceeded' }] },
    { name: 'no_text_output', env: { BRB_STT_URL: 'FAKE' }, audio: 'speech16k', opts: { engine: 'brb' },
      server: [ok(metadataResponse(NO_TEXT)), ok(inferResponse({ outputs: NO_TEXT.outputs, raw: [Buffer.alloc(8)] }))] },
    { name: 'silent_skips_the_call', env: { BRB_STT_URL: 'FAKE' }, audio: 'silent', opts: { engine: 'brb' }, server: [] },
    { name: 'not_a_wav', env: { BRB_STT_URL: 'FAKE' }, audio: 'notWav', opts: { engine: 'brb' }, server: [] },
    { name: 'not_configured', env: {}, audio: 'speech16k', opts: { engine: 'brb' }, server: [] },
  ];
  for (const sc of CALLS) {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.ZIPFORMER_MODEL_DIR = path.join(__dirname, 'no-model');
    for (const [k, v] of Object.entries(sc.env)) process.env[k] = v === 'FAKE' ? FAKE : v;
    serverScript = JSON.parse(JSON.stringify(sc.server));
    received.length = 0;
    usage.length = 0;
    const stt = fresh('lib/speech/stt.js');
    let result = null;
    let error = null;
    try {
      const buf = AUDIO[sc.audio];
      result = await stt.transcribe(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), sc.opts);
    } catch (err) {
      error = { message: err.message, status: err.status };
    }
    require(path.join(OUT, 'lib/speech/brb-stt.js')).brbSttClose();
    out.calls.push({
      ...sc,
      received: JSON.parse(JSON.stringify(received)),
      result,
      error,
      usage: usage.map(({ ms, ...rest }) => rest),
      leftover: serverScript.length,
    });
  }
  server.close();

  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log(`codec infer ${out.codec.infer.length}, transcripts ${out.codec.transcripts.length}, calls ${out.calls.length}`);
  for (const c of out.calls) console.log(c.name.padEnd(36), 'reqs', c.received.length, 'left', c.leftover, JSON.stringify(c.error ?? c.result));
  process.exit(0);
})();
