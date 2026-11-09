/**
 * The usage log — one row each time an STT, TTS or LLM engine does work:
 * which engine, how long it took, how much audio or text, what it cost, and
 * whether it failed.
 *
 * Rows are written from inside the engine layer (`./speech/stt`,
 * `./speech/tts`, `./llm/provider`), so every path that uses an engine is
 * covered without the call routes knowing about it. Writing never throws and
 * never slows a call down: one small SQLite insert, errors swallowed.
 *
 * `source` tells real traffic (`live`) apart from the model lab (`lab`); the
 * lab wraps its work in `withUsageSource('lab', …)`.
 */
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { all, now, run } from '@/lib/db';
import { audioCost, type EngineKind } from '@/lib/speech/registry';

export interface UsageEntry {
  kind: EngineKind;
  engine: string;
  /** LLM: `provider:model`. */
  model?: string | null;
  ms: number;
  /** Time to the first word / first audio, when the engine streams. */
  firstMs?: number | null;
  /** STT: audio heard. TTS: audio spoken. */
  audioMs?: number | null;
  /** TTS: characters spoken. LLM: characters written. */
  chars?: number | null;
  /** LLM: tokens read and written, as the provider reported them. */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Set by the caller when it knows the price (LLM); otherwise worked out from the audio length. */
  costUsd?: number | null;
  ok: boolean;
  error?: string | null;
  tenantId?: string | null;
}

const context = new AsyncLocalStorage<{ source: string; tenantId?: string }>();

/** Run `fn` with every usage row it causes tagged `source` (and the tenant). */
export function withUsageSource<T>(source: string, tenantId: string | undefined, fn: () => T): T {
  return context.run({ source, tenantId }, fn);
}

let writes = 0;
const KEEP_DAYS = 90;

export function recordUsage(entry: UsageEntry): void {
  try {
    const ctx = context.getStore();
    const round = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n));
    run(
      `INSERT INTO model_usage (tenant_id, source, kind, engine, model, ms, first_ms, audio_ms, chars,
         tokens_in, tokens_out, cost_usd, ok, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      entry.tenantId ?? ctx?.tenantId ?? null,
      ctx?.source ?? 'live',
      entry.kind,
      entry.engine,
      entry.model ?? null,
      round(entry.ms) ?? 0,
      round(entry.firstMs),
      round(entry.audioMs),
      round(entry.chars),
      round(entry.tokensIn),
      round(entry.tokensOut),
      entry.costUsd !== undefined ? entry.costUsd : audioCost(entry.kind, entry.engine, entry.audioMs),
      entry.ok ? 1 : 0,
      entry.error ? entry.error.slice(0, 200) : null,
      now(),
    );
    // Now and then, drop rows past the retention window.
    if (++writes % 500 === 0) {
      run(`DELETE FROM model_usage WHERE created_at < ?`, new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
    }
  } catch (err) {
    console.warn('[usage] not recorded:', err instanceof Error ? err.message : err);
  }
}

export interface UsageSummaryRow {
  kind: EngineKind;
  /** STT/TTS: the engine id. LLM: `provider:model`. */
  engine: string;
  uses: number;
  avgMs: number;
  avgFirstMs: number | null;
  failures: number;
  audioMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Null when nothing used had a known price. */
  costUsd: number | null;
  lastAt: string;
}

/**
 * Totals for real traffic over the last `days`: per engine for STT and TTS,
 * per model for LLMs (one provider runs many models).
 */
export function usageSummary(days = 7): UsageSummaryRow[] {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return all<{
    kind: EngineKind;
    engine: string;
    uses: number;
    avg_ms: number;
    avg_first: number | null;
    failures: number;
    audio_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost: number | null;
    last_at: string;
  }>(
    `SELECT kind, CASE WHEN kind = 'llm' THEN COALESCE(model, engine) ELSE engine END AS engine,
            COUNT(*) AS uses, AVG(ms) AS avg_ms, AVG(first_ms) AS avg_first,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures, SUM(audio_ms) AS audio_ms,
            SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
            SUM(cost_usd) AS cost, MAX(created_at) AS last_at
       FROM model_usage
      WHERE source = 'live' AND created_at >= ?
      GROUP BY 1, 2
      ORDER BY kind, uses DESC`,
    since,
  ).map((r) => ({
    kind: r.kind,
    engine: r.engine,
    uses: r.uses,
    avgMs: Math.round(r.avg_ms),
    avgFirstMs: r.avg_first == null ? null : Math.round(r.avg_first),
    failures: r.failures,
    audioMs: r.audio_ms ?? 0,
    tokensIn: r.tokens_in ?? 0,
    tokensOut: r.tokens_out ?? 0,
    costUsd: r.cost,
    lastAt: r.last_at,
  }));
}
