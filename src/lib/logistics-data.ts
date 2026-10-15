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

/** Digits as said: "48 29 13" and "48-29-13" are one number. */
function numbersIn(line: string): string[] {
  const text = uzbekNumbersToDigits(line).replace(/(\d)[\s.-]+(?=\d)/g, '$1');
  return [...text.matchAll(/\d{6,12}/g)].map((m) => m[0]);
}

export interface Lookup {
  found: Shipment[];
  /** The caller gave a number that matched nothing (and nothing was found since). */
  unknownNumber: string | null;
}

/** Everything the caller has said, searched for tracking and phone numbers. */
export function lookupShipments(callerLines: string[]): Lookup {
  const found: Shipment[] = [];
  let unknownNumber: string | null = null;
  for (const line of callerLines) {
    for (const n of numbersIn(line)) {
      const hits = SHIPMENTS.filter((s) => n.includes(s.track) || (n.length >= 9 && s.phone === n.slice(-9)));
      if (hits.length) {
        for (const h of hits) if (!found.includes(h)) found.push(h);
        unknownNumber = null;
      } else {
        unknownNumber = n;
      }
    }
  }
  return { found, unknownNumber };
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

function describe(s: Shipment, timeZone: string): string {
  return [
    `Tracking number ${s.track} — recipient ${s.name}, phone ending ${s.phone.slice(-4)}`,
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

/**
 * The system-prompt part for one logistics turn: who the agent is, how it
 * talks, the shipment(s) found so far, and the company's general answers.
 */
export function logisticsContext(callerLines: string[], agentName: string, timeZone = 'Asia/Tashkent'): string {
  const { found, unknownNumber } = lookupShipments(callerLines);
  const shipment = found.length
    ? [
        'SHIPMENT FOUND in the company system — the only source of truth; never add to it:',
        ...found.map((s) => describe(s, timeZone)),
        '- Tell them where it is now and when to expect it, naturally and in your own words. Say',
        '  dates as people say them; never read out the raw list. Mention the delivery method and',
        '  anything still to pay or do (a note) once, when it fits.',
        found.length > 1 ? '- Several shipments match: briefly name each by its goods and ask which one they mean.' : '',
      ]
    : [
        'NO SHIPMENT IDENTIFIED YET.',
        unknownNumber
          ? `- The number they gave (${unknownNumber}) matches nothing. Say you cannot find it, and ask them to repeat it slowly digit by digit, or to give the phone number the parcel was sent to.`
          : '- Ask for the 6-digit track number or the phone number the parcel was sent to. The system looks it up; never guess or make up a status.',
      ];

  return [
    'LOGISTICS SUPPORT — this takes priority over the knowledge-base routing above.',
    `You are ${agentName}, an operator of a cargo company that delivers goods from China to`,
    'Uzbekistan. Customers call to ask where their cargo is and when it will arrive. Your name and',
    `the language of the call are already set; never invent a company name.`,
    '',
    'HOW YOU SOUND — like a friendly, experienced operator, never like a script:',
    '- Short, natural, warm sentences, in the caller’s language. Build on what they just said.',
    '- Never repeat a sentence you already said; never ask again for something they told you.',
    '- If they are worried or angry about a delay, acknowledge it first, then give the facts.',
    '- In Uzbek, always call it "track raqam" (never "trek"); in Russian, "трек-номер".',
    '',
    ...shipment.filter(Boolean),
    '',
    'GENERAL ANSWERS (use only these; anything else: a manager will call them back today):',
    '- Delivery time from the China warehouse to Tashkent: by truck about 12–18 days, by rail',
    '  15–20 days, by air 5–7 days. Customs clearance in Tashkent usually takes 1–2 days.',
    '- Prices depend on weight, volume and method; a manager sends the current price list on Telegram.',
    '- The company handles customs clearance; sometimes a copy of the recipient’s passport is needed.',
    '- Pickup at the Tashkent terminal: Monday to Saturday, 9:00–19:00, with a passport and the',
    '  tracking number. Courier delivery in Tashkent the day after clearance; regions 1–3 days more.',
    '- Not accepted: liquids, loose batteries, flammable goods, medicines, weapons, counterfeit goods.',
    '- Damage, a missing box or a complaint: apologise, take down what happened, and say a manager',
    '  will call them back today. There is no live transfer in this call.',
    '',
    'Every reply here is answered=true, usedExcerpts=[].',
  ].join('\n');
}
