/**
 * How long a pause ends the caller's phrase, read from what they have said so far (Q4).
 *
 * A fixed wait is either too short for "…to'lovni keyingi…" (the caller is still thinking) or too long
 * for "Ha, mayli." (they are done). The live words already on screen tell the two apart: a phrase that
 * is clearly over ends sooner, one that is clearly not (a number being said, a trailing "va", an answer
 * to "qancha?") gets more time, and anything unclear keeps the current wait.
 *
 * Plain functions, no React: `tests/web/endpointing.test.mjs` runs them directly.
 */

/** The waits, in ms of quiet after the caller's last sound. */
export const PAUSE_MS = {
  /** "ha", "rahmat", "xo'p mayli": a reply that needs nothing more. */
  smallTalk: 500,
  /** The phrase ends with a question mark. */
  question: 600,
  /** The phrase ends with a full stop or "!". */
  complete: 700,
  /** Nothing tells: the wait the Playground used before (SILENCE_TIMEOUT_MS). */
  unsure: 1100,
  /** A number being said, a phrase left hanging, or an answer to "qancha / qachon / raqam…". */
  holding: 1500,
} as const;

export type PauseReason = keyof typeof PAUSE_MS;

// The same list as backend/app/engine/live_turn.py SMALL_TALK (the search skip, Q3).
const SMALL_TALK = [
  'ha', "xo'p", 'mayli', 'albatta', "to'g'ri", "bo'pti", 'tushunarli', "xo'sh",
  "yo'q", "yo'g'e", 'kerak emas',
  'rahmat', 'katta rahmat', "sog' bo'ling", 'xayr', "salomat bo'ling",
  'salom', 'assalomu alaykum', 'alo', 'allo',
  'hmm', 'aha', 'ana', 'mm',
];

/** Words that leave a phrase hanging when they come last ("hmm" alone too: the caller is thinking). */
const HANGING = new Set([
  'va', 'ham', 'hamda', 'lekin', 'ammo', 'biroq', 'yoki', 'keyin', 'chunki', 'agar', 'yani', 'masalan',
  'xullas', 'ee', 'eee', 'aa', 'mmm', 'hmm',
  'и', 'но', 'или', 'потом', 'потому', 'если', 'например', 'ну', 'э',
]);

/** Number words (Uzbek, Russian) by their beginning: "yigirma", "beshinchi", "mingta", "тысяч"… */
const NUMBER_STEMS = [
  'bir', 'ikki', 'uch', "to'rt", 'tort', 'besh', 'olti', 'yetti', 'sakkiz', "to'qqiz", 'toqqiz', "o'n", 'on',
  'yigirma', "o'ttiz", 'ottiz', 'qirq', 'ellik', 'oltmish', 'yetmish', 'sakson', "to'qson", 'toqson', 'yuz',
  'ming', 'million', 'milliard', 'nol',
  'один', 'два', 'три', 'четыр', 'пять', 'шест', 'сем', 'восем', 'девят', 'десят', 'двадцат', 'тридцат',
  'сорок', 'пятьдесят', 'сто', 'тысяч', 'миллион', 'ноль',
];
// Short stems match only the whole word ("o'n" is not "ona", "uch" is not "uchun", "bir" is not "biroq").
const WHOLE_ONLY = new Set(['on', 'bir', 'uch', 'yuz', 'nol', 'olti', 'сто', 'сем']);
// The forms of a whole-only stem that are still numbers ("oltita", "oltinchi"; "oltin" is gold).
const NUMBER_FORMS = ['oltita', 'oltinchi', 'birinchi', 'uchinchi', 'uchta', 'yuzta', 'yuzinchi', 'onta', 'oninchi'];

/** The agent asked for something said with numbers: an amount, a date, a phone or card number. */
const ASKS_FOR_NUMBERS =
  /\b(qancha|qachon|necha|nechta|sana|sanasi|raqam\w*|telefon\w*|summa\w*|miqdor\w*|tug'ilgan)\b|сколько|когда|номер|сумм|дат[аеуы]|телефон/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/-/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^'+|'+$/g, ''));
}

const PHRASES = SMALL_TALK.map((p) => words(p).map((w) => w.replace(/'/g, ''))).sort((a, b) => b.length - a.length);

/** The whole phrase is small talk (at most 3 words), as in the backend's search skip. */
export function isSmallTalk(text: string): boolean {
  const ws = words(text).map((w) => w.replace(/'/g, ''));
  if (ws.length === 0 || ws.length > 3) return false;
  let i = 0;
  outer: while (i < ws.length) {
    for (const phrase of PHRASES) {
      if (phrase.every((w, k) => ws[i + k] === w)) {
        i += phrase.length;
        continue outer;
      }
    }
    return false;
  }
  return true;
}

function isNumberWord(word: string): boolean {
  if (/\d/.test(word)) return true;
  const plain = word.replace(/'/g, '');
  if (NUMBER_FORMS.includes(plain)) return true;
  return NUMBER_STEMS.some((stem) => {
    const s = stem.replace(/'/g, '');
    return WHOLE_ONLY.has(s) ? plain === s : plain.startsWith(s);
  });
}

/** Words that always stop the agent: a refusal or "stop", however short. */
const STOP_WORDS = new Set(['yoq', 'yoge', 'emas', 'toxtang', 'toxta', 'toxtat', 'bas', 'stop', 'нет', 'не', 'стоп', 'подождите', 'хватит']);

/**
 * The caller really cut in (Q7): there are words, and they are not just "ha", "mhm" or "xo'p" said while
 * listening — unless they refuse or say stop, which always counts. No words (the wind, a car) never does.
 */
export function isRealInterruption(heard: string): boolean {
  const ws = words(heard).map((w) => w.replace(/'/g, ''));
  if (ws.length === 0) return false;
  if (ws.some((w) => STOP_WORDS.has(w))) return true;
  return !isSmallTalk(heard);
}

/**
 * The words as the early answer is matched on them (backend/app/engine/early.py `same_words`): case,
 * punctuation, apostrophe shapes and spacing left out. Q5.
 */
export function sameWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}_\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/**
 * Why, and so how long, a pause ends the phrase now. `heard` is the live transcript so far, `asked` the
 * agent's last line. Without live words (an engine that only transcribes recordings) nothing changes.
 */
export function pauseFor(heard: string, asked = ''): { reason: PauseReason; ms: number } {
  const pick = (reason: PauseReason) => ({ reason, ms: PAUSE_MS[reason] });
  const text = heard.trim();
  if (!text) return pick('unsure');
  const ws = words(text);
  const last = ws[ws.length - 1] ?? '';
  const ended = /[.!?。？！]["»)]*$/.test(text);
  if (isNumberWord(last) || /[,;:—–-]$/.test(text) || HANGING.has(last.replace(/'/g, ''))) return pick('holding');
  if (!ended && ASKS_FOR_NUMBERS.test(asked)) return pick('holding');
  if (isSmallTalk(text)) return pick('smallTalk');
  if (/\?["»)]*$/.test(text)) return pick('question');
  if (ended) return pick('complete');
  return pick('unsure');
}
