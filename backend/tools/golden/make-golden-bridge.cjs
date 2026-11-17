// Reference behaviour of the ORIGINAL TypeScript phone-bridge routes
// (src/app/api/telephony/bridge/{turn,filler,end}/route.ts and src/lib/telephony/bridge.ts) on a
// real SQLite database: the requests in scenarios-bridge.json, in order, with the real call
// engine and turn engine (local answers, no model keys) and a scripted TTS/STT — the speech
// layer has its own parity tests. Records each response (status, headers, body) and the call
// and turns it touched, then the daily usage and wallet.
// Usage: node make-golden-bridge.cjs <scenarios-bridge.json> <output.json> <workdir>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
const SPEC = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const OUTPUT = path.resolve(process.argv[3]);
const WORK = process.argv[4];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db

// ── scripted speech (mirrored in tests/test_bridge_parity.py) ──
class TtsError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
class SttError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const tts = {
  TtsError,
  async synthesizePcm(text, opts) {
    // The real normalizeForSpeech reads text.replace: undefined text throws a TypeError.
    if (typeof text !== 'string') throw new TypeError("Cannot read properties of undefined (reading 'replace')");
    if (opts.voiceId === 'boom') throw new TtsError('tts_unavailable', 503);
    return Buffer.from(`pcm|${opts.tenantId}|${opts.tag}|${opts.language}|${opts.voiceId}|${!!opts.cache}|${text}`, 'utf8');
  },
  async *synthesizeStream(text, opts) {
    yield Buffer.from(`stream|${opts.tenantId}|${opts.tag}|${opts.language}|${opts.voiceId}|${!!opts.cache}|`, 'utf8');
    for (const [i, word] of text.split(' ').entries()) {
      if (opts.voiceId === 'crack') throw new TtsError('tts_cut', 502);
      yield Buffer.from(`${i}:${word}|`, 'utf8');
    }
  },
};
const stt = {
  SttError,
  async transcribe(audio, opts) {
    const said = Buffer.from(audio).toString('utf8');
    if (said === '') throw new SttError('empty_audio', 400);
    if (said === 'FAIL') throw new SttError('stt_unreachable', 503);
    if (said === 'CRASH') throw new Error('socket hang up');
    if (said === 'SILENCE') return { text: '', engine: 'kotib', language: null };
    return { text: said, engine: `kotib-${opts.language}`, language: opts.language };
  },
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
// By file, so `@/lib/speech/tts` (routes) and `./tts` (fillers.ts) both get the script.
for (const [file, exports] of [['lib/speech/tts.js', tts], ['lib/speech/stt.js', stt]]) {
  const filename = path.join(OUT, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
globalThis.fetch = async () => { throw new Error('offline'); };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL', 'LLM_PROVIDER']) delete process.env[k];

// The stub's TypeError stands in for the real normalizeForSpeech(undefined): check it does throw.
const { normalizeForSpeech } = require(path.join(OUT, 'lib/speech/normalize.js'));
try { normalizeForSpeech(undefined); throw new Error('normalizeForSpeech(undefined) no longer throws: update the stub'); } catch (e) { if (!(e instanceof TypeError)) throw e; }

const db = require(path.join(OUT, 'lib/db.js'));
const routes = {
  turn: require(path.join(OUT, 'app/api/telephony/bridge/turn/route.js')).POST,
  filler: require(path.join(OUT, 'app/api/telephony/bridge/filler/route.js')).GET,
  end: require(path.join(OUT, 'app/api/telephony/bridge/end/route.js')).POST,
};

for (const [table, rows] of Object.entries(SPEC.seed)) {
  for (const row of rows) {
    const keys = Object.keys(row);
    db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  }
}

function request(sc) {
  const url = `http://localhost/api/telephony/bridge/${sc.route}${sc.qs !== undefined ? `?${sc.qs}` : ''}`;
  const headers = new Headers();
  const auth = sc.auth ?? 'ok';
  if (auth === 'ok') headers.set('x-bridge-secret', SPEC.secret);
  if (auth === 'wrong') headers.set('x-bridge-secret', SPEC.secret.replace(/.$/, 'X'));
  if (auth === 'short') headers.set('x-bridge-secret', SPEC.secret.slice(0, -1));
  if (sc.route === 'filler') return new Request(url, { method: 'GET', headers });
  let body;
  if (sc.form) {
    body = new FormData();
    for (const [name, value] of sc.form) {
      if (typeof value === 'string') body.append(name, value);
      else body.append(name, new Blob([Buffer.from(value.file, 'utf8')], { type: 'audio/wav' }), 'utterance.wav');
    }
  } else {
    body = Buffer.from(sc.raw, 'utf8');
    const type = 'contentType' in sc ? sc.contentType : 'application/json';
    if (type) headers.set('content-type', type);
  }
  return new Request(url, { method: 'POST', headers, body });
}

const HEADERS = ['content-type', 'cache-control', 'x-ovoz-callid', 'x-ovoz-escalate', 'x-ovoz-text', 'x-ovoz-engine', 'x-ovoz-count'];
const SEEDED = new Set(SPEC.seed.calls.map((c) => c.id));

function callView(callId, unstable) {
  const call = db.get(
    `SELECT tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164, status, outcome, language,
       intent, turns, duration_ms, cost_usd, escalated, escalation_reason, answered_at IS NOT NULL AS answered,
       ended_at FROM calls WHERE id=?`,
    callId,
  );
  if (!call) return null;
  if (unstable || !SEEDED.has(callId)) call.ended_at = call.ended_at ? 'x' : null;
  if (unstable) { call.duration_ms = typeof call.duration_ms; call.cost_usd = typeof call.cost_usd; }
  const turns = db.all(
    'SELECT ordinal, role, text, language, confidence, latency_ms IS NOT NULL AS has_latency FROM turns WHERE call_id=? ORDER BY ordinal',
    callId,
  );
  return { call, turns };
}

function finals() {
  return {
    usageDaily: db.all("SELECT day, calls, ai_resolved, escalated, abandoned, minutes, cost_usd, csat_sum, csat_count FROM usage_daily WHERE day='2026-11-12' ORDER BY day"),
    wallet: {
      balance: db.get("SELECT balance_uzs FROM tenants WHERE id='t1'").balance_uzs,
      ledger: db.all("SELECT kind, amount_uzs, balance_after, note FROM wallet_ledger WHERE tenant_id='t1' ORDER BY created_at, rowid"),
    },
    escalations: db.all('SELECT call_id, reason, priority, status FROM escalations ORDER BY call_id'),
    callCount: db.get('SELECT COUNT(*) AS n FROM calls').n,
  };
}

(async () => {
  const out = { results: [] };
  for (const sc of SPEC.scenarios) {
    if (sc.unstable && !out.finals) out.finals = finals();
    const env = sc.env ?? 'set';
    if (env === 'set') process.env.BRIDGE_SHARED_SECRET = SPEC.secret;
    else if (env === 'empty') process.env.BRIDGE_SHARED_SECRET = '';
    else delete process.env.BRIDGE_SHARED_SECRET;

    let res;
    try {
      res = await routes[sc.route](request(sc));
    } catch (err) {
      out.results.push({ name: sc.name, status: 500, threw: err.constructor.name });
      continue;
    }
    const headers = {};
    for (const h of HEADERS) if (res.headers.has(h)) headers[h] = res.headers.get(h);
    const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
    let body = raw;
    const minted = headers['x-ovoz-callid'] && !SEEDED.has(headers['x-ovoz-callid']) ? headers['x-ovoz-callid'] : null;
    if (minted) headers['x-ovoz-callid'] = `minted:${minted.split('_')[0]}`;
    if (sc.route === 'end' && headers['content-type'] === 'application/json') {
      // avg/p95 are measured turn latencies; an unstable scenario's end time is "now".
      body = JSON.parse(raw);
      for (const k of sc.unstable ? ['durationMs', 'cost', 'avg', 'p95'] : ['avg', 'p95']) if (k in body) body[k] = typeof body[k];
      body = JSON.stringify(body);
    }
    let touched = minted;
    if (!touched && sc.form) touched = (sc.form.find(([n]) => n === 'callId') ?? [])[1] || null;
    if (!touched && sc.route === 'end') {
      try { touched = String(JSON.parse(sc.raw.replace(/^﻿/, '')).callId ?? '').trim() || null; } catch { touched = null; }
    }
    out.results.push({ name: sc.name, status: res.status, headers, body, touched: touched && callView(touched, sc.unstable) });
  }
  if (!out.finals) out.finals = finals();
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 1));
  for (const r of out.results) console.log(String(r.status).padEnd(4), r.name.padEnd(34), (r.body ?? r.threw ?? '').slice(0, 70).replace(/\n/g, ' '));
  console.log('calls', out.finals.callCount, 'wallet', out.finals.wallet.balance, 'escalations', out.finals.escalations.length);
})();
