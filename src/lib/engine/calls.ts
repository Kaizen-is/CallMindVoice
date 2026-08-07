/**
 * Call lifecycle and usage accounting.
 */
import 'server-only';
import { all, get, id, now, run } from '@/lib/db';
import type { Agent, Call, Locale, PhoneNumber, Turn } from '@/lib/types';
import { percentile, safeJson, todayKey } from '@/lib/utils';
import { publish } from './bus';

/**
 * True per-minute COGS — what a minute costs *us*, NOT the customer price (that is
 * OVERAGE_PER_MINUTE in catalog.ts). Telephony is the only real per-minute cash
 * cost; STT/TTS run on the self-hosted Uzbek models, so their marginal cost is
 * amortised GPU + electricity, and the LLM is Gemini flash-lite. Kept safely below
 * the customer overage rate so the "where a minute goes" card shows real margin.
 */
export const RATE_CARD = {
  telephonyPerMin: 0.018,
  sttPerMin: 0.004,
  llmPerMin: 0.002,
  ttsPerMin: 0.003,
  platformPerMin: 0.005,
} as const;

export const COST_PER_MINUTE =
  RATE_CARD.telephonyPerMin +
  RATE_CARD.sttPerMin +
  RATE_CARD.llmPerMin +
  RATE_CARD.ttsPerMin +
  RATE_CARD.platformPerMin;

/**
 * Comparable-cost model for deflection savings.
 *
 * Stated openly because the number is only credible if the assumptions are:
 * a fully-loaded contact-centre seat (salary, employer taxes, supervision,
 * workspace, training) at $650/month, 22 working days, 8-hour shifts, and 65%
 * occupancy — the rest of a shift is wrap-up, breaks and idle time that you pay
 * for but that carries no call.
 *
 * Telephony is charged on both sides, so a like-for-like comparison keeps it in
 * both figures rather than quietly counting it against the AI only.
 */
export const OPERATOR_ASSUMPTIONS = {
  loadedMonthlyCost: 650,
  workingDays: 22,
  shiftHours: 8,
  occupancy: 0.65,
} as const;

export const OPERATOR_MINUTES_PER_MONTH =
  OPERATOR_ASSUMPTIONS.workingDays *
  OPERATOR_ASSUMPTIONS.shiftHours *
  60 *
  OPERATOR_ASSUMPTIONS.occupancy;

export const OPERATOR_COST_PER_MINUTE =
  OPERATOR_ASSUMPTIONS.loadedMonthlyCost / OPERATOR_MINUTES_PER_MONTH;

/** What one deflected minute is actually worth, telephony held constant. */
export const SAVING_PER_DEFLECTED_MINUTE = Math.max(
  0,
  OPERATOR_COST_PER_MINUTE - (COST_PER_MINUTE - RATE_CARD.telephonyPerMin),
);

export function startCall(params: {
  tenantId: string;
  agentId: string | null;
  numberId?: string | null;
  from: string;
  to: string;
  callerName?: string | null;
  channel?: 'voice' | 'web' | 'chat';
  direction?: 'inbound' | 'outbound';
  language?: Locale;
  startedAt?: string;
}): string {
  const callId = id('call');
  run(
    `INSERT INTO calls (id, tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164,
       caller_name, status, language, started_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'ringing', ?, ?)`,
    callId,
    params.tenantId,
    params.agentId,
    params.numberId ?? null,
    params.direction ?? 'inbound',
    params.channel ?? 'voice',
    params.from,
    params.to,
    params.callerName ?? null,
    params.language ?? 'uz',
    params.startedAt ?? now(),
  );
  publish(params.tenantId, {
    type: 'call_started',
    callId,
    from: params.from,
    to: params.to,
    language: params.language ?? 'uz',
  });
  return callId;
}

export function endCall(params: {
  tenantId: string;
  callId: string;
  outcome: 'resolved_by_ai' | 'resolved_by_operator' | 'abandoned' | 'voicemail';
  csat?: number | null;
  endedAt?: string;
}) {
  const call = get<Call>('SELECT * FROM calls WHERE id=? AND tenant_id=?', params.callId, params.tenantId);
  if (!call) return null;

  const endedAt = params.endedAt ?? now();
  const durationMs = Math.max(
    1000,
    new Date(endedAt).getTime() - new Date(call.started_at).getTime(),
  );
  const latencies = all<Turn>(
    `SELECT * FROM turns WHERE call_id=? AND role='agent' AND latency_ms IS NOT NULL`,
    params.callId,
  )
    .map((t) => t.latency_ms as number)
    .sort((a, b) => a - b);

  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const p95 = latencies.length ? Math.round(percentile(latencies, 95)) : null;
  const minutes = durationMs / 60000;
  const cost = Number((minutes * COST_PER_MINUTE).toFixed(4));

  run(
    `UPDATE calls SET status='completed', outcome=?, ended_at=?, duration_ms=?, avg_latency_ms=?,
       p95_latency_ms=?, cost_usd=?, csat=? WHERE id=?`,
    params.outcome,
    endedAt,
    durationMs,
    avg,
    p95,
    cost,
    params.csat ?? null,
    params.callId,
  );

  rollUpUsage({
    tenantId: params.tenantId,
    day: endedAt.slice(0, 10),
    outcome: params.outcome,
    escalated: Boolean(call.escalated),
    minutes,
    cost,
    latency: avg ?? 0,
    csat: params.csat ?? null,
  });

  publish(params.tenantId, {
    type: 'call_ended',
    callId: params.callId,
    outcome: params.outcome,
    durationMs,
    csat: params.csat ?? null,
  });
  return { durationMs, cost, avg, p95 };
}

export function abandonCall(tenantId: string, callId: string) {
  return endCall({ tenantId, callId, outcome: 'abandoned' });
}

function rollUpUsage(p: {
  tenantId: string;
  day: string;
  outcome: string;
  escalated: boolean;
  minutes: number;
  cost: number;
  latency: number;
  csat: number | null;
}) {
  const row = get<{ id: string; calls: number; avg_latency_ms: number }>(
    'SELECT id, calls, avg_latency_ms FROM usage_daily WHERE tenant_id=? AND day=?',
    p.tenantId,
    p.day,
  );
  const aiResolved = p.outcome === 'resolved_by_ai' ? 1 : 0;
  const escalated = p.escalated ? 1 : 0;
  const abandoned = p.outcome === 'abandoned' ? 1 : 0;

  if (!row) {
    run(
      `INSERT INTO usage_daily (id, tenant_id, day, calls, ai_resolved, escalated, abandoned,
         minutes, cost_usd, avg_latency_ms, csat_sum, csat_count)
       VALUES (?,?,?,1,?,?,?,?,?,?,?,?)`,
      id('usg'),
      p.tenantId,
      p.day,
      aiResolved,
      escalated,
      abandoned,
      p.minutes,
      p.cost,
      Math.round(p.latency),
      p.csat ?? 0,
      p.csat ? 1 : 0,
    );
    return;
  }
  // Running mean, so the stored average stays correct without re-scanning calls.
  const newAvg = Math.round((row.avg_latency_ms * row.calls + p.latency) / (row.calls + 1));
  run(
    `UPDATE usage_daily SET calls = calls + 1, ai_resolved = ai_resolved + ?, escalated = escalated + ?,
       abandoned = abandoned + ?, minutes = minutes + ?, cost_usd = cost_usd + ?, avg_latency_ms = ?,
       csat_sum = csat_sum + ?, csat_count = csat_count + ? WHERE id=?`,
    aiResolved,
    escalated,
    abandoned,
    p.minutes,
    p.cost,
    newAvg,
    p.csat ?? 0,
    p.csat ? 1 : 0,
    row.id,
  );
}

/* ── lookups ─────────────────────────────────────────────────── */

export function liveAgent(tenantId: string): Agent | undefined {
  return (
    get<Agent>(`SELECT * FROM agents WHERE tenant_id=? AND status='live' ORDER BY updated_at DESC LIMIT 1`, tenantId) ??
    get<Agent>('SELECT * FROM agents WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1', tenantId)
  );
}

export function primaryNumber(tenantId: string): PhoneNumber | undefined {
  return get<PhoneNumber>(
    `SELECT * FROM phone_numbers WHERE tenant_id=? AND status='active' ORDER BY created_at ASC LIMIT 1`,
    tenantId,
  );
}

export function callWithTurns(tenantId: string, callId: string) {
  const call = get<Call>('SELECT * FROM calls WHERE id=? AND tenant_id=?', callId, tenantId);
  if (!call) return null;
  const turns = all<Turn>(
    `SELECT * FROM turns WHERE call_id=? AND text != '__unanswered__' ORDER BY ordinal ASC`,
    callId,
  );
  return {
    call,
    turns: turns.map((t) => ({
      ...t,
      citations: safeJson(t.citations_json, [] as unknown[]),
      timings: safeJson(t.timings_json, {} as Record<string, number>),
    })),
  };
}

/**
 * Calls currently on the line. Playground sessions are excluded — they are a
 * test surface, and a forgotten browser tab should not sit on the wallboard
 * pretending to be a caller.
 */
export function activeCalls(tenantId: string) {
  return all<Call>(
    `SELECT * FROM calls
     WHERE tenant_id=? AND channel='voice'
       AND status IN ('ringing','active','escalating','with_operator')
     ORDER BY started_at DESC`,
    tenantId,
  );
}

/** Close voice calls that have been stuck open — a crashed simulator, say. */
export function reapStaleCalls(tenantId: string, olderThanMs = 15 * 60_000) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stale = all<{ id: string }>(
    `SELECT id FROM calls WHERE tenant_id=? AND status IN ('ringing','active')
       AND started_at < ?`,
    tenantId,
    cutoff,
  );
  for (const s of stale) endCall({ tenantId, callId: s.id, outcome: 'abandoned' });
  return stale.length;
}

export { todayKey };
