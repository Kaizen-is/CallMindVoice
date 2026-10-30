/**
 * Traffic simulator.
 *
 * Real telephony needs a Twilio account, a purchased number and a public
 * webhook URL — none of which belong in a first-run experience. The simulator
 * drives the *same* engine the phone lines drive (`runTurn`), so what you watch
 * on the live wallboard is genuine retrieval, genuine generation and genuine
 * escalation decisions against your own documents. Only the audio transport is
 * modelled rather than carried.
 *
 * See src/lib/telephony/twilio.ts for the production path this stands in for.
 */
import 'server-only';
import { get } from '@/lib/db';
import type { Agent, Locale } from '@/lib/types';
import { seededRandom } from '@/lib/utils';
import { endCall, liveAgent, primaryNumber, startCall } from './calls';
import { runTurn } from './conversation';
import { publish } from './bus';

/* ── caller personas ─────────────────────────────────────────── */

const UZ_NAMES = [
  'Aziz Karimov', 'Dilnoza Yusupova', 'Sardor Rahimov', 'Malika Tosheva',
  'Jasur Ergashev', 'Nilufar Saidova', 'Bekzod Aliyev', 'Kamola Nazarova',
  'Otabek Xolmatov', 'Shahnoza Qodirova', 'Rustam Ibragimov', 'Zilola Umarova',
  'Farrux Sultonov', 'Gulnora Abdullayeva', 'Timur Yoqubov', 'Sevara Mirzayeva',
];

const PREFIXES = ['+99890', '+99893', '+99894', '+99897', '+99899', '+99888'];

/**
 * Question banks per language. These are *caller* utterances only — every
 * answer comes from the tenant's real indexed documents at run time.
 */
const SCRIPTS: Record<Locale, { open: string[]; body: string[]; hard: string[]; close: string[] }> = {
  uz: {
    open: ['Assalomu alaykum', 'Salom, eshityapsizmi?', 'Assalomu alaykum, savolim bor edi'],
    body: [
      'Ish vaqtingiz qanday?',
      'Qabul narxi qancha?',
      'Manzilingiz qayerda joylashgan?',
      'Navbatga qanday yozilsam bo‘ladi?',
      'Bugun bo‘sh joy bormi?',
      'Qanday hujjatlar kerak?',
      'Dam olish kunlari ishlaysizmi?',
      'To‘lovni qanday amalga oshiraman?',
      'Sug‘urta polisi qabul qilinadimi?',
      'Telefon raqamingizni ayta olasizmi?',
      'Bolalar uchun ham xizmat bormi?',
      'Natijani qachon olaman?',
    ],
    hard: [
      'Menda kecha bo‘lgan operatsiya bo‘yicha shikoyat bor, kim javob beradi?',
      'O‘tgan yilgi shartnomamdagi 14-bandni tushuntira olasizmi?',
      'Xodimingiz menga noto‘g‘ri ma’lumot berdi, buni kim hal qiladi?',
    ],
    close: ['Rahmat, tushunarli', 'Katta rahmat, xayr', 'Yaxshi, rahmat sizga'],
  },
  ru: {
    open: ['Здравствуйте', 'Алло, добрый день', 'Здравствуйте, у меня вопрос'],
    body: [
      'Какой у вас график работы?',
      'Сколько стоит приём?',
      'Где вы находитесь?',
      'Как записаться на приём?',
      'Есть свободное время сегодня?',
      'Какие документы нужны?',
      'Вы работаете в выходные?',
      'Как можно оплатить?',
      'Вы принимаете страховку?',
      'Подскажите ваш номер телефона',
      'А для детей услуги есть?',
      'Когда будут готовы результаты?',
    ],
    hard: [
      'Я хочу подать жалобу на вчерашний приём, с кем можно поговорить?',
      'Объясните пункт 14 моего прошлогоднего договора',
      'Мне дали неверную информацию, кто это будет решать?',
    ],
    close: ['Спасибо, всё понятно', 'Большое спасибо, до свидания', 'Хорошо, спасибо вам'],
  },
  en: {
    open: ['Hello, good afternoon', 'Hi, I have a question', 'Hello, can you hear me?'],
    body: [
      'What are your opening hours?',
      'How much does an appointment cost?',
      'Where are you located?',
      'How do I book an appointment?',
      'Do you have anything available today?',
      'What documents do I need to bring?',
      'Are you open at the weekend?',
      'What payment methods do you accept?',
      'Do you accept insurance?',
      'Could you give me your phone number?',
      'Do you offer services for children?',
      'When will the results be ready?',
    ],
    hard: [
      'I want to make a complaint about yesterday — who can I speak to?',
      'Can you explain clause 14 of my contract from last year?',
      'Your staff gave me the wrong information, who resolves that?',
    ],
    close: ['Thanks, that is clear', 'Thank you very much, goodbye', 'Great, thanks for your help'],
  },
};

const HUMAN_REQUEST: Record<Locale, string> = {
  uz: 'Operator bilan gaplashsam bo‘ladimi?',
  ru: 'Можно соединить меня с оператором?',
  en: 'Could you put me through to a human agent, please?',
};

/* ── scheduling ──────────────────────────────────────────────── */

interface RunningCall {
  callId: string;
  timer: ReturnType<typeof setTimeout>;
}

const running: Map<string, RunningCall[]> = (globalThis as Record<string, unknown>).__ovozSim
  ? ((globalThis as Record<string, unknown>).__ovozSim as Map<string, RunningCall[]>)
  : new Map();
(globalThis as Record<string, unknown>).__ovozSim = running;

function track(tenantId: string, entry: RunningCall) {
  const list = running.get(tenantId) ?? [];
  list.push(entry);
  running.set(tenantId, list);
}

function untrack(tenantId: string, callId: string) {
  const list = running.get(tenantId);
  if (!list) return;
  running.set(
    tenantId,
    list.filter((e) => e.callId !== callId),
  );
}

export function simulatorLoad(tenantId: string) {
  return running.get(tenantId)?.length ?? 0;
}

export function stopSimulation(tenantId: string) {
  const list = running.get(tenantId) ?? [];
  for (const entry of list) clearTimeout(entry.timer);
  running.delete(tenantId);
  return list.length;
}

/* ── one simulated call ──────────────────────────────────────── */

export interface SimulateOptions {
  tenantId: string;
  language?: Locale;
  /** 0‥1 — how often the caller asks something the KB cannot answer. */
  difficulty?: number;
  /** Wall-clock speed multiplier; 1 = realistic, 8 = fast demo. */
  speed?: number;
  seed?: string;
}

export async function simulateCall(opts: SimulateOptions): Promise<string | null> {
  const { tenantId } = opts;
  const agent = liveAgent(tenantId);
  if (!agent) return null;

  const seed = opts.seed ?? `${tenantId}:${Math.random()}`;
  const rng = seededRandom(seed);
  const languages = JSON.parse(agent.languages_json || '["uz","ru","en"]') as Locale[];
  const language = opts.language ?? languages[Math.floor(rng() * languages.length)] ?? 'uz';
  const difficulty = opts.difficulty ?? 0.25;
  const speed = Math.max(1, opts.speed ?? 6);

  const number = primaryNumber(tenantId);
  const name = UZ_NAMES[Math.floor(rng() * UZ_NAMES.length)];
  const from = `${PREFIXES[Math.floor(rng() * PREFIXES.length)]}${String(Math.floor(rng() * 9e6) + 1e6)}`;

  const callId = startCall({
    tenantId,
    agentId: agent.id,
    numberId: number?.id ?? null,
    from,
    to: number?.e164 ?? '+998712000000',
    callerName: name,
    language,
    channel: 'voice',
  });

  const script = SCRIPTS[language] ?? SCRIPTS.en;
  const utterances: string[] = [script.open[Math.floor(rng() * script.open.length)]];

  const bodyTurns = 1 + Math.floor(rng() * 3);
  const pool = [...script.body];
  for (let i = 0; i < bodyTurns; i++) {
    if (rng() < difficulty && script.hard.length) {
      utterances.push(script.hard[Math.floor(rng() * script.hard.length)]);
    } else if (pool.length) {
      utterances.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
  }
  if (rng() < 0.12) utterances.push(HUMAN_REQUEST[language]);
  utterances.push(script.close[Math.floor(rng() * script.close.length)]);

  publish(tenantId, { type: 'call_ringing', callId, from });

  void driveCall({ tenantId, callId, agent, utterances, rng, speed, difficulty });
  return callId;
}

async function driveCall(p: {
  tenantId: string;
  callId: string;
  agent: Agent;
  utterances: string[];
  rng: () => number;
  speed: number;
  difficulty: number;
}) {
  const { tenantId, callId, agent, utterances, rng, speed } = p;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(20, ms / speed));
      track(tenantId, { callId, timer });
    });

  try {
    await wait(1200 + rng() * 1800); // ring time

    let escalated = false;
    for (const utterance of utterances) {
      const stillLive = get<{ status: string }>('SELECT status FROM calls WHERE id=?', callId);
      if (!stillLive || stillLive.status === 'completed' || stillLive.status === 'abandoned') return;

      // Speaking time, then recognition latency.
      await wait(900 + utterance.length * 42 + rng() * 700);
      const result = await runTurn({
        tenantId,
        callId,
        agent,
        utterance,
        sttMs: 180 + rng() * 220,
      });
      if (result.escalate) {
        escalated = true;
        break;
      }
      await wait(400 + rng() * 900); // caller absorbs the answer
    }

    if (escalated) {
      // The operator inbox now owns this call; it leaves the simulator here.
      untrack(tenantId, callId);
      return;
    }

    if (rng() < 0.05) {
      endCall({ tenantId, callId, outcome: 'abandoned' });
    } else {
      const csat = rng() < 0.82 ? (rng() < 0.72 ? 5 : 4) : rng() < 0.6 ? 3 : 2;
      endCall({ tenantId, callId, outcome: 'resolved_by_ai', csat });
    }
  } catch {
    endCall({ tenantId, callId, outcome: 'abandoned' });
  } finally {
    untrack(tenantId, callId);
  }
}

/* ── burst mode ──────────────────────────────────────────────── */

export async function simulateBurst(opts: SimulateOptions & { count: number; spreadMs?: number }) {
  const spread = opts.spreadMs ?? 2500;
  const started: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const callId = await simulateCall({ ...opts, seed: `${opts.seed ?? 'burst'}:${i}:${Date.now()}` });
    if (callId) started.push(callId);
    if (i < opts.count - 1) await new Promise((r) => setTimeout(r, spread / opts.count));
  }
  return started;
}
