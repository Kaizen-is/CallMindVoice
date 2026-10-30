/**
 * Trilingual text normalisation for Uzbek (Latin + Cyrillic), Russian and English.
 *
 * Uzbek is written in two scripts that are still both in daily use, and callers
 * mix Uzbek and Russian inside a single sentence. Everything is therefore
 * projected into one normalised Latin space before indexing *and* before
 * querying, so «шифокор», "shifokor" and "shifokorga" all collide.
 */

/* ── script folding ──────────────────────────────────────────── */

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ғ: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j',
  з: 'z', и: 'i', й: 'y', к: 'k', қ: 'q', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ў: 'o', ф: 'f', х: 'x', ҳ: 'h',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e',
  ю: 'yu', я: 'ya', ј: 'j', һ: 'h', ә: 'a', ө: 'o', ү: 'u', ң: 'ng',
};

/** Uzbek Latin digraph/apostrophe folding: oʻ→o, gʻ→g, sh→sh (kept). */
function foldUzbekLatin(s: string) {
  return s
    .replace(/[ʻʼʽ‘’`´']/g, '')
    .replace(/ʻ|ʼ/g, '');
}

export function normalize(input: string): string {
  // NFKD then strip combining marks, so accented forms fold to their base letter.
  let s = input.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = foldUzbekLatin(s);
  let out = '';
  for (const ch of s) {
    out += CYRILLIC_TO_LATIN[ch] ?? ch;
  }
  return out
    .replace(/[^a-z0-9\s\-+.@%/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── stopwords ───────────────────────────────────────────────── */

const STOPWORDS = new Set(
  (
    // English
    'a an and are as at be but by for from has have how i in is it its of on or that the this to was were what when where which who will with you your do does did can could would should not no yes if then than there here about into over under again more most some such only own same so too very ' +
    // Russian (transliterated by the same folding above)
    'i v vo ne chto on na ya s so kak a to vse ona tak ego no da ty k u zhe vi za bi po tolko ee mne bilo vot ot menya eshche net o iz emu teper kogda dazhe nu vdrug li esli uzhe ili ni bit bil nego do vas nibud opyat uzh vam skazal vedi tam potom sebya nichego ej mozhet oni tut gde est nado nej dlya mi tebya ih chem bila sam chtob bez budto chelovek chego raz tozhe sebe pod budet zh togda kto etot etogo kotoriy pri nas pro nih ' +
    // Uzbek
    'va bilan uchun bu shu ular biz siz men u bir har hech ham lekin ammo yoki agar chunki qanday qachon qayer nima kim necha juda faqat yana keyin oldin ustida ostida ichida tashqarida boshqa barcha hamma yaxshi kerak mumkin bor yoq edi ekan qilib deb dan ga da ni ning'
  ).split(' '),
);

export const isStopword = (t: string) => STOPWORDS.has(t);

/* ── stemming ────────────────────────────────────────────────── */

/**
 * Conservative suffix stripper covering the three languages we serve.
 * Ordered longest-first; never reduces a token below 4 characters.
 */
const SUFFIXES = [
  // Uzbek case / possessive / plural (agglutinative — strip one layer)
  'lardan', 'larga', 'larda', 'larni', 'larim', 'laring', 'lari', 'lar',
  'imizni', 'ingizni', 'ingiz', 'imiz', 'ning', 'dagi', 'gacha', 'dan', 'ga', 'da', 'ni', 'im', 'ing',
  'moqchi', 'yapti', 'gan', 'yotgan', 'adi', 'ydi', 'di', 'sh', 'ish',
  // Russian (transliterated)
  'ostyu', 'ostey', 'ostyah', 'ovaniya', 'eniya', 'aniya', 'ami', 'yami', 'ah', 'yah',
  'ov', 'ev', 'iy', 'yy', 'aya', 'oe', 'ie', 'ye', 'ye', 'om', 'em', 'ey', 'oy',
  'ami', 'imi', 'yu', 'ya', 'u', 'e', 'a', 'i', 'y', 'o',
  // English
  'ations', 'ation', 'ings', 'ing', 'edly', 'ies', 'ied', 'es', 'ed', 's',
];

export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suf of SUFFIXES) {
    if (token.length - suf.length >= 4 && token.endsWith(suf)) {
      return token.slice(0, -suf.length);
    }
  }
  return token;
}

/* ── cross-lingual bridging ──────────────────────────────────── */

/**
 * A caller asks in Russian about a page written in Uzbek. Lexical search can
 * never connect those, and a hashed-ngram encoder cannot either — the words
 * share no characters.
 *
 * So high-frequency contact-centre concepts get a shared canonical token.
 * Indexing and querying both emit it *alongside* the original term, which means
 * an exact same-language match still outranks a cross-language one, but a
 * cross-language question stops returning nothing at all.
 *
 * Entries are written post-normalisation (Cyrillic already folded to Latin).
 */
const CONCEPTS: Record<string, string[]> = {
  // Question words carry as much cross-language signal as nouns here:
  // "qancha", "сколько" and "how much" are the same question about price.
  price: [
    'narx', 'qiymat', 'cena', 'stoimost', 'price', 'cost', 'tarif', 'tariff', 'summa', 'prays',
    'qancha', 'skolko', 'much', 'stoit', 'pochem', 'fee', 'pul', 'dengi', 'money',
  ],
  hours: [
    'vaqt', 'soat', 'grafik', 'raspisanie', 'rezhim', 'hour', 'schedule', 'open', 'ochiq',
    'vremya', 'chas', 'qachon', 'kogda', 'when', 'rabota', 'ishlay', 'close', 'yopiq', 'zakrit',
    'work', 'opening', 'shift', 'smena',
  ],
  address: [
    'manzil', 'adres', 'address', 'joylash', 'nahodit', 'filial', 'branch', 'ofis', 'office',
    'qayer', 'gde', 'where', 'kocha', 'street', 'ulitsa', 'metro', 'orientir',
  ],
  doc: [
    'hujjat', 'dokument', 'document', 'spravka', 'guvohnoma', 'pasport', 'passport', 'polis',
    'policy', 'nuzhno', 'kerak', 'need', 'bring', 'olib',
  ],
  booking: [
    'navbat', 'yozil', 'zapis', 'priem', 'qabul', 'booking', 'appointment', 'reserve', 'bron',
    'konsultatsiya', 'konsultaci', 'consultation', 'consult', 'visit', 'tashrif',
  ],
  phone: ['telefon', 'raqam', 'nomer', 'number', 'phone', 'aloqa', 'svyaz', 'contact', 'kontakt', 'whatsapp', 'telegram'],
  payment: [
    'tolov', 'oplata', 'payment', 'pay', 'karta', 'card', 'nalich', 'naqd', 'perevod', 'transfer',
    'uzcard', 'humo', 'payme', 'click', 'rassrochk', 'muddatli', 'instalment', 'installment',
  ],
  insurance: ['sugurta', 'strahov', 'insurance', 'polis', 'insured'],
  doctor: [
    'shifokor', 'vrach', 'doctor', 'kardiolog', 'terapevt', 'pediatr', 'nevropatolog', 'ginekolog',
    'endokrinolog', 'physician', 'specialist', 'mutaxassis',
  ],
  child: ['bola', 'rebenok', 'detsk', 'child', 'children', 'kid', 'pediatr', 'vakcin', 'emlash', 'privivk'],
  result: ['natija', 'rezultat', 'result', 'analiz', 'tahlil', 'test', 'anali', 'gotov', 'tayyor', 'ready'],
  availability: ['bormi', 'mavjud', 'est', 'imeet', 'nalichie', 'available', 'svobodn', 'bosh', 'free', 'slot'],
  delivery: ['yetkaz', 'dostavka', 'delivery', 'kuryer', 'courier', 'ship', 'dostav'],
  refund: ['qaytar', 'vozvrat', 'refund', 'return', 'obmen', 'almash', 'exchange', 'garantiya', 'kafolat', 'warranty'],
  order: ['buyurtma', 'zakaz', 'order', 'pokupk', 'xarid', 'track', 'trek'],
  operator: [
    'operator', 'menejer', 'manager', 'xodim', 'sotrudnik', 'spetsialist', 'human', 'zhivoy',
    'soedinite', 'ulang', 'perevedite', 'agent', 'administrator',
  ],
  weekend: ['dam', 'vixodn', 'weekend', 'shanba', 'yakshanba', 'subbot', 'voskresen', 'saturday', 'sunday'],
  discount: ['chegirma', 'skidk', 'discount', 'aksiya', 'promo', 'sale'],
  complaint: ['shikoyat', 'jalob', 'complaint', 'pretenz', 'problema', 'muammo', 'problem'],
  cancel: ['bekor', 'otmen', 'cancel', 'perenes', 'kochir', 'reschedule'],
};

const CONCEPT_INDEX: Array<[string, string]> = Object.entries(CONCEPTS).flatMap(([concept, forms]) =>
  forms.map((f) => [f, `~${concept}`] as [string, string]),
);

/** Canonical concept token for a term, or null when it maps to nothing. */
export function conceptOf(term: string): string | null {
  const cached = conceptCache.get(term);
  if (cached !== undefined) return cached;

  let found: string | null = null;
  for (const [form, concept] of CONCEPT_INDEX) {
    if (term === form) {
      found = concept;
      break;
    }
    // Prefix match absorbs the inflection the stemmer left behind
    // ("dokumenty" → "dokument", "strahovoy" → "strahov"). Both sides need
    // four characters, or short forms start swallowing unrelated words.
    if (form.length >= 4 && term.length >= 4 && (term.startsWith(form) || form.startsWith(term))) {
      found = concept;
      break;
    }
  }
  conceptCache.set(term, found);
  return found;
}

// The map is scanned per term on every index and every query; memoising it
// turns the hot path into a hash lookup.
const conceptCache = new Map<string, string | null>();

/**
 * Terms plus their cross-language concept tokens. Used identically when
 * indexing a chunk and when resolving a query, so the two sides always agree.
 */
export function expandTerms(terms: string[]): string[] {
  const out = [...terms];
  const seen = new Set<string>();
  for (const t of terms) {
    const c = conceptOf(t);
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/* ── tokenisation ────────────────────────────────────────────── */

export function tokenize(input: string, { keepStopwords = false } = {}): string[] {
  const out: string[] = [];
  for (const raw of normalize(input).split(/[\s\-/]+/)) {
    const t = raw.replace(/^[.@%+]+|[.@%+]+$/g, '');
    if (t.length < 2) continue;
    if (!keepStopwords && isStopword(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * The canonical term list for a piece of text: stemmed tokens plus their
 * cross-language concept tokens. Both the indexer and the retriever call this,
 * which is what keeps a Russian question and an Uzbek document on speaking
 * terms.
 */
export function stems(input: string): string[] {
  return expandTerms(tokenize(input).map(stem));
}

/** Character n-grams give morphological robustness the stemmer misses. */
export function charNgrams(token: string, min = 3, max = 4): string[] {
  const padded = `«${token}»`;
  const out: string[] = [];
  for (let n = min; n <= max; n++) {
    for (let i = 0; i + n <= padded.length; i++) out.push(padded.slice(i, i + n));
  }
  return out;
}

/* ── language detection ──────────────────────────────────────── */

const UZ_MARKERS = /\b(va|bilan|uchun|kerak|qanday|salom|rahmat|shifokor|qabul|narx|ish|xizmat|mumkin|bormi|qilish|yoki)\b/;
const RU_MARKERS = /\b(и|в|не|что|как|вы|мне|здравствуйте|спасибо|врач|прием|цена|услуга|можно|или|где|когда)\b/i;
const EN_MARKERS = /\b(the|and|you|for|are|with|hello|thanks|doctor|price|service|can|how|when|where)\b/i;

/**
 * Genuinely Uzbek-specific graphemes.
 *
 * Note the digraphs are written as explicit alternations, not folded into the
 * character class: `[oʻ]` would match a bare `o`, which appears in every
 * English sentence ever written and would classify all of them as Uzbek.
 */
const UZ_GRAPHEMES = /қ|ғ|ҳ|ў|o['ʻʼ’]|g['ʻʼ’]|\bq[aeiou]|sh\w|ch\w/g;

export function detectLanguage(text: string): 'uz' | 'ru' | 'en' {
  const lower = text.toLowerCase();
  const cyr = (lower.match(/[а-яёқғҳўј]/g) ?? []).length;
  const lat = (lower.match(/[a-z]/g) ?? []).length;
  const letters = cyr + lat;
  if (!letters) return 'uz';

  const normalized = normalize(lower);
  const uzMarker = UZ_MARKERS.test(normalized);
  const ruMarker = RU_MARKERS.test(lower);
  const enMarker = EN_MARKERS.test(lower);

  // Scale the grapheme signal by text length so one incidental "sha" in a long
  // English sentence cannot outvote three English function words.
  const graphemes = (lower.match(UZ_GRAPHEMES) ?? []).length;
  const graphemeRate = graphemes / Math.max(6, letters / 4);

  let uz = (uzMarker ? 3.5 : 0) + Math.min(3, graphemeRate * 2.5);
  let ru = (ruMarker ? 3.5 : 0);
  let en = (enMarker ? 3.5 : 0);

  if (cyr > lat) {
    // Cyrillic is Russian unless something specifically Uzbek says otherwise.
    ru += 2.5;
    if (uzMarker || /[қғҳў]/.test(lower)) uz += 2;
    en -= 2;
  } else if (lat > 0) {
    en += 0.5;
    uz += 0.5;
  }

  if (uz > ru && uz > en) return 'uz';
  if (ru > en) return 'ru';
  if (en > uz) return 'en';
  return lat >= cyr ? 'uz' : 'ru';
}

/* ── misc ────────────────────────────────────────────────────── */

/** Cheap token estimate — good enough for cost display and chunk sizing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3.6));
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЎҚҒҲ«"(\d])|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Highlight query terms inside a snippet, returning [text, isMatch] runs. */
export function highlight(snippet: string, query: string): Array<[string, boolean]> {
  const wanted = new Set(stems(query));
  if (!wanted.size) return [[snippet, false]];
  const parts: Array<[string, boolean]> = [];
  const re = /([\p{L}\p{N}']+)|([^\p{L}\p{N}']+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    const word = m[1];
    if (word) {
      const s = stem(normalize(word));
      parts.push([word, wanted.has(s)]);
    } else {
      parts.push([m[2]!, false]);
    }
  }
  // merge adjacent runs of the same kind
  const merged: Array<[string, boolean]> = [];
  for (const [t, hit] of parts) {
    const last = merged[merged.length - 1];
    if (last && last[1] === hit) last[0] += t;
    else merged.push([t, hit]);
  }
  return merged;
}
