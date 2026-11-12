// Reference behaviour of the ORIGINAL TypeScript speech layer (src/lib/speech/tts.ts, speko.ts,
// stt.ts, gapi.ts, denoise.ts, voices.ts, gemini transcribe) for the Python parity tests:
// TTS disk-cache keys and mtime stamps, TTS requests and how the audio is cut into pieces, STT
// requests, engine choice and transcripts, and usage rows. Also the Playground's
// `nextSegment` (a closure in playground-voice.ts, copied verbatim below).
// Usage: node make-golden-speech.cjs <output.json> <tmpdir>
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'out');
const TMP = process.argv[3];
fs.mkdirSync(TMP, { recursive: true });

const usage = [];
let dbRows = {};
const stubs = {
  'server-only': {},
  '@/lib/db': {
    all: (sql) => (sql.includes('custom_voices') ? dbRows.custom ?? [] : []),
    get: (sql, tenant, id) => (sql.includes('custom_voices') ? (dbRows.custom ?? []).find((r) => r.id === id) : undefined),
    run: () => ({ changes: 0 }),
    now: () => new Date().toISOString(),
    id: (p) => `${p}_x`,
    UPLOAD_DIR: path.join(TMP, 'uploads'),
  },
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

// Expose the private cache key.
const ttsJs = path.join(OUT, 'lib/speech/tts.js');
const ttsSrc = fs.readFileSync(ttsJs, 'utf8');
if (!ttsSrc.includes('exports.__cacheKey')) fs.writeFileSync(ttsJs, `${ttsSrc}\nexports.__cacheKey = cacheKey;\n`);

/* ── fetch recorder (same as make-golden-llm.cjs) ── */
let fetchScript = [];
const requests = [];
async function bodyOf(body) {
  if (body == null) return null;
  if (typeof body === 'string') return { text: body };
  if (body instanceof FormData) {
    const parts = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') parts.push([name, value]);
      else {
        const bytes = Buffer.from(await value.arrayBuffer());
        parts.push([name, { filename: value.name, type: value.type, sha1: crypto.createHash('sha1').update(bytes).digest('hex'), size: bytes.length }]);
      }
    }
    return { form: parts };
  }
  return { other: String(body) };
}
function headerObj(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  delete out['idempotency-key'];
  return out;
}
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', headers: headerObj(init.headers), body: await bodyOf(init.body) });
  const next = fetchScript.shift();
  if (!next) throw new Error('no scripted response');
  if (next.error) throw new Error(next.error);
  const chunks = next.chunks ?? (next.body !== undefined ? [next.body] : []);
  let at = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (at < chunks.length) {
        const c = chunks[at++];
        controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : Buffer.from(c.b64, 'base64'));
      } else if (next.breakAfter) controller.error(new Error('connection reset'));
      else controller.close();
    },
  });
  return new Response(stream, { status: next.status ?? 200, statusText: next.statusText ?? '', headers: next.headers ?? {} });
};

function fresh(rel) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(OUT)) delete require.cache[k];
  return require(path.join(OUT, rel));
}
const ENV_KEYS = [
  'TTS_BASE_URL', 'TTS_CLIENT_ID', 'TTS_CLIENT_SECRET', 'TTS_JWT_TOKEN', 'TTS_STREAM_CHUNK_SEC', 'SPEKO_API_KEY', 'SPEKO_BASE_URL', 'SPEKO_TTS_VOICE',
  'STT_TRANSCRIBE_URL', 'WHISPER_TRANSCRIBE_URL', 'WHISPER_MODEL', 'WHISPER_API_KEY', 'GAPI_API_KEY', 'GAPIAPI', 'GAPI_BASE_URL', 'DENOISE_URL',
  'GEMINI_API_KEY', 'GEMINI_STT_MODEL', 'ZIPFORMER_MODEL_DIR', 'BRB_SPEECH_URL', 'BRB_SPEECH_LOGIN', 'BRB_SPEECH_PASSWORD',
];
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.c2ln`;
const BRB_ENV = { BRB_SPEECH_URL: ' https://brb.example/ ', BRB_SPEECH_LOGIN: ' callmind ', BRB_SPEECH_PASSWORD: 'p@ss w0rd' };
const tokenPair = (n, exp = 4102444800) => ({ body: JSON.stringify({ access_token: jwt({ sub: 'u1', type: 'access', exp, n }), refresh_token: `refresh-${n}`, token_type: 'bearer' }) });
function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  // Zipformer stays out of these runs (no model here).
  process.env.ZIPFORMER_MODEL_DIR = path.join(TMP, 'no-model');
  Object.assign(process.env, env);
}
function reset(sc) {
  fetchScript = JSON.parse(JSON.stringify(sc.fetch ?? []));
  requests.length = 0;
  usage.length = 0;
  dbRows = sc.db ?? {};
}
const usageView = () => usage.map(({ ms, firstMs, ...rest }) => ({ ...rest, firstMs: firstMs == null ? null : 'set' }));
const b64 = (buf) => ({ b64: Buffer.from(buf).toString('base64') });
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/* ── audio fixtures ── */
function wav({ rate = 16000, channels = 1, bits = 16, samples }) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28); h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const speech = (n, rate = 16000, channels = 1) =>
  wav({ rate, channels, samples: Array.from({ length: n * channels }, (_, i) => Math.round(Math.sin(i / 7) * 9000 + ((i * 7919) % 300) - 150)) });
const AUDIO = {
  speech16k: speech(8000),
  speech8kStereo: speech(4000, 8000, 2),
  speech44k: speech(11025, 44100),
  silent: wav({ samples: Array.from({ length: 4000 }, (_, i) => (i % 5) * 10 - 20) }),
  notWav: Buffer.from('OggS not a wav at all'),
};

const pcmPieces = (sizes) => sizes.map((n, i) => b64(Buffer.alloc(n, (i * 37) % 256)));

(async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  console.info = () => {};
  const out = { audio: {}, mtimes: [], cacheKeys: [], tts: [], stt: [], segments: [] };
  for (const [k, v] of Object.entries(AUDIO)) out.audio[k] = v.toString('base64');

  /* mtimeMs of real files: Node's number, and the nanoseconds it came from */
  const stamps = ['2026-11-12 07:01:54.123456789', '2026-01-01 00:00:00', '2025-06-30 23:59:59.999999999', '2026-11-12 07:01:54.5', '2024-02-29 12:00:00.000001'];
  for (const [i, stamp] of stamps.entries()) {
    const f = path.join(TMP, `m${i}.wav`);
    fs.writeFileSync(f, 'x');
    execFileSync('touch', ['-m', '-d', stamp, f]);
    out.mtimes.push({ ns: fs.statSync(f, { bigint: true }).mtimeNs.toString(), mtimeMs: String(fs.statSync(f).mtimeMs) });
  }

  /* cache keys */
  setEnv({});
  let tts = fresh('lib/speech/tts.js');
  const clonePath = path.join(TMP, 'm0.wav');
  const voices = [
    { kind: 'speaker', speaker: 'laylo' },
    { kind: 'design', design: 'Calm female voice, 30s, slow pace' },
    { kind: 'clone', refAudioPath: clonePath, refText: 'Assalomu alaykum, men Laylo.', fileName: 'v/1.wav' },
    { kind: 'clone', refAudioPath: path.join(TMP, 'missing.wav'), refText: 'yo‘q', fileName: 'missing.wav' },
  ];
  const texts = ['Bir daqiqa.', 'Kredit foizi yillik yigirma to‘rt foiz 😀', ''];
  for (const env of [{}, { SPEKO_TTS_VOICE: ' VlXLedwkU4YDM3HBGpiI ' }]) {
    setEnv(env);
    tts = fresh('lib/speech/tts.js');
    for (const text of texts) {
      for (const voice of voices) out.cacheKeys.push({ env, text, voice, engine: 'default', voiceId: null, rate: 8000, key: tts.__cacheKey(text, voice) });
      for (const [engine, voiceId, rate] of [['eleven_v3_conversational', null, 8000], ['eleven_v4_turbo', 'cfWx14ZbaEUT4BjIA5tH', 24000], ['eleven_v4_turbo', 'unknown', 16000], ['brb', null, 8000], ['brb', 'x', 24000]]) {
        out.cacheKeys.push({ env, text, voice: voices[0], engine, voiceId, rate, key: tts.__cacheKey(text, voices[0], engine, voiceId, rate) });
      }
    }
  }
  out.cloneMtimeNs = fs.statSync(clonePath, { bigint: true }).mtimeNs.toString();

  /* TTS renders */
  const TTS = [
    {
      name: 'own_tts_stream_clone_cached_quick',
      env: { TTS_BASE_URL: 'http://tts.local/', TTS_CLIENT_SECRET: 'sec', TTS_STREAM_CHUNK_SEC: '0.5' },
      db: { custom: [{ id: 'cv_1', tenant_id: 't1', mode: 'clone', ref_audio_path: 'v/clone.ogg', ref_text: 'Salom, men Dilnoza.', voice_design: null }] },
      files: { 'uploads/v/clone.ogg': 'OggS-fake-sample' },
      call: 'stream',
      text: '**Salom!** Ish vaqti 09:00-18:00. Telefon: +998 90 123 45 67. Yana bir gap, juda uzun bo‘lmasin, lekin baribir ikkinchi bo‘lakka o‘tsin.',
      opts: { tenantId: 't1', voiceId: 'cv_1', language: 'uz', cache: true, quickStart: true },
      fetch: [
        { body: JSON.stringify({ access_token: 'jwt-1', expires_in: 3600 }) },
        { chunks: pcmPieces([700, 901, 1, 3000, 2500, 5]) },
        { chunks: pcmPieces([5000, 3]) },
        { chunks: pcmPieces([1599, 2]) },
        { chunks: pcmPieces([10]) },
      ],
    },
    {
      name: 'own_tts_fixed_jwt_design_one_piece',
      env: { TTS_BASE_URL: 'http://tts.local', TTS_JWT_TOKEN: ' fixed-jwt ' },
      db: { custom: [{ id: 'cv_2', tenant_id: 't1', mode: 'design', ref_audio_path: null, ref_text: null, voice_design: 'Deep male voice' }] },
      call: 'pcm',
      text: 'Bir daqiqa.',
      opts: { tenantId: 't1', voiceId: 'cv_2', language: 'uz', cache: false },
      fetch: [{ chunks: pcmPieces([3999, 1, 8001]) }],
    },
    {
      name: 'own_tts_stream_fails',
      env: { TTS_BASE_URL: 'http://tts.local', TTS_JWT_TOKEN: 'jwt' },
      call: 'pcm',
      text: 'Salom.',
      opts: { tenantId: 't1', voiceId: 'timur', language: 'uz', cache: true },
      fetch: [{ status: 500, body: 'boom' }],
    },
    {
      name: 'speko_stream_24k_quick',
      env: { SPEKO_API_KEY: ' sk ', SPEKO_BASE_URL: 'https://router.example/v1/' },
      call: 'stream',
      text: 'Здравствуйте! Ваш платёж 250 000 сум принят. Спасибо за звонок.',
      opts: { tenantId: 't1', voiceId: 'VlXLedwkU4YDM3HBGpiI', language: 'ru', cache: true, engine: 'eleven_v4_turbo', sampleRate: 24000, quickStart: true },
      fetch: [{ chunks: pcmPieces([4000, 801, 12000, 11999, 2]) }, { chunks: pcmPieces([4799, 1, 4800]) }, { chunks: pcmPieces([30]) }],
    },
    {
      name: 'brb_login_then_speech_22k_to_8k',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Salom, men sizning AI yordamchingizman.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb' },
      fetch: [tokenPair(1), { body: b64(speech(6615, 22050)), headers: { 'content-type': 'audio/wav' } }],
    },
    {
      name: 'brb_stream_two_sentences_cached_24k',
      env: BRB_ENV,
      call: 'stream',
      text: 'Kredit foizi yillik yigirma to‘rt foiz. Muddat o‘ttiz olti oygacha, oldindan to‘lash ham mumkin.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb', sampleRate: 24000, cache: true },
      fetch: [tokenPair(1, null), { body: b64(speech(7200, 24000)) }, { body: b64(speech(9000, 16000, 2)) }],
    },
    {
      name: 'brb_401_refresh_then_retry',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Bir daqiqa.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb', cache: true },
      fetch: [tokenPair(1), { status: 401, body: '{"detail":"expired"}' }, tokenPair(2), { body: b64(speech(4000, 8000)) }],
    },
    {
      name: 'brb_refresh_refused_login_again',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Hozir tekshiraman.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb' },
      fetch: [tokenPair(1), { status: 401, body: 'no' }, { status: 401, body: 'refresh expired' }, tokenPair(3), { body: b64(speech(3000, 16000)) }],
    },
    {
      name: 'brb_limit_429',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Salom.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb' },
      fetch: [tokenPair(1), { status: 429, body: '{"detail":"limit reached"}' }],
    },
    {
      name: 'brb_login_refused',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Salom.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb' },
      fetch: [{ status: 401, body: '{"detail":"bad credentials"}' }],
    },
    {
      name: 'brb_raw_audio_passthrough',
      env: BRB_ENV,
      call: 'pcm',
      text: 'Xayr.',
      opts: { tenantId: 't1', language: 'uz', engine: 'brb' },
      fetch: [tokenPair(1), { body: b64(Buffer.alloc(20001, 7)) }],
    },
    {
      name: 'speko_401',
      env: { SPEKO_API_KEY: 'sk' },
      call: 'pcm',
      text: 'Hello.',
      opts: { tenantId: 't1', language: 'en', engine: 'eleven_v3_conversational' },
      fetch: [{ status: 401, body: 'bad key' }],
    },
  ];
  for (const sc of TTS) {
    setEnv(sc.env);
    reset(sc);
    for (const [rel, content] of Object.entries(sc.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
      fs.writeFileSync(path.join(TMP, rel), content);
    }
    const cwd = process.cwd();
    const work = path.join(TMP, `cwd-${sc.name}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    process.chdir(work); // the cache lives at <cwd>/data/tts-cache
    tts = fresh('lib/speech/tts.js');
    const pieces = [];
    let error = null;
    try {
      if (sc.call === 'stream') for await (const p of tts.synthesizeStream(sc.text, sc.opts)) pieces.push(p);
      else pieces.push(await tts.synthesizePcm(sc.text, sc.opts));
    } catch (err) {
      error = { message: err.message, status: err.status };
    }
    const cached = fs.existsSync(path.join(work, 'data/tts-cache')) ? fs.readdirSync(path.join(work, 'data/tts-cache')).sort() : [];
    process.chdir(cwd);
    out.tts.push({ ...sc, requests: JSON.parse(JSON.stringify(requests)), pieces: pieces.map((p) => ({ size: p.length, sha1: sha1(p) })), error, cached, usage: usageView(), leftover: fetchScript.length });
  }

  /* STT */
  const KOTIB = 'http://kotib.local/transcribe';
  const WHISPER = 'http://whisper.local/v1/audio/transcriptions';
  const STT = [
    { name: 'auto_kotib_whisper_kotib_wins', env: { STT_TRANSCRIBE_URL: KOTIB, WHISPER_TRANSCRIBE_URL: WHISPER }, audio: 'speech16k', opts: { language: 'uz' },
      fetch: [{ body: JSON.stringify({ text: ' bir ming to‘qqiz yuz to‘qson ikki ', language: 'uz' }) }, { body: JSON.stringify({ text: 'Bir ming...', language: 'uz' }) }] },
    { name: 'auto_whisper_switched_language', env: { STT_TRANSCRIBE_URL: KOTIB, WHISPER_TRANSCRIBE_URL: WHISPER, WHISPER_API_KEY: 'wk' }, audio: 'speech16k', opts: {},
      fetch: [{ body: JSON.stringify({ text: 'ya tysyacha', language: 'uz' }) }, { body: JSON.stringify({ text: 'Я хочу узнать баланс', language: 'ru' }) }] },
    { name: 'auto_ru_agent_whisper_only', env: { STT_TRANSCRIBE_URL: KOTIB, WHISPER_TRANSCRIBE_URL: WHISPER }, audio: 'speech16k', opts: { language: 'ru' },
      fetch: [{ body: JSON.stringify({ text: 'Сколько стоит?' }) }] },
    { name: 'auto_whisper_hallucination_kotib_short', env: { STT_TRANSCRIBE_URL: KOTIB, WHISPER_TRANSCRIBE_URL: WHISPER }, audio: 'speech16k', opts: { language: 'uz' },
      fetch: [{ body: JSON.stringify({ text: 'ha' }) }, { body: JSON.stringify({ text: 'Thank you.' }) }] },
    { name: 'auto_kotib_down_gemini_ear', env: { STT_TRANSCRIBE_URL: KOTIB, GEMINI_API_KEY: 'gk' }, audio: 'speech16k', opts: { language: 'uz' },
      fetch: [{ status: 502, body: 'down' }, { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Salom, kredit haqida' }] } }] }) }] },
    { name: 'auto_gemini_ear_ru_first', env: { STT_TRANSCRIBE_URL: KOTIB, GEMINI_API_KEY: 'gk', GEMINI_STT_MODEL: 'gemini-x' }, audio: 'speech16k', opts: { language: 'ru' },
      fetch: [{ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '<empty>' }] } }] }) }] },
    { name: 'auto_silent', env: { STT_TRANSCRIBE_URL: KOTIB }, audio: 'silent', opts: {}, fetch: [] },
    { name: 'auto_not_configured', env: {}, audio: 'speech16k', opts: {}, fetch: [] },
    { name: 'auto_denoise_then_kotib', env: { STT_TRANSCRIBE_URL: KOTIB, DENOISE_URL: 'http://clean.local/base/' }, audio: 'speech16k', opts: { denoise: true },
      fetch: [{ body: b64(Buffer.from('RIFF-cleaned')), headers: { 'x-cleaned': 'true', 'x-snr-db': '12' } }, { body: JSON.stringify({ text: 'tozalangan' }) }] },
    { name: 'gapi_words_to_digits', env: { GAPIAPI: ' gk ' }, audio: 'speech16k', opts: { engine: 'gapi', language: 'uz' },
      fetch: [{ body: JSON.stringify({ segments: [{ text: 'qirq sakkiz' }, { text: ' yigirma  to‘qqiz' }], language: { code: 'uz' } }) }] },
    { name: 'gapi_denoise_fails_open', env: { GAPI_API_KEY: 'gk', GAPI_BASE_URL: 'https://gapi.example/', DENOISE_URL: 'http://clean.local' }, audio: 'speech16k', opts: { engine: 'gapi', denoise: true },
      fetch: [{ status: 500, body: 'x' }, { body: JSON.stringify({ text: '' }) }] },
    { name: 'gapi_error', env: { GAPIAPI: 'gk' }, audio: 'speech16k', opts: { engine: 'gapi' }, fetch: [{ status: 429, body: 'slow down' }] },
    { name: 'speko_gemini_44k', env: { SPEKO_API_KEY: 'sk' }, audio: 'speech44k', opts: { engine: 'gemini', language: 'ru' },
      fetch: [{ body: JSON.stringify({ text: '  Добрый день  ' }) }] },
    { name: 'speko_scribe_stereo_8k', env: { SPEKO_API_KEY: 'sk' }, audio: 'speech8kStereo', opts: { engine: 'scribe' },
      fetch: [{ body: JSON.stringify({ text: 'ikki yuz ellik ming so‘m' }) }] },
    { name: 'speko_scribe_hallucination', env: { SPEKO_API_KEY: 'sk' }, audio: 'speech16k', opts: { engine: 'scribe' }, fetch: [{ body: JSON.stringify({ text: 'Субтитры сделал DimaTorzok' }) }] },
    { name: 'engine_not_configured', env: {}, audio: 'speech16k', opts: { engine: 'scribe' }, fetch: [] },
    { name: 'not_a_wav_passes_through', env: { STT_TRANSCRIBE_URL: KOTIB }, audio: 'notWav', opts: {}, fetch: [{ body: JSON.stringify({ text: 'ok' }) }] },
  ];
  for (const sc of STT) {
    setEnv(sc.env);
    reset(sc);
    const stt = fresh('lib/speech/stt.js');
    let result = null;
    let error = null;
    try {
      const buf = AUDIO[sc.audio];
      result = await stt.transcribe(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), sc.opts);
    } catch (err) {
      error = { message: err.message, status: err.status };
    }
    out.stt.push({ ...sc, requests: JSON.parse(JSON.stringify(requests)), result, error, usage: usageView(), leftover: fetchScript.length });
  }
  // gemini transcribe request bodies carry the whole WAV in base64: keep only its digest.
  for (const sc of out.stt) for (const r of sc.requests) if (r.body?.text?.includes('inlineData')) {
    const body = JSON.parse(r.body.text);
    const part = body.contents[0].parts[0].inlineData;
    part.data = `sha1:${sha1(part.data)}`;
    r.body = { geminiJson: body };
  }

  /* nextSegment — verbatim from speakAsWritten in src/lib/playground-voice.ts */
  const CLAUSE_MIN_WORDS = 4;
  const CLAUSE_MIN_CHARS = 25;
  function makeNext(fast) {
    const st = { text: '', taken: 0, finished: false, segments: 0 };
    const nextSegment = () => {
      const rest = st.text.slice(st.taken);
      if (st.finished) {
        st.taken = st.text.length;
        return rest.trim() || null;
      }
      const ends = [...rest.matchAll(/[.!?…]+(?=\s)/g)];
      const last = ends[ends.length - 1];
      if (last) {
        const cut = last.index + last[0].length;
        if (rest.slice(0, cut).trim().length >= 12) {
          st.taken += cut;
          return rest.slice(0, cut).trim();
        }
      }
      if (fast && st.segments === 0) {
        for (const m of rest.matchAll(/[,;:—–]+(?=\s)/g)) {
          const cut = m.index + m[0].length;
          const piece = rest.slice(0, cut).trim();
          if (piece.length >= CLAUSE_MIN_CHARS && piece.split(/\s+/).length >= CLAUSE_MIN_WORDS) {
            st.taken += cut;
            return piece;
          }
        }
      }
      return null;
    };
    return { st, nextSegment };
  }
  const REPLIES = [
    'Ha. Albatta, kredit foizi yillik yigirma to‘rt foiz, muddati esa o‘ttiz olti oygacha. Yana savol bormi?',
    'Assalomu alaykum, men Laylo, Ipoteka bankdan qo‘ng‘iroq qilyapman: Aziz Karimov bilan gaplashyapmanmi?',
    'Здравствуйте! Ваш платёж принят… Спасибо, что позвонили — хорошего дня!',
    'Ok.',
    'Short, clause; here — and then a much longer sentence follows without any end',
    'Emoji 😀😀😀 start, then: words words words words. Done!',
  ];
  for (const reply of REPLIES) {
    for (const fast of [true, false]) {
      for (const step of [3, 11, 1000]) {
        const { st, nextSegment } = makeNext(fast);
        const got = [];
        for (let i = 0; i < reply.length; i += step) {
          st.text = st.taken ? st.text + reply.slice(i, i + step) : (st.text + reply.slice(i, i + step)).trimStart();
          for (let seg = nextSegment(); seg; seg = nextSegment()) { got.push(seg); st.segments += 1; }
        }
        st.finished = true;
        for (let seg = nextSegment(); seg; seg = nextSegment()) { got.push(seg); st.segments += 1; }
        out.segments.push({ reply, fast, step, segments: got });
      }
    }
  }

  console.warn = origWarn;
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log(`mtimes ${out.mtimes.length}, keys ${out.cacheKeys.length}, tts ${out.tts.length}, stt ${out.stt.length}, segments ${out.segments.length}`);
  for (const s of out.tts) console.log('tts', s.name.padEnd(40), s.error ? JSON.stringify(s.error) : s.pieces.map((p) => p.size).join(','), 'cached', s.cached.length, 'left', s.leftover, 'reqs', s.requests.length);
  for (const s of out.stt) console.log('stt', s.name.padEnd(40), JSON.stringify(s.error ?? s.result));
})();
