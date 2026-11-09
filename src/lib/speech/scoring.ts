/**
 * Scoring a transcript against the words that were said: word and character
 * error rates (WER / CER), used by the deploy benchmark (`@/lib/benchmark`).
 *
 * It ignores differences that are not real mistakes: Latin vs Cyrillic
 * spelling, the many apostrophes of oʻ and gʻ, a left-out glottal-stop mark
 * (taʼzim = tazim), case, punctuation, numbers written as words vs digits, how
 * digits are grouped, and a suffix glued to a number ("30da" = "30 da").
 */
import { uzbekNumbersToDigits } from './numbers';

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: "g'", д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i',
  й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o', ў: "o'", п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'x', ҳ: 'h', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ь: '',
  ы: 'i', э: 'e', ю: 'yu', я: 'ya',
};

const DIGIT_WORDS: Record<string, string> = {
  nol: '0', bir: '1', ikki: '2', uch: '3', "to'rt": '4',
  besh: '5', olti: '6', yetti: '7', sakkiz: '8', "to'qqiz": '9',
};
const DIGIT_WORD = "(?:nol|bir|ikki|uch|to'rt|besh|olti|yetti|sakkiz|to'qqiz)";
const DIGIT_RUN = new RegExp(`(?<![\\p{L}'])${DIGIT_WORD}(?:\\s+${DIGIT_WORD})+(?![\\p{L}'])`, 'gu');

/** The text as the scorer compares it. */
export function normalizeForScoring(text: string): string {
  let s = text.toLowerCase();
  s = s.replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC[ch] ?? ch);
  s = s.replace(/[ʻʼ‘’`´']/g, "'");
  s = uzbekNumbersToDigits(s);
  s = s.replace(/[^\p{L}\p{N}' ]+/gu, ' ');
  // Digits read one by one ("bir ikki uch") are a number. A lone "bir" stays a word.
  s = s.replace(DIGIT_RUN, (run) => run.split(/\s+/).map((w) => DIGIT_WORDS[w]).join(' '));
  // A suffix glued to a number ("30da", "25-noyabr") is its own word.
  s = s.replace(/(\d)(?=\p{L})/gu, '$1 ').replace(/(\p{L})(?=\d)/gu, '$1 ');
  // A run of numbers is one token: "7 800 000" = "7800000", "1 2 3 4" = "1234",
  // "14 30" = "14:30". How an engine groups digits is formatting, not a mistake.
  s = s.replace(/\d+(?:\s+\d+)+/g, (run) => run.replace(/\s+/g, ''));
  // An apostrophe that is not part of a word (o', g', ma'no) is noise.
  s = s.replace(/(^|\s)'+|'+(?=\s|$)/g, '$1');
  // The glottal-stop mark (ma'no, ta'zim, in'om) is often left out in writing:
  // not a recognition error. Only o' and g' keep theirs — there it changes the letter.
  s = s.replace(/(?<![og])'/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Word and character error rates (0 = perfect), or nulls without a reference. */
export function score(reference: string, heard: string): { wer: number | null; cer: number | null } {
  const ref = normalizeForScoring(reference);
  if (!ref) return { wer: null, cer: null };
  const hyp = normalizeForScoring(heard);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  const words = ref.split(' ');
  return {
    wer: round(editDistance(words, hyp ? hyp.split(' ') : []) / words.length),
    cer: round(editDistance([...ref], [...hyp]) / ref.length),
  };
}
