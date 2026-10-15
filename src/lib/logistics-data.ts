/**
 * The logistics demo's "company system": made-up shipments from China to
 * Uzbekistan, and the lookup an operator would do in their software.
 *
 * Dates are kept as offsets from today, so the demo always looks current.
 * The model never guesses where a parcel is: the caller's own words are
 * searched for a tracking or phone number here, and only a record found here
 * is put in front of the model.
 */
import { uzbekNumbersToDigits } from '@/lib/speech/numbers';

type Method = 'avto' | 'avia' | 'temir yo‘l';

interface Shipment {
  track: string;
  phone: string; // 9 digits, without +998
  name: string;
  goods: string;
  boxes: number;
  kg: number;
  method: Method;
  origin: string;
  /** What has happened so far, oldest first: [day offset from today, event]. */
  history: Array<[number, string]>;
  /** Where it is right now, in one line. */
  now: string;
  /** Expected handover, as a day offset; null once delivered. */
  eta: number | null;
  delivery: string;
  payment: string;
  note?: string;
}

const SHIPMENTS: Shipment[] = [
  {
    track: '482913',
    phone: '901234567',
    name: 'Dilshod Rahimov',
    goods: 'phone cases and wireless headphones',
    boxes: 2,
    kg: 14,
    method: 'avto',
    origin: 'Guangzhou',
    history: [
      [-9, 'received at the Guangzhou warehouse'],
      [-7, 'left Guangzhou by truck'],
      [-4, 'arrived at the Urumqi sorting centre'],
      [-1, 'arrived at the Khorgos border crossing (China–Kazakhstan)'],
    ],
    now: 'waiting at the Khorgos border crossing; there is a truck queue, about one day of delay',
    eta: 6,
    delivery: 'pickup at the Tashkent terminal',
    payment: 'fully paid',
  },
  {
    track: '615027',
    phone: '932345678',
    name: 'Malika Yusupova',
    goods: 'children’s clothes',
    boxes: 1,
    kg: 6,
    method: 'avto',
    origin: 'Yiwu',
    history: [
      [-15, 'received at the Yiwu warehouse'],
      [-13, 'left Yiwu by truck'],
      [-6, 'crossed the Khorgos border'],
      [-2, 'entered Uzbekistan'],
      [-1, 'arrived at the Tashkent terminal'],
    ],
    now: 'at the Tashkent terminal, in customs clearance',
    eta: 2,
    delivery: 'courier to the customer’s address in Tashkent',
    payment: '185 000 so‘m still to pay, on delivery',
    note: 'customs needs a copy of the recipient’s passport; it can be sent to the company’s Telegram, and clearance then takes about a day',
  },
  {
    track: '739184',
    phone: '993456789',
    name: 'Jasur Karimov',
    goods: 'kitchen appliances (a blender and an air fryer)',
    boxes: 3,
    kg: 22,
    method: 'avto',
    origin: 'Guangzhou',
    history: [
      [-17, 'received at the Guangzhou warehouse'],
      [-14, 'left Guangzhou by truck'],
      [-8, 'crossed the Khorgos border'],
      [-3, 'arrived at the Tashkent terminal'],
      [-1, 'cleared customs'],
    ],
    now: 'out for delivery with a courier today, between 14:00 and 18:00; the courier calls 30 minutes before arriving',
    eta: 0,
    delivery: 'courier to the customer’s address in Tashkent',
    payment: 'fully paid',
  },
  {
    track: '827405',
    phone: '971234567',
    name: 'Gulnora Saidova',
    goods: 'furniture parts (chairs and a table)',
    boxes: 4,
    kg: 35,
    method: 'avto',
    origin: 'Yiwu',
    history: [
      [-16, 'received at the Yiwu warehouse'],
      [-14, 'left Yiwu by truck'],
      [-7, 'crossed the Khorgos border'],
      [-2, 'arrived at the Uzbek border (Yallama)'],
    ],
    now: 'held at the Uzbek border (Yallama) for a document check on the whole truck; not a problem with this customer’s parcel',
    eta: 5,
    delivery: 'pickup at the Tashkent terminal',
    payment: 'fully paid',
    note: 'delayed by about three days against the original estimate; a manager will call the customer as soon as the truck is released',
  },
  {
    track: '250468',
    phone: '946789012',
    name: 'Nodira Aliyeva',
    goods: 'cosmetics',
    boxes: 1,
    kg: 2.4,
    method: 'avia',
    origin: 'Shenzhen',
    history: [
      [-5, 'received at the Shenzhen warehouse'],
      [-3, 'flown to Urumqi'],
      [-1, 'landed in Tashkent'],
    ],
    now: 'landed in Tashkent yesterday; customs clearance today',
    eta: 1,
    delivery: 'pickup at the Tashkent terminal',
    payment: 'fully paid',
  },
  {
    track: '908351',
    phone: '905678901',
    name: 'Bekzod Tursunov',
    goods: 'car parts',
    boxes: 5,
    kg: 48,
    method: 'temir yo‘l',
    origin: 'Yiwu',
    history: [
      [-12, 'received at the Yiwu warehouse'],
      [-10, 'loaded on a freight train'],
      [-3, 'crossed into Kazakhstan'],
      [-1, 'passed Almaty'],
    ],
    now: 'on the train in Kazakhstan, past Almaty',
    eta: 4,
    delivery: 'courier to the customer’s address in Samarkand (one extra day after Tashkent)',
    payment: '420 000 so‘m still to pay, on delivery',
  },
  {
    track: '374620',
    phone: '887654321',
    name: 'Sevara Qodirova',
    goods: 'shoes',
    boxes: 1,
    kg: 3,
    method: 'avto',
    origin: 'Guangzhou',
    history: [[-2, 'received at the Guangzhou warehouse']],
    now: 'at the Guangzhou warehouse, waiting to be loaded with other parcels; the truck leaves in two days',
    eta: 16,
    delivery: 'pickup at the Tashkent terminal',
    payment: 'fully paid',
  },
  {
    track: '561739',
    phone: '951112233',
    name: 'Otabek Ergashev',
    goods: 'a laptop and accessories',
    boxes: 2,
    kg: 11,
    method: 'avia',
    origin: 'Shenzhen',
    history: [
      [-9, 'received at the Shenzhen warehouse'],
      [-7, 'landed in Tashkent'],
      [-5, 'cleared customs'],
      [-2, 'delivered and signed for by the recipient'],
    ],
    now: 'delivered two days ago, signed for by Otabek Ergashev',
    eta: null,
    delivery: 'courier to the customer’s address in Tashkent',
    payment: 'fully paid',
  },
];

/** The numbers the demo page offers visitors to try. */
export const TRY_TRACKS = ['482913', '615027', '739184', '827405'] as const;

/** Terms GAPI should expect on these calls (at most 20). */
export const LOGISTICS_VOCABULARY = [
  'Yiwu', 'Guangzhou', 'Shenzhen', 'Urumchi', 'Xorgos', 'Olmaota', 'Yallama', 'Toshkent',
  'posilka', 'track raqam', 'trek raqam', 'yuk', 'bojxona', 'kuryer', 'terminal', 'kargo', 'avia',
] as const;

/* ── lookup ──────────────────────────────────────────────────── */

const DIGIT_WORDS: Record<string, string> = {
  nol: '0', bir: '1', ikki: '2', uch: '3', "to'rt": '4', tort: '4', besh: '5',
  olti: '6', yetti: '7', sakkiz: '8', "to'qqiz": '9', toqqiz: '9',
};

/** "olti bir besh nol ikki yetti" — a number said digit by digit — as digits. */
function spelledDigits(line: string): string {
  const text = line.replace(/[‘’ʻʼ`]/g, "'");
  const word = "(?:nol|bir|ikki|uch|to'rt|tort|besh|olti|yetti|sakkiz|to'qqiz|toqqiz)";
  return text.replace(new RegExp(`\\b${word}(?:[\\s,.-]+${word}){2,}\\b`, 'gi'), (run) =>
    run.split(/[\s,.-]+/).map((w) => DIGIT_WORDS[w.toLowerCase()] ?? '').join(''),
  );
}

/** Digits as said: "48 29 13", "48, 29, 13" and "48-29-13" are one number. */
function joinedDigits(line: string): string[] {
  const text = uzbekNumbersToDigits(spelledDigits(line)).replace(/(\d)[\s.,-]+(?=\d)/g, '$1');
  return [...text.matchAll(/\d+/g)].map((m) => m[0]);
}

function numbersIn(line: string): string[] {
  return joinedDigits(line).filter((n) => n.length >= 6 && n.length <= 12);
}

export interface Lookup {
  found: Shipment[];
  /** How each found shipment was matched, by its track number. */
  matchedBy: Map<string, string>;
  /** The caller gave a number that matched nothing (and nothing was found since). */
  unknownNumber: string | null;
  /** Digits in their latest line too short to be a number (part of one, or misheard). */
  partial: string | null;
}

/** Everything the caller has said, searched for track and phone numbers. */
export function lookupShipments(callerLines: string[]): Lookup {
  const found: Shipment[] = [];
  const matchedBy = new Map<string, string>();
  let unknownNumber: string | null = null;
  for (const line of callerLines) {
    for (const n of numbersIn(line)) {
      const hits = SHIPMENTS.filter((s) => n.includes(s.track) || (n.length >= 9 && s.phone === n.slice(-9)));
      if (hits.length) {
        for (const h of hits) {
          if (!found.includes(h)) found.push(h);
          matchedBy.set(h.track, n.includes(h.track) ? 'the track number they gave' : 'the phone number they gave');
        }
        unknownNumber = null;
      } else {
        unknownNumber = n;
      }
    }
  }
  const last = callerLines[callerLines.length - 1] ?? '';
  const short = joinedDigits(last).filter((n) => n.length >= 2 && n.length < 6);
  const partial = !found.length && !numbersIn(last).length && short.length ? short.join(' ') : null;
  return { found, matchedBy, unknownNumber, partial };
}

/* ── what the model is told ──────────────────────────────────── */

const DAY_UZ = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
const DAY_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function dayLabel(offset: number, timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset, 12));
  const en = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
  const rel = offset === 0 ? 'today, ' : offset === 1 ? 'tomorrow, ' : offset === -1 ? 'yesterday, ' : '';
  return `${rel}${en} (${DAY_UZ[d.getUTCDay()]} / ${DAY_RU[d.getUTCDay()]})`;
}

function describe(s: Shipment, timeZone: string, matchedBy?: string): string {
  return [
    // No digits: the voice mispronounces long numbers, so the model is never given any to say.
    `Shipment of ${s.name}` + (matchedBy ? ` (found by ${matchedBy})` : ''),
    `  Goods: ${s.goods}; ${s.boxes} box(es), ${s.kg} kg; sent by ${s.method} from ${s.origin}.`,
    '  Route so far:',
    ...s.history.map(([d, e]) => `    - ${dayLabel(d, timeZone)}: ${e}`),
    `  Right now: ${s.now}.`,
    s.eta === null ? '  Already delivered.' : `  Expected handover: ${dayLabel(s.eta, timeZone)}.`,
    `  Delivery: ${s.delivery}. Payment: ${s.payment}.`,
    s.note ? `  Note: ${s.note}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The lookup's outcome in one line, read by the model right after the caller's words. */
export function lookupNote(callerLines: string[]): string {
  const { found } = lookupShipments(callerLines);
  return found.length
    ? `[Company system, this turn: shipment found for ${found.map((s) => s.name).join(', ')} — use only that record.]`
    : '[Company system, this turn: NOTHING FOUND for what they said. Do not describe any parcel, recipient, goods, place or date.]';
}

/**
 * The prompt part for one logistics turn: who the agent is, how a real
 * operator call goes, the shipment(s) found so far, and the company's answers.
 */
export function logisticsContext(callerLines: string[], agentName: string, timeZone = 'Asia/Tashkent'): string {
  const { found, matchedBy, unknownNumber, partial } = lookupShipments(callerLines);
  const shipment = found.length
    ? [
        'SHIPMENT FOUND in the company system — the only source of truth; never add to it:',
        ...found.map((s) => describe(s, timeZone, matchedBy.get(s.track))),
        '- If you said earlier that you could not find it, say now that you have found it.',
        found.length > 1 ? '- Several shipments match: briefly name each by its goods and ask which one they mean.' : '',
      ]
    : [
        'NO SHIPMENT IDENTIFIED YET — the system found nothing for what they said. You know nothing',
        'about any parcel: never describe a parcel, name a recipient, goods, place or date, and never',
        'say it is on the way. Inventing a parcel is the worst possible mistake here.',
        unknownNumber
          ? '- The number they gave matches nothing; speech recognition may have misheard it. Say you could not find that number, and ask them to say the track number again slowly, or to give the phone number the parcel was sent to.'
          : partial
            ? '- You only caught part of a number. Ask kindly for all six digits of the track number, slowly.'
            : '- Ask for the 6-digit track number or the phone number the parcel was sent to.',
      ];

  return [
    'COMPANY SYSTEM — LOGISTICS SUPPORT. This takes priority over the knowledge-base routing.',
    `You are ${agentName}, an operator of a cargo company that delivers goods from China to`,
    'Uzbekistan. Customers call to ask where their cargo is and when it will arrive. Your name and',
    'the language of the call are already set; never invent a company name.',
    '',
    'HOW A GOOD CALL GOES:',
    '1. Get the 6-digit track number (or the phone number the parcel was sent to). The lookup below',
    '   is instant and already done for this turn: never say "I will check", "one moment" or "please',
    '   wait" — give the result now.',
    '2. When a shipment is found, in ONE reply: confirm it in a few words (whose name it is in and',
    '   what is inside), then say where it is now and since when, the reason if it is delayed, what',
    '   happens next, and the expected date with its weekday. Then the delivery method and anything',
    '   they still have to pay or do. This status reply may be four to six short sentences; for it',
    '   the usual two-or-three-sentence limit does not apply.',
    '3. End EVERY reply with one natural next step or question that fits their situation, e.g. offer',
    '   the SMS when it reaches Tashkent, switching between pickup and courier, how to send the',
    '   passport copy, or whether they have another parcel to check. Never close the call yourself;',
    '   only when they say goodbye, thank them and wish them well.',
    '4. Follow-up questions are answered from the record (route dates, boxes, weight, method,',
    '   origin), building on what you already said — never repeat the same sentence.',
    '',
    'HOW YOU SOUND — like a friendly, experienced operator, never like a script:',
    '- Natural, warm sentences in the caller’s language. Use their name once you know it.',
    '- If they are worried or angry about a delay, acknowledge it first, then give the facts.',
    '- In Uzbek, always call it "track raqam" (never "trek"); in Russian, "трек-номер".',
    '- Never say a track number or a phone number out loud, not even to repeat it back or confirm',
    '  it — the voice mispronounces long numbers. Refer to it as "track raqamingiz" / "this number".',
    '- Say dates, prices and weights the way people say them out loud.',
    '',
    ...shipment.filter(Boolean),
    '',
    'GENERAL ANSWERS (use only these; anything else: a manager will call them back today):',
    '- Delivery time from the China warehouse to Tashkent: by truck about 12–18 days, by rail',
    '  15–20 days, by air 5–7 days. Customs clearance in Tashkent usually takes 1–2 days.',
    '- The company sends an SMS when the parcel reaches the Tashkent terminal and when the courier',
    '  sets off. Switching between pickup and courier is possible until the parcel reaches Tashkent.',
    '- Prices depend on weight, volume and method; a manager sends the current price list on Telegram.',
    '- The company handles customs clearance; sometimes a copy of the recipient’s passport is needed.',
    '- Pickup at the Tashkent terminal: Monday to Saturday, 9:00–19:00, with a passport and the',
    '  track number. Courier delivery in Tashkent the day after clearance; regions 1–3 days more.',
    '- Not accepted: liquids, loose batteries, flammable goods, medicines, weapons, counterfeit goods.',
    '- Damage, a missing box or a complaint: apologise, take down what happened, and say a manager',
    '  will call them back today. There is no live transfer in this call.',
    '',
    'Every reply here is answered=true, usedExcerpts=[].',
  ].join('\n');
}
