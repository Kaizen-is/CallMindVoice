// Reference outputs of the ORIGINAL TypeScript logistics demo lookup (src/lib/logistics-data.ts) for
// tests/test_logistics_data_parity.py: the number reading, the shipment lookup, the day labels and the
// whole prompt part, at fixed moments ("now" is pinned, as the dates are offsets from today).
// Usage: node make-golden-logistics.cjs <output.json>
const Module = require('module');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('@/lib/')) return origResolve.call(this, path.join(OUT, 'lib', request.slice(6)), parent, ...rest);
  return origResolve.call(this, request, parent, ...rest);
};

// The helpers the module keeps private, exposed for the fixture.
const dataJs = path.join(OUT, 'lib/logistics-data.js');
const dataSrc = fs.readFileSync(dataJs, 'utf8');
if (!dataSrc.includes('exports.__dayLabel')) {
  fs.writeFileSync(
    dataJs,
    `${dataSrc}\nexports.__dayLabel = dayLabel; exports.__spelledDigits = spelledDigits; ` +
      `exports.__joinedDigits = joinedDigits; exports.__numbersIn = numbersIn;\n`,
  );
}

// `new Date()` / Date.now() answer the pinned moment.
const RealDate = Date;
let pinned = null;
global.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0 && pinned !== null) super(pinned);
    else super(...args);
  }
  static now() {
    return pinned ?? RealDate.now();
  }
};

const data = require(dataJs);

const LINES = [
  [],
  [''],
  ['Assalomu alaykum, posilkam qayerda?'],
  ['482913'],
  ['Track raqamim 482913'],
  ['Mening track raqamim 48 29 13'],
  ['48, 29, 13'],
  ['48-29-13 raqamli yuk'],
  ['48.29.13'],
  ["to'rt yuz sakson ikki ming to'qqiz yuz o'n uch"],
  ["olti bir besh nol ikki yetti"],
  ['Olti Bir Besh Nol Ikki Yetti'],
  ['OLTI, BIR, BESH, NOL, IKKI, YETTI'],
  ['olti-bir-besh-nol-ikki-yetti'],
  ['yetti uch to‘qqiz bir sakkiz to’rt'],
  ['yetti uch toqqiz bir sakkiz tort'],
  ['yetti uch toʻqqiz bir sakkiz toʼrt'],
  ['yetti uch to`qqiz bir sakkiz to`rt'],
  ["yetti yuz o'ttiz to'qqiz ming, bir yuz sakson to'rt"],
  ["sakkiz yuz yigirma yetti ming to'rt yuz besh"],
  ['Telefonim 901234567'],
  ['+998 90 123 45 67'],
  ['998901234567'],
  ['telefon raqamim 93 234 56 78'],
  ['99 345 67 89 raqamiga yuborilgan'],
  ['97 123 45 67'],
  ['raqam 123456'],
  ['raqam 999999 edi'],
  ['raqamim 48 29'],
  ['48'],
  ['qirq sakkiz yigirma to‘qqiz'],
  ['1'],
  ['12345'],
  ['1234567890123'],
  ['12345678901'],
  ['482913 va 615027'],
  ['Birinchisi 482913, ikkinchisi 739184'],
  ['482913', 'rahmat'],
  ['999999', '482913'],
  ['482913', '999999'],
  ['482913', '48 29'],
  ['salom', '48'],
  ['salom', 'bilmayman'],
  ['салом', 'мой трек-номер 615027'],
  ['мой номер 250 468'],
  ['908351'],
  ['374620'],
  ['561739'],
  ['951112233'],
  ['887654321'],
  ['946789012'],
  ['905678901'],
  ['250468 qachon keladi?'],
  ['827405!'],
  ['827405?'],
  ['827405; rahmat'],
  ['8 2 7 4 0 5'],
  ['8  2  7  4  0  5'],
  ['82\t74\n05'],
  ['82 74 05 va 61 50 27'],
  ['nol nol nol'],
  ['bir ikki'],
  ['bir ikki uch'],
  ['bir ikki uchinchi'],
  ['birinchi ikkinchi uchinchi'],
  ['bir ikki uch tort besh olti yetti sakkiz toqqiz nol bir ikki uch'],
  ["to'rt sakkiz ikki to'qqiz bir uch"],
  ["to'rt yuz sakson ikki ming, to'qqiz yuz o'n uch"],
  ['Ⅳ ٤٨٢٩١٣ 482913'],
  ['ſix 482913'],
  ['beſh bir ikki'],
  ['bir iKKi uch'], // Kelvin sign: no `u` flag, so no case match with "k"
  ['ſakkiz bir ikki'], // long s: likewise
  // Every shipment at once: each one described, at every moment.
  ['482913 615027 739184 827405 250468 908351 374620 561739'],
];
const EVERY = LINES.length - 1;

const MOMENTS = [
  '2026-11-17T09:30:00.000Z',
  '2026-11-17T19:30:00.000Z', // already the 18th in Tashkent
  '2026-12-30T12:00:00.000Z', // the year turns within the offsets
  '2027-02-26T08:00:00.000Z', // February, not a leap year
  '2028-02-27T08:00:00.000Z', // February, a leap year
];

const cases = [];
for (const now of MOMENTS) {
  pinned = new RealDate(now).getTime();
  for (const [i, lines] of LINES.entries()) {
    // The whole prompt (long) for a fifth of the lines at the first moment, a few at the others, and
    // the every-shipment line everywhere.
    const full = i === EVERY || (now === MOMENTS[0] ? i % 5 === 0 : i % 17 === 4);
    const lookup = data.lookupShipments(lines);
    cases.push({
      now,
      lines,
      lookup: {
        found: lookup.found.map((s) => s.track),
        matchedBy: [...lookup.matchedBy.entries()],
        unknownNumber: lookup.unknownNumber,
        partial: lookup.partial,
      },
      note: data.lookupNote(lines),
      agentName: i % 2 ? 'Laylo' : 'Isomiddin',
      context: full ? data.logisticsContext(lines, i % 2 ? 'Laylo' : 'Isomiddin') : null,
      contextRu: full && i % 10 === 0 ? data.logisticsContext(lines, 'Laylo', 'Europe/Moscow') : null,
    });
  }
}

const dayLabels = [];
for (const now of MOMENTS) {
  pinned = new RealDate(now).getTime();
  for (const zone of ['Asia/Tashkent', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    for (let offset = -17; offset <= 17; offset++) {
      dayLabels.push({ now, zone, offset, label: data.__dayLabel(offset, zone) });
    }
  }
}
pinned = null;

const readings = LINES.flat().map((line) => ({
  line,
  spelled: data.__spelledDigits(line),
  joined: data.__joinedDigits(line),
  numbers: data.__numbersIn(line),
}));

// One record per line: compact, and a regenerated file still diffs line by line.
const list = (items) => `[\n${items.map((item) => JSON.stringify(item)).join(',\n')}\n]`;
fs.writeFileSync(
  process.argv[2],
  `{"tryTracks": ${JSON.stringify([...data.TRY_TRACKS])},\n"vocabulary": ${JSON.stringify([...data.LOGISTICS_VOCABULARY])},\n` +
    `"cases": ${list(cases)},\n"dayLabels": ${list(dayLabels)},\n"readings": ${list(readings)}}\n`,
);
console.log(`${cases.length} cases, ${dayLabels.length} day labels, ${readings.length} readings`);
