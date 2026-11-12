// Reference outputs of the ORIGINAL TypeScript speech/LLM helpers for the Python parity tests.
// Usage: node make-golden-text.cjs <golden_rag.json> <output.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@/lib/db') return 'golden-db-stub';
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['golden-db-stub'] = { id: 'golden-db-stub', filename: 'golden-db-stub', loaded: true, exports: { all: () => [] } };

const numbers = require(path.join(OUT, 'lib/speech/numbers.js'));
const normalize = require(path.join(OUT, 'lib/speech/normalize.js'));
const local = require(path.join(OUT, 'lib/llm/local.js'));
const loan = require(path.join(OUT, 'lib/llm/loan-call.js'));
const jsonStream = require(path.join(OUT, 'lib/llm/json-stream.js'));
const rag = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const NUMBER_PHRASES = [
  "bir ming to'qqiz yuz to'qson ikkinchi yilda tug'ilganman",
  'yetti million sakkiz yuz ming so‘m qarzingiz bor',
  "o'n beshinchi oktabrda to'layman",
  'yigirma beshinchi noyabr',
  "to'qson to'qqiz bir ikki uch to'rt besh olti yetti",
  'bir daqiqa kutib turing',
  'bir-ikki kun ichida',
  'birdan birga keldik',
  'ikki yuz ellik ming',
  'besh yuzta mijoz',
  "o'n ikkidan keyin",
  'mingga yaqin odam',
  'ellig inchi',
  'ellikinchi yil',
  'uchinchisi yaxshiroq',
  'birinchi navbatda',
  'ikkinchi dekabrda',
  'o‘ttiz birinchi dekabr',
  'qirq besh',
  'nol nol bir',
  'Bir Ming Ikki Yuz',
  'bir milliard ikki yuz million',
  'sakson sakkiz yoshda',
  "to'rt yuz to'qson",
  'oltmish yetti va yetmish olti',
  'yuz',
  'ming',
  'bir',
  '',
  '2024-yil 15-mart, 7 800 000 so‘m',
  "o'n-o'n besh daqiqa",
  'yigirma - yigirma besh',
];

const SPEECH_TEXTS = [
  '**Muhim:** ish vaqti 09:00-18:00, shanba 9:00–14:00.',
  'Telefon: +998 90 123 45 67 yoki +998901234567, qo‘shimcha 712007070.',
  'Narxi 250 000 so‘m, chegirma bilan 199,000 UZS yoki $25.',
  'Цена 1.500.000 сум, или 120 USD, или €99.',
  'Masofa 12km, og‘irligi 3 kg, maydoni 45m2.',
  '# Sarlavha\n- birinchi band\n- ikkinchi band\n1. raqamli band\n\nYangi xatboshi.',
  'Batafsil: https://www.medline.uz/narxlar?ref=1 yoki info@medline.uz ga yozing.',
  'Qabul: 8:30 – 17:00 | dam olish: yakshanba',
  '«Kredit» bo‘yicha "ma’lumot" „bor”.',
  'Код: `ABC-123` и [ссылка](https://x.uz). ```code block``` готово.',
  'Soat 23:00 dan 07:30 gacha yopiq. 24:00 emas.',
  '2024-2025 o‘quv yili, mahsulot kodi 12-34-56.',
  'Balans: 1 234 567 890 so‘m; karta 8600 1234 5678 9012.',
  'Курс: $1 = 12 850 сум. Комиссия 1%.',
  'Hello!! Price is $1,250.50 — open 9:00-17:00 Mon-Fri.',
  'Short.',
  '   spaced   text   with   gaps   ',
  'Line one\nline two\n\nline three',
  'So‘m va soʻm ikkalasi ham, UZS ham.',
  'Ruble ₽500 and RUB 200, EUR 10.',
];

const LONG_REPLIES = [
  'Assalomu alaykum! Sizning kreditingiz bo‘yicha qarzdorlik yetti million sakkiz yuz ming so‘mni tashkil qiladi. To‘lovni qaysi kuni amalga oshira olasiz? Agar savollaringiz bo‘lsa, bemalol so‘rang.',
  'Ha. Albatta. Tushunarli, rahmat. Kartangizni bloklash uchun mobil ilovaga kiring, sozlamalar bo‘limini oching, kartalar ro‘yxatidan kerakli kartani tanlang, bloklash tugmasini bosing, so‘ng tasdiqlash kodini kiriting va operatsiyani yakunlang.',
  'Короткий ответ.',
  'This is a single very long sentence without any terminal punctuation that just keeps going on and on, with commas, more commas, and even more clauses, until it is well past the maximum chunk length of one hundred and twenty characters, at which point it must wrap',
];

const INTENT_TEXTS = [
  ...rag.strings.map((s) => s.input),
  'Operatorga ulang!!!',
  'RAHMAT, XAYR',
  'ha',
  'yomon xizmat, juda uzoq kutdim',
  'ОЧЕНЬ ПЛОХО!!! НЕ РАБОТАЕТ',
  'thanks, great and fast',
  'where is my order zakaz',
  'qanday qilib hujjat olish mumkin',
];

// Hits from the TypeScript retrieval over the golden corpus, with the fields synthesizeLocal reads.
const byId = Object.fromEntries(rag.corpus.map((r) => [r.id, r]));
const hitsFor = (i) =>
  rag.retrievals[i].hits.map((h) => ({ ...h, text: byId[h.chunkId].text, heading: byId[h.chunkId].heading, documentTitle: byId[h.chunkId].title }));

const SYNTH_CASES = [];
rag.retrievals.forEach((r, i) => {
  if (!r.hits.length) return;
  for (const [language, threshold] of [['uz', 0.45], ['ru', 0.3], ['en', 0.99]]) {
    SYNTH_CASES.push({ question: r.query, hits: hitsFor(i), confidence: r.confidence, language, threshold, history: [] });
  }
});
SYNTH_CASES.push({ question: 'Salom!', hits: [], confidence: 0, language: 'uz', threshold: 0.45, history: [] });
SYNTH_CASES.push({ question: 'Salom!', hits: [], confidence: 0, language: 'uz', threshold: 0.45, history: [{ role: 'caller', text: 'x' }] });
SYNTH_CASES.push({ question: 'operator kerak', hits: hitsFor(0), confidence: 0.9, language: 'ru', threshold: 0.45, history: [] });
SYNTH_CASES.push({ question: 'rahmat, xayr', hits: hitsFor(0), confidence: 0.9, language: 'en', threshold: 0.45, history: [] });
SYNTH_CASES.push({ question: 'Narxi qancha?', hits: hitsFor(0), confidence: 0.9, language: 'uz', threshold: 0.45, history: [], maxChars: 60 });

const SUMMARY_CASES = [
  { turns: [], language: 'uz', reason: 'low_confidence' },
  { turns: [{ role: 'caller', text: 'Kredit  narxi\nqancha?' }, { role: 'agent', text: 'x' }, { role: 'caller', text: 'yomon, juda uzoq kutdim!!' }], language: 'uz', reason: 'negative_sentiment' },
  { turns: [{ role: 'caller', text: 'Соедините с оператором' }], language: 'ru', reason: 'explicit_request' },
  { turns: [{ role: 'caller', text: 'x'.repeat(200) + ' 😀' }], language: 'en', reason: 'custom_reason' },
];

const IDENTITY_CASES = [
  { birthYear: '1992', lines: ['Ha, men Azizman', 'bir ming to‘qqiz yuz to‘qson ikkinchi yilda'] },
  { birthYear: '1992', lines: ['92-yil'] },
  { birthYear: '1992', lines: ['1990', '1991', '1992'] },
  { birthYear: '1992', lines: ['1990, 1991, 1992'] },
  { birthYear: '1992', lines: ['92'] },
  { birthYear: '1992', lines: ['1933'] },
  { birthYear: '1992', lines: ['92-го года'] },
  { birthYear: '1992', lines: ['salom', 'qaysi yil?'] },
  { birthYear: '', lines: ['1992'] },
  { birthYear: '92', lines: ['1992'] },
  { birthYear: '1985', lines: ['sakson besh yil', 'yo‘q'] },
  { birthYear: '1985', lines: ['1985-yilda', 'ha'] },
];

const CALENDAR_CASES = [
  ['2026-11-12T07:00:00Z', 'Asia/Tashkent'],
  ['2026-11-15T20:30:00Z', 'Asia/Tashkent'],
  ['2026-11-30T19:30:00Z', 'Asia/Tashkent'],
  ['2026-01-31T10:00:00Z', 'Asia/Tashkent'],
  ['2028-02-29T10:00:00Z', 'Asia/Tashkent'],
  ['2026-12-31T21:00:00Z', 'Asia/Tashkent'],
  ['2026-03-29T01:30:00Z', 'Europe/Moscow'],
  ['2026-11-14T23:30:00Z', 'America/New_York'],
];

const STREAM_CASES = [
  { raw: '{"answer":"Assalomu alaykum, kreditingiz bo\'yicha.","answered":true,"usedExcerpts":[1]}', cuts: [1, 5, 12, 20, 33, 47, 60] },
  { raw: '{"answer":"Qator\\nyangi \\"iqtibos\\" va \\\\ teskari, \\u0451lka \\u00e9","answered":false,"usedExcerpts":[]}', cuts: [14, 15, 16, 30, 31, 44, 45, 46, 47, 52] },
  { raw: '{ "answered": true, "answer" : "tartib boshqa", "usedExcerpts": [] }', cuts: [3, 28, 31, 40] },
  { raw: '{"answer":"emoji \\ud83d\\ude00 bor","answered":true}', cuts: [20, 26, 27, 32] },
  { raw: '{"answer":"bad \\uZZ12 escape","answered":true}', cuts: [] },
  { raw: '{"usedExcerpts":[1],"answered":true}', cuts: [10] },
];

const golden = {
  note: 'Generated from src/lib/speech/{numbers,normalize}.ts and src/lib/llm/{local,loan-call,json-stream}.ts. Regenerate only when the TypeScript changes.',
  numbers: NUMBER_PHRASES.map((t) => ({ input: t, output: numbers.uzbekNumbersToDigits(t) })),
  speech: SPEECH_TEXTS.flatMap((t) => ['uz', 'ru', 'en'].map((lang) => ({ input: t, language: lang, output: normalize.normalizeForSpeech(t, lang) }))),
  split: [...LONG_REPLIES, ...SPEECH_TEXTS].map((t) => ({ input: t, output: normalize.splitForSpeech(t) })),
  intents: INTENT_TEXTS.map((t) => ({ input: t, intent: local.classifyIntent(t), sentiment: local.sentimentOf(t) })),
  synth: SYNTH_CASES.map((c) => ({ ...c, output: local.synthesizeLocal({ ...c, agentName: 'Nadya' }) })),
  summaries: SUMMARY_CASES.map((c) => ({ ...c, output: local.summarizeLocal(c.turns, c.language, c.reason) })),
  identity: IDENTITY_CASES.map((c) => ({ ...c, output: loan.identityCheck({ fullName: 'Aziz', birthYear: c.birthYear, loanAmount: '', prompt: '' }, c.lines) })),
  calendar: CALENDAR_CASES.map(([iso, tz]) => ({ now: iso, timeZone: tz, output: loan.calendarBlock(tz, new Date(iso)) })),
  stream: STREAM_CASES.map((c) => {
    const deltas = [];
    const feed = jsonStream.answerExtractor((d) => deltas.push(d));
    for (const cut of [...c.cuts, c.raw.length]) feed(c.raw.slice(0, cut));
    return { ...c, deltas };
  }),
};
for (const s of golden.synth) s.output.usedHits = s.output.usedHits.map((h) => h.chunkId);
fs.writeFileSync(process.argv[3], JSON.stringify(golden, null, 1));
console.log(Object.entries(golden).filter(([k]) => k !== 'note').map(([k, v]) => `${k} ${v.length}`).join(', '));
