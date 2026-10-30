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
 *     Here the next three weeks are written out, so a spoken day is looked up,
 *     never worked out.
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

/** The next three weeks in the tenant's time zone, named the way callers name them. */
export function calendarBlock(timeZone = 'Asia/Tashkent', now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // Noon UTC keeps day arithmetic clear of any daylight-saving edge.
  const today = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
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
