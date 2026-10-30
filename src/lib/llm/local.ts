/**
 * The local answer synthesiser.
 *
 * Ovoz ships working out of the box with no API key, so answer generation has a
 * real fallback rather than a stub: a query-focused extractive summariser that
 * classifies the caller's intent, pulls the sentences that actually answer it
 * out of the retrieved chunks, and renders them as spoken-register replies in
 * the caller's language. On FAQ- and policy-shaped knowledge bases — which is
 * what contact centres actually run on — this is close to hosted-LLM quality
 * and costs nothing per call.
 *
 * When ANTHROPIC_API_KEY / OPENAI_API_KEY is present, `hosted.ts` takes over
 * and this module becomes the degradation path for provider outages.
 */
import type { RetrievalHit } from '@/lib/rag/retrieve';
import { detectLanguage, normalize, sentences, stem, tokenize } from '@/lib/rag/text';
import type { Locale } from '@/lib/types';

/* ── intent taxonomy ─────────────────────────────────────────── */

export type Intent =
  | 'price'
  | 'hours'
  | 'location'
  | 'contact'
  | 'booking'
  | 'availability'
  | 'documents'
  | 'policy'
  | 'howto'
  | 'status'
  | 'complaint'
  | 'human'
  | 'greeting'
  | 'goodbye'
  | 'affirm'
  | 'general';

const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ['human', /\b(operator|operatorga|human|zhivoy|manager|menejer|specialist|spetsialist|sotrudnik|xodim|perevedite|ulang|ulab|soedinite|agent)\b/],
  ['greeting', /\b(salom|assalom|assalomu|zdravstvuyte|privet|dobriy|hello|hi|hey|good morning|good afternoon)\b/],
  ['goodbye', /\b(xayr|rahmat|spasibo|do svidaniya|poka|bye|goodbye|thanks|thank you)\b/],
  ['affirm', /^(ha|xa|yes|da|ok|okay|xorosho|yaxshi|tugri|verno|konechno|albatta)\b/],
  ['price', /\b(narx|narxi|qancha|pul|tolov|to lov|summa|price|cost|how much|fee|tariff|tarif|cena|stoit|stoimost|skolko|oplata|prays)\b/],
  ['hours', /\b(vaqt|soat|ish vaqti|qachon|ochiq|yopiq|hours|open|close|when|schedule|raspisanie|grafik|rezhim|rabotaete|vremya|dam olish)\b/],
  ['location', /\b(manzil|qayer|joylash|address|where|location|adres|gde|nahodit|filial|branch|kurish|karta|orientir)\b/],
  ['contact', /\b(telefon|raqam|aloqa|contact|phone|number|email|pochta|nomer|svyaz|whatsapp|telegram)\b/],
  ['booking', /\b(navbat|yozil|band qil|qabul|book|appointment|reserve|schedule|zapis|zapisatsya|priem|zabronirovat|rezerv)\b/],
  ['availability', /\b(bormi|bor mi|mavjud|available|est li|imeetsya|nalichie|svobodn|bosh joy|in stock)\b/],
  ['documents', /\b(hujjat|pasport|documents|document|spravka|passport|dokument|nuzhno vzyat|olib kelish|kerakli)\b/],
  ['status', /\b(holat|status|qayerda|track|order|zakaz|buyurtma|dostavka|yetkaz|where is my|gotov|tayyor)\b/],
  ['complaint', /\b(shikoyat|complaint|problem|muammo|jaloba|ne rabotaet|ishlamayapti|ploho|yomon|obman|refund|vozvrat|qaytar)\b/],
  ['policy', /\b(qoida|shart|policy|rules|usloviya|pravila|garantiya|kafolat|strahov|sugurta|dogovor|shartnoma|licenz)\b/],
  ['howto', /\b(qanday|kak|how|qilaman|sdelat|oformit|rasmiylash|poluchit|olish|instrukciya)\b/],
];

export function classifyIntent(text: string): Intent {
  const n = ` ${normalize(text)} `;
  for (const [intent, re] of INTENT_PATTERNS) if (re.test(n)) return intent;
  return 'general';
}

/** Human-readable intent label used across analytics. */
export const INTENT_LABEL: Record<Intent, string> = {
  price: 'Pricing',
  hours: 'Opening hours',
  location: 'Location',
  contact: 'Contact details',
  booking: 'Appointment booking',
  availability: 'Availability',
  documents: 'Required documents',
  policy: 'Policy & terms',
  howto: 'How-to',
  status: 'Order / request status',
  complaint: 'Complaint',
  human: 'Operator request',
  greeting: 'Greeting',
  goodbye: 'Closing',
  affirm: 'Confirmation',
  general: 'General enquiry',
};

/* ── sentiment ───────────────────────────────────────────────── */

const NEGATIVE = /\b(yomon|yoqmadi|shikoyat|jahl|xafa|kutdim|uzoq|sekin|ishlamayapti|muammo|noto|aldadi|ploho|uzhasno|dolgo|zhdu|ne rabotaet|problema|obman|zlyus|nedovolen|bad|awful|terrible|angry|wait|waiting|useless|broken|refund|complain|slow)\b/;
const POSITIVE = /\b(rahmat|zor|ajoyib|yaxshi|tez|minnatdor|spasibo|otlichno|horosho|bistro|udobno|great|thanks|perfect|excellent|helpful|fast)\b/;

export function sentimentOf(text: string): number {
  const n = ` ${normalize(text)} `;
  let score = 0;
  if (NEGATIVE.test(n)) score -= 0.55;
  if (POSITIVE.test(n)) score += 0.5;
  if (/[!]{2,}/.test(text)) score -= 0.15;
  const caps = text.replace(/[^A-ZА-Я]/g, '').length / Math.max(1, text.replace(/[^\p{L}]/gu, '').length);
  if (caps > 0.6 && text.length > 12) score -= 0.2;
  return Math.max(-1, Math.min(1, score));
}

/* ── phrasebook ──────────────────────────────────────────────── */

interface Phrases {
  lead: Partial<Record<Intent, string[]>>;
  generic: string[];
  unknown: string[];
  transfer: string[];
  greeting: string[];
  goodbye: string[];
  followUp: string[];
  ack: string[];
}

const PHRASES: Record<Locale, Phrases> = {
  uz: {
    lead: {
      price: ['Narxlar quyidagicha:', 'Bu xizmat narxi:'],
      hours: ['Ish vaqtimiz:', 'Qabul vaqti:'],
      location: ['Manzilimiz:', 'Bizni bu yerdan topasiz:'],
      contact: ['Aloqa maʼlumotlari:'],
      booking: ['Navbatga yozilish tartibi:'],
      availability: ['Maʼlumot bo‘yicha:'],
      documents: ['Kerakli hujjatlar:'],
      policy: ['Shartlarimiz bo‘yicha:'],
      howto: ['Tartib quyidagicha:'],
      status: ['Holat bo‘yicha:'],
    },
    generic: ['Maʼlumotlarimizga ko‘ra:', 'Mana javob:'],
    unknown: [
      'Kechirasiz, bu savolga aniq javob topa olmadim. Mutaxassisimizga ulab qo‘yaymi?',
      'Afsuski, menda bu boʻyicha aniq maʼlumot yo‘q. Operatorga ulayman.',
    ],
    transfer: ['Albatta, hozir operatorga ulayman. Bir daqiqa kutib turing.'],
    greeting: ['Assalomu alaykum! Men {agent}man. Sizga qanday yordam bera olaman?'],
    goodbye: ['Sizga rahmat! Yana savollaringiz bo‘lsa, qo‘ng‘iroq qiling. Xayr!'],
    followUp: ['Yana biror savolingiz bormi?', 'Boshqa yordam kerakmi?'],
    ack: ['Tushunarli.', 'Yaxshi.'],
  },
  ru: {
    lead: {
      price: ['Стоимость следующая:', 'По ценам:'],
      hours: ['Мы работаем так:', 'График приёма:'],
      location: ['Наш адрес:', 'Мы находимся здесь:'],
      contact: ['Контактные данные:'],
      booking: ['Записаться можно так:'],
      availability: ['По наличию:'],
      documents: ['Необходимые документы:'],
      policy: ['По условиям:'],
      howto: ['Порядок такой:'],
      status: ['По статусу:'],
    },
    generic: ['По нашим данным:', 'Отвечаю:'],
    unknown: [
      'К сожалению, точного ответа на этот вопрос у меня нет. Соединить вас со специалистом?',
      'Не могу это подтвердить по базе знаний. Давайте я переключу вас на оператора.',
    ],
    transfer: ['Конечно, сейчас соединю вас с оператором. Одну минуту.'],
    greeting: ['Здравствуйте! Меня зовут {agent}. Чем могу помочь?'],
    goodbye: ['Спасибо за обращение! Всего доброго.'],
    followUp: ['Могу ещё чем-то помочь?', 'Есть ещё вопросы?'],
    ack: ['Понял вас.', 'Хорошо.'],
  },
  en: {
    lead: {
      price: ['Here are the prices:', 'The cost is:'],
      hours: ['Our opening hours:', 'We are open:'],
      location: ['Our address:', 'You can find us here:'],
      contact: ['Contact details:'],
      booking: ['Here is how booking works:'],
      availability: ['On availability:'],
      documents: ['Documents you will need:'],
      policy: ['On our terms:'],
      howto: ['Here is the process:'],
      status: ['On the status:'],
    },
    generic: ['Here is what I have:', 'According to our records:'],
    unknown: [
      "I couldn't find a confident answer to that. Shall I connect you to a specialist?",
      "I don't have that in my knowledge base. Let me pass you to a colleague.",
    ],
    transfer: ['Of course — connecting you to an operator now. One moment.'],
    greeting: ["Hello! I'm {agent}. How can I help you today?"],
    goodbye: ['Thanks for calling. Have a great day!'],
    followUp: ['Anything else I can help with?', 'Is there anything else?'],
    ack: ['Got it.', 'Understood.'],
  },
};

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function seedOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ── evidence selection ──────────────────────────────────────── */

const NUMERIC = /\d/;
const MONEY = /(\d[\d\s.,]*)\s*(so'm|som|sum|uzs|usd|\$|€|rub|руб|ming|mln|million)/i;
const TIME = /\b(\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm)|dushanba|seshanba|chorshanba|payshanba|juma|shanba|yakshanba|ponedelnik|vtornik|sreda|chetverg|pyatnitsa|subbota|voskresene|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const ADDRESS = /\b(kocha|ko'cha|street|str\.|ul\.|dom|uy|shahar|city|tuman|district|mfy|orientir|metro|prospekt)\b/i;
const PHONE = /(\+?\d[\d\s()-]{7,})/;

const INTENT_BONUS: Partial<Record<Intent, RegExp>> = {
  price: MONEY,
  hours: TIME,
  location: ADDRESS,
  contact: PHONE,
};

interface ScoredSentence {
  text: string;
  score: number;
  hit: RetrievalHit;
}

function scoreSentences(question: string, hits: RetrievalHit[], intent: Intent): ScoredSentence[] {
  const qTerms = new Set(tokenize(question).map(stem));
  const bonusRe = INTENT_BONUS[intent];
  const out: ScoredSentence[] = [];

  hits.forEach((hit, hitIdx) => {
    const lines = hit.text
      .split('\n')
      .flatMap((line) => (line.length > 220 ? sentences(line) : [line]))
      .map((s) => s.trim())
      .filter((s) => s.replace(/\s/g, '').length > 12);

    lines.forEach((line, lineIdx) => {
      const terms = new Set(tokenize(line).map(stem));
      let overlap = 0;
      for (const t of qTerms) if (terms.has(t)) overlap++;
      const coverage = qTerms.size ? overlap / qTerms.size : 0;

      let score = coverage * 2.6;
      score += hit.score * 1.5;
      score -= hitIdx * 0.22;
      score -= lineIdx * 0.035;
      if (bonusRe?.test(line)) score += 1.5;
      if (intent === 'price' && NUMERIC.test(line)) score += 0.35;
      // The heading line of an FAQ chunk restates the question — good anchor,
      // poor answer, so keep it findable but never let it be the reply itself.
      if (hit.heading && line.trim() === hit.heading.trim()) score -= 1.1;
      if (/^[•\-*]/.test(line)) score += 0.2;
      if (line.length < 26) score -= 0.4;
      if (line.length > 320) score -= 0.3;

      out.push({ text: line, score, hit });
    });
  });

  return out.sort((a, b) => b.score - a.score);
}

function tidy(line: string): string {
  return line
    .replace(/^[•\-*]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep replies short — this text is going to be spoken aloud. */
function assemble(picked: ScoredSentence[], intent: Intent, limit: number): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let budget = limit;

  for (const s of picked) {
    const clean = tidy(s.text);
    const key = normalize(clean).slice(0, 60);
    if (!clean || seen.has(key)) continue;
    if (clean.length > budget && kept.length) break;
    seen.add(key);
    kept.push(clean);
    budget -= clean.length;
    const cap = intent === 'price' || intent === 'documents' || intent === 'howto' ? 3 : 2;
    if (kept.length >= cap || budget <= 40) break;
  }

  if (kept.length <= 1) return kept[0] ?? '';
  // Multiple facts read better as a short spoken list.
  return kept.map((k) => (/[.!?:;]$/.test(k) ? k : `${k}.`)).join(' ');
}

/* ── public API ──────────────────────────────────────────────── */

export interface SynthesisInput {
  question: string;
  hits: RetrievalHit[];
  confidence: number;
  language: Locale;
  agentName: string;
  threshold: number;
  history?: Array<{ role: string; text: string }>;
  maxChars?: number;
}

export interface SynthesisOutput {
  answer: string;
  intent: Intent;
  answered: boolean;
  usedHits: RetrievalHit[];
  engine: string;
}

export function synthesizeLocal(input: SynthesisInput): SynthesisOutput {
  const { question, hits, confidence, agentName, threshold } = input;
  const language = input.language ?? detectLanguage(question);
  const phrases = PHRASES[language] ?? PHRASES.en;
  const intent = classifyIntent(question);
  const seed = seedOf(question);
  const maxChars = input.maxChars ?? 340;

  if (intent === 'human') {
    return { answer: pick(phrases.transfer, seed), intent, answered: false, usedHits: [], engine: 'local' };
  }
  if (intent === 'greeting' && !input.history?.length) {
    return {
      answer: pick(phrases.greeting, seed).replace('{agent}', agentName),
      intent,
      answered: true,
      usedHits: [],
      engine: 'local',
    };
  }
  if (intent === 'goodbye') {
    return { answer: pick(phrases.goodbye, seed), intent, answered: true, usedHits: [], engine: 'local' };
  }

  if (!hits.length || confidence < threshold) {
    return { answer: pick(phrases.unknown, seed), intent, answered: false, usedHits: hits.slice(0, 2), engine: 'local' };
  }

  const scored = scoreSentences(question, hits, intent);
  const body = assemble(scored, intent, maxChars);
  if (!body) {
    return { answer: pick(phrases.unknown, seed), intent, answered: false, usedHits: hits.slice(0, 2), engine: 'local' };
  }

  const leadOptions = phrases.lead[intent] ?? phrases.generic;
  const lead = confidence > 0.72 ? pick(leadOptions, seed) : pick(phrases.generic, seed);
  const followUp = pick(phrases.followUp, seed + 7);

  const usedChunkIds = new Set(scored.slice(0, 4).map((s) => s.hit.chunkId));
  const usedHits = hits.filter((h) => usedChunkIds.has(h.chunkId)).slice(0, 3);

  const answer = `${lead} ${body}${/[.!?]$/.test(body) ? '' : '.'} ${followUp}`.replace(/\s+/g, ' ').trim();
  return { answer, intent, answered: true, usedHits, engine: 'local' };
}

/* ── call summarisation (used for operator hand-off) ─────────── */

export function summarizeLocal(
  turns: Array<{ role: string; text: string }>,
  language: Locale,
  reason: string,
): string {
  const callerTurns = turns.filter((t) => t.role === 'caller').map((t) => t.text.trim()).filter(Boolean);
  if (!callerTurns.length) {
    return { uz: 'Qo‘ng‘iroq boshlandi, mijoz hali savol bermadi.', ru: 'Звонок начат, клиент ещё не задал вопрос.', en: 'Call started; the caller has not asked anything yet.' }[language];
  }

  const intent = classifyIntent(callerTurns.join(' '));
  const topic = INTENT_LABEL[intent];
  const first = callerTurns[0].replace(/\s+/g, ' ').slice(0, 150);
  const last = callerTurns[callerTurns.length - 1].replace(/\s+/g, ' ').slice(0, 150);
  const mood = sentimentOf(callerTurns.join(' '));

  const reasonText: Record<string, Record<Locale, string>> = {
    low_confidence: {
      uz: 'AI bazadan ishonchli javob topa olmadi',
      ru: 'AI не нашёл уверенного ответа в базе',
      en: 'the assistant could not find a confident answer',
    },
    explicit_request: {
      uz: 'mijoz operatorni so‘radi',
      ru: 'клиент попросил оператора',
      en: 'the caller asked for a human',
    },
    negative_sentiment: {
      uz: 'mijoz norozi',
      ru: 'клиент недоволен',
      en: 'the caller sounds unhappy',
    },
    repeated_failure: {
      uz: 'ketma-ket bir necha savolga javob topilmadi',
      ru: 'несколько вопросов подряд остались без ответа',
      en: 'several questions in a row went unanswered',
    },
    after_hours: {
      uz: 'ish vaqtidan tashqari murojaat',
      ru: 'обращение вне рабочего времени',
      en: 'the call arrived outside business hours',
    },
  };
  const why = reasonText[reason]?.[language] ?? reason;

  const templates: Record<Locale, string> = {
    uz: `Mavzu: ${topic}. Mijozning birinchi savoli: “${first}”. Oxirgi gap: “${last}”. Eskalatsiya sababi: ${why}.${mood < -0.2 ? ' Diqqat: mijoz kayfiyati salbiy.' : ''}`,
    ru: `Тема: ${topic}. Первый вопрос клиента: «${first}». Последняя реплика: «${last}». Причина эскалации: ${why}.${mood < -0.2 ? ' Внимание: клиент раздражён.' : ''}`,
    en: `Topic: ${topic}. Caller opened with: “${first}”. Last message: “${last}”. Escalated because ${why}.${mood < -0.2 ? ' Heads up: the caller sounds frustrated.' : ''}`,
  };
  return templates[language];
}
