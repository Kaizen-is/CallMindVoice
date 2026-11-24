// Reference behaviour of the ORIGINAL TypeScript traffic simulator and demo-history generator
// (src/lib/engine/simulator.ts, demo-data.ts, seededRandom in utils.ts) on a real SQLite database
// with the local answer engine, the clock pinned and the zone Asia/Tashkent: the random streams,
// every row written (calls, turns, escalations, daily usage, invoices) and the bus events.
// Usage: node --experimental-sqlite make-golden-ops.cjs <golden_rag.json> <output.json> <workdir>
process.env.TZ = 'Asia/Tashkent';
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
const RAG = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUTPUT = path.resolve(process.argv[3]);
const WORK = process.argv[4];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db

// The clock stands still (timers still run): every timestamp and duration is reproducible.
const NOW = Date.parse('2026-11-12T05:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
};

class NoClaude { constructor() { throw new Error('no claude in this run'); } }
const stubs = { 'server-only': {}, '@anthropic-ai/sdk': Object.assign(NoClaude, { default: NoClaude }), '@/lib/usage-log': { recordUsage: () => {}, withUsageSource: (_s, _t, fn) => fn() } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
globalThis.fetch = async () => { throw new Error('offline'); };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'LLM_PROVIDER']) delete process.env[k];

const db = require(path.join(OUT, 'lib/db.js'));
const bus = require(path.join(OUT, 'lib/engine/bus.js'));
const utils = require(path.join(OUT, 'lib/utils.js'));
const simulator = require(path.join(OUT, 'lib/engine/simulator.js'));
const demo = require(path.join(OUT, 'lib/engine/demo-data.js'));

const STAMP = '2026-11-01T05:00:00.000Z';
const SEED = {
  tenants: [{ id: 't1', name: 'Medline', slug: 'medline', balance_uzs: 50000, created_at: STAMP, updated_at: STAMP }],
  agents: [{ id: 'agt_rec', tenant_id: 't1', name: 'Laylo', status: 'live', persona: 'friendly', greeting: 'Assalomu alaykum!', primary_lang: 'uz', voice_id: 'laylo', languages_json: '["uz","ru","en"]', max_turns: 20, confidence_threshold: 0.3, escalation_json: '{"onLowConfidence":false,"maxFailedTurns":9}', created_at: STAMP, updated_at: STAMP }],
  phone_numbers: [{ id: 'num_main', tenant_id: 't1', e164: '+998712345678', label: 'Main', agent_id: 'agt_rec', status: 'active', created_at: STAMP }],
  documents: [...new Map(RAG.corpus.map((c) => [c.document_id, { id: c.document_id, tenant_id: 't1', title: c.title, source_type: 'text', status: 'ready', created_at: STAMP, updated_at: STAMP }])).values()],
  chunks: RAG.corpus.map((c, i) => ({ id: c.id, tenant_id: 't1', document_id: c.document_id, ordinal: i, heading: c.heading, text: c.text, token_count: c.token_count, embedding: { b64: c.embedding }, terms_json: c.terms_json, created_at: STAMP })),
};
function insert(table, row) {
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => (row[k] && row[k].b64 ? Buffer.from(row[k].b64, 'base64') : row[k])));
}
for (const [table, rows] of Object.entries(SEED)) for (const row of rows) insert(table, row);

const RANDOM_SEEDS = ['', 'a', 't1:demo', 'тест', '😀x', 'burst:0:1731390000000', 'ten_0c1abuwrqsyz2n7k:0.7234567891234567'];
const SIM_SEEDS = Array.from({ length: 36 }, (_, i) => ({
  seed: `golden:${i}`,
  language: [undefined, 'ru', 'en', 'uz'][i % 4],
  difficulty: [undefined, 0, 0.5, 1, 0.25, 0.9][i % 6],
}));

const events = [];
bus.subscribe('t1', (e) => events.push(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Measured latencies differ run to run; whether they are set does not.
const LATENCY = ['latency_ms', 'first_response_ms', 'avg_latency_ms', 'p95_latency_ms'];
const maskLatency = (row) => { const out = { ...row }; for (const k of LATENCY) if (k in out) out[k] = out[k] === null ? null : 'x'; if (out.timings_json && out.timings_json !== '{}') out.timings_json = Object.keys(JSON.parse(out.timings_json)).join(','); return out; };
const noId = ({ id, ...rest }) => rest;

function rowsOf(callId) {
  return {
    call: maskLatency(noId(db.get('SELECT * FROM calls WHERE id=?', callId))),
    turns: db.all('SELECT * FROM turns WHERE call_id=? ORDER BY ordinal', callId).map((t) => maskLatency(noId({ ...t, call_id: 'x' }))),
    escalations: db.all('SELECT * FROM escalations WHERE call_id=?', callId).map((e) => noId({ ...e, call_id: 'x' })),
  };
}

(async () => {
  const out = { now: new RealDate(NOW).toISOString(), timeZone: 'Asia/Tashkent', seed: { ...SEED, chunks: SEED.chunks.length }, random: {}, simulator: [], demo: {} };

  for (const s of RANDOM_SEEDS) {
    const rng = utils.seededRandom(s);
    const values = Array.from({ length: 8 }, () => rng());
    for (let i = 8; i < 999; i++) rng();
    values.push(rng());
    out.random[s] = values;
  }

  // One simulated call at a time, at full speed; each runs to its end before the next starts.
  for (const s of SIM_SEEDS) {
    events.length = 0;
    const callId = await simulator.simulateCall({ tenantId: 't1', seed: s.seed, language: s.language, difficulty: s.difficulty, speed: 1e9 });
    const loadAtStart = simulator.simulatorLoad('t1');
    while (simulator.simulatorLoad('t1') > 0) await sleep(5);
    await sleep(20);
    out.simulator.push({ ...s, loadAtStart, rows: rowsOf(callId), events: events.map((e) => ({ ...e, callId: 'x', ...('escalationId' in e ? { escalationId: 'x' } : {}), ...('latencyMs' in e ? { latencyMs: 'x' } : {}) })) });
  }
  db.run('DELETE FROM escalations'); db.run('DELETE FROM turns'); db.run('DELETE FROM calls'); db.run('DELETE FROM usage_daily'); db.run('DELETE FROM wallet_ledger'); db.run('DELETE FROM knowledge_gaps');

  // The demo history, twice: the second run finds the invoices and adds to the same days.
  // Days whose average latency includes a replayed call (measured, so not compared).
  const measuredDays = () => db.all("SELECT DISTINCT substr(ended_at, 1, 10) AS d FROM calls WHERE id IN (SELECT call_id FROM turns WHERE latency_ms IS NOT NULL)").map((r) => r.d);
  const tables = () => {
    const measured = new Set(measuredDays());
    return {
      calls: db.all('SELECT * FROM calls ORDER BY started_at, from_e164, caller_name').map((c) => maskLatency(noId(c))),
      escalations: db.all('SELECT e.*, c.started_at AS call_started, c.from_e164 AS call_from FROM escalations e JOIN calls c ON c.id = e.call_id ORDER BY c.started_at, c.from_e164, e.created_at').map((e) => noId({ ...e, call_id: 'x' })),
      usage_daily: db.all('SELECT * FROM usage_daily ORDER BY day').map((u) => noId(measured.has(u.day) ? { ...u, avg_latency_ms: 'x' } : u)),
      invoices: db.all('SELECT * FROM invoices ORDER BY period').map(noId),
    };
  };
  const opts = { tenantId: 't1', days: 9, perDay: 14, liveCalls: 4 };
  out.demo.first = await demo.seedDemoHistory(opts);
  out.demo.afterFirst = tables();
  out.demo.second = await demo.seedDemoHistory(opts);
  out.demo.afterSecond = tables();
  out.demo.measuredDays = measuredDays();
  out.demo.cleared = demo.clearDemoHistory('t1');
  out.demo.noAgent = await demo.seedDemoHistory({ tenantId: 'nobody' });

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 1));
  console.log('simulator calls', out.simulator.length, 'outcomes', [...new Set(out.simulator.map((s) => `${s.rows.call.status}/${s.rows.call.outcome}`))].join(' '));
  console.log('demo', JSON.stringify(out.demo.first), 'calls', out.demo.afterSecond.calls.length, 'cleared', out.demo.cleared);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
