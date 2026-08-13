/**
 * Call lifecycle and usage accounting.
 */
import 'server-only';
import { all, get, id, now, run } from '@/lib/db';
import { AI_MINUTE_UZS } from '@/lib/catalog';
import type { Agent, Call, Locale, PhoneNumber, SpeechTest, Turn } from '@/lib/types';
import { percentile, safeJson, todayKey } from '@/lib/utils';
import { dispatchWebhook } from '@/lib/webhooks';
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
  // Notify subscribed webhooks without blocking the call path.
  void dispatchWebhook(params.tenantId, 'call.started', {
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

  // Draw the handled minutes from the prepaid so'm wallet — the AI listens (STT)
  // and speaks (TTS), so a minute costs AI_MINUTE_UZS. Additive to the USD cost
  // accounting above; the balance is allowed to go negative rather than cut a
  // caller off mid-sentence.
  const debit = Math.round(minutes * AI_MINUTE_UZS);
  if (debit > 0) debitWallet(params.tenantId, debit, `AI call · ${minutes.toFixed(1)} min`);

  publish(params.tenantId, {
    type: 'call_ended',
    callId: params.callId,
    outcome: params.outcome,
    durationMs,
    csat: params.csat ?? null,
  });
  void dispatchWebhook(params.tenantId, 'call.completed', {
    callId: params.callId,
    outcome: params.outcome,
    durationMs,
    avgLatencyMs: avg,
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

/**
 * Subtract a so'm amount from the tenant's prepaid wallet and record the
 * movement in `wallet_ledger` with the resulting balance. The balance may go
 * negative — usage is never blocked; a low or negative balance is surfaced on
 * the billing page for the owner to top up.
 */
function debitWallet(tenantId: string, amountUzs: number, note: string) {
  run('UPDATE tenants SET balance_uzs = balance_uzs - ? WHERE id=?', amountUzs, tenantId);
  const balance =
    get<{ balance_uzs: number }>('SELECT balance_uzs FROM tenants WHERE id=?', tenantId)
      ?.balance_uzs ?? 0;
  run(
    `INSERT INTO wallet_ledger (id, tenant_id, kind, amount_uzs, balance_after, note, created_at)
     VALUES (?,?, 'debit', ?, ?, ?, ?)`,
    id('wl'),
    tenantId,
    amountUzs,
    balance,
    note,
    now(),
  );
}

/* ── lookups ─────────────────────────────────────────────────── */

export function liveAgent(tenantId: string): Agent | undefined {
  return (
    get<Agent>(`SELECT * FROM agents WHERE tenant_id=? AND status='live' ORDER BY updated_at DESC LIMIT 1`, tenantId) ??
    get<Agent>('SELECT * FROM agents WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1', tenantId)
  );
}

/** Every agent belonging to a tenant, oldest first — for the multi-agent pickers. */
export function listAgents(tenantId: string): Array<{ id: string; name: string; status: Agent['status'] }> {
  return all<{ id: string; name: string; status: Agent['status'] }>(
    'SELECT id, name, status FROM agents WHERE tenant_id=? ORDER BY created_at ASC',
    tenantId,
  );
}

/**
 * Latest developer speech-lab runs of one kind (stt|tts) for a tenant — the
 * history rail on the /app/dev/{stt,tts} pages. Newest first, capped small.
 */
export function listSpeechTests(tenantId: string, kind: 'stt' | 'tts'): SpeechTest[] {
  return all<SpeechTest>(
    'SELECT * FROM speech_tests WHERE tenant_id=? AND kind=? ORDER BY created_at DESC LIMIT 20',
    tenantId,
    kind,
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
