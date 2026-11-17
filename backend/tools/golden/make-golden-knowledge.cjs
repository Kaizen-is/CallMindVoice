// Reference behaviour of the ORIGINAL TypeScript knowledge base for the Python parity test
// (backend/tests/test_knowledge_parity.py): every server action in src/app/actions/knowledge.ts,
// the knowledge page's data (src/app/app/knowledge/page.tsx) and POST /api/v1/documents, run on a
// real SQLite file with the real auth.ts (session cookies), ingest pipeline (unpdf, mammoth,
// chunking, local embeddings) and retrieval. Recorded: each call's result (or what it threw), the
// revalidatePath calls, bus events and webhook dispatches, and at the end every row written
// (documents, chunks with their vectors and term counts, audit log, API-key stamps).
// IDs and timestamps come from counters (patched into db.ts) so the Python run can match them exactly.
// Usage: node make-golden-knowledge.cjs <output.json> <workdir>
const Module = require('module');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OUT = path.join(__dirname, 'out');
const REPO = path.join(__dirname, '../../..');
const OUTPUT = path.resolve(process.argv[2]);
const WORK = process.argv[3];
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'data'), { recursive: true });
process.chdir(WORK); // db.ts opens <cwd>/data/ovoz.db; uploads go to <cwd>/data/uploads

const SECRET = 'test-secret-öçü-2026'; // backend/tests/conftest.py
process.env.OVOZ_SESSION_SECRET = SECRET;
for (const k of ['OPENAI_API_KEY', 'OPENAI_EMBEDDING_MODEL']) delete process.env[k];

let token = '';
const revalidated = [];
const webhooks = [];
const stubs = {
  'server-only': {},
  'next/cache': { revalidatePath: (p) => revalidated.push(p) },
  'next/headers': {
    cookies: async () => ({
      get: (name) => (name === 'ovoz_session' && token ? { name, value: token } : undefined),
      getAll: () => (token ? [{ name: 'ovoz_session', value: token }] : []),
    }),
    headers: async () => new Headers(),
  },
  '@/lib/webhooks': { dispatchWebhook: async (tenantId, event, data) => webhooks.push({ tenantId, event, data }) },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request in stubs) return `stub:${request}`;
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};
for (const [name, exports] of Object.entries(stubs)) require.cache[`stub:${name}`] = { id: `stub:${name}`, filename: `stub:${name}`, loaded: true, exports };
module.paths.unshift(path.join(REPO, 'node_modules'));
process.env.NODE_PATH = path.join(REPO, 'node_modules');
Module._initPaths();

/* ── scripted web pages for addUrlAction ── */
const PAGES = {
  'https://klinika.uz/narxlar': {
    status: 200,
    body:
      '<!doctype html><html><head><title> Klinika &amp; narxlar </title><style>p{color:red}</style>' +
      '<script>var x = "<p>yashirin</p>";</script></head><body><nav><a href="/">Bosh sahifa</a></nav>' +
      '<h1>Qabul narxlari</h1><p>Terapevt qabuli — 120&nbsp;000 so&#39;m.</p><ul><li>Kardiolog — 180 000 so\'m</li>' +
      '<li>LOR — 150 000 so\'m</li></ul><div>Ish vaqti: dushanbadan jumagacha 08:00 dan 20:00 gacha.<br>Shanba 09:00–16:00.</div>' +
      '<h2>Manzil</h2><p>Toshkent, Chilonzor &lt;metro&gt; yonida, &quot;Medline&quot; binosi.</p><footer>© 2026</footer></body></html>',
  },
  'https://example.uz/page': {
    status: 200,
    // 140 letters + 6 emoji: 146 characters but 152 UTF-16 units, so JavaScript's {1,150} does not match.
    body: `<html><head><title>${'Sarlavha '.repeat(20).slice(0, 140)}${'😀'.repeat(6)}</title></head><body><p>Bu sahifada yetarlicha matn bor: xizmatlar, narxlar va ish vaqti haqida batafsil ma'lumot.</p></body></html>`,
  },
  'https://short.uz/': { status: 200, body: '<html><head><title>Qisqa</title></head><body>Salom</body></html>' },
  'https://missing.uz/': { status: 404, body: 'not found' },
  'https://klinika.uz/a%20b?x=1': {
    status: 200,
    body: '﻿<html><head><title>BOM bilan sahifa</title></head><body><p>Bu sahifa UTF-8 BOM bilan boshlanadi va charset sarlavhasi boshqacha.</p></body></html>',
  },
};
const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  const key = String(url);
  fetched.push({ url: key, userAgent: init.headers?.['user-agent'] ?? null });
  if (key === 'https://down.uz/') throw new TypeError('fetch failed');
  const page = PAGES[key];
  if (!page) throw new TypeError('fetch failed');
  return new Response(Buffer.from(page.body, 'utf8'), { status: page.status, headers: { 'content-type': 'text/html; charset=windows-1251' } });
};

/* ── deterministic ids and clock ── */
const db = require(path.join(OUT, 'lib/db.js'));
const counters = {};
db.id = (prefix) => {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}_${String(counters[prefix]).padStart(16, '0')}`;
};
let tick = 0;
const BASE = Date.parse('2026-11-12T05:00:00.000Z');
db.now = () => new Date(BASE + 1000 * tick++).toISOString();

// Expose ingest.ts's private helpers for the unit cases at the end.
const ingestJs = path.join(OUT, 'lib/rag/ingest.js');
const ingestSrc = fs.readFileSync(ingestJs, 'utf8');
if (!ingestSrc.includes('exports.__units')) fs.writeFileSync(ingestJs, `${ingestSrc}\nexports.__units = { cleanupPdf, csvToText, jsonToText, sanitize };\n`);
const ingest = require(ingestJs);
const bus = require(path.join(OUT, 'lib/engine/bus.js'));
const actions = require(path.join(OUT, 'app/actions/knowledge.js'));
const analytics = require(path.join(OUT, 'lib/analytics.js'));
const starterPacks = require(path.join(OUT, 'lib/starter-packs.js'));
const route = require(path.join(OUT, 'app/api/v1/documents/route.js'));

/* ── seed ── */
const STAMP = '2026-11-12T00:00:00.000Z';
const FAR = '2099-01-01T00:00:00.000Z';
const SEED = {
  tenants: [
    { id: 'ten_clinic', name: 'Medline', slug: 'medline', industry: 'clinic', created_at: STAMP, updated_at: STAMP },
    { id: 'ten_bank', name: 'Bank', slug: 'bank', industry: 'finance', created_at: STAMP, updated_at: STAMP },
  ],
  users: [
    { id: 'usr_admin', tenant_id: 'ten_clinic', email: 'a@x.uz', name: 'Aziz', password_hash: 'x', role: 'admin', locale: 'uz', created_at: STAMP, updated_at: STAMP },
    { id: 'usr_analyst', tenant_id: 'ten_clinic', email: 'b@x.uz', name: 'Bobur', password_hash: 'x', role: 'analyst', locale: 'ru', created_at: STAMP, updated_at: STAMP },
    { id: 'usr_owner', tenant_id: 'ten_bank', email: 'c@x.uz', name: 'Dilnoza', password_hash: 'x', role: 'owner', locale: 'en', created_at: STAMP, updated_at: STAMP },
  ],
  sessions: [
    { id: 'ses_admin', user_id: 'usr_admin', tenant_id: 'ten_clinic', created_at: STAMP, expires_at: FAR },
    { id: 'ses_analyst', user_id: 'usr_analyst', tenant_id: 'ten_clinic', created_at: STAMP, expires_at: FAR },
    { id: 'ses_owner', user_id: 'usr_owner', tenant_id: 'ten_bank', created_at: STAMP, expires_at: FAR },
  ],
  api_keys: [
    { id: 'key_write', tenant_id: 'ten_bank', name: 'w', prefix: 'ovoz_sk_write', hash: sha256('ovoz_sk_write_key_0001'), scopes: 'read,write', created_at: STAMP },
    { id: 'key_read', tenant_id: 'ten_bank', name: 'r', prefix: 'ovoz_sk_read', hash: sha256('ovoz_sk_read_key_0001'), scopes: 'read', created_at: STAMP },
  ],
};
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
for (const [table, rows] of Object.entries(SEED)) {
  for (const row of rows) {
    const keys = Object.keys(row);
    db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
  }
}
function cookieFor(sid) {
  return `${sid}.${crypto.createHmac('sha256', SECRET).update(sid).digest('base64url')}`;
}

/* ── synthetic upload files ── */
function pdfFile() {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dict, data) => `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
  const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()).join('');
  const toUnicode = add(
    stream(
      '',
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def\n' +
        '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
        '2 beginbfchar <0020> <0020> <041F> <041F> endbfchar\n' +
        '2 beginbfrange <0430> <044F> <0430> <0410> <0412> [<0410> <0411> <0412>] endbfrange\n' +
        'endcmap CMapName currentdict /CMap defineresource pop end end',
    ),
  );
  const cidDescriptor = add('<< /Type /FontDescriptor /FontName /CustomSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>');
  const cidFont = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CustomSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${cidDescriptor} 0 R /DW 600 /W [ 32 [278] 1040 [640 620 610] 1071 [710] 1072 1103 520 ] >>`);
  const f2 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /CustomSans /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const timesDescriptor = add('<< /Type /FontDescriptor /FontName /TimesNewRomanPSMT /Flags 34 /FontBBox [-568 -216 2046 693] /ItalicAngle 0 /Ascent 891 /Descent -216 /CapHeight 662 /StemV 82 >>');
  const widths = Array.from({ length: 95 }, (_, i) => 250 + ((i * 37) % 400)).join(' ');
  const f3 = add(`<< /Type /Font /Subtype /TrueType /BaseFont /TimesNewRomanPSMT /FirstChar 32 /LastChar 126 /Widths [${widths}] /Encoding /WinAnsiEncoding /FontDescriptor ${timesDescriptor} 0 R >>`);
  const symDescriptor = add('<< /Type /FontDescriptor /FontName /CustomSymbols /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 333 >>');
  const f4 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /CustomSymbols /FirstChar 1 /LastChar 4 /Widths [500 510 520 530] /Encoding << /Type /Encoding /Differences [1 /uni0451 /afii10071 /G41 /f_t] >> /FontDescriptor ${symDescriptor} 0 R >>`);
  const form = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Matrix [1 0 0 1 0 -100] /Resources << /Font << /F1 ${f1} 0 R >> >>`, 'BT /F1 10 Tf 72 400 Td (Form ichidagi matn ham olinadi) Tj ET'));
  const content1 = [
    'BT /F1 14 Tf 72 780 Td (Klinika ish vaqti) Tj',
    '/F1 11 Tf 0 -20 Td [(Dushanba) -250 (dan) -2500 (Juma) -250 (gacha) 0 ( ochiq)] TJ',
    '0 -14 Td (Narxlar: terapevt 120 000 so\'m, infor-) Tj',
    '0 -14 Td (matsion xizmatlar bepul.) Tj',
    '2 Tc 0 -24 Td (BO\'LIM) Tj 0 Tc',
    '0 -14 Td (The builder of the building) Tj',
    'ET',
    'q BT /F1 9 Tf 1 0 0 1 400 780 Tm (Telefon: +998 71 200 70 70) Tj ET Q',
    '/Span << /MCID 0 >> BDC BT /F3 12 Tf 72 600 Td (Times matni. Ikkinchi gap) Tj 50 Tz ( siqilgan) Tj 100 Tz 5 Ts (yuqori) Tj 0 Ts ET EMC',
    `BT /F2 12 Tf 72 560 Td <${hex('Прайс лист')}> Tj ET`,
    'BT /F4 12 Tf 72 540 Td <01020304> Tj ( ) Tj ET',
    'BT /F1 12 Tf 0 1 -1 0 300 300 Tm (Aylantirilgan matn) Tj ET',
    'BT /F1 12 Tf 72 -50 Td (Sahifadan tashqarida) Tj ET',
    '/X1 Do',
  ].join('\n');
  const c1 = add(stream('', content1));
  const content2 = [
    'BT /F1 11 Tf 14 TL 72 700 Td (Ikkinchi sahifa birinchi qator) Tj',
    'T* (ikkinchi qator kichik harf bilan) Tj',
    "(uchinchi qator apostrof bilan) '",
    '2 1 (to\'rtinchi qator qo\'shtirnoq bilan) "',
    '0 -20 Td (O\'ng tomonda) Tj 400 0 Td (kesilgan joyda) Tj',
    'ET',
  ].join('\n');
  const c2 = add(stream('', content2));
  const resources = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R /F4 ${f4} 0 R >> /XObject << /X1 ${form} 0 R >> >>`;
  const pages = objects.length + 4; // after the two pages and the catalog
  const p1 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${c1} 0 R >>`);
  const p2 = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /CropBox [0 0 300 842] /Resources ${resources} /Contents ${c2} 0 R >>`);
  add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  if (add(`<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 >>`) !== pages) throw new Error('page tree id');
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${pages - 1} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function docxFile() {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const date = new Date('2026-11-12T00:00:00Z');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { date, createFolders: false });
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', { date, createFolders: false });
  const p = (inner) => `<w:p>${inner}</w:p>`;
  const r = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const body = [
    p(r('Shartnoma shartlari')),
    p(r('Birinchi band: ') + '<w:r><w:rPr><w:b/></w:rPr><w:t>muhim</w:t></w:r><w:r><w:tab/><w:t>tab bilan</w:t></w:r>'),
    p('<w:r><w:t>Qator</w:t><w:br/><w:t>ikkinchi qator davom etadi</w:t></w:r>'),
    `<w:tbl><w:tr><w:tc>${p(r('Xizmat'))}</w:tc><w:tc>${p(r('Narx'))}</w:tc></w:tr><w:tr><w:tc>${p(r('Terapevt'))}</w:tc><w:tc>${p(r("120 000 so'm"))}</w:tc></w:tr></w:tbl>`,
    p(r('Тўлов шартлари: олдиндан 50% тўланади, қолгани хизмат кўрсатилгандан сўнг.')),
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`, { date, createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const TEXT_UZ = [
  'Ish vaqti va manzil',
  'Klinika dushanbadan jumagacha 08:00 dan 20:00 gacha ishlaydi. Shanba kuni 09:00 dan 16:00 gacha.',
  'Manzil: Toshkent shahri, Chilonzor tumani, Bunyodkor ko\'chasi 12-uy.',
  '',
  'Qabul narxlari',
  'Terapevt qabuli — 120 000 so\'m.',
  'Kardiolog qabuli — 180 000 so\'m. Birinchi konsultatsiya EKG bilan birga.',
  'LOR (quloq-burun-tomoq) qabuli — 150 000 so\'m.',
  '',
  '2024 yil narxlari',
  '1. Umumiy qon tahlili — 60 000 so\'m, natija 3 soatda tayyor.',
  '2. MRT bosh miya — 850 000 so\'m.',
].join('\n');

async function files() {
  const big = { name: 'katta.txt', type: 'text/plain', fill: 'a', size: 25 * 1024 * 1024 + 1 };
  return {
    batch: [
      { name: "Narxlar_ro'yxati-2026.txt", type: 'text/plain', data: Buffer.from(TEXT_UZ, 'utf8') },
      { name: 'eslatma.md', type: '', data: Buffer.from('# Eslatma\n\nBemorlar qabulga 10 daqiqa oldin kelishlari kerak.\n\n## Bekor qilish\n\nKamida 2 soat oldin xabar bering.\n', 'utf8') },
      { name: 'narxlar.csv', type: 'text/csv', data: Buffer.from('﻿Xizmat,Narx,Izoh\n"Terapevt, birlamchi",120000,\nKardiolog,180000,"EKG ""bilan"""\n\n,,\nLOR,150000,tez\n', 'utf8') },
      { name: 'jadval.tsv', type: '', data: Buffer.from('Kun\tVaqt\nDushanba\t08:00-20:00\nShanba\t09:00-16:00\r\nYakshanba\tdam olish\n', 'utf8') },
      { name: 'sahifa.html', type: 'text/html', data: Buffer.from(PAGES['https://klinika.uz/narxlar'].body, 'utf8') },
      { name: 'malumot.json', type: 'application/json', data: Buffer.from(JSON.stringify({ xizmat: 'Terapevt', '2': 'ikki', '10': [true, null, 1.5, 1e21, 0.1], '1': { a: { b: { c: { d: { e: { f: { g: 'chuqur' } } } } } } }, narx: 120000, katta: 0 }).replace('"katta":0', '"katta":12345678901234567890'), 'utf8') },
      { name: 'buzilgan.json', type: 'application/json', data: Buffer.from('{"xizmat": "Terapevt", narx: 120000, izoh: "bu JSON emas, oddiy matn sifatida olinadi"', 'utf8') },
      { name: 'hisobot.pdf', type: 'application/pdf', data: pdfFile() },
      { name: 'shartnoma.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await docxFile() },
      { name: 'bo\'sh.txt', type: 'text/plain', data: Buffer.from('salom', 'utf8') },
      { name: 'buzuq.pdf', type: 'application/pdf', data: Buffer.from('bu PDF emas', 'utf8') },
      { name: 'buzuq.docx', type: '', data: Buffer.from('bu ham Word fayli emas', 'utf8') },
      big,
      { name: '.yashirin', type: '', data: Buffer.from('Nuqta bilan boshlanadigan fayl nomi, kengaytmasi yo\'q, oddiy matn.', 'utf8') },
      { name: 'skan.bin', type: 'application/pdf', data: pdfFile() },
      { name: 'ПРАЙС ЛИСТ.TXT', type: 'text/plain', data: Buffer.from('Прайс-лист: консультация терапевта 120 000 сум, кардиолога 180 000 сум.\nЗапись по телефону.', 'utf8') },
    ],
    single: [{ name: 'yagona.txt', type: 'text/plain', data: Buffer.from('Bitta fayl: navbatga yozilish telefon orqali yoki Telegram bot orqali amalga oshiriladi.', 'utf8') }],
    failing: [
      { name: 'a.txt', type: 'text/plain', data: Buffer.from('qisqa', 'utf8') },
      big,
    ],
    constructor: [{ name: 'construction.txt', type: 'text/plain', data: Buffer.from('Building notes\nThe constructor visits on Monday. The constructor brings the plans and the constructor signs the contract.\nPrices are fixed for 2026.', 'utf8') }],
  };
}

function toFormData(list) {
  const fd = new FormData();
  for (const f of list) {
    const data = f.data ?? Buffer.alloc(f.size, f.fill);
    fd.append('files', new File([data], f.name, { type: f.type }));
  }
  fd.append('note', 'not a file'); // non-file entries are ignored
  return fd;
}
const describe = (list) => list.map((f) => (f.data ? { name: f.name, type: f.type, b64: f.data.toString('base64') } : { name: f.name, type: f.type, fill: f.fill, size: f.size }));

/* ── the run ── */
const events = [];
for (const t of ['ten_clinic', 'ten_bank']) bus.subscribe(t, (e) => events.push({ tenant: t, ...e }));

async function call(step) {
  token = step.as ? cookieFor(step.as) : '';
  revalidated.length = 0;
  events.length = 0;
  webhooks.length = 0;
  fetched.length = 0;
  let result;
  try {
    const value = await step.run();
    // NaN/Infinity kept visible as '__NaN'; the retrieval timing (tookMs) is not reproducible, so it is dropped.
    const replacer = (k, v) => (k === 'tookMs' ? null : typeof v === 'number' && !Number.isFinite(v) ? `__${v}` : v);
    result = { value: JSON.parse(JSON.stringify(value, replacer)) };
  } catch (err) {
    result = { throws: err.constructor.name, message: err.message };
  }
  return { ...result, revalidated: [...revalidated], events: [...events], webhooks: [...webhooks], fetched: [...fetched] };
}

async function v1(headers, body) {
  const req = new Request('http://localhost/api/v1/documents', { method: 'POST', headers, body });
  const res = await route.POST(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

(async () => {
  const F = await files();
  const steps = [];
  const run = async (name, spec, fn) => {
    const out = await call({ as: spec.as, run: fn });
    steps.push({ name, ...spec, ...out });
  };
  const A = 'ses_admin';
  const B = 'ses_analyst';
  const O = 'ses_owner';

  await run('upload_batch', { as: A, action: 'uploadDocumentsAction', files: describe(F.batch) }, () => actions.uploadDocumentsAction(toFormData(F.batch)));
  await run('upload_single', { as: A, action: 'uploadDocumentsAction', files: describe(F.single) }, () => actions.uploadDocumentsAction(toFormData(F.single)));
  await run('upload_failing', { as: A, action: 'uploadDocumentsAction', files: describe(F.failing) }, () => actions.uploadDocumentsAction(toFormData(F.failing)));
  await run('upload_none', { as: A, action: 'uploadDocumentsAction', files: [] }, () => actions.uploadDocumentsAction(toFormData([])));
  await run('upload_forbidden', { as: B, action: 'uploadDocumentsAction', files: describe(F.single) }, () => actions.uploadDocumentsAction(toFormData(F.single)));
  await run('upload_signed_out', { as: null, action: 'uploadDocumentsAction', files: describe(F.single) }, () => actions.uploadDocumentsAction(toFormData(F.single)));
  await run('upload_owner_constructor', { as: O, action: 'uploadDocumentsAction', files: describe(F.constructor) }, () => actions.uploadDocumentsAction(toFormData(F.constructor)));

  for (const url of ['https://klinika.uz/narxlar', 'example.uz/page', 'https://Klinika.UZ:443/a b?x=1', 'https://short.uz', 'https://missing.uz/', 'https://down.uz/', 'http://exa mple.uz', 'httpx://foo.uz/', 'ftp://files.uz/x', 'javascript:alert(1)', '']) {
    await run(`url ${url}`, { as: A, action: 'addUrlAction', args: { url } }, () => actions.addUrlAction(url));
  }
  await run('url_forbidden', { as: B, action: 'addUrlAction', args: { url: 'https://klinika.uz/narxlar' } }, () => actions.addUrlAction('https://klinika.uz/narxlar'));

  const longText = 'Navbatga yozilish telefon orqali, Telegram bot orqali yoki klinikaga kelib amalga oshiriladi. Yozilishda ism-familiya va telefon raqam kerak.';
  for (const [title, text] of [['  Eslatma  ', longText], ['', longText], ['Qisqa', '   juda qisqa matn   '], ['😀'.repeat(120), longText + ' Emoji sarlavha.']]) {
    await run(`text ${title.slice(0, 10)}`, { as: A, action: 'addTextAction', args: { title, text } }, () => actions.addTextAction(title, text));
  }
  const pairs = [
    { q: 'Ish vaqtingiz qanday?', a: 'Dushanbadan jumagacha 08:00 dan 20:00 gacha.' },
    { q: '   ', a: 'bo\'sh savol' },
    { q: 'Manzil qayerda?', a: '  ' },
    { q: 'Сколько стоит приём терапевта?', a: '120 000 сум, повторный приём со скидкой 50%.' },
  ];
  await run('faq', { as: A, action: 'addFaqAction', args: { title: '  Savollar ', pairs } }, () => actions.addFaqAction('  Savollar ', pairs));
  await run('faq_one', { as: A, action: 'addFaqAction', args: { title: '', pairs: pairs.slice(0, 1) } }, () => actions.addFaqAction('', pairs.slice(0, 1)));
  await run('faq_empty', { as: A, action: 'addFaqAction', args: { title: 'X', pairs: pairs.slice(1, 3) } }, () => actions.addFaqAction('X', pairs.slice(1, 3)));
  await run('faq_short', { as: A, action: 'addFaqAction', args: { title: 'Y', pairs: [{ q: 'Ha?', a: 'Ha.' }] } }, () => actions.addFaqAction('Y', [{ q: 'Ha?', a: 'Ha.' }]));
  await run('starter_clinic', { as: A, action: 'addStarterPackAction', args: {} }, () => actions.addStarterPackAction());
  await run('starter_finance', { as: O, action: 'addStarterPackAction', args: {} }, () => actions.addStarterPackAction());

  for (const query of ['terapevt narxi qancha', 'Сколько стоит приём кардиолога?', 'MRT', 'ish vaqti shanba', 'insurance policy price', '', 'constructor']) {
    await run(`retrieve clinic ${query}`, { as: B, action: 'testRetrievalAction', args: { query } }, () => actions.testRetrievalAction(query));
  }
  for (const query of ['opening hours', 'constructor plans', 'qabul']) {
    await run(`retrieve bank ${query}`, { as: O, action: 'testRetrievalAction', args: { query } }, () => actions.testRetrievalAction(query));
  }
  await run('list_clinic', { as: B, action: 'listDocumentsAction', args: {} }, () => actions.listDocumentsAction());

  await run('reindex_text', { as: A, action: 'reindexDocumentAction', args: { documentId: 'doc_0000000000000001' } }, () => actions.reindexDocumentAction('doc_0000000000000001'));
  const failed = db.get("SELECT id FROM documents WHERE status='failed' AND tenant_id='ten_clinic' ORDER BY rowid LIMIT 1");
  await run('reindex_failed', { as: A, action: 'reindexDocumentAction', args: { documentId: failed.id } }, () => actions.reindexDocumentAction(failed.id));
  await run('reindex_missing', { as: A, action: 'reindexDocumentAction', args: { documentId: 'doc_nope' } }, () => actions.reindexDocumentAction('doc_nope'));
  const other = db.get("SELECT id FROM documents WHERE tenant_id='ten_bank' ORDER BY rowid LIMIT 1");
  await run('reindex_other_tenant', { as: A, action: 'reindexDocumentAction', args: { documentId: other.id } }, () => actions.reindexDocumentAction(other.id));
  await run('delete', { as: A, action: 'deleteDocumentAction', args: { documentId: 'doc_0000000000000002' } }, () => actions.deleteDocumentAction('doc_0000000000000002'));
  await run('delete_again', { as: A, action: 'deleteDocumentAction', args: { documentId: 'doc_0000000000000002' } }, () => actions.deleteDocumentAction('doc_0000000000000002'));
  await run('delete_forbidden', { as: B, action: 'deleteDocumentAction', args: { documentId: 'doc_0000000000000001' } }, () => actions.deleteDocumentAction('doc_0000000000000001'));
  await run('list_after_delete', { as: A, action: 'listDocumentsAction', args: {} }, () => actions.listDocumentsAction());

  // The page's data, as page.tsx computed it.
  const views = {};
  for (const tenant of ['ten_clinic', 'ten_bank']) {
    const t = db.get('SELECT * FROM tenants WHERE id=?', tenant);
    const pack = starterPacks.starterPackFor(t.industry);
    views[tenant] = {
      documents: db.all(
        `SELECT id, title, source_type, source_ref, byte_size, language, status, progress, error,
                chunk_count, token_count, char_count, created_at, updated_at
         FROM documents WHERE tenant_id=? ORDER BY created_at DESC`,
        tenant,
      ),
      stats: analytics.knowledgeStats(tenant),
      pack: { industry: pack.industry, title: pack.title, description: pack.description },
    };
  }

  // POST /api/v1/documents
  const auth = { authorization: 'Bearer ovoz_sk_write_key_0001', 'content-type': 'application/json' };
  const api = [];
  const apiCases = [
    ['no key', {}, JSON.stringify({ title: 'X', text: 'y' })],
    ['bad scheme', { authorization: 'Basic abc' }, '{}'],
    ['malformed key', { authorization: 'Bearer sk_live_123' }, '{}'],
    ['unknown key', { authorization: 'Bearer ovoz_sk_unknown' }, '{}'],
    ['read-only key', { authorization: 'Bearer ovoz_sk_read_key_0001' }, '{}'],
    ['invalid json', auth, '{title: x}'],
    ['null body', auth, 'null'],
    ['array body', auth, '[]'],
    ['no title', auth, JSON.stringify({ title: '   ', text: 'matn' })],
    ['no text', auth, JSON.stringify({ title: 'Sarlavha', text: '  \n ' })],
    ['too short', auth, JSON.stringify({ title: 'Qisqa', text: 'kichik' })],
    ['ok md', auth, JSON.stringify({ title: '  API hujjati  ', text: TEXT_UZ, sourceType: 'md' })],
    ['ok unknown type', auth, JSON.stringify({ title: 'API ikkinchi', text: 'Yetkazib berish Toshkent bo\'ylab bepul, viloyatlarga 2-3 kun ichida.', sourceType: 'exe' })],
    ['bom body', auth, '﻿' + JSON.stringify({ title: 'BOM', text: 'Bu so\'rov tanasi UTF-8 BOM bilan boshlanadi, lekin JSON to\'g\'ri.' })],
  ];
  for (const [name, headers, body] of apiCases) {
    webhooks.length = 0;
    let res;
    try {
      res = await v1(headers, body);
    } catch (err) {
      res = { status: 500, body: null, throws: err.message }; // Next.js answers an uncaught error with a 500
    }
    api.push({ name, headers, request: body, status: res.status, response: res.body, throws: res.throws ?? null, webhooks: [...webhooks] });
  }

  const dump = {
    documents: db.all('SELECT * FROM documents ORDER BY rowid'),
    chunks: db.all('SELECT * FROM chunks ORDER BY rowid').map((c) => ({ ...c, embedding: c.embedding ? Buffer.from(c.embedding).toString('base64') : null })),
    audit_log: db.all('SELECT * FROM audit_log ORDER BY rowid'),
    api_keys: db.all('SELECT id, last_used FROM api_keys ORDER BY id'),
    uploads: fs.existsSync(path.join(WORK, 'data/uploads'))
      ? fs.readdirSync(path.join(WORK, 'data/uploads')).flatMap((t) => fs.readdirSync(path.join(WORK, 'data/uploads', t)).sort().map((f) => `${t}/${f}`))
      : [],
  };
  const packs = {};
  for (const industry of ['clinic', 'insurance', 'retail', 'finance', 'other']) packs[industry] = starterPacks.starterPackFor(industry);

  // The helpers on their own, with edge cases the uploads above do not reach.
  const { cleanupPdf, csvToText, jsonToText, sanitize } = ingest.__units;
  const titleOf = (html, url) => (html.match(/<title[^>]*>([^<]{1,150})<\/title>/i)?.[1] ?? new URL(url).hostname).trim();
  const units = {
    extname: ['a.pdf', 'A.PDF', '.bashrc', 'a.', 'a.b.c', '..', '...', '.a.b', 'noext', '', 'dir.x/file', 'a.txt/', 'x/.y', 'ф.doc', 'a..b', '. pdf'].map((n) => [n, path.posix.extname(n)]),
    html: [
      '<P>One</p><P>Two</P>',
      '<SCRIPT>x</SCRIPT>a<br/>b<BR >c',
      '<li class="x">a</li><li>b</li>',
      '<h3 id=t>Head</h3>text',
      'a&amp;lt;b &nbsp;&nbsp; c',
      '<div>\n\n\n\n</div>x',
      '<nav>menu</nav><footer>f</footer>body',
      '<ſcript>x</ſcript>y',
    ].map((h) => [h, ingest.htmlToText(h)]),
    csv: [
      ['a,b\n1,2\n', ','],
      ['"x, y",z\r\n"he said ""hi""",\n', ','],
      ['h1\th2\n v1 \t\n', '\t'],
      ['only header\n', ','],
      ['', ','],
      ['a,b,c\n1\n1,,3,4\n', ','],
    ].map(([c, d]) => [c, d, csvToText(c, d)]),
    json: [
      { b: 1, 2: 'two', 1: 'one', a: { '01': 'x', 10: 'y', 4294967295: 'big', 4294967294: 'max' } },
      [1.5, 1e21, 1e-7, -0, 123456789012, true, false, null, 'str'],
      { d1: { d2: { d3: { d4: { d5: { d6: { d7: 'deep' } } } } } } },
      'plain',
      42,
      null,
    ].map((v) => [v, jsonToText(v)]),
    // As uploaded: the text's own key order, which JavaScript re-sorts (integer keys first).
    jsonText: ['{"b":1,"2":"two","1":"one","01":"x","-1":"neg","1.5":"f","4294967294":"max","4294967295":"over"}', '{"a":1,"a":2,"b":{"z":0,"0":"zero"}}', '[12345678901234567890, 1e400, -0.0, 0.1]', '{"__proto__": "p", "constructor": 1}'].map((t) => [t, jsonToText(JSON.parse(t))]),
    cleanupPdf: ['infor-\nmation', 'line one\nline two', 'Title\nNext', 'end.\nnext', 'a\r\nb\rc', 'x\n\n\n\ny', 'a  \t b', '  padded  ', 'Ўзбек\nтили', 'word-\nWord'].map((t) => [t, cleanupPdf(t)]),
    sanitize: ['\u0000a\u0007b\u000Bc\u000Cd\u001Fe\u007Ff﻿g', '\t\n  x  \r\n', ' y '].map((t) => [t, sanitize(t)]),
    title: [
      ['<TITLE lang=uz>  Sarlavha  </TITLE>', 'https://a.uz/'],
      ['<title></title><title>Ikkinchi</title>', 'https://a.uz/'],
      ['<title>x<y</title>', 'https://b.uz/p'],
      [`<title>${'a'.repeat(150)}</title>`, 'https://c.uz/'],
      [`<title>${'a'.repeat(151)}</title>`, 'https://d.uz/'],
      [`<title>${'😀'.repeat(75)}</title>`, 'https://e.uz/'],
      [`<title>${'😀'.repeat(76)}</title>`, 'https://xn--e1afmkfd.xn--p1ai/'],
    ].map(([h, u]) => [h, u, titleOf(h, u)]),
  };

  fs.writeFileSync(OUTPUT, `${JSON.stringify({ seed: SEED, secret: SECRET, base: BASE, pages: PAGES, steps, views, api, dump, packs, units }, null, 1)}\n`);
  console.log(`${steps.length} action calls, ${api.length} API calls, ${dump.documents.length} documents, ${dump.chunks.length} chunks, clock ${tick}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
