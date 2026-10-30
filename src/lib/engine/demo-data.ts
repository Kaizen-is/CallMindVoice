/**
 * Demo history generator.
 *
 * Explicitly user-triggered and clearly labelled in the UI. It exists because
 * an analytics page with three calls in it tells you nothing about whether the
 * analytics are any good.
 *
 * Two kinds of record are produced:
 *   • The most recent slice runs through the *real* engine — genuine retrieval,
 *     genuine answers, genuine citations and latencies. Those calls are
 *     indistinguishable from live traffic because they are live traffic.
 *   • Older days are backfilled as metadata-only call records with realistic
 *     distributions, so the 30-day charts have shape without spending minutes
 *     of compute replaying thousands of conversations.
 */
import 'server-only';
import { all, get, id, now, run, tx } from '@/lib/db';
import type { Agent, Locale } from '@/lib/types';
import { seededRandom } from '@/lib/utils';
import { COST_PER_MINUTE, liveAgent, primaryNumber, startCall, endCall } from './calls';
import { runTurn } from './conversation';
import { invalidateCorpus } from '@/lib/rag/retrieve';

const NAMES = [
  'Aziz Karimov', 'Dilnoza Yusupova', 'Sardor Rahimov', 'Malika Tosheva', 'Jasur Ergashev',
  'Nilufar Saidova', 'Bekzod Aliyev', 'Kamola Nazarova', 'Otabek Xolmatov', 'Shahnoza Qodirova',
  'Rustam Ibragimov', 'Zilola Umarova', 'Farrux Sultonov', 'Gulnora Abdullayeva', 'Timur Yoqubov',
  'Sevara Mirzayeva', 'Doniyor Tursunov', 'Feruza Xolikova', 'Alisher Nurmatov', 'Mohira Bekova',
];

const PREFIXES = ['+99890', '+99893', '+99894', '+99897', '+99899', '+99888', '+99891'];

const INTENTS: Array<{ intent: string; weight: number; solvable: number }> = [
  { intent: 'hours', weight: 18, solvable: 0.96 },
  { intent: 'price', weight: 22, solvable: 0.92 },
  { intent: 'booking', weight: 16, solvable: 0.78 },
  { intent: 'location', weight: 10, solvable: 0.97 },
  { intent: 'documents', weight: 8, solvable: 0.88 },
  { intent: 'availability', weight: 7, solvable: 0.55 },
  { intent: 'policy', weight: 6, solvable: 0.7 },
  { intent: 'status', weight: 5, solvable: 0.42 },
  { intent: 'complaint', weight: 4, solvable: 0.15 },
  { intent: 'general', weight: 4, solvable: 0.6 },
];

const ESCALATION_REASONS = [
  'low_confidence',
  'explicit_request',
  'negative_sentiment',
  'repeated_failure',
];

/** Calls cluster in office hours; weekends are quieter. */
function hourWeight(hour: number, weekday: number) {
  if (weekday === 0) return hour >= 10 && hour <= 15 ? 0.25 : 0.03;
  if (weekday === 6) return hour >= 10 && hour <= 16 ? 0.5 : 0.05;
  if (hour < 8 || hour > 20) return 0.04;
  if (hour >= 9 && hour <= 12) return 1;
  if (hour >= 13 && hour <= 17) return 0.85;
  return 0.4;
}

function pickIntent(rng: () => number) {
  const total = INTENTS.reduce((a, i) => a + i.weight, 0);
  let r = rng() * total;
  for (const i of INTENTS) {
    r -= i.weight;
    if (r <= 0) return i;
  }
  return INTENTS[0];
}

export interface SeedOptions {
  tenantId: string;
  days?: number;
  /** Average calls on a busy weekday. */
  perDay?: number;
  /** How many recent calls to run through the real engine. */
  liveCalls?: number;
}

export async function seedDemoHistory(opts: SeedOptions) {
  const { tenantId } = opts;
  const days = opts.days ?? 30;
  const perDay = opts.perDay ?? 55;
  const liveCalls = opts.liveCalls ?? 12;

  const agent = liveAgent(tenantId);
  if (!agent) return { ok: false, created: 0, message: 'Create an agent first.' };

  const number = primaryNumber(tenantId);
  const rng = seededRandom(`${tenantId}:demo`);
  const languages = JSON.parse(agent.languages_json || '["uz","ru","en"]') as Locale[];

  let created = 0;
  const dayTotals = new Map<string, { calls: number; ai: number; esc: number; aband: number; minutes: number; cost: number; latency: number[]; csatSum: number; csatCount: number }>();

  tx(() => {
    for (let d = days; d >= 1; d--) {
      const date = new Date(Date.now() - d * 864e5);
      const weekday = date.getDay();
      // A gentle upward trend so the charts show the agent bedding in.
      const growth = 0.62 + (1 - d / days) * 0.5;
      const dayCalls = Math.round(perDay * growth * (weekday === 0 ? 0.2 : weekday === 6 ? 0.5 : 1) * (0.8 + rng() * 0.45));

      for (let c = 0; c < dayCalls; c++) {
        let hour = Math.floor(rng() * 24);
        // Rejection-sample against the hour-of-day profile.
        for (let attempt = 0; attempt < 6 && rng() > hourWeight(hour, weekday); attempt++) {
          hour = Math.floor(rng() * 24);
        }
        const started = new Date(date);
        started.setHours(hour, Math.floor(rng() * 60), Math.floor(rng() * 60), 0);

        const spec = pickIntent(rng);
        const language = languages[Math.floor(rng() * languages.length)] ?? 'uz';
        const answered = rng() < spec.solvable;
        const abandoned = !answered && rng() < 0.12;
        const escalated = !answered && !abandoned;

        const turns = answered ? 2 + Math.floor(rng() * 4) : 2 + Math.floor(rng() * 3);
        const durationMs = Math.round((28 + turns * 14 + rng() * 45) * 1000);
        // Latency improves slightly over the period as the index warms.
        const base = 700 - (1 - d / days) * 180;
        const avgLatency = Math.round(base + rng() * 260 + (escalated ? 90 : 0));
        const minutes = durationMs / 60000;
        const cost = Number((minutes * COST_PER_MINUTE).toFixed(4));
        const csat = answered
          ? rng() < 0.78
            ? 5
            : rng() < 0.7
              ? 4
              : 3
          : escalated
            ? rng() < 0.5
              ? 4
              : 3
            : null;

        const callId = id('call');
        const endedAt = new Date(started.getTime() + durationMs);

        run(
          `INSERT INTO calls (id, tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164,
             caller_name, status, outcome, language, intent, sentiment, confidence, csat, turns,
             duration_ms, first_response_ms, avg_latency_ms, p95_latency_ms, cost_usd, escalated,
             escalation_reason, summary, started_at, answered_at, ended_at)
           VALUES (?,?,?,?, 'inbound', 'voice', ?,?,?, 'completed', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
          callId,
          tenantId,
          agent.id,
          number?.id ?? null,
          `${PREFIXES[Math.floor(rng() * PREFIXES.length)]}${String(Math.floor(rng() * 9e6) + 1e6)}`,
          number?.e164 ?? '+998712000000',
          NAMES[Math.floor(rng() * NAMES.length)],
          abandoned ? 'abandoned' : escalated ? 'resolved_by_operator' : 'resolved_by_ai',
          language,
          spec.intent,
          answered ? 0.1 + rng() * 0.4 : -0.6 + rng() * 0.5,
          answered ? 0.6 + rng() * 0.37 : 0.12 + rng() * 0.35,
          csat,
          turns,
          durationMs,
          Math.round(avgLatency * (0.85 + rng() * 0.3)),
          avgLatency,
          Math.round(avgLatency * (1.25 + rng() * 0.35)),
          cost,
          escalated ? 1 : 0,
          escalated ? ESCALATION_REASONS[Math.floor(rng() * ESCALATION_REASONS.length)] : null,
          started.toISOString(),
          started.toISOString(),
          endedAt.toISOString(),
        );

        if (escalated) {
          const waited = Math.round(4000 + rng() * 26000);
          run(
            `INSERT INTO escalations (id, tenant_id, call_id, reason, priority, status, summary,
               operator_id, waited_ms, handled_ms, resolution, created_at, assigned_at, resolved_at)
             VALUES (?,?,?,?,?, 'resolved', NULL, NULL, ?, ?, 'answered', ?, ?, ?)`,
            id('esc'),
            tenantId,
            callId,
            ESCALATION_REASONS[Math.floor(rng() * ESCALATION_REASONS.length)],
            rng() < 0.15 ? 'urgent' : rng() < 0.4 ? 'high' : 'normal',
            waited,
            Math.round(60000 + rng() * 180000),
            started.toISOString(),
            new Date(started.getTime() + waited).toISOString(),
            endedAt.toISOString(),
          );
        }

        const key = started.toISOString().slice(0, 10);
        const t = dayTotals.get(key) ?? {
          calls: 0, ai: 0, esc: 0, aband: 0, minutes: 0, cost: 0, latency: [], csatSum: 0, csatCount: 0,
        };
        t.calls++;
        if (answered) t.ai++;
        if (escalated) t.esc++;
        if (abandoned) t.aband++;
        t.minutes += minutes;
        t.cost += cost;
        t.latency.push(avgLatency);
        if (csat) {
          t.csatSum += csat;
          t.csatCount++;
        }
        dayTotals.set(key, t);
        created++;
      }
    }

    for (const [day, t] of dayTotals) {
      const avg = Math.round(t.latency.reduce((a, b) => a + b, 0) / Math.max(1, t.latency.length));
      run(
        `INSERT INTO usage_daily (id, tenant_id, day, calls, ai_resolved, escalated, abandoned,
           minutes, cost_usd, avg_latency_ms, csat_sum, csat_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, day) DO UPDATE SET
           calls = calls + excluded.calls,
           ai_resolved = ai_resolved + excluded.ai_resolved,
           escalated = escalated + excluded.escalated,
           abandoned = abandoned + excluded.abandoned,
           minutes = minutes + excluded.minutes,
           cost_usd = cost_usd + excluded.cost_usd,
           avg_latency_ms = excluded.avg_latency_ms,
           csat_sum = csat_sum + excluded.csat_sum,
           csat_count = csat_count + excluded.csat_count`,
        id('usg'),
        tenantId,
        day,
        t.calls,
        t.ai,
        t.esc,
        t.aband,
        t.minutes,
        t.cost,
        avg,
        t.csatSum,
        t.csatCount,
      );
    }

    // A year of invoices so the billing page has history.
    for (let m = 3; m >= 1; m--) {
      const d = new Date();
      d.setMonth(d.getMonth() - m);
      const period = d.toISOString().slice(0, 7);
      if (get('SELECT id FROM invoices WHERE tenant_id=? AND period=?', tenantId, period)) continue;
      const calls = Math.round(900 + rng() * 700);
      const minutes = calls * (2.2 + rng() * 1.4);
      run(
        `INSERT INTO invoices (id, tenant_id, period, plan, base_usd, usage_usd, total_usd, minutes, calls, status, issued_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'paid', ?)`,
        id('inv'),
        tenantId,
        period,
        'pro',
        1890,
        Number((minutes * 0.065).toFixed(2)),
        Number((1890 + minutes * 0.065).toFixed(2)),
        Number(minutes.toFixed(0)),
        calls,
        d.toISOString(),
      );
    }
  });

  // The most recent calls are replayed through the real engine so the
  // transcripts, citations and latencies on those records are genuine.
  const realIds: string[] = [];
  for (let i = 0; i < liveCalls; i++) {
    const language = languages[i % languages.length] ?? 'uz';
    const callId = await replayRealCall(tenantId, agent, language, rng);
    if (callId) realIds.push(callId);
  }

  invalidateCorpus(tenantId);
  return {
    ok: true,
    created: created + realIds.length,
    realCalls: realIds.length,
    message: `Generated ${created} historical records and ${realIds.length} fully-replayed calls.`,
  };
}

const REPLAY_SCRIPTS: Record<Locale, string[][]> = {
  uz: [
    ['Assalomu alaykum', 'Ish vaqtingiz qanday?', 'Rahmat!'],
    ['Salom, kardiolog qabuli qancha turadi?', 'Qanday hujjatlar kerak?'],
    ['Manzilingiz qayerda?', 'Dam olish kunlari ishlaysizmi?'],
    ['Navbatga qanday yozilsam bo‘ladi?', 'Katta rahmat'],
  ],
  ru: [
    ['Здравствуйте, вы принимаете страховой полис?', 'А какие документы нужны?'],
    ['Сколько стоит приём терапевта?', 'Спасибо, всё понятно'],
    ['Когда будут готовы анализы?', 'Хорошо, спасибо'],
    ['Я хочу подать жалобу на вчерашний приём', 'С кем можно поговорить?'],
  ],
  en: [
    ['Hello, what are your opening hours?', 'Thanks very much'],
    ['How much is a consultation?', 'Do you accept insurance?'],
    ['When will my results be ready?', 'Great, thank you'],
  ],
};

async function replayRealCall(
  tenantId: string,
  agent: Agent,
  language: Locale,
  rng: () => number,
): Promise<string | null> {
  const scripts = REPLAY_SCRIPTS[language] ?? REPLAY_SCRIPTS.en;
  const script = scripts[Math.floor(rng() * scripts.length)];
  const number = primaryNumber(tenantId);
  const startedAt = new Date(Date.now() - Math.floor(rng() * 8 * 3600_000)).toISOString();

  const callId = startCall({
    tenantId,
    agentId: agent.id,
    numberId: number?.id ?? null,
    from: `${PREFIXES[Math.floor(rng() * PREFIXES.length)]}${String(Math.floor(rng() * 9e6) + 1e6)}`,
    to: number?.e164 ?? '+998712000000',
    callerName: NAMES[Math.floor(rng() * NAMES.length)],
    language,
    startedAt,
  });

  let escalated = false;
  for (const utterance of script) {
    const result = await runTurn({
      tenantId,
      callId,
      agent,
      utterance,
      sttMs: 150 + rng() * 200,
    });
    if (result.escalate) {
      escalated = true;
      break;
    }
  }

  endCall({
    tenantId,
    callId,
    outcome: escalated ? 'resolved_by_operator' : 'resolved_by_ai',
    csat: rng() < 0.8 ? 5 : 4,
    endedAt: new Date(new Date(startedAt).getTime() + 40_000 + rng() * 90_000).toISOString(),
  });
  return callId;
}

export function clearDemoHistory(tenantId: string) {
  const before = get<{ c: number }>('SELECT COUNT(*) AS c FROM calls WHERE tenant_id=?', tenantId)?.c ?? 0;
  tx(() => {
    run('DELETE FROM escalations WHERE tenant_id=?', tenantId);
    run('DELETE FROM turns WHERE tenant_id=?', tenantId);
    run('DELETE FROM calls WHERE tenant_id=?', tenantId);
    run('DELETE FROM usage_daily WHERE tenant_id=?', tenantId);
    run('DELETE FROM knowledge_gaps WHERE tenant_id=?', tenantId);
    run('DELETE FROM invoices WHERE tenant_id=?', tenantId);
  });
  return before;
}

export function callCount(tenantId: string) {
  return all<{ c: number }>('SELECT COUNT(*) AS c FROM calls WHERE tenant_id=?', tenantId)[0]?.c ?? 0;
}
