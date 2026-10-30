/**
 * GET /v1/calls  (scope: read)
 *
 * List a tenant's calls with outcome and latency, newest first. Supports
 * `?limit=` (default 50, capped at 200), `?outcome=` (exact match) and
 * `?from=` (ISO date/time lower bound on start time). `hasMore` tells the
 * caller whether another page exists.
 */
import { requireApiKey } from '@/lib/api-auth';
import { all } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface CallRow {
  id: string;
  from_e164: string;
  outcome: string | null;
  language: string;
  turns: number;
  duration_ms: number;
  avg_latency_ms: number | null;
  csat: number | null;
}

export async function GET(req: Request) {
  const auth = requireApiKey(req, 'read');
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;

  const rawLimit = Number(params.get('limit'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
      : DEFAULT_LIMIT;

  const where: string[] = ['tenant_id = ?'];
  const args: unknown[] = [auth.tenantId];

  const outcome = params.get('outcome');
  if (outcome) {
    where.push('outcome = ?');
    args.push(outcome);
  }

  const from = params.get('from');
  if (from) {
    where.push('started_at >= ?');
    args.push(from);
  }

  // Fetch one extra row to decide `hasMore` without a second COUNT query.
  const rows = all<CallRow>(
    `SELECT id, from_e164, outcome, language, turns, duration_ms, avg_latency_ms, csat
       FROM calls
      WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC
      LIMIT ?`,
    ...args,
    limit + 1,
  );

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map((r) => ({
    id: r.id,
    from: r.from_e164,
    outcome: r.outcome,
    language: r.language,
    turns: r.turns,
    durationMs: r.duration_ms,
    avgLatencyMs: r.avg_latency_ms,
    csat: r.csat,
  }));

  return Response.json({ data, hasMore });
}
