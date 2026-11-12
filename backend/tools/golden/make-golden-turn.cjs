// Reference behaviour of the ORIGINAL TypeScript turn engine (runTurn in
// src/lib/engine/conversation.ts, startCall/endCall in calls.ts) on a real SQLite database, with
// the local answer engine (no model keys): what each turn returns, what it writes (turns, calls,
// knowledge gaps, escalations, daily usage, wallet) and what it publishes on the bus.
// Usage: node make-golden-turn.cjs <golden_rag.json> <output.json> <workdir>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
const RAG = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const WORK = process.argv[4];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db

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
const calls = require(path.join(OUT, 'lib/engine/calls.js'));
const conversation = require(path.join(OUT, 'lib/engine/conversation.js'));

const STAMP = '2026-11-12T05:00:00.000Z';
const SEED = {
  tenants: [{ id: 't1', name: 'Medline', slug: 'medline', balance_uzs: 50000, created_at: STAMP, updated_at: STAMP }],
  agents: [
    { id: 'agt_rec', tenant_id: 't1', name: 'Laylo', status: 'live', persona: 'friendly', greeting: 'Assalomu alaykum!', primary_lang: 'uz', voice_id: 'laylo', max_turns: 4, confidence_threshold: 0.55, escalation_json: '{"maxFailedTurns":3}', created_at: STAMP, updated_at: STAMP },
    { id: 'agt_loan', tenant_id: 't1', name: 'Isomiddin', status: 'draft', persona: 'professional', greeting: 'Salom', primary_lang: 'uz', voice_id: 'isomiddin', max_turns: 20, confidence_threshold: 0.6, escalation_json: '{}', target_json: JSON.stringify({ fullName: 'Aziz Karimov', birthYear: '1992', loanAmount: '1 000 000', prompt: '' }), created_at: STAMP, updated_at: STAMP },
    { id: 'agt_hours', tenant_id: 't1', name: 'Kecha', status: 'draft', persona: 'concise', greeting: '', primary_lang: 'ru', voice_id: 'laylo', max_turns: 20, confidence_threshold: 0.55, escalation_json: '{"afterHoursAction":"voicemail","onLowConfidence":false}', hours_json: JSON.stringify({ enabled: true, timezone: 'Asia/Tashkent', days: { 0: { open: '00:00', close: '00:01', closed: false }, 1: { open: '00:00', close: '00:01', closed: false }, 2: { open: '00:00', close: '00:01', closed: false }, 3: { open: '00:00', close: '00:01', closed: false }, 4: { open: '00:00', close: '00:01', closed: false }, 5: { open: '00:00', close: '00:01', closed: false }, 6: { open: '00:00', close: '00:01', closed: false } } }), created_at: STAMP, updated_at: STAMP },
  ],
  documents: [...new Map(RAG.corpus.map((c) => [c.document_id, { id: c.document_id, tenant_id: 't1', title: c.title, source_type: 'text', status: 'ready', created_at: STAMP, updated_at: STAMP }])).values()],
  chunks: RAG.corpus.map((c, i) => ({ id: c.id, tenant_id: 't1', document_id: c.document_id, ordinal: i, heading: c.heading, text: c.text, token_count: c.token_count, embedding: { b64: c.embedding }, terms_json: c.terms_json, created_at: STAMP })),
};
function insert(table, row) {
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => (row[k] && row[k].b64 ? Buffer.from(row[k].b64, 'base64') : row[k])));
}
for (const [table, rows] of Object.entries(SEED)) for (const row of rows) insert(table, row);

const SCRIPTS = [
  { name: 'receptionist_voice', agent: 'agt_rec', channel: 'voice', lines: ['Assalomu alaykum', 'Ish vaqtingiz qanday?', 'dam olish kunlari-chi?', 'Kosmosga uchish narxi qancha bo‘ladi?', 'Yana bir savol: marsga chipta?', 'Rahmat, xayr'], end: { outcome: 'resolved_by_ai', csat: 5, endedAt: '2026-11-12T05:03:30.500Z' } },
  { name: 'receptionist_human', agent: 'agt_rec', channel: 'web', lines: ['Operator bilan gaplashmoqchiman'], end: { outcome: 'resolved_by_operator', csat: null, endedAt: '2026-11-12T05:00:00.400Z' } },
  { name: 'angry_web', agent: 'agt_rec', channel: 'web', lines: ['Bu dahshat, juda yomon xizmat, jahlim chiqdi!'] },
  { name: 'loan_call', agent: 'agt_loan', channel: 'voice', lines: ['Allo', 'Operator kerak', 'Pulim yo‘q, juda yomon ahvoldaman'] },
  { name: 'after_hours_ru', agent: 'agt_hours', channel: 'voice', lines: ['Здравствуйте, какие у вас цены?', 'До свидания'], end: { outcome: 'abandoned', csat: null, endedAt: '2026-11-12T06:00:00.000Z' } },
];

const events = [];
bus.subscribe('t1', (e) => events.push(e));

const mask = (r) => ({ ...r, timings: { sttMs: r.timings.sttMs, ttsMs: r.timings.ttsMs } });

(async () => {
  const out = { seed: SEED, scripts: [] };
  for (const sc of SCRIPTS) {
    const agent = db.get('SELECT * FROM agents WHERE id=?', sc.agent);
    const callId = calls.startCall({ tenantId: 't1', agentId: agent.id, from: '+998901112233', to: '+998712000000', channel: sc.channel, language: agent.primary_lang, startedAt: STAMP });
    const results = [];
    for (const [i, line] of sc.lines.entries()) {
      const r = await conversation.runTurn({ tenantId: 't1', callId, agent, utterance: line, sttMs: 100 + i });
      results.push(mask(r));
    }
    let ended = null;
    if (sc.end) ended = calls.endCall({ tenantId: 't1', callId, ...sc.end });
    const turns = db.all('SELECT ordinal, role, text, language, confidence, citations_json, timings_json, latency_ms IS NOT NULL AS has_latency FROM turns WHERE call_id=? ORDER BY ordinal', callId)
      .map((t) => ({ ...t, timings_json: t.timings_json && t.timings_json !== '{}' ? Object.keys(JSON.parse(t.timings_json)).join(',') + '|tts=' + JSON.parse(t.timings_json).ttsMs + '|stt=' + JSON.parse(t.timings_json).sttMs : t.timings_json }));
    const call = db.get('SELECT direction, channel, status, outcome, language, intent, sentiment, confidence, csat, turns, duration_ms, first_response_ms IS NOT NULL AS has_frm, avg_latency_ms IS NOT NULL AS has_avg, cost_usd, escalated, escalation_reason, summary, answered_at IS NOT NULL AS answered, ended_at FROM calls WHERE id=?', callId);
    const escalations = db.all('SELECT reason, priority, status, summary FROM escalations WHERE call_id=?', callId);
    out.scripts.push({ ...sc, results, ended: ended && { durationMs: ended.durationMs, cost: ended.cost }, turns, call, escalations });
  }
  out.gaps = db.all('SELECT question, hits, best_score, status FROM knowledge_gaps ORDER BY question');
  out.usageDaily = db.all('SELECT day, calls, ai_resolved, escalated, abandoned, minutes, cost_usd, csat_sum, csat_count FROM usage_daily ORDER BY day');
  out.wallet = { balance: db.get('SELECT balance_uzs FROM tenants WHERE id=?', 't1').balance_uzs, ledger: db.all("SELECT kind, amount_uzs, balance_after, note FROM wallet_ledger ORDER BY created_at, rowid") };
  out.events = events.map((e) => ({ ...e, ...(e.callId ? { callId: 'x' } : {}), ...(e.escalationId ? { escalationId: 'x' } : {}), ...('latencyMs' in e ? { latencyMs: 'x' } : {}) }));
  fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
  for (const s of out.scripts) console.log(s.name.padEnd(22), s.results.map((r) => `${r.intent}/${r.escalate ?? '-'}/${r.answered}`).join(' '));
  console.log('gaps', out.gaps.length, 'events', out.events.length, 'wallet', JSON.stringify(out.wallet.balance));
})();
