// Reference behaviour of the ORIGINAL TypeScript for agents, onboarding, models and voices:
// src/app/actions/{agent,models,voices}.ts and the pages that loaded their own data
// (agent studio, Playground, onboarding, Model lab, Voices, For developers ▸ STT/TTS/clone/design),
// taken from git revision <rev> — the last one before they became thin proxies to Python — and
// src/lib/{speech/scoring,benchmark,lab}.ts, run on a real SQLite database with a fixed seed:
//   • each page: the props it passed to its client component (minus `locale`);
//   • each server action: its return value (or error), revalidatePath / redirect calls, and the rows
//     it added, changed or removed;
//   • the transcript scorer on fixed inputs; the deploy benchmark with scripted engines and a scripted
//     clock, the rows it wrote, and the Model lab's numbers afterwards.
// IDs come from a fixed byte stream (sha256 of a counter) instead of random bytes, so the Python
// replay (tests/test_agents_parity.py) produces the very same ids. Timestamps written during the run
// are masked as "<now>".
//
// The TypeScript is transpiled on load (typescript.transpileModule; the project uses isolatedModules),
// so no tsc step is needed. Run from the repository root:
//   node --experimental-sqlite backend/tools/golden/make-golden-agents.cjs \
//     backend/tests/fixtures/golden_agents.json %TEMP%\golden-agents [rev]
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_FILE = path.resolve(process.argv[2]);
const WORK = path.resolve(process.argv[3]);
const REV = process.argv[4] || 'b68a116';
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data', 'uploads'), { recursive: true });
// benchmark.ts reads the STT test set from <cwd>/benchmarks/stt-uz.
fs.cpSync(path.join(ROOT, 'benchmarks', 'stt-uz'), path.join(WORK, 'benchmarks', 'stt-uz'), { recursive: true });
const ORIG = path.join(WORK, 'orig', 'src');

/* ── loading the TypeScript ──────────────────────────────────── */

function original(rel) {
  const dest = path.join(ORIG, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, execFileSync('git', ['show', `${REV}:src/${rel}`], { cwd: ROOT }));
  return dest;
}

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
};
for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions, fileName: filename });
    module._compile(outputText, filename);
  };
}

const calls = { revalidate: [], redirect: null };
let cookie = null;
class Redirect extends Error {
  constructor(url) {
    super('NEXT_REDIRECT');
    this.url = url;
  }
}
const stubs = {
  'server-only': {},
  'next/cache': { revalidatePath: (p, type) => calls.revalidate.push(type ? [p, type] : [p]) },
  'next/navigation': {
    redirect: (url) => {
      calls.redirect = url;
      throw new Redirect(url);
    },
  },
  'next/headers': {
    cookies: async () => ({
      get: (name) => (name === 'ovoz_session' && cookie ? { name, value: cookie } : undefined),
      getAll: () => (cookie ? [{ name: 'ovoz_session', value: cookie }] : []),
    }),
    headers: async () => new Headers(),
  },
  // A page returns <Component {...props} />: keep the element as data.
  'react/jsx-runtime': {
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key }),
    Fragment: 'Fragment',
  },
  // A page's own client components (./studio, ./playground …) are stand-ins: only their props matter.
  component: new Proxy({}, { get: (_t, name) => (name === '__esModule' ? true : function Component() {}) }),
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/')) return resolve.call(this, path.join(ROOT, 'src', request.slice(2)), parent, ...rest);
  if (request.startsWith('.') && parent && parent.filename && parent.filename.startsWith(ORIG)) return 'stub:component';
  return resolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) {
  require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
}

/* ── deterministic ids, network, environment ─────────────────── */

let idCounter = 0;
globalThis.crypto.getRandomValues = (arr) => {
  const bytes = crypto.createHash('sha256').update(String(idCounter++)).digest();
  arr.set(bytes.subarray(0, arr.length));
  return arr;
};

const STT_URL = 'http://stt.test/transcribe';
const sttRequests = [];
globalThis.fetch = async (url, init) => {
  if (String(url) === STT_URL) {
    const file = init.body.get('file');
    sttRequests.push({ name: file.name, type: file.type, size: file.size });
    if (file.name === 'broken.wav') return new Response('upstream exploded', { status: 500 });
    if (file.name === 'silent.wav') return Response.json({ text: '   ' });
    if (file.name === 'null.wav') return Response.json(null);
    return Response.json({ text: '  Salom, bu mening ovozim.  ', language: 'uz' });
  }
  throw new Error(`offline: ${url}`);
};

const ENV_KEYS = [
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL',
  'TTS_BASE_URL', 'TTS_CLIENT_SECRET', 'TTS_JWT_TOKEN', 'SPEKO_API_KEY', 'STT_TRANSCRIBE_URL', 'WHISPER_TRANSCRIBE_URL',
  'GAPIAPI', 'GAPI_API_KEY', 'BRB_SPEECH_URL', 'BRB_SPEECH_LOGIN', 'BRB_SPEECH_PASSWORD', 'BRB_STT_URL',
  'ZIPFORMER_MODEL_DIR', 'DENOISE_URL', 'OVOZ_SESSION_SECRET',
];
const SECRET = 'test-secret-öçü-2026';
const PROFILES = {
  // Own TTS and the own STT set up, nothing else: answers come from the local engine.
  bare: {
    TTS_BASE_URL: 'http://tts.test',
    TTS_JWT_TOKEN: 'fake',
    STT_TRANSCRIBE_URL: STT_URL,
    ZIPFORMER_MODEL_DIR: path.join(WORK, 'no-zipformer'),
  },
  // Every key present (nothing is called): readiness flags and engine labels change.
  keys: {
    TTS_BASE_URL: 'http://tts.test',
    TTS_CLIENT_SECRET: 'fake-secret',
    STT_TRANSCRIBE_URL: STT_URL,
    WHISPER_TRANSCRIBE_URL: 'http://whisper.test',
    ZIPFORMER_MODEL_DIR: path.join(WORK, 'no-zipformer'),
    SPEKO_API_KEY: 'fake',
    GAPIAPI: 'fake',
    GEMINI_API_KEY: 'fake',
    OPENAI_API_KEY: 'fake',
    BRB_SPEECH_URL: 'http://brb.test',
    BRB_SPEECH_LOGIN: 'brb',
    BRB_SPEECH_PASSWORD: 'brb',
    BRB_STT_URL: 'brb-stt.test:443',
  },
};
function useProfile(name) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, PROFILES[name], { OVOZ_SESSION_SECRET: SECRET, LLM_FALLBACK_MODEL: 'off' });
}
useProfile('bare');
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db; UPLOAD_DIR is <cwd>/data/uploads

/* ── the database and its seed ───────────────────────────────── */

const db = require(path.join(ROOT, 'src/lib/db.ts'));
const RUN_START = new Date().toISOString();

const T = (d, h = 8, m = 0, s = 0) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const FAR = '2099-01-01T00:00:00.000Z';
const HOURS_PARTIAL = JSON.stringify({ enabled: true, days: { 0: { open: '10:00', close: '12:00', closed: false }, 7: { open: 'x', close: 'y', closed: true } } });
const SEED = {
  tenants: [
    { id: 'ten_med', name: 'Medline', slug: 'medline', industry: 'clinic', locale: 'uz-Cyrl', onboarded: 0, settings_json: '{"llmModel":"openai:gpt-5.5","theme":{"dark":true}}', balance_uzs: 100000, created_at: T(1), updated_at: T(1) },
    { id: 'ten_two', name: 'Two Logistics', slug: 'two', industry: 'logistics', locale: 'ru', onboarded: 0, settings_json: '{}', balance_uzs: 0, created_at: T(2), updated_at: T(2) },
    { id: 'ten_three', name: 'Three', slug: 'three', industry: 'insurance', locale: 'en', onboarded: 1, settings_json: '{"bankAgentSeeded":"2026-11-01T00:00:00.000Z"}', created_at: T(3), updated_at: T(3) },
    { id: 'ten_four', name: 'Four', slug: 'four', industry: 'retail', locale: 'en', onboarded: 0, settings_json: 'not json', created_at: T(4), updated_at: T(4) },
  ],
  users: [
    { id: 'usr_owner', tenant_id: 'ten_med', email: 'owner@med.uz', name: 'Olim', password_hash: 'x', role: 'owner', locale: 'ru', created_at: T(1), updated_at: T(1) },
    { id: 'usr_admin', tenant_id: 'ten_med', email: 'admin@med.uz', name: 'Aziza', password_hash: 'x', role: 'admin', locale: 'uz', created_at: T(1), updated_at: T(1) },
    { id: 'usr_oper', tenant_id: 'ten_med', email: 'oper@med.uz', name: 'Operator', password_hash: 'x', role: 'operator', locale: 'en', created_at: T(1), updated_at: T(1) },
    { id: 'usr_two', tenant_id: 'ten_two', email: 'two@two.uz', name: 'Борис', password_hash: 'x', role: 'owner', locale: 'en', created_at: T(2), updated_at: T(2) },
    { id: 'usr_three', tenant_id: 'ten_three', email: 'three@three.uz', name: 'Analyst', password_hash: 'x', role: 'analyst', locale: 'uz-Cyrl', created_at: T(3), updated_at: T(3) },
    { id: 'usr_four', tenant_id: 'ten_four', email: 'four@four.uz', name: 'Four', password_hash: 'x', role: 'admin', locale: 'en', created_at: T(4), updated_at: T(4) },
  ],
  agents: [
    { id: 'agt_paused', tenant_id: 'ten_med', name: 'Paused', status: 'paused', persona: 'concise', greeting: '', fallback_line: '', instructions: '', languages_json: '["ru"]', primary_lang: 'ru', voice_id: 'isomiddin', llm_model: 'gemini:gemini-3.8-flash', tts_engine: 'eleven_v3_conversational', tts_voice_id: '', created_at: T(1, 7), updated_at: T(1, 7) },
    { id: 'agt_live', tenant_id: 'ten_med', name: 'Laylo', status: 'live', persona: 'friendly', greeting: ' Assalomu alaykum! ', fallback_line: 'Kechirasiz', instructions: 'Be kind', languages_json: '["uz","ru"]', primary_lang: 'uz', voice_id: 'laylo', speaking_rate: 1.1, max_turns: 20, confidence_threshold: 0.5, escalation_json: '{"maxFailedTurns":3,"fallbackNumber":"+998901112233"}', hours_json: HOURS_PARTIAL, target_json: '{}', llm_model: 'anthropic:claude-haiku-5-5', tts_engine: 'eleven_v4_turbo', tts_voice_id: 'VlXLedwkU4YDM3HBGpiI', version: 3, created_at: T(1, 8), updated_at: T(3, 9) },
    { id: 'agt_draft', tenant_id: 'ten_med', name: 'Draft', status: 'draft', persona: 'professional', greeting: 'Salom', fallback_line: 'Bilmayman', instructions: '', languages_json: 'not json', primary_lang: 'uz', voice_id: 'cv_design', hours_json: '', target_json: '{"fullName":"Aziz Karimov","birthYear":"1992"}', llm_model: 'bogus:model', tts_engine: 'brb', tts_voice_id: '', created_at: T(2, 8), updated_at: T(2, 8) },
    { id: 'agt_three', tenant_id: 'ten_three', name: 'Three', status: 'live', greeting: 'Hello', primary_lang: 'en', voice_id: 'laylo', created_at: T(3), updated_at: T(3) },
  ],
  documents: [
    { id: 'doc_a', tenant_id: 'ten_med', title: 'Narxlar', source_type: 'pdf', status: 'ready', chunk_count: 12, token_count: 3400, byte_size: 10240, created_at: T(2), updated_at: T(2) },
    { id: 'doc_b', tenant_id: 'ten_med', title: 'Broken', source_type: 'docx', status: 'failed', chunk_count: 0, token_count: 0, byte_size: 99, created_at: T(3), updated_at: T(3) },
    { id: 'doc_c', tenant_id: 'ten_med', title: 'FAQ', source_type: 'faq', status: 'ready', chunk_count: 5, token_count: 800, byte_size: 2048, created_at: T(1), updated_at: T(1) },
  ],
  phone_numbers: [
    { id: 'num_1', tenant_id: 'ten_med', e164: '+998712000001', agent_id: 'agt_live', created_at: T(1) },
    { id: 'num_2', tenant_id: 'ten_med', e164: '+998712000002', created_at: T(2) },
  ],
  custom_voices: [
    { id: 'cv_clone', tenant_id: 'ten_med', name: 'Mening ovozim', mode: 'clone', ref_audio_path: 'voice_cv_clone.wav', ref_text: 'Salom dunyo', created_at: T(1) },
    { id: 'cv_design', tenant_id: 'ten_med', name: 'Buvi', mode: 'design', voice_design: 'female, elderly', created_at: T(2) },
    { id: 'cv_two', tenant_id: 'ten_two', name: 'Two voice', mode: 'design', voice_design: 'male', created_at: T(2) },
  ],
  calls: [
    { id: 'call_pg1', tenant_id: 'ten_med', agent_id: 'agt_live', channel: 'web', from_e164: 'playground', to_e164: 'playground', status: 'completed', turns: 2, started_at: T(5, 10), ended_at: T(5, 10, 0, 30) },
    { id: 'call_pg2', tenant_id: 'ten_med', agent_id: 'agt_live', channel: 'web', from_e164: 'playground', to_e164: 'playground', status: 'active', turns: 3, started_at: T(6, 10) },
    { id: 'call_pg3', tenant_id: 'ten_med', agent_id: 'agt_draft', channel: 'web', from_e164: 'playground', to_e164: 'playground', status: 'ringing', turns: 0, started_at: T(6, 11) },
    { id: 'call_voice', tenant_id: 'ten_med', agent_id: 'agt_live', channel: 'voice', from_e164: '+998901234567', to_e164: '+998712000001', status: 'completed', turns: 2, started_at: T(4, 9), ended_at: T(4, 9, 2) },
    { id: 'call_two', tenant_id: 'ten_two', agent_id: null, channel: 'web', from_e164: 'playground', to_e164: 'playground', status: 'active', turns: 1, started_at: T(6, 9) },
  ],
  turns: [
    { id: 'trn_1', tenant_id: 'ten_med', call_id: 'call_pg1', ordinal: 0, role: 'caller', text: 'Salom', language: 'uz', created_at: T(5, 10, 0, 5) },
    { id: 'trn_2', tenant_id: 'ten_med', call_id: 'call_pg1', ordinal: 1, role: 'agent', text: 'Assalomu alaykum', language: 'uz', confidence: 0.8, timings_json: '{"totalMs":120,"sttMs":0}', citations_json: '[{"documentTitle":"Narxlar","heading":null,"snippet":"Qabul 100 000","score":0.71,"chunkId":"c1"},{"documentTitle":"FAQ","snippet":"no heading"}]', created_at: T(5, 10, 0, 20) },
    { id: 'trn_3', tenant_id: 'ten_med', call_id: 'call_pg1', ordinal: 2, role: 'system', text: '__unanswered__', created_at: T(5, 10, 0, 21) },
    { id: 'trn_4', tenant_id: 'ten_med', call_id: 'call_pg2', ordinal: 0, role: 'caller', text: 'Ish vaqti?', language: 'uz', created_at: T(6, 10, 0, 5) },
    { id: 'trn_5', tenant_id: 'ten_med', call_id: 'call_pg2', ordinal: 1, role: 'agent', text: 'Dushanba-juma', created_at: T(6, 10, 0, 9) },
    { id: 'trn_6', tenant_id: 'ten_med', call_id: 'call_pg2', ordinal: 2, role: 'caller', text: 'Rahmat 🙏', language: 'uz', created_at: T(6, 10, 1, 0) },
    { id: 'trn_7', tenant_id: 'ten_med', call_id: 'call_voice', ordinal: 0, role: 'caller', text: 'Allo', created_at: T(4, 9, 0, 3) },
  ],
  speech_tests: [
    { id: 'st_1', tenant_id: 'ten_med', user_id: 'usr_admin', kind: 'stt', input: 'a.wav', output: 'salom', voice: 'gapi', created_at: T(3) },
    { id: 'st_2', tenant_id: 'ten_med', user_id: 'usr_admin', kind: 'stt', input: 'b.wav', output: 'xayr', voice: null, created_at: T(5) },
    { id: 'st_3', tenant_id: 'ten_med', user_id: 'usr_owner', kind: 'tts', input: 'Matn', output: null, voice: 'laylo', created_at: T(4) },
    { id: 'st_4', tenant_id: 'ten_two', user_id: 'usr_two', kind: 'tts', input: 'Two', output: null, voice: 'laylo', created_at: T(4) },
  ],
  benchmark_runs: [
    { build: 'b0', started_at: T(1), finished_at: T(1, 9), status: 'done' },
    { build: 'b1', started_at: T(2), finished_at: T(2, 9), status: 'partial' },
  ],
  benchmark_results: [
    { build: 'b0', kind: 'stt', engine: 'kotib', passed: 2, samples: 3, latency_ms: 1500, first_ms: null, wer: 0.2, cer: 0.1, clarity: null, created_at: T(1, 9) },
    { build: 'b1', kind: 'stt', engine: 'kotib', passed: 3, samples: 3, latency_ms: 1200, first_ms: null, wer: 0.15, cer: 0.05, clarity: null, created_at: T(2, 9) },
    { build: 'b1', kind: 'stt', engine: 'gapi', passed: 0, samples: 3, latency_ms: null, first_ms: null, wer: null, cer: null, clarity: null, created_at: T(2, 9) },
    { build: 'b1', kind: 'tts', engine: 'default', passed: 3, samples: 3, latency_ms: 900, first_ms: 300, wer: null, cer: null, clarity: 0.95, created_at: T(2, 9) },
    { build: 'b1', kind: 'llm', engine: 'openai:gpt-5.5', passed: 3, samples: 3, latency_ms: 1100, first_ms: 400, wer: null, cer: null, clarity: null, created_at: T(2, 9) },
  ],
};
SEED.sessions = SEED.users.map((u) => ({ id: `ses_${u.id.slice(4)}`, user_id: u.id, tenant_id: u.tenant_id, created_at: T(1), expires_at: FAR }));

function insert(table, row) {
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}
for (const [table, rows] of Object.entries(SEED)) for (const row of rows) insert(table, row);
const CLONE_SAMPLE = Buffer.from('RIFF....WAVEfmt seed sample');
fs.writeFileSync(path.join(WORK, 'data', 'uploads', 'voice_cv_clone.wav'), CLONE_SAMPLE);

const tokenFor = (user) => {
  const sid = `ses_${user.slice(4)}`;
  return `${sid}.${crypto.createHmac('sha256', SECRET).update(sid).digest('base64url')}`;
};

/* ── normalising and diffing rows ────────────────────────────── */

const ISO_ANY = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A calendar day of the run (any time zone): later than every seeded day.
const RUN_DAY = new Date(Date.parse(RUN_START) - 36 * 3600e3).toISOString().slice(0, 10);
function mask(value) {
  if (typeof value === 'string') {
    if (DAY.test(value) && value >= RUN_DAY) return '<today>';
    // Also inside a value, e.g. settings_json {"bankAgentSeeded":"<now>"}.
    return value.replace(ISO_ANY, (stamp) => (stamp >= RUN_START ? '<now>' : stamp));
  }
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) =>
        // Measured timings: keep which ones there are, and the given STT/TTS times.
        k === 'timings' && v && typeof v === 'object' ? [k, { keys: Object.keys(v).join(','), sttMs: v.sttMs ?? null, ttsMs: v.ttsMs ?? null }] : [k, mask(v)],
      ),
    );
  }
  return value;
}
// Durations and costs of calls made during the run depend on the clock.
const VOLATILE = {
  calls: ['duration_ms', 'first_response_ms', 'avg_latency_ms', 'p95_latency_ms', 'cost_usd'],
  turns: ['latency_ms', 'timings_json'],
  usage_daily: ['minutes', 'cost_usd', 'avg_latency_ms'],
};
const TABLES = ['tenants', 'agents', 'custom_voices', 'audit_log', 'calls', 'turns', 'usage_daily', 'wallet_ledger', 'knowledge_gaps', 'escalations', 'model_usage', 'benchmark_runs', 'benchmark_results'];
function snapshot() {
  const out = {};
  for (const t of TABLES) out[t] = new Map(db.all(`SELECT rowid AS _rowid, * FROM ${t}`).map((r) => [r._rowid, JSON.stringify(normRow(t, r))]));
  return out;
}
function normRow(table, row) {
  const r = mask(row);
  const fresh = Object.values(r).includes('<now>') || Object.values(r).includes('<today>');
  for (const col of VOLATILE[table] ?? []) if (fresh && col in r) r[col] = '<v>';
  return r;
}
let last = snapshot();
function changes() {
  const now = snapshot();
  const out = {};
  for (const t of TABLES) {
    const added = [];
    const changed = [];
    const removed = [];
    for (const [rowid, row] of now[t]) {
      if (!last[t].has(rowid)) added.push(JSON.parse(row));
      else if (last[t].get(rowid) !== row) changed.push(JSON.parse(row));
    }
    for (const rowid of last[t].keys()) if (!now[t].has(rowid)) removed.push(rowid);
    if (added.length || changed.length || removed.length) out[t] = { added, changed, removed };
  }
  last = now;
  return out;
}
function uploads() {
  const dir = path.join(WORK, 'data', 'uploads');
  return fs.readdirSync(dir).sort().map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
}

/* ── pages ───────────────────────────────────────────────────── */

const PAGES = {
  agent: 'app/app/agent/page.tsx',
  playground: 'app/app/playground/page.tsx',
  onboarding: 'app/onboarding/page.tsx',
  'models/lab': 'app/app/models/lab/page.tsx',
  'models/voices': 'app/app/models/voices/page.tsx',
  'dev/stt': 'app/app/dev/stt/page.tsx',
  'dev/tts': 'app/app/dev/tts/page.tsx',
  'dev/voice-clone': 'app/app/dev/voice-clone/page.tsx',
  'dev/voice-design': 'app/app/dev/voice-design/page.tsx',
};
const pageModules = Object.fromEntries(Object.entries(PAGES).map(([name, rel]) => [name, require(original(rel))]));
const { translator } = require(path.join(ROOT, 'src/lib/i18n.ts'));

async function renderPage(page, query) {
  let el;
  try {
    el = await pageModules[page].default({ searchParams: Promise.resolve(query ?? {}) });
  } catch (err) {
    if (err instanceof Redirect) return { redirect: err.url }; // decided by the page itself, before any data
    throw err;
  }
  if (typeof el.type === 'string') return { element: el.type }; // the page's own "no agent" markup
  const { locale, ...props } = el.props;
  return { props, key: el.key ?? null };
}

/* ── actions ─────────────────────────────────────────────────── */

const ACTIONS = {
  ...require(original('app/actions/agent.ts')),
  ...require(original('app/actions/models.ts')),
  ...require(original('app/actions/voices.ts')),
};
// The order of each action's parameters, so the Python side gets them by name.
const PARAMS = {
  saveAgentAction: ['agentId', 'draft'],
  setAgentStatusAction: ['agentId', 'status'],
  createAgentAction: ['name'],
  playgroundTurnAction: ['params'],
  endPlaygroundCallAction: ['callId', 'csat'],
  listPlaygroundChatsAction: ['agentId'],
  loadPlaygroundChatAction: ['callId'],
  completeOnboardingAction: ['payload'],
  skipOnboardingAction: [],
  setDefaultLlmAction: ['choice'],
  createDesignVoiceAction: ['input'],
  deleteCustomVoiceAction: ['voiceId'],
};

async function runAction(name, args, form) {
  calls.revalidate = [];
  calls.redirect = null;
  let result;
  let error = null;
  try {
    if (form) {
      const fd = new FormData();
      for (const [k, v] of form) {
        if (v && typeof v === 'object') fd.append(k, new Blob([Buffer.from(v.b64, 'base64')], { type: v.type }), v.name);
        else fd.append(k, v);
      }
      result = await ACTIONS[name](fd);
    } else {
      result = await ACTIONS[name](...PARAMS[name].map((p) => args[p]));
    }
  } catch (err) {
    if (err instanceof Redirect) result = undefined;
    else error = err.status === 403 ? 'forbidden' : err.status === 401 ? 'unauthorized' : `throws:${err.message}`;
  }
  return { result: result === undefined ? null : mask(result), error, revalidate: calls.revalidate, redirect: calls.redirect };
}

/* ── the scenario ────────────────────────────────────────────── */

const longText = (n, tail) => 'x'.repeat(n) + tail;
const DRAFT = {
  name: '  Yangi nom  ',
  persona: 'warm',
  greeting: 'Assalomu alaykum, Medline!',
  fallbackLine: 'Mutaxassisga ulayman',
  instructions: longText(3999, '😀 and more'),
  languages: [],
  primaryLang: 'ru',
  voiceId: 'isomiddin',
  speakingRate: 1.25,
  maxTurns: 30,
  confidenceThreshold: 0.4,
  status: 'live',
  escalation: { onLowConfidence: false, onExplicitRequest: true, onNegativeSentiment: true, onRepeatedFailure: true, maxFailedTurns: 4, afterHoursAction: 'voicemail', ringTimeoutSec: 20, fallbackNumber: '' },
  hours: { enabled: true, timezone: 'Asia/Tashkent', days: { 0: { open: '00:00', close: '00:00', closed: true }, 1: { open: '08:00', close: '17:00', closed: false } } },
  target: { fullName: `  ${longText(117, '😀😀')}  `, birthYear: ' 19a92x5 ', loanAmount: ' 7 800 000 so‘m ', prompt: 'Eslatma' },
  llmModel: 'openai:gpt-5.5',
  ttsEngine: 'eleven_v3_conversational',
  ttsVoiceId: 'nope',
};
const file = (name, content, type = 'audio/wav') => ({ name, type, b64: Buffer.from(content).toString('base64') });

const STEPS = [
  // pages, own TTS and STT only
  ['view', 'bare', 'usr_admin', 'agent'],
  ['view', 'bare', 'usr_admin', 'agent', { agent: 'agt_draft' }],
  ['view', 'bare', 'usr_admin', 'agent', { agent: 'agt_nope' }],
  ['view', 'bare', 'usr_oper', 'agent'],
  ['view', 'bare', 'usr_two', 'agent'],
  ['view', 'bare', 'usr_admin', 'onboarding'],
  ['view', 'bare', 'usr_two', 'onboarding'],
  ['view', 'bare', 'usr_four', 'onboarding'],
  ['view', 'bare', 'usr_admin', 'models/lab'],
  ['view', 'bare', 'usr_oper', 'models/lab'],
  ['view', 'bare', 'usr_admin', 'models/voices'],
  ['view', 'bare', 'usr_admin', 'models/voices', { model: 'brb' }],
  ['view', 'bare', 'usr_admin', 'models/voices', { model: 'nope' }],
  ['view', 'bare', 'usr_admin', 'dev/stt'],
  ['view', 'bare', 'usr_admin', 'dev/stt', { model: 'kotib' }],
  ['view', 'bare', 'usr_admin', 'dev/stt', { model: 'gapi' }],
  ['view', 'bare', 'usr_admin', 'dev/tts'],
  ['view', 'bare', 'usr_two', 'dev/tts'],
  ['view', 'bare', 'usr_admin', 'dev/voice-clone'],
  ['view', 'bare', 'usr_admin', 'dev/voice-design'],
  ['view', 'bare', 'usr_admin', 'playground'],
  ['view', 'bare', 'usr_admin', 'playground'],
  ['view', 'bare', 'usr_two', 'playground'],
  ['view', 'bare', 'usr_three', 'playground'],
  // pages, every key present
  ['view', 'keys', 'usr_owner', 'agent'],
  ['view', 'keys', 'usr_admin', 'agent', { agent: 'agt_paused' }],
  ['view', 'keys', 'usr_owner', 'playground'],
  ['view', 'keys', 'usr_admin', 'models/lab'],
  ['view', 'keys', 'usr_admin', 'models/voices', { model: 'eleven_v4_turbo' }],
  ['view', 'keys', 'usr_admin', 'dev/stt'],
  ['view', 'keys', 'usr_admin', 'dev/stt', { model: 'gapi' }],
  ['view', 'keys', 'usr_admin', 'dev/tts'],
  ['view', 'keys', 'usr_admin', 'dev/voice-clone'],
  ['view', 'keys', 'usr_admin', 'dev/voice-design'],
  // the account's default model
  ['action', 'bare', 'usr_oper', 'setDefaultLlmAction', { choice: 'openai:gpt-5.5' }],
  ['action', 'bare', 'usr_admin', 'setDefaultLlmAction', { choice: 'nope:x' }],
  ['action', 'bare', 'usr_admin', 'setDefaultLlmAction', { choice: 'gemini:gemini-3.8-flash' }],
  ['action', 'bare', 'usr_admin', 'setDefaultLlmAction', { choice: '' }],
  ['action', 'bare', 'usr_admin', 'setDefaultLlmAction', { choice: null }],
  ['action', 'bare', 'usr_four', 'setDefaultLlmAction', { choice: 'openai:gpt-5.5' }],
  ['view', 'keys', 'usr_admin', 'models/lab'],
  // agent studio
  ['action', 'bare', 'usr_oper', 'saveAgentAction', { agentId: 'agt_live', draft: DRAFT }],
  ['action', 'bare', 'usr_admin', 'saveAgentAction', { agentId: 'agt_nope', draft: DRAFT }],
  ['action', 'bare', 'usr_admin', 'saveAgentAction', { agentId: 'agt_live', draft: DRAFT }],
  ['action', 'bare', 'usr_admin', 'saveAgentAction', { agentId: 'agt_draft', draft: { ...DRAFT, name: '   ', languages: ['ru', 'en'], status: 'paused', llmModel: 'bogus', ttsEngine: 'brb', ttsVoiceId: 'x', target: { fullName: '', birthYear: '', loanAmount: '', prompt: '' } } }],
  ['action', 'bare', 'usr_owner', 'saveAgentAction', { agentId: 'agt_paused', draft: { ...DRAFT, ttsEngine: '', ttsVoiceId: 'lZSeoYcz4phdvms888pn', llmModel: '' } }],
  ['action', 'bare', 'usr_owner', 'saveAgentAction', { agentId: 'agt_paused', draft: { ...DRAFT, ttsEngine: 'eleven_v4_turbo', ttsVoiceId: 'fytsqG6MLzC2aCSw7MLa' } }],
  ['view', 'bare', 'usr_admin', 'agent'],
  ['action', 'bare', 'usr_admin', 'setAgentStatusAction', { agentId: 'agt_draft', status: 'live' }],
  ['action', 'bare', 'usr_admin', 'setAgentStatusAction', { agentId: 'agt_draft', status: 'paused' }],
  ['action', 'bare', 'usr_admin', 'setAgentStatusAction', { agentId: 'agt_nope', status: 'draft' }],
  ['action', 'bare', 'usr_three', 'setAgentStatusAction', { agentId: 'agt_three', status: 'paused' }],
  ['action', 'bare', 'usr_admin', 'createAgentAction', { name: '  Sotuv  ' }],
  ['action', 'bare', 'usr_admin', 'createAgentAction', {}],
  ['action', 'bare', 'usr_two', 'createAgentAction', { name: 'Логистика' }],
  ['action', 'bare', 'usr_four', 'createAgentAction', { name: '' }],
  ['action', 'bare', 'usr_three', 'createAgentAction', { name: 'No' }],
  ['view', 'bare', 'usr_two', 'agent'],
  // custom voices
  ['action', 'bare', 'usr_admin', 'createDesignVoiceAction', { input: { name: '   ', attributes: ['female'] } }],
  ['action', 'bare', 'usr_admin', 'createDesignVoiceAction', { input: { name: 'Ovoz', attributes: [' ', ''] } }],
  ['action', 'bare', 'usr_admin', 'createDesignVoiceAction', { input: { name: 'Ovoz', attributes: ['Female', ' Robot '] } }],
  ['action', 'bare', 'usr_oper', 'createDesignVoiceAction', { input: { name: `  ${longText(58, '😀😀')}`, attributes: [' Female ', 'Young Adult', 'whisper', ''] } }],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', '  ']]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz']]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz'], ['refAudio', 'not a file']]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz'], ['refAudio', file('empty.wav', '')]]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz'], ['refAudio', file('silent.wav', 'RIFF-silent')]]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz'], ['refAudio', file('broken.wav', 'RIFF-broken')]]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Ovoz'], ['refAudio', file('null.wav', 'RIFF-null')]]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', ' Mening  ovozim '], ['refAudio', file('Sample.WAV', 'RIFF-sample-1')]]],
  ['form', 'bare', 'usr_oper', 'createCloneVoiceAction', [['name', 'Noext'], ['refAudio', file('recording', 'RIFF-sample-2', 'audio/webm')]]],
  ['form', 'bare', 'usr_admin', 'createCloneVoiceAction', [['name', 'Mp3'], ['refAudio', file('my.voice.Mp3', 'ID3-sample-3', 'audio/mpeg')]]],
  ['view', 'bare', 'usr_admin', 'dev/voice-clone'],
  ['view', 'bare', 'usr_admin', 'dev/voice-design'],
  ['view', 'bare', 'usr_admin', 'models/voices'],
  ['action', 'bare', 'usr_admin', 'deleteCustomVoiceAction', { voiceId: 'cv_two' }],
  ['action', 'bare', 'usr_admin', 'deleteCustomVoiceAction', { voiceId: 'cv_clone' }],
  ['action', 'bare', 'usr_admin', 'deleteCustomVoiceAction', { voiceId: 'cv_design' }],
  ['action', 'bare', 'usr_admin', 'deleteCustomVoiceAction', { voiceId: 'cv_design' }],
  ['view', 'bare', 'usr_admin', 'dev/tts'],
  // the Playground's chat and history
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: null, utterance: '   ' } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: null, utterance: 'Salom', agentId: 'agt_nope' } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: 'call_nope', utterance: 'Salom' } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: 'call_two', utterance: 'Salom' } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: null, utterance: 'Ish vaqtingiz qanday?' } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: '$call', utterance: 'Operator bilan gaplashmoqchiman', sttMs: 120 } }],
  ['action', 'bare', 'usr_admin', 'playgroundTurnAction', { params: { callId: null, utterance: 'Salom', agentId: 'agt_draft', sttMs: 55 } }],
  // The chats just held move to a fixed time with fixed latencies, so their bills (by the second) are the same on both sides.
  ['sql', 'bare', 'usr_admin', 'time travel', [
    `UPDATE calls SET started_at = '2026-11-07T10:00:00.000Z',
       answered_at = CASE WHEN answered_at IS NULL THEN NULL ELSE '2026-11-07T10:00:00.000Z' END,
       first_response_ms = CASE WHEN first_response_ms IS NULL THEN NULL ELSE 800 END,
       avg_latency_ms = CASE WHEN avg_latency_ms IS NULL THEN NULL ELSE 800 END,
       p95_latency_ms = CASE WHEN p95_latency_ms IS NULL THEN NULL ELSE 800 END
     WHERE started_at >= '$RUN_START'`,
    `UPDATE turns SET created_at = strftime('%Y-%m-%dT%H:%M:%f', '2026-11-07T10:00:00', '+' || (ordinal * 7) || ' seconds') || 'Z',
       latency_ms = CASE WHEN latency_ms IS NULL THEN NULL ELSE 800 END,
       timings_json = CASE WHEN timings_json IS NULL THEN NULL ELSE '{"sttMs":0,"totalMs":800}' END
     WHERE created_at >= '$RUN_START'`,
  ]],
  ['action', 'bare', 'usr_admin', 'listPlaygroundChatsAction', { agentId: 'agt_live' }],
  ['action', 'bare', 'usr_admin', 'listPlaygroundChatsAction', { agentId: 'agt_draft' }],
  ['action', 'bare', 'usr_two', 'listPlaygroundChatsAction', { agentId: 'agt_live' }],
  ['action', 'bare', 'usr_admin', 'loadPlaygroundChatAction', { callId: 'call_pg2' }],
  ['action', 'bare', 'usr_admin', 'loadPlaygroundChatAction', { callId: 'call_pg1' }],
  ['action', 'bare', 'usr_admin', 'loadPlaygroundChatAction', { callId: 'call_voice' }],
  ['action', 'bare', 'usr_admin', 'loadPlaygroundChatAction', { callId: 'call_two' }],
  ['action', 'bare', 'usr_admin', 'endPlaygroundCallAction', { callId: '$call', csat: 5 }],
  ['action', 'bare', 'usr_admin', 'endPlaygroundCallAction', { callId: '$call', csat: 5 }],
  ['action', 'bare', 'usr_admin', 'endPlaygroundCallAction', { callId: 'call_pg3' }],
  ['action', 'bare', 'usr_admin', 'endPlaygroundCallAction', { callId: 'call_nope', csat: 4 }],
  ['action', 'bare', 'usr_admin', 'loadPlaygroundChatAction', { callId: '$call' }],
  // onboarding
  ['action', 'bare', 'usr_oper', 'completeOnboardingAction', { payload: { greeting: 'x', primaryLang: 'uz', languages: ['uz'], voiceId: 'laylo', persona: 'calm', goLive: true } }],
  ['action', 'bare', 'usr_admin', 'completeOnboardingAction', { payload: { greeting: 'Salom!', primaryLang: 'ru', languages: [], voiceId: 'isomiddin', persona: 'calm', goLive: true } }],
  ['action', 'bare', 'usr_two', 'completeOnboardingAction', { payload: { greeting: 'Привет', primaryLang: 'ru', languages: ['ru', 'uz'], voiceId: 'laylo', persona: 'friendly', goLive: false } }],
  ['action', 'bare', 'usr_three', 'skipOnboardingAction', {}],
  ['action', 'bare', 'usr_four', 'skipOnboardingAction', {}],
];

/* ── the transcript scorer ───────────────────────────────────── */

const SCORING = [
  ['Assalomu alaykum!', 'assalomu alaykum'],
  ['Buyurtmangiz 25-noyabr kuni soat 14:30 da yetkaziladi.', 'buyurtmangiz yigirma beshinchi noyabr kuni soat 14 30 da yetkaziladi'],
  ['Telefon: 7 800 000 so‘m', 'telefon 7800000 som'],
  ['bir ikki uch to‘rt', '1 2 3 4'],
  ['Men bir daqiqa kutaman', 'men bir daqiqa kutaman'],
  ['Ўзбекистон пойтахти Тошкент', 'O‘zbekiston poytaxti Toshkent'],
  ['ma’muriy bayonnoma ta’zim', "mamuriy bayonnoma ta'zim"],
  ["g'isht o'rdak `g‘alla´", 'gisht ordak galla'],
  ['30da uchrashamiz', '30 da uchrashamiz'],
  ['  ', 'anything'],
  ['Salom', ''],
  ['Здравствуйте, какие у вас цены?', 'здравствуйте какие у вас цены'],
  ['Emoji 😀 test', 'emoji test'],
  ["' o' '' g'' ''x", 'o g x'],
  ['Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.', 'shifokor qabuliga yozilish uchun ismingizni ayting'],
  ['ÄÖÜ ß İstanbul', 'äöü ss istanbul'],
  ['Ikki ming yigirma oltinchi yil', '2026-yil'],
  ['nol nol yetti', '007'],
  ['A\tB\nC D', 'a b c d'],
];

/* ── the benchmark, with scripted engines ────────────────────── */

const CLOCK_STEPS = [120.5, 37.25, 250, 3.125, 980.75, 61];
let clockAt = 1000;
let clockIndex = 0;
const clock = () => {
  clockAt += CLOCK_STEPS[clockIndex++ % CLOCK_STEPS.length];
  return clockAt;
};

const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks', 'stt-uz', 'set.json'), 'utf8'));
const CLIP_SHA1 = SET.clips.map((c) => crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'benchmarks', 'stt-uz', c.file))).digest('hex'));
const BENCH = {
  clipSha1: CLIP_SHA1,
  sttReady: { kotib: true, whisper: true, gapi: true, local: false, speko: false, gemini: true, scribe: true, brb: false },
  // What each engine "hears" per clip; null = the engine throws.
  stt: {
    kotib: SET.clips.map((c) => c.text),
    gapi: SET.clips.map((c, i) => (i === 3 ? null : c.text.replace(/[aeiou]/g, i % 2 ? 'o' : 'a').toUpperCase())),
    gemini: SET.clips.map((c, i) => (i % 4 === 0 ? '' : c.text.split(' ').slice(1).join(' '))),
    scribe: SET.clips.map(() => null),
  },
  ttsReady: { default: true, brb: false, eleven_v3_conversational: true, eleven_v4_turbo: true },
  zipformer: true,
  // Per sentence: {firstMs, totalMs, spoken, pcmBytes}; null = the render throws.
  tts: {
    default: [
      { firstMs: 210.5, totalMs: 890.25, spoken: 'Assalomu alaykum! Buyurtmangiz yigirma beshinchi noyabr kuni', pcmBytes: 1000 },
      { firstMs: 190, totalMs: 700, spoken: 'Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.', pcmBytes: 1002 },
      { firstMs: 333.333, totalMs: 1200.1, spoken: 'Kechirasiz, bu savolga javob bera olmayman.', pcmBytes: 1004 },
    ],
    eleven_v3_conversational: [null, null, null],
    eleven_v4_turbo: [
      { firstMs: 99.9, totalMs: 450.45, spoken: 'Assalomu alaykum!', pcmBytes: 2000 },
      null,
      { firstMs: 120, totalMs: 480, spoken: 'Kechirasiz.', pcmBytes: 2002 },
    ],
  },
  // What Zipformer hears back, by WAV size (44-byte header + pcm); a size not listed throws.
  heard: { 1044: 'assalomu alaykum buyurtmangiz 25 noyabr kuni', 1046: 'shifokor qabuliga yozilish uchun', 2044: 'assalomu aleykum', 2046: 'kechirasiz' },
  llmReady: ['openai', 'gemini'],
  // Per model and question: {deltas, answer, engine}; null = generateAnswer throws.
  llm: {
    'openai:gpt-5.5': [
      { deltas: 3, answer: 'Toshkent.', engine: 'openai:gpt-5.5' },
      { deltas: 0, answer: 'Yetti kun.', engine: 'openai:gpt-5.5' },
      { deltas: 1, answer: '100 darajada.', engine: 'openai:gpt-5.5' },
    ],
    'openai:gpt-6.1-sol': [
      { deltas: 2, answer: 'Toshkent', engine: 'claude:claude-haiku-5-5 (fallback)' },
      { deltas: 0, answer: '', engine: 'openai:gpt-6.1-sol' },
      null,
    ],
    'gemini:gemini-3.8-flash': [
      { deltas: 0, answer: 'Bilmayman', engine: 'local' },
      { deltas: 4, answer: 'Yetti', engine: 'gemini:gemini-3.8-flash' },
      { deltas: 1, answer: 'Yuz daraja', engine: 'gemini:gemini-3.8-flash' },
    ],
    'gemini:gemini-3.5-flash-lite': [
      { deltas: 0, answer: 'Toshkent', engine: 'gemini:gemini-3.5-flash-lite' },
      { deltas: 2, answer: '  ', engine: 'gemini:gemini-3.5-flash-lite' },
      { deltas: 0, answer: 'Yuz', engine: 'gemini:gemini-3.5-flash-lite' },
    ],
  },
};
const DEFAULT_LLM = (deltas) => ({ deltas, answer: 'Javob', engine: 'x' });

async function benchmarkSection() {
  const stt = require(path.join(ROOT, 'src/lib/speech/stt.ts'));
  const tts = require(path.join(ROOT, 'src/lib/speech/tts.ts'));
  const zipformer = require(path.join(ROOT, 'src/lib/speech/zipformer.ts'));
  const provider = require(path.join(ROOT, 'src/lib/llm/provider.ts'));
  Object.defineProperty(performance, 'now', { value: clock, configurable: true, writable: true });
  stt.sttEngineIds = () => ({ ...BENCH.sttReady });
  stt.transcribeOne = async (engine, audio) => {
    const i = CLIP_SHA1.indexOf(crypto.createHash('sha1').update(Buffer.from(audio)).digest('hex'));
    const heard = BENCH.stt[engine][i];
    if (heard === null) throw new Error(`${engine} failed`);
    return { text: heard, engine, language: 'uz' };
  };
  tts.ttsEngines = () => ({ ...BENCH.ttsReady });
  tts.renderTimed = async (sentence, opts) => {
    const out = BENCH.tts[opts.engine][TTS_INDEX(sentence)];
    if (!out || opts.tenantId !== 'bench' || opts.language !== 'uz') throw new Error('render failed');
    return { pcm: Buffer.alloc(out.pcmBytes, opts.voiceId.length), firstMs: out.firstMs, totalMs: out.totalMs, spoken: out.spoken };
  };
  zipformer.zipformerAvailable = () => BENCH.zipformer;
  zipformer.transcribeWav = (wav) => {
    const heard = BENCH.heard[wav.length];
    if (heard === undefined) throw new Error('zipformer failed');
    return heard;
  };
  provider.llmProviderReady = (p) => BENCH.llmReady.includes(p);
  provider.generateAnswer = async (input, onDelta) => {
    const script = BENCH.llm[input.llm] ?? LLM_QUESTIONS.map(() => DEFAULT_LLM(1));
    const out = script[LLM_QUESTIONS.indexOf(input.question)];
    if (!out) throw new Error('model failed');
    for (let i = 0; i < out.deltas; i++) onDelta?.('piece');
    return { answer: out.answer, engine: out.engine, intent: 'faq', answered: true, usedHits: [] };
  };
  const benchmark = require(path.join(ROOT, 'src/lib/benchmark.ts'));
  const lab = require(path.join(ROOT, 'src/lib/lab.ts'));
  last = snapshot();
  const first = await benchmark.runBenchmark('build-42');
  const rows = changes();
  const again = await benchmark.runBenchmark('build-42');
  return { ...BENCH, clockSteps: CLOCK_STEPS, first, again, rows, latest: mask(benchmark.latestBenchmarks()), stats: mask(lab.modelStats()) };
}
const TTS_SENTENCES = [
  'Assalomu alaykum! Buyurtmangiz 25-noyabr kuni soat 14:30 da yetkaziladi.',
  'Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.',
  'Kechirasiz, bu savolga javob bera olmayman, sizni mutaxassisga ulayman.',
];
const TTS_INDEX = (s) => TTS_SENTENCES.indexOf(s);
const LLM_QUESTIONS = ['O‘zbekistonning poytaxti qaysi shahar?', 'Bir haftada necha kun bor?', 'Suv necha darajada qaynaydi?'];

/* ── run ─────────────────────────────────────────────────────── */

(async () => {
  const out = { rev: REV, secret: SECRET, profiles: PROFILES, sttUrl: STT_URL, seed: SEED, cloneSample: CLONE_SAMPLE.toString('base64'), steps: [] };
  out.localSynth = Object.fromEntries(['uz', 'uz-Cyrl', 'ru', 'en'].map((l) => [l, translator(l)('play.localSynth', 'Local synthesiser')]));
  let lastCall = null;
  for (const [kind, profile, user, name, args] of STEPS) {
    useProfile(profile);
    cookie = tokenFor(user);
    const step = { kind, profile, user, name, args: args ?? null };
    if (kind === 'sql') {
      for (const statement of args) db.run(statement.replaceAll('$RUN_START', RUN_START));
    } else if (kind === 'view') {
      calls.revalidate = [];
      Object.assign(step, mask(await renderPage(name, args)));
    } else {
      const resolved = JSON.parse(JSON.stringify(args).replaceAll('"$call"', JSON.stringify(lastCall)));
      step.args = resolved;
      const r = kind === 'form' ? await runAction(name, null, resolved) : await runAction(name, resolved);
      Object.assign(step, r);
      if (name === 'playgroundTurnAction' && r.result && r.result.callId && !lastCall) lastCall = r.result.callId;
      if (kind === 'form') step.uploads = uploads();
    }
    // Background work (webhooks) settles before the rows are read.
    await new Promise((res) => setTimeout(res, 5));
    step.rows = changes();
    out.steps.push(step);
  }
  out.sttRequests = sttRequests;
  out.idsUsed = idCounter;
  out.scoring = SCORING.map(([ref, heard]) => {
    const scoring = require(path.join(ROOT, 'src/lib/speech/scoring.ts'));
    return { ref, heard, normRef: scoring.normalizeForScoring(ref), normHeard: scoring.normalizeForScoring(heard), score: scoring.score(ref, heard) };
  });
  useProfile('bare');
  out.benchmark = await benchmarkSection();
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + '\n');
  const errors = out.steps.filter((s) => s.error && s.error.startsWith('throws')).map((s) => `${s.name}: ${s.error}`);
  console.log(`steps ${out.steps.length}, ids ${idCounter}, unexpected errors: ${errors.length ? errors.join('; ') : 'none'}`);
  console.log(`benchmark rows ${JSON.stringify(Object.fromEntries(Object.entries(out.benchmark.rows).map(([t, c]) => [t, c.added.length])))}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
