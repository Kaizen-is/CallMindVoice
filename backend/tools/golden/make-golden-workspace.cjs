// Reference behaviour of the ORIGINAL TypeScript for the workspace administration and dashboards
// port: the data each page computed (src/app/app/{page,analytics/page,numbers/page,team/page,
// settings/page,developers/page}.tsx, billing/billing-view.tsx — the data-loading lines copied
// as they were, run on the compiled src/lib) and the server actions of src/app/actions/ops.ts
// (run for real, with a frozen clock), on a seeded SQLite database.
//
// Compile first, from a checkout of commit b68a116 (after the port, ops.ts is a thin proxy):
//   npx tsc -p backend/tools/golden/tsconfig-workspace.json
// Usage: node --experimental-sqlite make-golden-workspace.cjs <output.json> <workdir>
//
// The approved fix is applied to the reference too: intents() groups by COALESCE(intent,'general')
// (the original SQL is kept in `intentsOriginal` to show the difference).
process.env.TZ = 'Asia/Tashkent'; // hourlyHeat buckets by local time; the Python test uses the same zone
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OUT = path.join(__dirname, 'out');
const OUTPUT = path.resolve(process.argv[2]); // before the chdir below
const WORK = process.argv[3];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db

// ── frozen clock ────────────────────────────────────────────────────
const NOW = '2026-11-17T09:30:00.000Z';
const NOW_MS = Date.parse(NOW);
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW_MS);
    else super(...args);
  }
  static now() {
    return NOW_MS;
  }
}
globalThis.Date = FakeDate;
const ago = (days, hours = 0, minutes = 0, ms = 0) =>
  new RealDate(NOW_MS - days * 864e5 - hours * 36e5 - minutes * 6e4 - ms).toISOString();

// ── stubs ───────────────────────────────────────────────────────────
const SECRET = 'test-secret-öçü-2026';
process.env.OVOZ_SESSION_SECRET = SECRET;
const PROVIDER_ENV = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_EMBEDDING_MODEL', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'LLM_PROVIDER', 'BRIDGE_SHARED_SECRET'];
for (const k of PROVIDER_ENV) delete process.env[k];

let currentToken = null;
const revalidated = [];
class NoClaude { constructor() { throw new Error('no claude in this run'); } }
const stubs = {
  'server-only': {},
  '@anthropic-ai/sdk': Object.assign(NoClaude, { default: NoClaude }),
  '@/lib/usage-log': { recordUsage: () => {}, withUsageSource: (_s, _t, fn) => fn() },
  'next/cache': { revalidatePath: (...args) => revalidated.push(args) },
  'next/headers': {
    cookies: async () => ({
      get: (name) => (name === 'ovoz_session' && currentToken ? { name, value: currentToken } : undefined),
      getAll: () => (currentToken ? [{ name: 'ovoz_session', value: currentToken }] : []),
      set: () => {},
      delete: () => {},
    }),
    headers: async () => new Map(),
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
globalThis.fetch = async () => { throw new Error('offline'); };

const db = require(path.join(OUT, 'lib/db.js'));
const A = require(path.join(OUT, 'lib/analytics.js'));
const calls = require(path.join(OUT, 'lib/engine/calls.js'));
const catalog = require(path.join(OUT, 'lib/catalog.js'));
const choice = require(path.join(OUT, 'lib/llm/choice.js'));
const provider = require(path.join(OUT, 'lib/llm/provider.js'));
const embed = require(path.join(OUT, 'lib/rag/embed.js'));
const status = require(path.join(OUT, 'lib/telephony/status.js'));
const utils = require(path.join(OUT, 'lib/utils.js'));
const auth = require(path.join(OUT, 'lib/auth.js'));
const ops = require(path.join(OUT, 'app/actions/ops.js'));

// analytics.ts with the approved fix, compiled from the same source with the one line changed.
const fixedSource = fs
  .readFileSync(path.join(OUT, 'lib/analytics.js'), 'utf8')
  .replace('GROUP BY intent ORDER BY c DESC LIMIT ?', "GROUP BY COALESCE(intent,'general') ORDER BY c DESC LIMIT ?");
if (!fixedSource.includes("GROUP BY COALESCE(intent,'general')")) throw new Error('intents() SQL not found');
const fixedModule = new Module(path.join(OUT, 'lib/analytics-fixed.js'), module);
fixedModule.filename = path.join(OUT, 'lib/analytics-fixed.js');
fixedModule.paths = Module._nodeModulePaths(path.join(OUT, 'lib'));
fixedModule._compile(fixedSource, fixedModule.filename);
const AF = fixedModule.exports;

// ── seed ────────────────────────────────────────────────────────────
let seedState = 12345;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const T1 = 'ten_main', T2 = 'ten_other', T3 = 'ten_low';
const STAMP = ago(120);
const SEED = {
  tenants: [
    { id: T1, name: 'Medline', slug: 'medline', industry: 'healthcare', plan: 'trial', balance_uzs: 250000, settings_json: '{}', created_at: STAMP, updated_at: STAMP },
    { id: T2, name: 'Other Co', slug: 'other', plan: 'pro', balance_uzs: -500, settings_json: '{}', created_at: STAMP, updated_at: STAMP },
    { id: T3, name: 'Low Bank', slug: 'low', plan: 'trial', balance_uzs: 99999, settings_json: '{"llmModel":"gemini:gemini-3.8-flash"}', created_at: STAMP, updated_at: STAMP },
  ],
  users: [
    { id: 'usr_owner', tenant_id: T1, email: 'owner@example.uz', name: 'Olga', password_hash: 'x', role: 'owner', avatar_hue: 10, locale: 'uz', status: 'active', presence: 'online', last_seen_at: ago(0, 1), created_at: ago(100), updated_at: ago(100) },
    { id: 'usr_admin', tenant_id: T1, email: 'admin@example.uz', name: 'Aziz', password_hash: 'x', role: 'admin', avatar_hue: 200, locale: 'en', status: 'active', presence: 'offline', last_seen_at: null, created_at: ago(90), updated_at: ago(90) },
    { id: 'usr_op', tenant_id: T1, email: 'op@example.uz', name: 'Bek', password_hash: 'x', role: 'operator', avatar_hue: 120, locale: 'ru', status: 'active', presence: 'away', last_seen_at: ago(2), created_at: ago(80), updated_at: ago(80) },
    { id: 'usr_op2', tenant_id: T1, email: 'op2@example.uz', name: 'Gulnora', password_hash: 'x', role: 'operator', avatar_hue: 300, locale: 'uz', status: 'invited', presence: 'offline', last_seen_at: null, created_at: ago(70), updated_at: ago(70) },
    { id: 'usr_an', tenant_id: T1, email: 'an@example.uz', name: 'Dilnoza', password_hash: 'x', role: 'analyst', avatar_hue: 45, locale: 'en', status: 'active', presence: 'offline', last_seen_at: null, created_at: ago(60), updated_at: ago(60) },
    { id: 'usr_other', tenant_id: T2, email: 'other@example.uz', name: 'Otabek', password_hash: 'x', role: 'operator', avatar_hue: 90, locale: 'uz', status: 'active', presence: 'offline', last_seen_at: null, created_at: ago(50), updated_at: ago(50) },
    { id: 'usr_low', tenant_id: T3, email: 'low@example.uz', name: 'Laylo', password_hash: 'x', role: 'owner', avatar_hue: 150, locale: 'uz', status: 'active', presence: 'offline', last_seen_at: null, created_at: ago(40), updated_at: ago(40) },
  ],
  sessions: [],
  agents: [
    { id: 'agt_live', tenant_id: T1, name: 'Laylo', status: 'live', created_at: ago(100), updated_at: ago(30) },
    { id: 'agt_draft', tenant_id: T1, name: 'Draft', status: 'draft', created_at: ago(10), updated_at: ago(1) },
    { id: 'agt_o', tenant_id: T2, name: 'Other', status: 'draft', created_at: ago(50), updated_at: ago(50) },
  ],
  phone_numbers: [
    { id: 'num_old', tenant_id: T1, e164: '+998711111111', label: 'Old line', provider: 'sip', region: 'Tashkent', agent_id: null, status: 'inactive', capabilities: 'voice', monthly_cost: 3.0, created_at: ago(110) },
    { id: 'num_main', tenant_id: T1, e164: '+998712000001', label: 'Main line', provider: 'simulator', region: 'Tashkent', agent_id: 'agt_live', status: 'active', capabilities: 'voice', monthly_cost: 3.5, created_at: ago(100) },
    { id: 'num_o', tenant_id: T2, e164: '+998712223344', label: 'Other line', provider: 'simulator', region: 'Tashkent', agent_id: 'agt_o', status: 'active', capabilities: 'voice', monthly_cost: 3.0, created_at: ago(50) },
  ],
  calls: [],
  escalations: [],
  usage_daily: [],
  knowledge_gaps: [],
  documents: [
    { id: 'doc_1', tenant_id: T1, title: 'Prices', source_type: 'pdf', byte_size: 12345, status: 'ready', chunk_count: 12, token_count: 3400, created_at: ago(90), updated_at: ago(90) },
    { id: 'doc_2', tenant_id: T1, title: 'Hours', source_type: 'txt', byte_size: 900, status: 'ready', chunk_count: 2, token_count: 210, created_at: ago(80), updated_at: ago(80) },
    { id: 'doc_3', tenant_id: T1, title: 'Broken', source_type: 'docx', byte_size: 5000, status: 'failed', chunk_count: 0, token_count: 0, created_at: ago(70), updated_at: ago(70) },
    { id: 'doc_o', tenant_id: T2, title: 'Other', source_type: 'md', byte_size: 77, status: 'ready', chunk_count: 1, token_count: 20, created_at: ago(50), updated_at: ago(50) },
  ],
  api_keys: [
    { id: 'key_a', tenant_id: T1, name: 'Zapier', prefix: 'ovoz_sk_AAAAAAAA', hash: 'hash-a', scopes: 'read', last_used: ago(1), created_by: 'usr_admin', created_at: ago(20), revoked_at: null },
    { id: 'key_b', tenant_id: T1, name: 'Old', prefix: 'ovoz_sk_BBBBBBBB', hash: 'hash-b', scopes: 'read,write', last_used: null, created_by: 'usr_owner', created_at: ago(40), revoked_at: ago(30) },
    { id: 'key_o', tenant_id: T2, name: 'Other', prefix: 'ovoz_sk_CCCCCCCC', hash: 'hash-c', scopes: 'read', last_used: null, created_by: 'usr_other', created_at: ago(10), revoked_at: null },
  ],
  webhooks: [
    { id: 'whk_a', tenant_id: T1, url: 'https://hooks.example.com/a', events: 'call.completed', secret: 'whsec_seed_a', status: 'active', created_at: ago(15) },
    { id: 'whk_o', tenant_id: T2, url: 'https://other.example.com/', events: 'call.started', secret: 'whsec_seed_o', status: 'active', created_at: ago(5) },
  ],
  wallet_ledger: [],
  audit_log: [],
  speech_tests: [
    { id: 'spt_seed', tenant_id: T1, user_id: 'usr_admin', kind: 'stt', input: 'clip.wav', output: 'salom', voice: null, created_at: ago(3) },
  ],
};
for (const u of SEED.users) SEED.sessions.push({ id: `ses_${u.id.slice(4)}`, user_id: u.id, tenant_id: u.tenant_id, created_at: STAMP, expires_at: '2099-01-01T00:00:00.000Z' });

// Calls: ~60 over the last 70 days at assorted hours, plus edges on the 30- and 60-day boundaries.
const INTENTS = [null, null, 'general', 'general', 'greeting', 'price', 'hours', 'complaint', 'made_up_intent'];
const OUTCOMES = ['resolved_by_ai', 'resolved_by_ai', 'resolved_by_ai', 'resolved_by_operator', 'abandoned', null];
const LATENCIES = [null, 640, 812, 812, 955, 1200, 1430, 2210, 3900, 700];
const callRow = (i, startedAt, extra = {}) => {
  const outcome = pick(OUTCOMES);
  return {
    id: `call_${String(i).padStart(3, '0')}`, tenant_id: T1, agent_id: 'agt_live', number_id: pick(['num_main', 'num_main', null]),
    direction: 'inbound', channel: pick(['voice', 'voice', 'web']), from_e164: `+99890${String(1000000 + i)}`, to_e164: '+998712000001',
    caller_name: pick([null, 'Ali', 'Vali']), status: 'completed', language: pick(['uz', 'uz', 'ru', 'en']), intent: pick(INTENTS),
    outcome, escalated: outcome === 'resolved_by_operator' ? 1 : 0, csat: pick([null, null, 3, 4, 5, 1]),
    duration_ms: Math.floor(rnd() * 400000), avg_latency_ms: pick(LATENCIES), cost_usd: Math.round(rnd() * 10000) / 1e5,
    sentiment: Math.round(rnd() * 100) / 100 - 0.5, turns: Math.floor(rnd() * 12), started_at: startedAt, ended_at: startedAt, ...extra,
  };
};
for (let i = 0; i < 60; i++) SEED.calls.push(callRow(i, ago(Math.floor(rnd() * 70), Math.floor(rnd() * 24), Math.floor(rnd() * 60), Math.floor(rnd() * 1000))));
SEED.calls.push(callRow(60, ago(30), { intent: null }));           // exactly on the 30-day line: included
SEED.calls.push(callRow(61, ago(30, 0, 0, 1), { intent: 'general' })); // one millisecond older: excluded
SEED.calls.push(callRow(62, ago(60), { outcome: 'resolved_by_ai', escalated: 0 }));
SEED.calls.push(callRow(63, ago(0, 0, 2), { status: 'active', outcome: null, ended_at: null, duration_ms: 0, avg_latency_ms: null }));
SEED.calls.push(callRow(64, ago(0, 0, 1), { status: 'ringing', outcome: null, ended_at: null, duration_ms: 0 }));
SEED.calls.push(callRow(65, ago(0, 0, 5), { status: 'with_operator', outcome: null, escalated: 1 }));
SEED.calls.push({ ...callRow(66, ago(3)), tenant_id: T2, agent_id: 'agt_o', number_id: 'num_o' });

const REASONS = ['low_confidence', 'caller_request', 'negative_sentiment', 'max_turns', 'some_new_reason'];
for (let i = 0; i < 14; i++) {
  const st = pick(['waiting', 'assigned', 'resolved', 'resolved', 'missed']);
  SEED.escalations.push({
    id: `esc_${i}`, tenant_id: T1, call_id: `call_${String(i * 4).padStart(3, '0')}`, reason: pick(REASONS), priority: pick(['normal', 'high', 'urgent']),
    status: st, operator_id: st === 'waiting' ? null : pick(['usr_op', 'usr_op', 'usr_admin', 'usr_owner', 'usr_an']),
    waited_ms: pick([null, 4000, 12500, 61000, 999]), handled_ms: st === 'resolved' ? pick([30000, 95000, null, 41234]) : null,
    created_at: ago(Math.floor(rnd() * 45), Math.floor(rnd() * 24)),
  });
}
SEED.escalations.push({ id: 'esc_o', tenant_id: T2, call_id: 'call_066', reason: 'caller_request', status: 'waiting', created_at: ago(1) });

const dayKey = (d) => new RealDate(NOW_MS - d * 864e5).toISOString().slice(0, 10);
for (const [d, extra] of [[0, {}], [1, { csat_sum: 0, csat_count: 0 }], [5, {}], [29, {}], [31, {}], [12, { minutes: 0.1 + 0.2 }]]) {
  SEED.usage_daily.push({ id: `ud_${d}`, tenant_id: T1, day: dayKey(d), calls: 10 + d, ai_resolved: 7, escalated: 2, abandoned: 1, minutes: 33.25 + d / 3, cost_usd: 1.0 / 3 + d, avg_latency_ms: 900 + d, csat_sum: 17, csat_count: 4, ...extra });
}
SEED.usage_daily.push({ id: 'ud_o', tenant_id: T2, day: dayKey(0), calls: 99, ai_resolved: 1, escalated: 1, abandoned: 1, minutes: 1, cost_usd: 1, avg_latency_ms: 1, csat_sum: 0, csat_count: 0 });

const GAPS = [['Sizlarda ipoteka bormi?', 5, 2], ['Kredit foizi qancha?', 5, 1], ['Filial qayerda?', 3, 4], ['Dam olish kunlari?', 3, 4], ['Karta blok', 1, 9], ['Valyuta kursi', 2, 6], ['Omonat', 7, 0]];
GAPS.forEach(([q, hits, days], i) => SEED.knowledge_gaps.push({ id: `gap_${i}`, tenant_id: T1, question: q, hits, best_score: Math.round(rnd() * 1000) / 1000, status: 'open', answer: null, last_seen: ago(days), created_at: ago(40) }));
SEED.knowledge_gaps.push({ id: 'gap_answered', tenant_id: T1, question: 'Done', hits: 50, best_score: 0.2, status: 'answered', answer: 'Yes', last_seen: ago(1), created_at: ago(40) });
SEED.knowledge_gaps.push({ id: 'gap_ignored', tenant_id: T1, question: 'Spam', hits: 60, best_score: 0.1, status: 'ignored', answer: null, last_seen: ago(1), created_at: ago(40) });
SEED.knowledge_gaps.push({ id: 'gap_o', tenant_id: T2, question: 'Other', hits: 99, best_score: 0.3, status: 'open', answer: null, last_seen: ago(1), created_at: ago(40) });

for (let i = 0; i < 18; i++) SEED.wallet_ledger.push({ id: `wl_seed${i}`, tenant_id: T1, kind: i % 4 === 0 ? 'topup' : 'debit', amount_uzs: i % 4 === 0 ? 500000 : 1000 * i, balance_after: 250000 - i, note: i % 4 === 0 ? 'Manual top-up' : 'Call', created_at: ago(i, i) });
SEED.wallet_ledger.push({ id: 'wl_o', tenant_id: T2, kind: 'debit', amount_uzs: 500, balance_after: -500, note: 'Call', created_at: ago(1) });
for (let i = 0; i < 28; i++) SEED.audit_log.push({ id: `aud_seed${i}`, tenant_id: T1, actor_id: i % 3 ? 'usr_admin' : null, actor_name: i % 3 ? 'Aziz' : 'system', action: pick(['number.added', 'team.invited', 'apikey.created', 'tenant.updated']), target: i % 2 ? `x${i}` : null, meta_json: JSON.stringify({ i }), ip: null, created_at: ago(i % 20, i) });
SEED.audit_log.push({ id: 'aud_o', tenant_id: T2, actor_id: null, actor_name: 'system', action: 'x', target: null, meta_json: '{}', ip: null, created_at: ago(0) });

function insert(table, row) {
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
}
const ORDER = ['tenants', 'users', 'sessions', 'agents', 'phone_numbers', 'calls', 'escalations', 'usage_daily', 'knowledge_gaps', 'documents', 'api_keys', 'webhooks', 'wallet_ledger', 'audit_log', 'speech_tests'];
for (const table of ORDER) for (const row of SEED[table]) insert(table, row);

// ── sessions ────────────────────────────────────────────────────────
const tokenFor = (userId) => {
  const sid = `ses_${userId.slice(4)}`;
  return `${sid}.${crypto.createHmac('sha256', SECRET).update(sid).digest('base64url')}`;
};
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// ── views: the pages' data-loading lines, as they were ──────────────
async function session(userId) {
  currentToken = tokenFor(userId);
  return auth.requireSession();
}

function overviewView({ tenant }) {
  const stats = A.overview(tenant.id, 30);
  const prev = A.overview(tenant.id, 60);
  const trend = A.daily(tenant.id, 30);
  const kb = A.knowledgeStats(tenant.id);
  const gaps = A.knowledgeGaps(tenant.id, 5);
  const topIntents = AF.intents(tenant.id, 30, 5);
  const agent = calls.liveAgent(tenant.id);
  const telephony = status.telephonyStatus();
  const recent = db.all(`SELECT * FROM calls WHERE tenant_id=? ORDER BY started_at DESC LIMIT 8`, tenant.id);
  const priorCalls = Math.max(0, prev.totalCalls - stats.totalCalls);
  const callsDelta = priorCalls > 0 ? ((stats.totalCalls - priorCalls) / priorCalls) * 100 : null;
  const setupDone = { knowledge: kb.ready > 0, agent: agent?.status === 'live', number: true, tested: stats.totalCalls > 0 };
  return {
    stats, trend, kb, gaps, topIntents, recent, callsDelta, setupDone,
    llm: {
      hosted: provider.engineIsHosted(choice.tenantDefaultLlm(tenant.id)),
      label: provider.engineLabel(choice.tenantDefaultLlm(tenant.id)),
      serverHosted: provider.engineIsHosted(),
    },
    telephony,
  };
}

function analyticsView({ tenant }) {
  const stats = A.overview(tenant.id, 30);
  const trend = A.daily(tenant.id, 30);
  const heat = A.hourlyHeat(tenant.id, 30);
  const topIntents = AF.intents(tenant.id, 30, 8);
  const langs = A.languageSplit(tenant.id, 30);
  const reasons = A.escalationReasons(tenant.id, 30);
  const gaps = A.knowledgeGaps(tenant.id, 8);
  const operators = A.operatorLeaderboard(tenant.id, 30);
  const latencies = db.all(
    `SELECT avg_latency_ms AS v FROM calls WHERE tenant_id=? AND avg_latency_ms IS NOT NULL
     ORDER BY avg_latency_ms ASC`,
    tenant.id,
  ).map((r) => r.v);
  const aiMinutes = stats.totalCalls ? stats.minutes * stats.deflectionRate : 0;
  const humanEquivalent = aiMinutes * calls.OPERATOR_COST_PER_MINUTE;
  const actualSpend = aiMinutes * (calls.COST_PER_MINUTE - calls.RATE_CARD.telephonyPerMin);
  return {
    stats, trend, heat, topIntents, langs, reasons, gaps, operators,
    latency: { p50: utils.percentile(latencies, 50), p90: utils.percentile(latencies, 90), p95: utils.percentile(latencies, 95), p99: utils.percentile(latencies, 99) },
    aiMinutes, humanEquivalent, actualSpend,
    operatorAssumptions: calls.OPERATOR_ASSUMPTIONS, operatorCostPerMinute: calls.OPERATOR_COST_PER_MINUTE,
  };
}

function numbersView({ tenant }) {
  const numbers = db.all(
    `SELECT n.*, a.name AS agent_name,
            (SELECT COUNT(*) FROM calls c WHERE c.number_id = n.id) AS call_count
     FROM phone_numbers n
     LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.tenant_id=? ORDER BY n.created_at ASC`,
    tenant.id,
  );
  return { numbers, telephony: status.telephonyStatus() };
}

function teamView({ tenant }) {
  const members = db.all(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.avatar_hue, u.locale, u.status,
            u.presence, u.last_seen_at, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM escalations e WHERE e.operator_id = u.id AND e.status='resolved') AS handled
     FROM users u WHERE u.tenant_id=? ORDER BY
       CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
       u.created_at ASC`,
    tenant.id,
  );
  return { members, audit: auth.recentAudit(tenant.id, 25) };
}

function settingsView({ tenant }) {
  const embedding = embed.embeddingEngine();
  return {
    llm: {
      hosted: provider.engineIsHosted(choice.tenantDefaultLlm(tenant.id)),
      label: provider.engineLabel(choice.tenantDefaultLlm(tenant.id)),
      serverHosted: provider.engineIsHosted(),
    },
    embedding: { id: embedding.id, hosted: embedding.hosted },
    telephony: status.telephonyStatus(),
    stats: A.knowledgeStats(tenant.id),
  };
}

function developersView({ tenant }) {
  const keys = db.all('SELECT * FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC', tenant.id);
  const hooks = db.all('SELECT * FROM webhooks WHERE tenant_id=? ORDER BY created_at DESC', tenant.id);
  const number = calls.primaryNumber(tenant.id);
  return { keys, hooks, exampleNumber: number?.e164 ?? '+998712000000' };
}

function billingView({ tenant }) {
  const LOW_BALANCE_UZS = 100_000; // billing-view.tsx
  const balance = tenant.balance_uzs;
  const negative = balance < 0;
  const low = !negative && balance < LOW_BALANCE_UZS;
  const ledger = db.all('SELECT * FROM wallet_ledger WHERE tenant_id=? ORDER BY created_at DESC LIMIT 15', tenant.id);
  return { balance, negative, low, ledger, uzsRates: catalog.UZS_RATES, aiMinuteUzs: catalog.AI_MINUTE_UZS };
}

const VIEWS = { overview: overviewView, analytics: analyticsView, numbers: numbersView, team: teamView, settings: settingsView, developers: developersView, billing: billingView };

async function allViews(users, env) {
  for (const k of PROVIDER_ENV) delete process.env[k];
  Object.assign(process.env, env);
  const out = [];
  for (const userId of users) {
    for (const [name, fn] of Object.entries(VIEWS)) out.push({ user: userId, env, view: name, data: roundTrip(fn(await session(userId))) });
  }
  for (const k of Object.keys(env)) delete process.env[k];
  return out;
}

// ── actions ─────────────────────────────────────────────────────────
const TABLES = ['phone_numbers', 'users', 'sessions', 'api_keys', 'webhooks', 'speech_tests', 'tenants', 'wallet_ledger', 'knowledge_gaps', 'audit_log'];
const NEW_ID = /\b(num|usr|key|whk|spt|wl|aud)_[0-9a-z]{16}\b/g;
function mask(value, row) {
  if (typeof value !== 'string') return value;
  if (/^ovoz_sk_[A-Za-z0-9_-]{32}$/.test(value)) return '<api key>';
  if (/^ovoz_sk_[A-Za-z0-9_-]{8}$/.test(value) && row && row.hash) return '<api key prefix>';
  if (/^[0-9a-f]{64}$/.test(value)) return '<sha256>';
  if (/^whsec_[A-Za-z0-9_-]{32}$/.test(value)) return '<webhook secret>';
  if (/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(value)) return '<password hash>';
  return value.replace(NEW_ID, '<$1>');
}
function maskRow(row) {
  const out = {};
  const isNew = typeof row.id === 'string' && /^(num|usr|key|whk|spt|wl|aud)_[0-9a-z]{16}$/.test(row.id);
  for (const [k, v] of Object.entries(row)) {
    if (isNew && k === 'avatar_hue') {
      if (!(Number.isInteger(v) && v >= 0 && v < 360)) throw new Error(`bad hue ${v}`);
      out[k] = '<hue>';
    } else out[k] = v && typeof v === 'object' ? maskDeep(v) : mask(v, row);
  }
  return out;
}
const maskDeep = (v) => (Array.isArray(v) ? v.map(maskDeep) : v && typeof v === 'object' ? maskRow(v) : mask(v));
const snapshot = () => Object.fromEntries(TABLES.map((t) => [t, db.all(`SELECT * FROM ${t}`).map(maskRow).map((r) => JSON.stringify(r)).sort()]));
function multisetMinus(a, b) {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(JSON.parse(x));
  }
  return out;
}

const LONG_STT = 'a'.repeat(3999) + '😀' + 'tail'; // .slice(0, 4000) cuts the emoji in half
const LONG_TTS = 'ў'.repeat(8001);
const STEPS = [
  // who, action, args (by parameter name)
  [null, 'addNumberAction', { input: { e164: '+998712000099', label: 'x', provider: 'sip' } }],
  ['usr_an', 'addNumberAction', { input: { e164: '+998712000099', label: 'x', provider: 'sip' } }],
  ['usr_op', 'removeNumberAction', { numberId: 'num_main' }],
  ['usr_an', 'saveSpeechTestAction', { input: { kind: 'tts', input: 'Salom', output: null, voice: 'laylo' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '998 71 200', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+123456', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+1234567890123456', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+１２３４５６７８', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+12345678\n', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+12345678x', label: 'x', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: ' +998712000002 ', label: '   ', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+998712000002', label: 'Dup', provider: 'sip' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: '+998712223344', label: '  Shared  ', provider: 'simulator' } }],
  ['usr_admin', 'addNumberAction', { input: { e164: 5, label: 'x', provider: 'sip' } }],
  ['usr_admin', 'removeNumberAction', { numberId: 'num_old' }],
  ['usr_admin', 'removeNumberAction', { numberId: 'num_o' }],
  ['usr_admin', 'inviteMemberAction', { input: { name: 'Short', email: 's@example.uz', role: 'operator', password: 'short' } }],
  ['usr_admin', 'inviteMemberAction', { input: { name: 'Emoji', email: 'e@example.uz', role: 'operator', password: 'abc😀😀' } }],
  ['usr_admin', 'inviteMemberAction', { input: { name: 'Dup', email: '  OWNER@Example.UZ ', role: 'operator', password: 'longenough' } }],
  ['usr_admin', 'inviteMemberAction', { input: { name: ' Kamola ', email: ' Kamola@Example.UZ ', role: 'analyst', password: 'abcd😀😀' } }],
  ['usr_admin', 'changeRoleAction', { userId: 'usr_admin', role: 'owner' }],
  ['usr_admin', 'changeRoleAction', { userId: 'usr_op2', role: 'admin' }],
  ['usr_admin', 'changeRoleAction', { userId: 'usr_other', role: 'analyst' }],
  ['usr_admin', 'setMemberStatusAction', { userId: 'usr_admin', status: 'disabled' }],
  ['usr_admin', 'setMemberStatusAction', { userId: 'usr_op', status: 'disabled' }],
  ['usr_admin', 'setMemberStatusAction', { userId: 'usr_op', status: 'active' }],
  ['usr_admin', 'setMemberStatusAction', { userId: 'usr_other', status: 'disabled' }],
  ['usr_admin', 'createApiKeyAction', { name: '   ', scopes: 'read' }],
  ['usr_admin', 'createApiKeyAction', { name: ' CI key ', scopes: 'read,write' }],
  ['usr_admin', 'revokeApiKeyAction', { keyId: 'key_a' }],
  ['usr_admin', 'revokeApiKeyAction', { keyId: 'key_o' }],
  ['usr_admin', 'saveWebhookAction', { url: 'http://hooks.example.com/x', events: 'call.completed' }],
  ['usr_admin', 'saveWebhookAction', { url: 'hooks.example.com/x', events: 'call.completed' }],
  ['usr_admin', 'saveWebhookAction', { url: 'https://exa mple.com/', events: 'call.completed' }],
  ['usr_admin', 'saveWebhookAction', { url: 'https://example.com:99999/', events: 'call.completed' }],
  ['usr_admin', 'saveWebhookAction', { events: 'call.completed' }],
  ['usr_admin', 'saveWebhookAction', { url: 'HTTPS://Hooks.Example.COM/in?x=1', events: 'call.completed,call.started' }],
  ['usr_admin', 'saveWebhookAction', { url: 'https:hooks.example.com', events: 'call.started' }],
  ['usr_admin', 'deleteWebhookAction', { hookId: 'whk_a' }],
  ['usr_admin', 'deleteWebhookAction', { hookId: 'whk_o' }],
  ['usr_admin', 'saveSpeechTestAction', { input: { kind: 'nope', input: 'x' } }],
  ['usr_admin', 'saveSpeechTestAction', { input: { kind: 'stt', input: LONG_STT, output: 'salom 😀' } }],
  ['usr_admin', 'saveSpeechTestAction', { input: { kind: 'tts', input: LONG_TTS, output: LONG_TTS, voice: 'isomiddin' } }],
  ['usr_admin', 'saveSpeechTestAction', { input: { kind: 'tts' } }],
  ['usr_admin', 'updateTenantAction', { input: { name: '  Medline Clinic  ', industry: 'healthcare', timezone: 'Asia/Samarkand', country: 'UZ' } }],
  ['usr_admin', 'resolveGapAction', { gapId: 'gap_0', answer: 'Ha, bor.' }],
  ['usr_admin', 'resolveGapAction', { gapId: 'gap_o', answer: 'cross-tenant' }],
  ['usr_admin', 'ignoreGapAction', { gapId: 'gap_1' }],
  ['usr_admin', 'ignoreGapAction', { gapId: 'gap_o' }],
  ['usr_admin', 'changePlanAction', { plan: 'pro' }],
  ['usr_admin', 'topUpAction', { amountUzs: 1000 }],
  ['usr_owner', 'changePlanAction', { plan: 'business' }],
  ['usr_owner', 'topUpAction', { amountUzs: 0 }],
  ['usr_owner', 'topUpAction', { amountUzs: -5 }],
  ['usr_owner', 'topUpAction', { amountUzs: 0.4 }],
  ['usr_owner', 'topUpAction', { amountUzs: 'abc' }],
  ['usr_owner', 'topUpAction', { amountUzs: null }],
  ['usr_owner', 'topUpAction', {}],
  ['usr_owner', 'topUpAction', { amountUzs: 2.5 }],
  ['usr_owner', 'topUpAction', { amountUzs: ' 1e3 ' }],
  ['usr_owner', 'topUpAction', { amountUzs: true }],
  ['usr_owner', 'topUpAction', { amountUzs: 500000 }],
];
// Positional parameters of each action, in order (how the generator calls the TypeScript).
const PARAMS = {
  addNumberAction: ['input'], removeNumberAction: ['numberId'], inviteMemberAction: ['input'], changeRoleAction: ['userId', 'role'],
  setMemberStatusAction: ['userId', 'status'], createApiKeyAction: ['name', 'scopes'], revokeApiKeyAction: ['keyId'],
  saveWebhookAction: ['url', 'events'], deleteWebhookAction: ['hookId'], saveSpeechTestAction: ['input'], updateTenantAction: ['input'],
  changePlanAction: ['plan'], topUpAction: ['amountUzs'], resolveGapAction: ['gapId', 'answer'], ignoreGapAction: ['gapId'],
};

(async () => {
  const out = { now: NOW, timezone: process.env.TZ, seed: SEED, intentsOriginal: {}, views: [], steps: [], finalViews: [] };
  for (const t of [T1, T2, T3]) out.intentsOriginal[t] = roundTrip(A.intents(t, 30, 8));
  out.views.push(...(await allViews(['usr_admin', 'usr_other', 'usr_low'], {})));
  out.views.push(...(await allViews(['usr_admin', 'usr_low'], { GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key', OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large', BRIDGE_SHARED_SECRET: 'bridge' })));

  // Each step records what the action returned (or threw) and the rows it added and removed in
  // every table (an UPDATE removes the old row and adds the new one), with random values masked.
  let before = snapshot();
  for (const [who, action, args] of STEPS) {
    currentToken = who ? tokenFor(who) : null;
    revalidated.length = 0;
    let result;
    try {
      result = { value: maskDeep(roundTrip(await ops[action](...PARAMS[action].map((p) => args[p])))) };
    } catch (err) {
      result = { throws: err.constructor.name, status: err.status ?? null };
    }
    const after = snapshot();
    const changes = {};
    for (const t of TABLES) {
      const added = multisetMinus(after[t], before[t]);
      const removed = multisetMinus(before[t], after[t]);
      if (added.length || removed.length) changes[t] = { added, removed };
    }
    before = after;
    out.steps.push({ user: who, action, args, result, revalidated: roundTrip(revalidated), changes });
  }
  for (const [name, fn] of Object.entries(VIEWS)) {
    if (name === 'overview' || name === 'analytics' || name === 'settings') continue;
    out.finalViews.push({ user: 'usr_owner', view: name, data: maskDeep(roundTrip(fn(await session('usr_owner')))) });
  }
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`views ${out.views.length}, steps ${out.steps.length}, final views ${out.finalViews.length}`);
})();
