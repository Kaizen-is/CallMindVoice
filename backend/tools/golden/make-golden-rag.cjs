// Runs the ORIGINAL TypeScript RAG modules (compiled to ./out) on fixed inputs and writes
// the reference outputs the Python port must reproduce exactly.
// Usage: node make-golden-rag.cjs <output.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
// '@/lib/db' is replaced by an in-memory stub serving the test corpus; other '@/lib/x' → compiled files.
let corpusRows = [];
const dbStub = {
  all(sql) {
    if (/COUNT\(\*\)/.test(sql)) return [{ c: corpusRows.length, m: 'golden' }];
    return corpusRows;
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@/lib/db') return 'golden-db-stub';
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
require.cache['golden-db-stub'] = { id: 'golden-db-stub', filename: 'golden-db-stub', loaded: true, exports: dbStub };

delete process.env.OPENAI_API_KEY; // local embeddings only

const text = require(path.join(OUT, 'lib/rag/text.js'));
const embed = require(path.join(OUT, 'lib/rag/embed.js'));
const chunk = require(path.join(OUT, 'lib/rag/chunk.js'));
const retrieve = require(path.join(OUT, 'lib/rag/retrieve.js'));
const packs = require(path.join(OUT, 'lib/starter-packs.js'));

const b64 = (f32) => Buffer.from(embed.packVector(f32)).toString('base64');

const STRINGS = [
  'Assalomu alaykum! Kredit olish uchun qanday hujjatlar kerak?',
  'Ассалому алайкум, кредит олиш учун қандай ҳужжатлар керак?',
  'Здравствуйте, сколько стоит консультация кардиолога?',
  'Hello, how much does a cardiologist consultation cost?',
  "O'zbekiston, g'alaba, oʻqish, gʻoya, o‘rta, g’isht — apostrophe variants",
  'Kartamni bloklamoqchiman, oxirgi 4 raqami 8600 1234 5678 9012',
  'Foiz stavkasi yillik 24% dan boshlanadi; minimal summa 5 000 000 so\'m.',
  'Мне нужно перенести запись на субботу, можно?',
  'Ish vaqti: dushanba–juma 09:00–18:00, shanba 09:00–14:00. Yakshanba dam olish kuni.',
  'Filial manzili qayerda? Chilonzor metro yonidami?',
  'Operator bilan gaplashmoqchiman, iltimos ulang',
  'Соедините меня с живым оператором пожалуйста',
  "I'd like to RETURN my order #A-1045 and get a refund.",
  'Strahovoy polis OSAGO stoimost? Mashina 2019 yil',
  'Bolalar shifokori (pediatr) qabuliga yozilish',
  'Natijalar qachon tayyor bo‘ladi? Analiz topshirgan edim.',
  'Mening ismim Aziz Karimov, tugʻilgan yilim 1992-yil.',
  'Yetkazib berish narxi qancha? Toshkent bo‘ylab bepulmi?',
  'Payme, Click, Uzcard va Humo orqali to‘lov qilsa bo‘ladimi?',
  'Muddatli to‘lov (rassrochka) 12 oyga bormi?',
  'Résumé, café, naïve — accented letters fold',
  'Emoji test 😀👍 kredit 💳 olish',
  'TEST tEsT ТЕСТ тест',
  'a b c d e f g',
  '   ',
  '',
  '12345 67.890 +998 71 200 70 70 info@medline.uz 50% /path',
  'Shikoyatim bor: muammo hal bo‘lmadi, pul qaytarilmadi.',
  'Bekor qilish va ko‘chirish (perenos) shartlari qanday?',
  'Chegirma va aksiya bormi? Skidka 10%?',
  'what are your opening hours on saturday and sunday?',
  'Где находится ваш офис и как к вам доехать?',
  'Shu yil davomida to‘lasam bo‘ladimi?',
  'Boʻlmasa sakkizinchi dekabrda.',
  'Ҳа, албатта. Раҳмат!',
  'qanday qilib kartani blokdan chiqarish mumkin',
  'sha sho shu cha cho chu qa qe qi qo qu',
  'Line one.\n\nLine two after blank.\nLine three. Next Sentence here! And «quoted» start. 3 items.',
];

const QUERIES = [
  'Ish vaqti qanday?',
  'Klinika soat nechada ochiladi?',
  'Сколько стоит консультация кардиолога?',
  'how much is a cardiologist visit',
  'Manzilingiz qayerda?',
  'Где вы находитесь?',
  'Analiz natijalari qachon tayyor?',
  'Полис ОСАГО стоимость',
  'sug‘urta polisi narxi',
  'Strahovoy sluchay chto delat',
  'Buyurtmamni qaytarsam bo‘ladimi?',
  'Можно вернуть товар?',
  'Yetkazib berish narxi',
  'Muddatli to‘lov bormi?',
  'Kredit foiz stavkasi qancha?',
  'Kartani qanday bloklash mumkin?',
  'Как заблокировать карту?',
  'Operator bilan bog‘lash',
  'pediatr qabuliga yozilish',
  'Payme orqali to‘lash mumkinmi?',
  'xyzzy plugh frobnicate',
  '',
  'shanba kuni ishlaysizmi',
  'weekend opening hours',
  'telefon raqamingiz',
];

const BANK_DOC = [
  '# Kredit mahsulotlari',
  '',
  'Iste\'mol krediti: yillik 24% dan, muddati 36 oygacha.',
  'Avtokredit: yillik 21% dan, boshlang\'ich to\'lov 25%.',
  '- Minimal summa: 5 000 000 so\'m',
  '- Maksimal summa: 300 000 000 so\'m',
  '',
  'KARTA XIZMATLARI',
  'Kartani bloklash uchun 1600 raqamiga qo\'ng\'iroq qiling yoki mobil ilovadan foydalaning.',
  'Kartani blokdan chiqarish faqat filialda pasport bilan',
  'amalga oshiriladi va bir kun ichida bajariladi.',
  '',
  '1. Филиалы и часы работы',
  'Головной офис: Ташкент, проспект Амира Темура, 15. Пн–Пт 9:00–18:00.',
  'Филиал Чиланзар: ул. Бунёдкор, 7. Суббота 9:00–14:00.',
  '',
  'Ҳужжатлар',
  'Кредит олиш учун паспорт, иш жойидан маълумотнома ва даромад ҳақида справка керак.',
  '',
  'Long paragraph',
  Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} explains a banking rule in detail. Another clause follows here!`).join(' '),
].join('\r\n');

const NO_STRUCTURE = 'just one long unstructured blob of text without any line breaks or headings that goes on and on about loans and cards and branches and opening hours '.repeat(12);

const DOCS = [
  { id: 'doc_clinic', title: 'Clinic', text: packs.starterPackFor('clinic').body },
  { id: 'doc_insurance', title: 'Insurance', text: packs.starterPackFor('insurance').body },
  { id: 'doc_retail', title: 'Retail', text: packs.starterPackFor('retail').body },
  { id: 'doc_bank', title: 'Bank', text: BANK_DOC },
  { id: 'doc_blob', title: 'Blob title', text: NO_STRUCTURE },
];

const FAQ = [
  { q: 'Kredit qancha muddatga beriladi?', a: '36 oygacha.' },
  { q: '  Karta yo‘qolsa nima qilish kerak?  ', a: ' 1600 ga qo‘ng‘iroq qiling. ' },
  { q: 'empty answer', a: '   ' },
];

// ── text functions ──
const strings = STRINGS.map((s) => {
  const toks = text.tokenize(s);
  return {
    input: s,
    normalize: text.normalize(s),
    tokenize: toks,
    tokenizeAll: text.tokenize(s, { keepStopwords: true }),
    stems: text.stems(s),
    concepts: toks.map((t) => text.conceptOf(text.stem(t))),
    ngrams: toks.length ? text.charNgrams(toks[0]) : [],
    language: text.detectLanguage(s),
    estimateTokens: text.estimateTokens(s),
    sentences: text.sentences(s),
    highlight: text.highlight(s, 'kredit hujjat narx karta'),
    embedding: b64(embed.localEmbed(s)),
  };
});

// ── chunking ──
const chunks = DOCS.map((d) => ({ id: d.id, title: d.title, text: d.text, chunks: chunk.chunkDocument(d.text, d.title) }));
const faq = chunk.chunkFaq(FAQ);

// ── retrieval over a corpus built exactly as ingest.ts stores it ──
let n = 0;
corpusRows = [];
for (const d of chunks) {
  for (const c of d.chunks) {
    const counts = {};
    for (const t of text.stems(c.text)) counts[t] = (counts[t] ?? 0) + 1;
    if (c.heading) for (const t of text.stems(c.heading)) counts[t] = (counts[t] ?? 0) + 2;
    corpusRows.push({
      id: `chk_${String(n++).padStart(4, '0')}`,
      document_id: d.id,
      heading: c.heading,
      text: c.text,
      token_count: c.tokenCount,
      embedding: embed.packVector(embed.localEmbed(c.text)),
      terms_json: JSON.stringify(counts),
      title: d.title,
    });
  }
}

(async () => {
  const retrievals = [];
  for (const q of QUERIES) {
    const r = await retrieve.retrieve('ten_golden', q, { topK: 5 });
    retrievals.push({
      query: q,
      confidence: r.confidence,
      strategy: r.strategy,
      totalChunks: r.totalChunks,
      hits: r.hits.map((h) => ({ chunkId: h.chunkId, score: h.score, lexicalScore: h.lexicalScore, denseScore: h.denseScore, rank: h.rank, snippet: h.snippet })),
    });
  }
  const golden = {
    note: 'Generated from the TypeScript modules in src/lib/rag (and starter-packs.ts). Regenerate only when the TypeScript changes.',
    strings,
    chunks,
    faq,
    corpus: corpusRows.map((r) => ({ ...r, embedding: Buffer.from(r.embedding).toString('base64') })),
    retrievals,
  };
  fs.writeFileSync(process.argv[2], JSON.stringify(golden, null, 1));
  console.log(`strings ${strings.length}, documents ${chunks.length} → ${corpusRows.length} chunks, faq ${faq.length}, queries ${retrievals.length}`);
})();
