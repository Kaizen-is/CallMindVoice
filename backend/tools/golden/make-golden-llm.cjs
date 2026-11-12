// Reference behaviour of the ORIGINAL TypeScript answer layer (src/lib/llm/provider.ts and the
// Gemini / OpenAI / Ollama clients) for the Python parity tests.
//
// Every scenario runs the real compiled `generateAnswer` / `summarizeCall` with:
//   - global fetch replaced by a recorder that answers from a script,
//   - @anthropic-ai/sdk replaced by a fake that records params and answers from a script,
//   - recordUsage replaced by a recorder.
// and writes down the requests, the Claude params, the streamed deltas, the result and the usage rows.
// Usage: node make-golden-llm.cjs <output.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OUT = path.join(__dirname, 'out');
const FIXED_NOW = Date.parse('2026-11-12T09:30:00.000Z'); // a Thursday, for the loan calendar

/* ── fixed clock (the loan calendar uses `new Date()`) ── */
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED_NOW);
  }
  static now() {
    return FIXED_NOW;
  }
}
globalThis.Date = FixedDate;

/* ── module stubs ── */
const usage = [];
let claudeScript = [];
const claudeCalls = [];

const stubs = {
  'server-only': {},
  '@/lib/db': { all: () => [], get: () => undefined, run: () => ({ changes: 0 }), now: () => new Date().toISOString(), id: (p) => `${p}_x`, UPLOAD_DIR: '/nonexistent/uploads' },
  '@/lib/usage-log': {
    recordUsage: (e) => usage.push({ ...e }),
    withUsageSource: (_s, _t, fn) => fn(),
  },
  '@anthropic-ai/sdk': class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (params) => {
          claudeCalls.push({ kind: 'create', params: JSON.parse(JSON.stringify(params)) });
          const next = claudeScript.shift();
          if (!next) throw new Error('no scripted claude response');
          if (next.throw) throw new Error(next.throw);
          return next.message;
        },
        stream: (params) => {
          claudeCalls.push({ kind: 'stream', params: JSON.parse(JSON.stringify(params)) });
          const next = claudeScript.shift();
          if (!next) throw new Error('no scripted claude response');
          return {
            async *[Symbol.asyncIterator]() {
              for (const ev of next.events ?? []) yield ev;
              if (next.throw) throw new Error(next.throw);
            },
            async finalMessage() {
              return next.final;
            },
          };
        },
      };
    }
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) {
  require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports: name === '@anthropic-ai/sdk' ? Object.assign(exports, { default: exports }) : exports };
}

/* ── fetch recorder ── */
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
  // Pull-based, so every chunk reaches the reader before a scripted connection reset.
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

/* ── fresh modules per scenario (module-level caches: the Claude client, the TTS token) ── */
function fresh(rel) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(OUT)) delete require.cache[k];
  return require(path.join(OUT, rel));
}

const ENV_KEYS = [
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL',
  'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_API_KEY', 'LLM_PROVIDER', 'LLM_FALLBACK_MODEL',
];

/* ── shared inputs ── */
const HITS = [
  { chunkId: 'chk_a', documentId: 'doc_1', documentTitle: 'Narxlar', heading: 'Kredit', text: 'Kredit foizi yillik 24%. Muddat 36 oygacha.', snippet: 'Kredit foizi…', score: 0.8123456, lexicalScore: 0.7, denseScore: 0.6 },
  { chunkId: 'chk_b', documentId: 'doc_2', documentTitle: 'Ish vaqti', heading: null, text: 'Dushanba–juma 09:00–18:00. 😀 ' + 'x'.repeat(1500), snippet: 'Dushanba…', score: 0.5, lexicalScore: 0.4, denseScore: 0.3 },
  { chunkId: 'chk_c', documentId: 'doc_3', documentTitle: 'Manzil', heading: 'Filial', text: 'Toshkent, Amir Temur 1.', snippet: 'Toshkent…', score: 0.31, lexicalScore: 0.2, denseScore: 0.1 },
];
const BASE = {
  question: 'Kredit foizi qancha?',
  hits: HITS,
  confidence: 0.81,
  language: 'uz',
  agentName: 'Laylo',
  threshold: 0.55,
  history: [
    { role: 'caller', text: 'Salom' },
    { role: 'agent', text: 'Assalomu alaykum! Qanday yordam bera olaman?' },
  ],
};
const TARGET = { fullName: 'Aziz Karimov', birthYear: '1992', loanAmount: '7 800 000 so‘m', prompt: 'Toʻlovni Payme orqali qilish mumkin. Ikki qismga boʻlish mumkin.' };
const ANSWER = (answer, answered = true, used = [1]) => JSON.stringify({ answer, answered, usedExcerpts: used });

function geminiBody(text, usage = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 5 }) {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: usage });
}
function geminiSse(pieces, usage = { promptTokenCount: 200, candidatesTokenCount: 40 }) {
  return pieces.map((p, i) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: p }] } }], ...(i === pieces.length - 1 ? { usageMetadata: usage } : {}) })}\r\n\r\n`);
}
function splitEvery(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
const claudeDeltas = (text, n = 7) => splitEvery(text, n).map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
const claudeFinal = (extra = {}) => ({ usage: { input_tokens: 300, output_tokens: 44 }, stop_reason: 'end_turn', model: 'claude-haiku-5-5', ...extra });

const SCENARIOS = [
  {
    name: 'gemini_one_piece',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, persona: 'friendly', instructions: 'Har doim "hurmatli mijoz" deb murojaat qiling.' },
    fetch: [{ body: geminiBody(ANSWER('  Kredit foizi yillik yigirma to‘rt foiz.  ', true, [1, 1, 3, 9])) }],
  },
  {
    name: 'gemini_streamed',
    env: { GEMINI_API_KEY: 'g-key', GEMINI_MODEL: 'gemini-3.5-flash-lite' },
    delta: true,
    input: BASE,
    fetch: [{ chunks: splitEvery(geminiSse(['{"answer":"Kredit foizi ', 'yillik yigirma \\"to‘rt\\" foiz.\\nMuddat', ' 36 oy.","answered":true,"usedExcerpts":[1]}']).join(''), 37) }],
  },
  {
    name: 'gemini_stream_503_haiku_rescues_streamed',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'gemini' },
    delta: true,
    input: BASE,
    fetch: [{ status: 503, statusText: 'Service Unavailable', body: '{"error":{"message":"high demand"}}' }],
    claude: [{ events: claudeDeltas(ANSWER('Foiz yillik 24 foiz.', true, [1])), final: claudeFinal() }],
  },
  {
    name: 'gemini_stream_503_no_anthropic_local',
    env: { GEMINI_API_KEY: 'g-key' },
    delta: true,
    input: BASE,
    fetch: [{ status: 503, body: 'busy' }],
  },
  {
    name: 'gemini_one_piece_unreadable_haiku_one_piece',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'gemini' },
    input: BASE,
    fetch: [{ body: geminiBody('not json at all') }],
    claude: [{ message: { content: [{ type: 'text', text: ANSWER(' Yillik 24 foiz. ', true, [2]) }], usage: { input_tokens: 310, output_tokens: 20 }, stop_reason: 'end_turn', model: 'claude-haiku-5-5' } }],
  },
  {
    name: 'gemini_stream_breaks_after_partial',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'gemini' },
    delta: true,
    input: BASE,
    fetch: [{ chunks: geminiSse(['{"answer":"Kredit foizi yillik', ' yigirma to‘rt']), breakAfter: true }],
  },
  {
    name: 'gemini_blocked',
    env: { GEMINI_API_KEY: 'g-key', LLM_FALLBACK_MODEL: 'off', ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'gemini' },
    input: BASE,
    fetch: [{ body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) }],
  },
  {
    name: 'gemini_stream_false_comparison',
    env: { GEMINI_API_KEY: 'g-key' },
    delta: true,
    input: { ...BASE, stream: false },
    fetch: [{ body: geminiBody(ANSWER('Bir qismda.', false, [])) }],
  },
  {
    name: 'openai_streamed_with_usage',
    env: { OPENAI_API_KEY: 'o-key', OPENAI_MODEL: 'gpt-5.5', GEMINI_API_KEY: 'g-key', LLM_PROVIDER: 'openai' },
    delta: true,
    input: { ...BASE, language: 'ru', question: 'Сколько процентов?' },
    fetch: [{
      chunks: [
        ...splitEvery(['{"answer":"Двадцать', ' четыре процента.","answered":true,"usedExcerpts":[1,2]}'].map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join(''), 23),
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 410, completion_tokens: 25 } })}\n\n`,
        'data: [DONE]\n\n',
      ],
    }],
  },
  {
    name: 'openai_choice_gpt6_sol_base_url',
    env: { OPENAI_API_KEY: 'o-key', OPENAI_BASE_URL: 'https://llm.example.com/v1///' },
    delta: true,
    input: { ...BASE, llm: 'openai:gpt-6.1-sol' },
    fetch: [{ chunks: [`data: ${JSON.stringify({ choices: [{ delta: { content: '```json\n{"answer":"Ha.","answered":true,"usedExcerpts":[]}\n```' } }] })}\n`] }],
  },
  {
    name: 'ollama_streamed',
    env: { OLLAMA_BASE_URL: 'http://gpu:11434/', OLLAMA_API_KEY: 'ol-key' },
    delta: true,
    input: { ...BASE, language: 'en', question: 'What are your hours?' },
    fetch: [{ chunks: [JSON.stringify({ message: { content: '{"answer":"We open' } }) + '\n', JSON.stringify({ message: { content: ' at nine.","answered":true,"usedExcerpts":[2]}' }, prompt_eval_count: 99, eval_count: 12 }) + '\n'] }],
  },
  {
    name: 'ollama_one_piece_fenced',
    env: { OLLAMA_BASE_URL: 'http://gpu:11434' },
    input: BASE,
    fetch: [{ body: JSON.stringify({ message: { content: 'Here:\n```json\n{"answer":"Ochiq.","answered":true,"usedExcerpts":[3]}\n```' }, prompt_eval_count: 50, eval_count: 9 }) }],
  },
  {
    name: 'anthropic_one_piece',
    env: { ANTHROPIC_API_KEY: 'a-key', ANTHROPIC_MODEL: 'claude-sonnet-5-5' },
    input: { ...BASE, persona: 'empathetic' },
    claude: [{ message: { content: [{ type: 'text', text: ANSWER('Yillik 24 foiz.', true, [1, 2]) }], usage: { input_tokens: 500, output_tokens: 30 }, stop_reason: 'end_turn', model: 'claude-sonnet-5-5-20261001' } }],
  },
  {
    name: 'anthropic_streamed_opus',
    env: { ANTHROPIC_API_KEY: 'a-key' },
    delta: true,
    input: { ...BASE, llm: 'anthropic:claude-opus-5-5' },
    claude: [{ events: claudeDeltas(ANSWER('Foiz — yillik 24. Muddati esa 36 oy.', true, [1]), 5), final: claudeFinal({ model: 'claude-opus-5-5' }) }],
  },
  {
    name: 'anthropic_refusal_local',
    env: { ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'claude' },
    input: BASE,
    claude: [{ message: { content: [{ type: 'text', text: '' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'refusal', model: 'claude-opus-5' } }],
  },
  {
    name: 'haiku_chosen_fails_no_self_rescue',
    env: { ANTHROPIC_API_KEY: 'a-key' },
    delta: true,
    input: { ...BASE, llm: 'anthropic:claude-haiku-5-5' },
    claude: [{ events: [], throw: 'overloaded' }],
  },
  {
    name: 'haiku_default_with_both_keys',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key' },
    delta: true,
    input: BASE,
    claude: [{ events: claudeDeltas(ANSWER('Yillik 24 foiz.', true, [1])), final: claudeFinal() }],
  },
  {
    name: 'haiku_default_fails_local',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key' },
    input: BASE,
    claude: [{ throw: 'overloaded' }],
  },
  {
    name: 'human_shortcut',
    env: { GEMINI_API_KEY: 'g-key' },
    delta: true,
    input: { ...BASE, question: 'Operator bilan ulang iltimos' },
  },
  {
    name: 'loan_awaiting_opening',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, question: 'Allo', hits: [], confidence: 0, history: [], persona: 'professional', target: TARGET, greeting: 'Assalomu alaykum, men Laylo, Ipoteka bankdanman.', timeZone: 'Asia/Tashkent' },
    fetch: [{ body: geminiBody(ANSWER('Assalomu alaykum! Aziz Karimov bilan gaplashyapmanmi?', true, [])) }],
  },
  {
    name: 'loan_just_wrong_year',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, question: 'bir ming to‘qqiz yuz to‘qson birinchi yil', hits: [], target: TARGET, history: [{ role: 'caller', text: 'Allo' }, { role: 'agent', text: 'Aziz Karimov bilan gaplashyapmanmi?' }, { role: 'caller', text: 'Ha, menman' }] },
    fetch: [{ body: geminiBody(ANSWER('Kechirasiz, bu to‘g‘ri emas.', true, [])) }],
  },
  {
    name: 'loan_one_wrong_then_other_line',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, question: 'Nega qo‘ng‘iroq qilyapsiz?', hits: [], target: TARGET, history: [{ role: 'caller', text: '1990' }, { role: 'agent', text: 'Afsus, bu noto‘g‘ri.' }] },
    fetch: [{ body: geminiBody(ANSWER('Bu shaxsiy masala.', true, [])) }],
  },
  {
    name: 'loan_failed_two_wrong',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, question: '85-yil', hits: [], target: TARGET, history: [{ role: 'caller', text: '1990' }, { role: 'agent', text: 'Noto‘g‘ri.' }] },
    fetch: [{ body: geminiBody(ANSWER('Ma’lumotlar mos kelmadi. Xayr.', true, [])) }],
  },
  {
    name: 'loan_confirmed_asked_day_then_question',
    env: { GEMINI_API_KEY: 'g-key' },
    input: {
      ...BASE, language: 'uz', question: 'Qancha to‘lashim kerak?', hits: [], persona: 'concise', instructions: 'Qisqa gapiring.', target: TARGET,
      greeting: 'Salom, men Laylo.', timeZone: 'Asia/Tashkent',
      history: [{ role: 'caller', text: 'Ha, menman' }, { role: 'agent', text: 'Rahmat! Tug‘ilgan yilingiz?' }, { role: 'caller', text: '92-yil' }, { role: 'agent', text: 'Rahmat. Qaysi kuni to‘lay olasiz?' }],
    },
    fetch: [{ body: geminiBody(ANSWER('7 800 000 so‘m.', true, [])) }],
  },
  {
    name: 'loan_unchecked_no_year_on_file_ru',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, language: 'ru', question: 'Да, это я', hits: [], target: { ...TARGET, birthYear: '', loanAmount: '' }, timeZone: 'Europe/Moscow' },
    fetch: [{ body: geminiBody(ANSWER('Спасибо!', true, [])) }],
  },
  {
    name: 'loan_named_day_uz',
    env: { GEMINI_API_KEY: 'g-key' },
    input: {
      ...BASE, language: 'uz', question: '1 haftadan keyin', hits: [], target: TARGET, timeZone: 'Asia/Tashkent',
      history: [{ role: 'caller', text: 'Ha, menman' }, { role: 'agent', text: 'Rahmat! Tug‘ilgan yilingiz?' }, { role: 'caller', text: '1992' }, { role: 'agent', text: 'Rahmat. Qaysi kuni to‘lay olasiz?' }],
    },
    fetch: [{ body: geminiBody(ANSWER('Yaxshi, o‘n to‘qqizinchi noyabr, payshanba kuni kutamiz.', true, [])) }],
  },
  {
    name: 'loan_named_day_ru_unchecked',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, language: 'ru', question: 'Через неделю, наверное', hits: [], target: { ...TARGET, birthYear: '' }, timeZone: 'Europe/Moscow' },
    fetch: [{ body: geminiBody(ANSWER('Хорошо, ждём девятнадцатого ноября.', true, [])) }],
  },
  {
    name: 'loan_named_day_before_identity',
    env: { GEMINI_API_KEY: 'g-key' },
    input: { ...BASE, language: 'uz', question: 'ertaga gaplashamiz', hits: [], target: TARGET, timeZone: 'Asia/Tashkent', history: [{ role: 'caller', text: 'Ha' }] },
    fetch: [{ body: geminiBody(ANSWER('Tug‘ilgan yilingizni ayting.', true, [])) }],
  },
  {
    name: 'lookup_facts_and_note_long_history',
    env: { GEMINI_API_KEY: 'g-key' },
    input: {
      ...BASE, question: 'Yukim qayerda?', extraSystem: 'SHIPMENT 4812: in Samarkand, arriving tomorrow.', extraNote: '(Lookup: found shipment 4812.)',
      history: Array.from({ length: 46 }, (_, i) => ({ role: i % 2 ? 'agent' : 'caller', text: `gap ${i}` })),
    },
    fetch: [{ body: geminiBody(ANSWER('Yukingiz Samarqandda.', true, [])) }],
  },
  {
    name: 'gemini_empty_answer_local_floor',
    env: { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key', LLM_PROVIDER: 'gemini' },
    input: BASE,
    fetch: [{ body: geminiBody(ANSWER('   ', true, [])) }],
    claude: [{ throw: 'down' }],
  },
];

const SUMMARIES = [
  {
    name: 'summary_gemini',
    env: { GEMINI_API_KEY: 'g-key' },
    args: [[{ role: 'caller', text: 'Kredit bo‘yicha savol' }, { role: 'agent', text: 'Tushunmadim' }, { role: 'caller', text: 'Operator kerak' }], 'uz', 'explicit_request', null],
    fetch: [{ body: geminiBody('  Mijoz kredit haqida so‘rayapti.  ') }],
  },
  {
    name: 'summary_claude',
    env: { ANTHROPIC_API_KEY: 'a-key' },
    args: [[{ role: 'caller', text: 'Help' }, { role: 'agent', text: 'Sure' }], 'en', 'low_confidence', 'anthropic:claude-haiku-5-5'],
    claude: [{ message: { content: [{ type: 'text', text: 'Caller needs help.' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn', model: 'claude-haiku-5-5' } }],
  },
  {
    name: 'summary_short_local',
    env: { GEMINI_API_KEY: 'g-key' },
    args: [[{ role: 'caller', text: 'Salom' }], 'ru', 'negative_sentiment', null],
  },
  {
    name: 'summary_openai_fails_local',
    env: { OPENAI_API_KEY: 'o-key' },
    args: [[{ role: 'caller', text: 'A' }, { role: 'agent', text: 'B' }], 'en', 'max_turns', null],
    fetch: [{ status: 500, body: 'oops' }],
  },
];

function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

function reset(sc) {
  fetchScript = JSON.parse(JSON.stringify(sc.fetch ?? []));
  claudeScript = JSON.parse(JSON.stringify(sc.claude ?? []));
  requests.length = 0;
  claudeCalls.length = 0;
  usage.length = 0;
}

function usageView() {
  return usage.map((u) => {
    const { ms, firstMs, ...rest } = u;
    return { ...rest, firstMs: firstMs == null ? null : 'set' };
  });
}

(async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  const out = { scenarios: [], summaries: [], resolve: [] };
  for (const sc of SCENARIOS) {
    setEnv(sc.env);
    reset(sc);
    const provider = fresh('lib/llm/provider.js');
    const deltas = [];
    const result = await provider.generateAnswer(JSON.parse(JSON.stringify(sc.input)), sc.delta ? (d) => deltas.push(d) : undefined);
    out.scenarios.push({
      name: sc.name, env: sc.env, delta: Boolean(sc.delta), input: sc.input, fetch: sc.fetch ?? [], claude: sc.claude ?? [],
      requests: JSON.parse(JSON.stringify(requests)), claudeCalls: JSON.parse(JSON.stringify(claudeCalls)),
      deltas, result, usage: usageView(), leftover: { fetch: fetchScript.length, claude: claudeScript.length },
    });
  }
  for (const sc of SUMMARIES) {
    setEnv(sc.env);
    reset(sc);
    const provider = fresh('lib/llm/provider.js');
    const result = await provider.summarizeCall(...sc.args);
    out.summaries.push({ name: sc.name, env: sc.env, args: sc.args, fetch: sc.fetch ?? [], claude: sc.claude ?? [], requests: JSON.parse(JSON.stringify(requests)), claudeCalls: JSON.parse(JSON.stringify(claudeCalls)), result });
  }
  // Model resolution and labels under different keys.
  const choices = [null, 'gemini:gemini-3.8-flash', 'openai:gpt-5.5', 'anthropic:claude-haiku-5-5', 'ollama:gemma4:31b', 'bogus', ':x', 'gemini: ', 'gemini'];
  const envs = [{}, { GEMINI_API_KEY: 'g' }, { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }, { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, { OLLAMA_BASE_URL: 'http://x', GEMINI_API_KEY: 'g', LLM_PROVIDER: 'anthropic' }, { OPENAI_API_KEY: 'o', LLM_PROVIDER: 'OpenAI', GEMINI_MODEL: 'gm' }];
  for (const env of envs) {
    setEnv(env);
    const provider = fresh('lib/llm/provider.js');
    for (const c of choices) {
      out.resolve.push({ env, choice: c, resolved: provider.resolveLlm(c), name: provider.engineName(c), label: provider.engineLabel(c), hosted: provider.engineIsHosted(c) });
    }
  }
  console.warn = origWarn;
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  console.log(`scenarios ${out.scenarios.length}, summaries ${out.summaries.length}, resolve ${out.resolve.length}`);
  for (const s of out.scenarios) console.log(s.name.padEnd(48), s.result.engine.padEnd(40), JSON.stringify(s.leftover));
})();
