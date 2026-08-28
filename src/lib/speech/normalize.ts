/**
 * Spoken-form normalisation — the last step before text reaches the TTS.
 *
 * The internal TTS already expands bare numbers (`normalize_numbers=true` in
 * `buildTtsForm`), so this module deliberately does NOT re-implement a
 * number-to-words engine. It fixes the things that engine cannot see:
 *
 *   • markdown / stray symbols that would be read out literally
 *   • long digit runs (phone numbers, card numbers) that must be spoken in
 *     groups with pauses, not as one astronomical number
 *   • clock times, which are read as a division ("14/30") otherwise
 *   • currency and unit abbreviations, which differ per language
 *   • thousands separators, which split one number into several
 *
 * Everything here is language-aware (uz / ru / en) and lossless in meaning:
 * we only ever rewrite the *surface form* a synthesiser sees.
 */
import type { Locale } from '@/lib/types';

/* ── per-language vocabulary ─────────────────────────────────── */

interface Vocab {
  /** Joins the hour and minute of a clock time. */
  time: (h: number, m: number) => string;
  /** Currency symbol / code expansions. */
  currency: Record<string, string>;
  /** Unit abbreviations that must not be spelled out letter by letter. */
  units: Record<string, string>;
  /** Spoken form of "+" leading an international number. */
  plus: string;
  /** Joins the two ends of a range ("9:00-18:00", "10-15 kun"). */
  range: string;
}

const VOCAB: Record<Locale, Vocab> = {
  uz: {
    // Uzbek says "o'n to'rt nol nol" for a round hour and "14:30" as
    // "o'n to'rtdan o'ttiz daqiqa o'tdi" colloquially — but on a phone line the
    // unambiguous form wins: "soat 14 30".
    time: (h, m) => (m === 0 ? `soat ${h}` : `soat ${h} ${pad(m)}`),
    currency: {
      "so'm": "so'm",
      soʻm: "so'm",
      UZS: "so'm",
      $: 'dollar',
      USD: 'dollar',
      '€': 'yevro',
      EUR: 'yevro',
      '₽': 'rubl',
      RUB: 'rubl',
    },
    units: { km: 'kilometr', kg: 'kilogramm', m2: 'kvadrat metr', gb: 'gigabayt', mb: 'megabayt' },
    plus: 'plyus',
    range: 'dan',
  },
  ru: {
    time: (h, m) => (m === 0 ? `${h} часов` : `${h} часов ${m} минут`),
    currency: {
      "so'm": 'сум',
      сум: 'сум',
      UZS: 'сум',
      $: 'долларов',
      USD: 'долларов',
      '€': 'евро',
      EUR: 'евро',
      '₽': 'рублей',
      RUB: 'рублей',
    },
    units: { km: 'километров', kg: 'килограмм', m2: 'квадратных метров', gb: 'гигабайт', mb: 'мегабайт' },
    plus: 'плюс',
    range: 'до',
  },
  en: {
    time: (h, m) => (m === 0 ? `${h} o'clock` : `${h} ${pad(m)}`),
    currency: {
      "so'm": 'som',
      UZS: 'som',
      $: 'dollars',
      USD: 'dollars',
      '€': 'euros',
      EUR: 'euros',
      '₽': 'roubles',
      RUB: 'roubles',
    },
    units: { km: 'kilometres', kg: 'kilograms', m2: 'square metres', gb: 'gigabytes', mb: 'megabytes' },
    plus: 'plus',
    range: 'to',
  },
};

const pad = (n: number) => String(n).padStart(2, '0');

/* ── individual passes ───────────────────────────────────────── */

/** Strip markdown emphasis, headings, list bullets and code fences. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links & images → their label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '');
}

/**
 * Phone numbers → digit groups separated by commas so the synthesiser pauses.
 * `+998901234567` → `plyus 998, 90, 123, 45, 67`.
 * Only touches runs of 9+ digits, so prices and years are left alone.
 */
function spellPhones(text: string, v: Vocab): string {
  return text.replace(/(\+?)(\d[\d\s()-]{8,}\d)/g, (whole, plus: string, body: string) => {
    const digits = body.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) return whole;
    const groups = groupPhone(digits);
    return `${plus ? `${v.plus} ` : ''}${groups.join(', ')}`;
  });
}

/** Uzbek/CIS shape: country(3) area(2) 3-2-2; falls back to even 3s. */
function groupPhone(d: string): string[] {
  if (d.length === 12 && d.startsWith('998')) {
    return [d.slice(0, 3), d.slice(3, 5), d.slice(5, 8), d.slice(8, 10), d.slice(10, 12)];
  }
  if (d.length === 9) return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)];
  const out: string[] = [];
  for (let i = 0; i < d.length; i += 3) out.push(d.slice(i, i + 3));
  return out;
}

/**
 * A hyphen between two clock times is a range, not a minus sign. Spelling
 * it out has to happen before the clock pass, while the colons are still there
 * to identify the operands.
 */
function spellRanges(text: string, v: Vocab): string {
  // Restricted to two clock times on purpose: a bare `2024-2025` or a product
  // code should not be reinterpreted, and phone numbers were already handled.
  return text.replace(
    /\b(\d{1,2}:[0-5]\d)\s?[-\u2013\u2014]\s?(\d{1,2}:[0-5]\d)\b/g,
    (_m, a: string, b: string) => `${a} ${v.range} ${b}`,
  );
}

/** `14:30` → the language's spoken clock form. Leaves `1:2` style ratios alone. */
function spellTimes(text: string, v: Vocab): string {
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (whole, hh: string, mm: string) =>
    v.time(Number(hh), Number(mm)),
  );
}

/** `250 000` / `250,000` / `250.000` → `250000`, so it is read as one number. */
function joinThousands(text: string): string {
  return text
    .replace(/(?<=\d)[  ](?=\d{3}\b)/g, '')
    .replace(/(?<=\d),(?=\d{3}\b)/g, '')
    .replace(/(?<=\d)\.(?=\d{3}\b)/g, '');
}

/** Currency symbols and codes → words, in the caller's language. */
function spellCurrency(text: string, v: Vocab): string {
  let out = text;
  for (const [sym, word] of Object.entries(v.currency)) {
    if (sym === '$' || sym === '€' || sym === '₽') {
      // Symbol precedes the amount in English usage; move it after and expand.
      out = out.replace(new RegExp(`\\${sym}\\s?(\\d[\\d.]*)`, 'g'), `$1 ${word}`);
      out = out.replace(new RegExp(`\\${sym}`, 'g'), ` ${word}`);
    } else {
      out = out.replace(new RegExp(`\\b${escapeRe(sym)}\\b`, 'gi'), word);
    }
  }
  return out;
}

/** Unit abbreviations glued to a number → the spelled-out unit. */
function spellUnits(text: string, v: Vocab): string {
  let out = text;
  for (const [abbr, word] of Object.entries(v.units)) {
    out = out.replace(new RegExp(`(\\d)\\s?${escapeRe(abbr)}\\b`, 'gi'), `$1 ${word}`);
  }
  return out;
}

/** URLs and emails read aloud are useless — reduce them to their host/handle. */
function tameUrls(text: string): string {
  return text
    .replace(/https?:\/\/(www\.)?([^\s/]+)\S*/gi, '$2')
    .replace(/\b([\w.+-]+)@([\w.-]+)\b/g, '$1 at $2');
}

/** Collapse anything the synthesiser would stumble on. */
function tidy(text: string): string {
  return text
    .replace(/[«»""„]/g, '')
    .replace(/\s*\|\s*/g, ', ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── public entry point ──────────────────────────────────────── */

/**
 * Rewrite `text` into the form the TTS should actually receive.
 * Order matters: markdown first (so symbols do not survive), thousands before
 * phones (so `250 000` is not mistaken for a digit run), currency after the
 * digits have settled.
 */
export function normalizeForSpeech(text: string, language: Locale = 'uz'): string {
  const v = VOCAB[language] ?? VOCAB.uz;
  let out = stripMarkdown(text);
  out = tameUrls(out);
  out = joinThousands(out);
  out = spellPhones(out, v);
  out = spellRanges(out, v);
  out = spellTimes(out, v);
  out = spellCurrency(out, v);
  out = spellUnits(out, v);
  return tidy(out);
}

/**
 * Split a reply into synthesis chunks at sentence boundaries.
 *
 * This is what makes streaming possible: each chunk is synthesised
 * independently and played the moment it is ready, so the caller hears the
 * first sentence while the rest is still rendering. Chunks are kept above
 * `minChars` because very short fragments make the voice sound clipped, and
 * below `maxChars` because render time grows with length.
 */
export function splitForSpeech(text: string, { minChars = 30, maxChars = 120 } = {}): string[] {
  const clean = text.trim();
  // Only a genuinely short reply is worth keeping whole: splitting it would
  // cost more in per-request overhead than it saves in time-to-first-word.
  if (clean.length <= minChars * 2) return clean ? [clean] : [];

  // Sentence-ish boundaries: terminator + whitespace, keeping the terminator.
  const pieces = clean.split(/(?<=[.!?…])\s+/);
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && last.length < minChars) {
      out[out.length - 1] = `${last} ${piece}`;
    } else if (piece.length > maxChars) {
      // A single runaway sentence — break it on clause commas as a last resort.
      out.push(...hardWrap(piece, maxChars));
    } else {
      out.push(piece);
    }
  }
  return out.filter(Boolean);
}

function hardWrap(sentence: string, maxChars: number): string[] {
  const parts = sentence.split(/(?<=,)\s+/);
  const out: string[] = [];
  let buf = '';
  for (const part of parts) {
    if (buf && buf.length + part.length > maxChars) {
      out.push(buf);
      buf = part;
    } else {
      buf = buf ? `${buf} ${part}` : part;
    }
  }
  if (buf) out.push(buf);
  return out;
}
