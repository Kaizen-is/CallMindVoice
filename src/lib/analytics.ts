/**
 * Analytics roll-ups.
 *
 * Everything here derives from the calls / turns / usage_daily tables — no
 * numbers are invented at render time, so what the dashboard shows is what the
 * engine actually did.
 */
import 'server-only';
import { all, get } from '@/lib/db';
import { INTENT_LABEL, type Intent } from '@/lib/llm/local';
import { dayKeysBack, percentile } from '@/lib/utils';
import { SAVING_PER_DEFLECTED_MINUTE } from '@/lib/engine/calls';

export interface Overview {
  totalCalls: number;
  aiResolved: number;
  escalated: number;
  abandoned: number;
  deflectionRate: number;
  minutes: number;
  costUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  csat: number | null;
  csatResponses: number;
  avgHandleSec: number;
  operatorHoursSaved: number;
  savingsUsd: number;
  activeNow: number;
  waitingEscalations: number;
}

export function overview(tenantId: string, days = 30): Overview {
  const since = new Date(Date.now() - days * 864e5).toISOString();

  const totals = get<{
    calls: number;
    ai: number;
    esc: number;
    aband: number;
    ms: number;
    cost: number;
    csatSum: number;
    csatCount: number;
  }>(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN outcome='resolved_by_ai' THEN 1 ELSE 0 END) AS ai,
            SUM(escalated) AS esc,
            SUM(CASE WHEN outcome='abandoned' THEN 1 ELSE 0 END) AS aband,
            COALESCE(SUM(duration_ms),0) AS ms,
            COALESCE(SUM(cost_usd),0) AS cost,
            COALESCE(SUM(csat),0) AS csatSum,
            SUM(CASE WHEN csat IS NOT NULL THEN 1 ELSE 0 END) AS csatCount
     FROM calls WHERE tenant_id=? AND started_at >= ?`,
    tenantId,
    since,
  );

  const latencies = all<{ v: number }>(
    `SELECT avg_latency_ms AS v FROM calls
     WHERE tenant_id=? AND started_at >= ? AND avg_latency_ms IS NOT NULL
     ORDER BY avg_latency_ms ASC`,
    tenantId,
    since,
  ).map((r) => r.v);

  const activeNow =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM calls WHERE tenant_id=? AND status IN ('ringing','active','escalating','with_operator')`,
      tenantId,
    )?.c ?? 0;
  const waiting =
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM escalations WHERE tenant_id=? AND status='waiting'`,
      tenantId,
    )?.c ?? 0;

  const calls = totals?.calls ?? 0;
  const ai = totals?.ai ?? 0;
  const minutes = (totals?.ms ?? 0) / 60000;
  const aiMinutes = calls ? minutes * (ai / calls) : 0;

  return {
    totalCalls: calls,
    aiResolved: ai,
    escalated: totals?.esc ?? 0,
    abandoned: totals?.aband ?? 0,
    deflectionRate: calls ? ai / calls : 0,
    minutes,
    costUsd: totals?.cost ?? 0,
    avgLatencyMs: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0,
    p95LatencyMs: latencies.length ? Math.round(percentile(latencies, 95)) : 0,
    csat: totals?.csatCount ? (totals.csatSum ?? 0) / totals.csatCount : null,
    csatResponses: totals?.csatCount ?? 0,
    avgHandleSec: calls ? (totals?.ms ?? 0) / calls / 1000 : 0,
    operatorHoursSaved: aiMinutes / 60,
    // Only fully-deflected minutes count: an escalated call was paid for twice,
    // so it is not a saving. Telephony is excluded from both sides.
    savingsUsd: aiMinutes * SAVING_PER_DEFLECTED_MINUTE,
    activeNow,
    waitingEscalations: waiting,
  };
}

export interface DailyPoint {
  day: string;
  calls: number;
  aiResolved: number;
  escalated: number;
  abandoned: number;
  minutes: number;
  cost: number;
  avgLatencyMs: number;
  csat: number | null;
}

export function daily(tenantId: string, days = 30): DailyPoint[] {
  const rows = all<{
    day: string;
    calls: number;
    ai_resolved: number;
    escalated: number;
    abandoned: number;
    minutes: number;
    cost_usd: number;
    avg_latency_ms: number;
    csat_sum: number;
    csat_count: number;
  }>(
    `SELECT * FROM usage_daily WHERE tenant_id=? AND day >= ? ORDER BY day ASC`,
    tenantId,
    dayKeysBack(days)[0],
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return dayKeysBack(days).map((day) => {
    const r = byDay.get(day);
    return {
      day,
      calls: r?.calls ?? 0,
      aiResolved: r?.ai_resolved ?? 0,
      escalated: r?.escalated ?? 0,
      abandoned: r?.abandoned ?? 0,
      minutes: r?.minutes ?? 0,
      cost: r?.cost_usd ?? 0,
      avgLatencyMs: r?.avg_latency_ms ?? 0,
      csat: r && r.csat_count ? r.csat_sum / r.csat_count : null,
    };
  });
}

export function intents(tenantId: string, days = 30, limit = 8) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return all<{ intent: string; c: number; resolved: number }>(
    `SELECT COALESCE(intent,'general') AS intent, COUNT(*) AS c,
            SUM(CASE WHEN outcome='resolved_by_ai' THEN 1 ELSE 0 END) AS resolved
     FROM calls WHERE tenant_id=? AND started_at >= ?
     GROUP BY intent ORDER BY c DESC LIMIT ?`,
    tenantId,
    since,
    limit,
  ).map((r) => ({
    intent: r.intent,
    label: INTENT_LABEL[r.intent as Intent] ?? r.intent,
    count: r.c,
    resolvedRate: r.c ? r.resolved / r.c : 0,
  }));
}

export function languageSplit(tenantId: string, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return all<{ language: string; c: number }>(
    `SELECT language, COUNT(*) AS c FROM calls WHERE tenant_id=? AND started_at >= ?
     GROUP BY language ORDER BY c DESC`,
    tenantId,
    since,
  );
}

export function hourlyHeat(tenantId: string, days = 14) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = all<{ started_at: string }>(
    'SELECT started_at FROM calls WHERE tenant_id=? AND started_at >= ?',
    tenantId,
    since,
  );
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) {
    const d = new Date(r.started_at);
    grid[d.getDay()][d.getHours()] += 1;
  }
  return grid;
}

export function escalationReasons(tenantId: string, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return all<{ reason: string; c: number; avgWait: number | null }>(
    `SELECT reason, COUNT(*) AS c, AVG(waited_ms) AS avgWait
     FROM escalations WHERE tenant_id=? AND created_at >= ?
     GROUP BY reason ORDER BY c DESC`,
    tenantId,
    since,
  );
}

export function knowledgeGaps(tenantId: string, limit = 10) {
  return all<{ id: string; question: string; hits: number; best_score: number; last_seen: string }>(
    `SELECT id, question, hits, best_score, last_seen FROM knowledge_gaps
     WHERE tenant_id=? AND status='open' ORDER BY hits DESC, last_seen DESC LIMIT ?`,
    tenantId,
    limit,
  );
}

export function operatorLeaderboard(tenantId: string, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return all<{
    id: string;
    name: string;
    avatar_hue: number;
    handled: number;
    avgHandle: number | null;
    avgWait: number | null;
  }>(
    `SELECT u.id, u.name, u.avatar_hue,
            COUNT(e.id) AS handled,
            AVG(e.handled_ms) AS avgHandle,
            AVG(e.waited_ms) AS avgWait
     FROM users u LEFT JOIN escalations e
       ON e.operator_id = u.id AND e.status='resolved' AND e.created_at >= ?
     WHERE u.tenant_id=? AND u.role IN ('operator','admin','owner')
     GROUP BY u.id ORDER BY handled DESC`,
    since,
    tenantId,
  );
}

export function knowledgeStats(tenantId: string) {
  const docs = get<{ c: number; ready: number; chunks: number; tokens: number; bytes: number }>(
    `SELECT COUNT(*) AS c,
            SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
            COALESCE(SUM(chunk_count),0) AS chunks,
            COALESCE(SUM(token_count),0) AS tokens,
            COALESCE(SUM(byte_size),0) AS bytes
     FROM documents WHERE tenant_id=?`,
    tenantId,
  );
  return {
    documents: docs?.c ?? 0,
    ready: docs?.ready ?? 0,
    chunks: docs?.chunks ?? 0,
    tokens: docs?.tokens ?? 0,
    bytes: docs?.bytes ?? 0,
  };
}
