/**
 * Spelled-out Uzbek numbers → digits, for what the Uzbek STT hears.
 *
 * Kotib writes exactly what was said, so a caller's year of birth arrives as
 * "bir ming to'qqiz yuz to'qson ikkinchi yilda" — and the model, asked to
 * compare that with 1992 on file, gets it wrong. Digits it does not get wrong.
 * Amounts and dates read better too: "yetti million sakkiz yuz ming" becomes
 * "7 800 000", "o'n beshinchi oktabrda" becomes "15-oktabrda".
 *
 * Only real numbers are rewritten. A lone small number stays a word, because
 * "bir" is also the article and an idiom ("bir daqiqa" — just a moment,
 * "birdan" — at once, "birga" — together), and "bir-ikki kun" (a day or two)
 * is not "1 2 kun".
 */

const VALUES: Record<string, number> = {
  nol: 0,
  bir: 1,
  ikki: 2,
  uch: 3,
  "to'rt": 4,
  besh: 5,
  olti: 6,
  yetti: 7,
  sakkiz: 8,
  "to'qqiz": 9,
  "o'n": 10,
  yigirma: 20,
  "o'ttiz": 30,
  qirq: 40,
  ellik: 50,
  oltmish: 60,
  yetmish: 70,
  sakson: 80,
  "to'qson": 90,
};

const SCALES: Record<string, number> = { yuz: 100, ming: 1_000, million: 1_000_000, milliard: 1_000_000_000 };

/** Endings a number can carry: "beshta", "o'ndan", "ikkinchisi", "mingga". */
const ENDINGS = ['tadan', 'gacha', 'ning', 'dan', 'ga', 'da', 'ni', 'ta', 'si', ''];

const MONTH = /^(yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sent[ya]?abr|okt[ya]?abr|noyabr|dekabr)/;

interface NumberWord {
  value: number;
  scale: boolean;
  ordinal: boolean;
  ending: string;
}

/** One word as a number, or null. Apostrophes are already normalised to '. */
function readWord(word: string): NumberWord | null {
  for (const ending of ENDINGS) {
    if (ending && !word.endsWith(ending)) continue;
    const base = ending ? word.slice(0, -ending.length) : word;
    if (!base) continue;
    const plain = lookup(base);
    if (plain) return { ...plain, ordinal: false, ending };
    // Ordinals: bir+inchi, ikki+nchi, ellig+inchi (ellik softens).
    for (const suffix of ['inchi', 'nchi']) {
      if (!base.endsWith(suffix)) continue;
      const stem = base.slice(0, -suffix.length);
      const found = lookup(stem === 'ellig' ? 'ellik' : stem);
      if (found) return { ...found, ordinal: true, ending };
    }
  }
  return null;
}

function lookup(stem: string): { value: number; scale: boolean } | null {
  if (stem in VALUES) return { value: VALUES[stem], scale: false };
  if (stem in SCALES) return { value: SCALES[stem], scale: true };
  return null;
}

/**
 * Turn a run of number words into numbers. Usually one, but a run of single
 * digits ("to'qson to'qqiz bir ikki" — a phone number) is several.
 */
function readRun(words: NumberWord[]): number[] {
  const numbers: number[] = [];
  let total = 0;
  let group = 0;
  let last: 'none' | 'unit' | 'ten' | 'scale' = 'none';
  const flush = () => {
    if (last !== 'none') numbers.push(total + group);
    total = 0;
    group = 0;
    last = 'none';
  };
  for (const w of words) {
    if (w.scale) {
      if (w.value === 100) group = (group || 1) * 100;
      else {
        total += (group || 1) * w.value;
        group = 0;
      }
      last = 'scale';
    } else if (w.value >= 10) {
      // A tens word after a unit or another tens word starts a new number.
      if (last === 'unit' || last === 'ten') flush();
      group += w.value;
      last = 'ten';
    } else {
      if (last === 'unit') flush();
      group += w.value;
      last = 'unit';
    }
  }
  flush();
  return numbers;
}

function digits(n: number): string {
  // Group large amounts the way they are printed: 7 800 000. Years stay whole.
  return n >= 10_000 ? n.toLocaleString('en-US').replace(/,/g, ' ') : String(n);
}

export function uzbekNumbersToDigits(text: string): string {
  // Words, kept with their separators so everything else survives untouched.
  const tokens = text.split(/([^\p{L}'ʻʼ‘’`]+)/u);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const read = (t: string | undefined) =>
      t ? readWord(t.toLowerCase().replace(/[ʻʼ‘’`]/g, "'")) : null;
    const first = read(tokens[i]);
    if (!first) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }

    // Collect the run: number words joined by plain spaces (or a hyphen), with
    // an ordinal or an ending allowed only on its last word.
    const run: NumberWord[] = [first];
    let end = i;
    while (!run[run.length - 1].ordinal && !run[run.length - 1].ending) {
      const gap = tokens[end + 1];
      const next = read(tokens[end + 2]);
      if (!next || !gap || !/^[\s-]+$/.test(gap)) break;
      run.push(next);
      end += 2;
    }

    const numbers = readRun(run);
    const tail = run[run.length - 1];
    const following = tokens[end + 2]?.toLowerCase() ?? '';
    const isNumber =
      (numbers.length === 1 && (run.length > 1 || numbers[0] >= 10)) ||
      (numbers.length > 1 && numbers.some((n) => n >= 10)) ||
      (tail.ordinal && MONTH.test(following));
    if (!isNumber) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }

    let written = numbers.map(digits).join(' ');
    if (tail.ordinal) {
      // "1992-yilda", "15-oktabrda": an ordinal joins the word it counts.
      const gap = tokens[end + 1];
      if (!tail.ending && gap && /^\s+$/.test(gap) && tokens[end + 2]) {
        out.push(`${written}-${tokens[end + 2]}`);
        i = end + 3;
        continue;
      }
      written += tail.ending ? `-${tail.ending}` : '-chi';
    } else if (tail.ending) {
      written += tail.ending;
    }
    out.push(written);
    i = end + 1;
  }
  return out.join('');
}
