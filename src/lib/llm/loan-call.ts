/**
 * The two facts of an outbound loan call that are decided in code, not by the
 * model. Both were measured failing when the model decided them itself:
 *
 *   • Identity. Given the year of birth, the model accepted an age as a year
 *     (and so became an oracle for guessing it), let a self-declared brother
 *     through, and kept comparing after two wrong tries. Here the model never
 *     sees the year at all: the caller's own words are checked, and the prompt
 *     is only told the outcome.
 *   • Dates. The model placed "Friday" on a Saturday and "Monday" on today.
 *     Here the next three weeks are written out, and a day the person names
 *     ("1 haftadan keyin", "juma kuni", "через неделю") is worked out in code
 *     and handed over with the words to say it back with (`namedDay`).
 */
import { uzbekNumbersToDigits } from '@/lib/speech/numbers';
import type { CallTarget } from '@/lib/types';

/* ── identity ────────────────────────────────────────────────── */

/**
 * `unchecked` — no year of birth on file, so the model asks "is this X?" itself.
 * `awaiting` — no matching year yet. `failed` — two wrong years; no later year
 * is compared, even the right one.
 */
export type IdentityStatus = 'unchecked' | 'awaiting' | 'confirmed' | 'failed';

export interface IdentityCheck {
  status: IdentityStatus;
  /** Their latest line gave a year, and it was wrong — the model must say so, not thank them. */
  justWrong: boolean;
  wrongTries: number;
}

const MAX_WRONG_YEARS = 2;

/** Years said in one line: "1992", "92-yil", "92-го года", or a bare "92". */
function spokenYears(line: string): string[] {
  // Kotib already writes digits; typed or other-engine text may not.
  const text = uzbekNumbersToDigits(line);
  // Any four-digit number counts as an attempt — an absurd one ("1833", "2939") is a wrong
  // answer, not silence; ignoring it let the call carry on as if nothing had been said.
  const years = [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((m) => m[1]);
  for (const m of text.matchAll(/(?<!\d)(\d{2})(?:\s*-?\s*(?:го|й))?\s*-?\s*(?:yil|йил|год)/gi)) years.push(m[1]);
  const bare = text.replace(/[\s.,!?;:'"«»()-]/g, '');
  if (/^\d{2}$/.test(bare)) years.push(bare);
  return years;
}

/** Whether the person has proved who they are, judged from everything they have said. */
export function identityCheck(target: CallTarget, callerLines: string[]): IdentityCheck {
  const year = target.birthYear.trim();
  if (!/^\d{4}$/.test(year)) return { status: 'unchecked', justWrong: false, wrongTries: 0 };
  let wrong = 0;
  let justWrong = false;
  for (const line of callerLines) {
    const said = spokenYears(line);
    justWrong = false;
    if (!said.length) continue;
    // Every year in the line must be the right one: "1990, 1991, 1992" is a guess, not an answer.
    if (said.every((y) => y === year || y === year.slice(2))) {
      return { status: 'confirmed', justWrong: false, wrongTries: wrong };
    }
    wrong += 1;
    justWrong = true;
    if (wrong >= MAX_WRONG_YEARS) return { status: 'failed', justWrong: true, wrongTries: wrong };
  }
  return { status: 'awaiting', justWrong, wrongTries: wrong };
}

/* ── calendar ────────────────────────────────────────────────── */

const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_UZ = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const DAY_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTH_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_MS = 86_400_000;

function label(d: Date): string {
  const w = d.getUTCDay();
  return `${DAY_EN[w]} (${DAY_UZ[w]} / ${DAY_RU[w]}) ${d.getUTCDate()} ${MONTH_EN[d.getUTCMonth()]}`;
}

/** Today in the tenant's time zone, at noon UTC (which keeps day arithmetic clear of daylight saving). */
function todayIn(timeZone: string, now: Date): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
}

/** The next three weeks in the tenant's time zone, named the way callers name them. */
export function calendarBlock(timeZone = 'Asia/Tashkent', now = new Date()): string {
  const today = todayIn(timeZone, now);
  const day = (n: number) => new Date(today.getTime() + n * DAY_MS);

  // Weeks run Monday to Sunday: the rest of this one, then the next two.
  const untilSunday = (7 - today.getUTCDay()) % 7;
  const range = (from: number, to: number) => {
    const out: string[] = [];
    for (let n = from; n <= to; n++) out.push(label(day(n)));
    return out.join('; ');
  };

  // Relative periods people actually say: "in two weeks", "at the end of the month".
  const inMonths = (n: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + n, 1, 12));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).getUTCDate();
    d.setUTCDate(Math.min(today.getUTCDate(), last));
    return d;
  };
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 12));
  const nextMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1, 12));

  return [
    'CALENDAR — look every date up here; never work out a weekday or a date yourself:',
    `- today: ${label(today)} ${today.getUTCFullYear()}`,
    `- tomorrow (ertaga / завтра): ${label(day(1))}`,
    `- the day after tomorrow (indinga / послезавтра): ${label(day(2))}`,
    untilSunday >= 3 ? `- rest of this week: ${range(3, untilSunday)}` : '',
    `- next week (kelasi hafta / на следующей неделе): ${range(untilSunday + 1, untilSunday + 7)}`,
    `- the week after: ${range(untilSunday + 8, untilSunday + 14)}`,
    `- in 3 days (3 kundan keyin / через три дня): ${label(day(3))}`,
    `- in a week (bir haftadan keyin / через неделю): ${label(day(7))}`,
    `- in 10 days (10 kundan keyin / через десять дней): ${label(day(10))}`,
    `- in two weeks (ikki haftadan keyin / через две недели): ${label(day(14))}`,
    `- in three weeks (uch haftadan keyin / через три недели): ${label(day(21))}`,
    `- in a month (bir oydan keyin / через месяц): ${label(inMonths(1))}`,
    `- end of this month (oy oxirida / в конце месяца): ${label(monthEnd)}`,
    `- start of next month (keyingi oy boshida / в начале следующего месяца): ${label(nextMonthStart)}`,
    'A weekday on its own ("juma kuni", "kelasi juma", "в пятницу") means its nearest date',
    'after today in this list. "Next week" plus a weekday means that weekday under "next',
    'week". A day of the month on its own ("25-chi", "третьего числа") means this month if',
    'it is still ahead, otherwise next month. Any other period ("in 5 days", "in two months")',
    'is counted from today the same way. Never agree to a date that has passed.',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── the day they just named ─────────────────────────────────── */

// Even with the calendar written out, a small model picked the wrong line for
// "1 haftadan keyin" four times in five (and said the day in the wrong words).
// So a day the person names is worked out here, as identity is, and the model
// is handed the date and the exact words to say it back with.

const MONTH_UZ = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktabr', 'noyabr', 'dekabr'];
const MONTH_RU_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const UNIT_UZ = ['bir', 'ikki', 'uch', "to'rt", 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz"];
const ORD_UZ = ['birinchi', 'ikkinchi', 'uchinchi', "to'rtinchi", 'beshinchi', 'oltinchi', 'yettinchi', 'sakkizinchi', "to'qqizinchi"];
const TENS_UZ: Record<string, number> = { "o'n": 10, yigirma: 20, "o'ttiz": 30 };
const ORD_TENS_UZ: Record<string, number> = { "o'ninchi": 10, yigirmanchi: 20, "o'ttizinchi": 30 };
const NUM_RU: Record<string, number> = {
  один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, пятнадцать: 15,
};
const ORD_RU_GEN = [
  'первого', 'второго', 'третьего', 'четвёртого', 'пятого', 'шестого', 'седьмого', 'восьмого', 'девятого', 'десятого',
  'одиннадцатого', 'двенадцатого', 'тринадцатого', 'четырнадцатого', 'пятнадцатого', 'шестнадцатого',
  'семнадцатого', 'восемнадцатого', 'девятнадцатого',
];
const WEEKDAY_UZ = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
// Whole words: "сред" alone would also catch "средства" (funds) and "среди".
const WEEKDAY_RU = [
  'воскресенье|воскресенья', 'понедельник|понедельника', 'вторник|вторника', 'среда|среду|среды',
  'четверг|четверга', 'пятница|пятницу|пятницы', 'суббота|субботу|субботы',
];

/** A word starts or ends here (letters and the Uzbek apostrophe belong to words). */
const B = "(?<![\\p{L}'])";
const E = "(?![\\p{L}'])";
const alt = (words: string[]) => words.join('|');

/** Number words as digits: "ikki", "o'n besh", "две", and ordinals ("beshinchi") as "5-chi". */
function digitsFor(text: string): string {
  let t = text.replace(
    new RegExp(`${B}(?:(${alt(Object.keys(TENS_UZ))})\\s+)?(${alt(ORD_UZ)})${E}`, 'gu'),
    (_m, tens: string | undefined, unit: string) => `${(tens ? TENS_UZ[tens] : 0) + ORD_UZ.indexOf(unit) + 1}-chi`,
  );
  t = t.replace(new RegExp(`${B}(${alt(Object.keys(ORD_TENS_UZ))})${E}`, 'gu'), (_m, w: string) => `${ORD_TENS_UZ[w]}-chi`);
  t = t.replace(
    new RegExp(`${B}(${alt(Object.keys(TENS_UZ))})(?:\\s+(${alt(UNIT_UZ)}))?${E}`, 'gu'),
    (_m, tens: string, unit: string | undefined) => String(TENS_UZ[tens] + (unit ? UNIT_UZ.indexOf(unit) + 1 : 0)),
  );
  t = t.replace(new RegExp(`${B}(${alt(UNIT_UZ)})${E}`, 'gu'), (_m, w: string) => String(UNIT_UZ.indexOf(w) + 1));
  // Russian ordinals in the genitive ("двадцать пятого", "третьего") as "25-го".
  const ordRu = ORD_RU_GEN.map((w) => w.replace(/ё/g, 'е'));
  t = t.replace(
    new RegExp(`${B}(?:(двадцать|тридцать)\\s+)?(${alt(ordRu)})${E}`, 'gu'),
    (_m, tens: string | undefined, w: string) => `${(tens === 'двадцать' ? 20 : tens ? 30 : 0) + ordRu.indexOf(w) + 1}-го`,
  );
  t = t.replace(new RegExp(`${B}(двадцатого|тридцатого)${E}`, 'gu'), (_m, w: string) => (w === 'двадцатого' ? '20-го' : '30-го'));
  t = t.replace(
    new RegExp(`${B}(?:(двадцать|тридцать)\\s+)?(${alt(Object.keys(NUM_RU))})${E}`, 'gu'),
    (_m, tens: string | undefined, unit: string) => String((tens === 'двадцать' ? 20 : tens ? 30 : 0) + NUM_RU[unit]),
  );
  return t.replace(new RegExp(`${B}(двадцать|тридцать)${E}`, 'gu'), (_m, w: string) => (w === 'двадцать' ? '20' : '30'));
}

function ordinalUz(n: number): string {
  const tens = Math.floor(n / 10) * 10;
  const unit = n % 10;
  if (!unit) return Object.keys(ORD_TENS_UZ).find((w) => ORD_TENS_UZ[w] === tens)!;
  const tensWord = Object.keys(TENS_UZ).find((w) => TENS_UZ[w] === tens);
  return tensWord ? `${tensWord} ${ORD_UZ[unit - 1]}` : ORD_UZ[unit - 1];
}

function ordinalRu(n: number): string {
  if (n < 20) return ORD_RU_GEN[n - 1];
  if (n === 20) return 'двадцатого';
  if (n === 30) return 'тридцатого';
  return `${n < 30 ? 'двадцать' : 'тридцать'} ${ORD_RU_GEN[(n % 10) - 1]}`;
}

export interface NamedDay {
  /** YYYY-MM-DD. */
  date: string;
  /** As the calendar names it, with the year. */
  label: string;
  /** The words to say it back with. */
  say: { uz: string; ru: string; en: string };
}

function named(d: Date): NamedDay {
  const w = d.getUTCDay();
  const day = d.getUTCDate();
  const m = d.getUTCMonth();
  return {
    date: d.toISOString().slice(0, 10),
    label: `${label(d)} ${d.getUTCFullYear()}`,
    say: {
      uz: `${ordinalUz(day)} ${MONTH_UZ[m]}, ${DAY_UZ[w]}`.replace(/'/g, '‘'),
      ru: `${ordinalRu(day)} ${MONTH_RU_GEN[m]}, ${DAY_RU[w]}`,
      en: `${DAY_EN[w]}, ${day} ${MONTH_EN[m]}`,
    },
  };
}

/**
 * The day one line names — "ertaga", "1 haftadan keyin", "juma kuni", "kelasi
 * hafta seshanba", "25-noyabr", "oy oxirida", "через неделю", "в пятницу" —
 * worked out from today in the tenant's time zone, or null when it names none
 * or says it unclearly (a negation such as "ertaga emas" is left to the model).
 */
export function namedDay(line: string, timeZone = 'Asia/Tashkent', now = new Date()): NamedDay | null {
  const t = digitsFor(uzbekNumbersToDigits(line).toLowerCase().replace(/[‘ʻʼ’`]/g, "'").replace(/ё/g, 'е'));
  if (new RegExp(`${B}(?:emas|не)${E}`, 'u').test(t)) return null;
  const today = todayIn(timeZone, now);
  const at = (n: number) => named(new Date(today.getTime() + n * DAY_MS));
  const monthsLater = (n: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + n, 1, 12));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).getUTCDate();
    d.setUTCDate(Math.min(today.getUTCDate(), last));
    return named(d);
  };
  const dayOf = (year: number, month: number, day: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    return day >= 1 && day <= last ? new Date(Date.UTC(year, month, day, 12)) : null;
  };

  // "3 kundan keyin", "2 haftadan so'ng", "1 oydan keyin"
  let m = t.match(
    new RegExp(`(?<![0-9])([0-9]{1,2})\\s*-?\\s*(kun|hafta|oy)(?:lar)?(?:dan)?\\s+(?:keyin|so'ng|o'tib|o'tgach)${E}`, 'u'),
  );
  if (m) {
    const n = Number(m[1]);
    return m[2] === 'oy' ? monthsLater(n) : at(m[2] === 'kun' ? n : n * 7);
  }
  // "через неделю", "через 3 дня", "через месяц"
  m = t.match(new RegExp(`${B}через\\s+(?:([0-9]{1,2})\\s+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев)${E}`, 'u'));
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    return m[2].startsWith('месяц') ? monthsLater(n) : at(m[2].startsWith('нед') ? n * 7 : n);
  }
  if (new RegExp(`${B}(?:indinga|послезавтра)${E}`, 'u').test(t)) return at(2);
  if (new RegExp(`${B}(?:ertaga|завтра)${E}`, 'u').test(t)) return at(1);
  if (new RegExp(`${B}(?:bugun|сегодня)${E}`, 'u').test(t)) return at(0);
  if (/oy\s+oxir|конц[еау]\s+месяца/u.test(t)) {
    return named(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 12)));
  }
  if (/(?:keyingi|kelasi)\s+oy\s+bosh|начал[еоа]\s+следующего\s+месяца/u.test(t)) {
    return named(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1, 12)));
  }
  // "25-noyabr", "25 noyabrda", "25-го ноября" — a whole month word ("1 marta", once, is not March)
  m = t.match(
    new RegExp(
      `(?<![0-9])([0-9]{1,2})\\s*-?\\s*(?:chi\\s+|го\\s+|е\\s+)?(?:(${alt(MONTH_UZ)})(?:da|ga|dan|gacha|ning|si)?|(${alt(MONTH_RU_GEN)}))${E}`,
      'u',
    ),
  );
  if (m) {
    const month = m[2] ? MONTH_UZ.indexOf(m[2]) : MONTH_RU_GEN.indexOf(m[3]);
    let d = dayOf(today.getUTCFullYear(), month, Number(m[1]));
    if (d && d.getTime() < today.getTime()) d = dayOf(today.getUTCFullYear() + 1, month, Number(m[1]));
    return d ? named(d) : null;
  }
  // "25-chi", "5-chi kuni", "5-sanada", "третьего числа" (a day of the month on its own). An
  // ordinal counts only at the end of the line or before kun/sana: "birinchi to'lov" is not a day.
  m = t.match(/(?<![0-9])([0-9]{1,2})\s*-?\s*(?:(?:chi|inchi|nchi)(?:si)?(?=\s*[.,!?]*\s*(?![\s\S])|\s+(?:kun|sana))|sana|го\s+числа|числа)/u);
  if (m) {
    const n = Number(m[1]);
    let d = n >= today.getUTCDate() ? dayOf(today.getUTCFullYear(), today.getUTCMonth(), n) : null;
    d ??= dayOf(today.getUTCFullYear(), today.getUTCMonth() + 1, n);
    return d ? named(d) : null;
  }
  // "juma kuni", "kelasi hafta seshanba", "в пятницу", "в следующий вторник"
  let weekday = WEEKDAY_UZ.findIndex((w) => new RegExp(`${B}${w}`, 'u').test(t));
  if (weekday < 0) weekday = WEEKDAY_RU.findIndex((w) => new RegExp(`${B}(?:${w})${E}`, 'u').test(t));
  if (weekday >= 0) {
    const todayW = today.getUTCDay();
    if (/(?:kelasi|keyingi)\s+hafta|следующ/u.test(t)) return at((7 - todayW) % 7 + 1 + ((weekday + 6) % 7));
    return at((weekday - todayW + 7) % 7 || 7);
  }
  return null;
}
