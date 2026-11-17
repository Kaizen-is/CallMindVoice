// Copies the data tables the Python PDF text extractor (backend/app/rag/pdf_text.py) needs out of
// the pdf.js build that unpdf ships (node_modules/unpdf/dist/pdfjs.mjs), so both sides decode text
// with the same tables: the seven simple-font encodings, the glyph-name → Unicode list, the
// standard / substitute font-name maps, the serif-font list, the standard 14 fonts' widths, and the
// content-stream operators with their argument counts.
//
// Usage (repo root): node backend/tools/pdfjs-tables.cjs backend/app/rag/pdfjs_tables.json
// Re-run after upgrading unpdf; a changed file means pdf.js changed and the Python must follow.
const fs = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '../../node_modules/unpdf/dist/pdfjs.mjs');
const src = fs.readFileSync(bundlePath, 'utf8');
const version = (src.match(/apiVersion:`([\d.]+)`/) || [])[1];

function getLookupTableFactory(init, asArray = false) {
  let table;
  return function () {
    if (init) {
      table = asArray ? [] : Object.create(null);
      init(table);
      init = null;
    }
    return table;
  };
}

/** The `name=getLookupTableFactory(...)` call, evaluated. */
function factory(name) {
  const found = new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}=getLookupTableFactory\\(`).exec(src);
  if (!found) throw new Error(`table ${name} not found`);
  const start = found.index;
  let i = src.indexOf('(', start);
  const open = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  const call = `getLookupTableFactory${src.slice(open, i + 1)}`;
  // eslint-disable-next-line no-new-func
  return new Function('getLookupTableFactory', 'mt', `return ${call};`)(getLookupTableFactory, glyphs)();
}

let glyphTable = null;
const glyphs = () => glyphTable;
glyphTable = factory('mt');

// const st=`…`.split(`.`),ct=…,lt=…,ut=…,dt=…,ft=…,pt=`…`.split(`.`);
const encStart = src.indexOf('const st=');
const encEnd = src.indexOf('.split(`.`);', src.indexOf(',pt=', encStart)) + '.split(`.`);'.length;
// eslint-disable-next-line no-new-func
const enc = new Function(`${src.slice(encStart, encEnd)} return {st,ct,lt,ut,dt,ft,pt};`)();

const metricsRaw = factory('$t');
const metrics = {};
for (const [name, value] of Object.entries(metricsRaw)) metrics[name] = typeof value === 'number' ? value : { ...value() };

const opStart = src.indexOf('static get opMap(){');
const opEnd = src.indexOf('}))}', opStart);
const ops = {};
for (const m of src.slice(opStart, opEnd).matchAll(/(?:^|[{,])(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_*]+)):\{id:C\.\w+,numArgs:(\d+),variableArgs:(!0|!1)\}/g)) {
  ops[m[1] ?? m[2] ?? m[3] ?? m[4]] = [Number(m[5]), m[6] === '!0'];
}

const out = {
  pdfjs: version,
  encodings: {
    StandardEncoding: enc.ut,
    WinAnsiEncoding: enc.dt,
    MacRomanEncoding: enc.lt,
    SymbolSetEncoding: enc.ft,
    ZapfDingbatsEncoding: enc.pt,
    ExpertEncoding: enc.st,
    MacExpertEncoding: enc.ct,
  },
  glyphs: { ...glyphs() },
  stdFontMap: { ...factory('Rt') },
  nonStdFontMap: { ...factory('Bt') },
  serifFonts: Object.keys(factory('Vt')),
  symbolsFonts: Object.keys(factory('Ht')),
  metrics,
  ops,
};
for (const [name, table] of Object.entries(out.encodings)) if (table.length !== 256) throw new Error(`${name}: ${table.length} entries`);
fs.writeFileSync(process.argv[2], `${JSON.stringify(out)}\n`);
console.log(`pdf.js ${version}: ${Object.keys(out.glyphs).length} glyph names, ${Object.keys(ops).length} operators`);
