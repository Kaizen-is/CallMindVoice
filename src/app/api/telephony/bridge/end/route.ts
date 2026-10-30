/**
 * Asterisk/FreePBX ↔ Ovoz voice bridge — END endpoint.
 *
 * The AudioSocket bridge POSTs here when Asterisk sends a terminate frame (0x00)
 * or the TCP socket closes, so the DB `calls` row is closed and usage is rolled
 * up. Same shared-secret gate as the turn endpoint.
 *
 * Body (JSON): { callId, durationSec?, outcome? }
 *   callId       required — the Ovoz DB call id from `x-ovoz-callid`.
 *   durationSec  optional — wall-clock seconds the bridge saw the call; when
 *                present it pins the stored end time (started_at + durationSec)
 *                so the recorded duration matches the wire, instead of "now".
 *   outcome      optional override; defaults to `resolved_by_ai` (see below).
 *
 * `endCall` needs the tenant id and an outcome, which the bridge does not carry,
 * so we resolve the tenant from the call row and default the outcome.
 *
 * CREATE-ONLY module: imports the shared engine/db read-only.
 */
import { timingSafeEqual } from 'node:crypto';
import { get } from '@/lib/db';
import { endCall } from '@/lib/engine/calls';
import type { Call } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Outcome = 'resolved_by_ai' | 'resolved_by_operator' | 'abandoned' | 'voicemail';
const OUTCOMES: readonly Outcome[] = ['resolved_by_ai', 'resolved_by_operator', 'abandoned', 'voicemail'];

export async function POST(request: Request): Promise<Response> {
  // ── Auth gate (before touching the body). ──
  const secret = process.env.BRIDGE_SHARED_SECRET;
  if (!secret) return Response.json({ error: 'bridge_not_configured' }, { status: 503 });
  if (!secretMatches(request.headers.get('x-bridge-secret'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { callId?: string; durationSec?: number; outcome?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const callId = (body.callId ?? '').trim();
  if (!callId) return Response.json({ error: 'missing_callId' }, { status: 400 });

  const call = get<Call>('SELECT * FROM calls WHERE id=?', callId);
  if (!call) return Response.json({ error: 'call_not_found' }, { status: 404 });

  // Idempotent: a hangup can be signalled twice (0x00 then socket close).
  if (call.ended_at || call.status === 'completed' || call.status === 'abandoned') {
    return Response.json({ ok: true, alreadyClosed: true, callId });
  }

  // Pin the end time from the reported duration when it is sane; otherwise let
  // endCall() stamp "now".
  let endedAt: string | undefined;
  if (typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec >= 0) {
    endedAt = new Date(new Date(call.started_at).getTime() + body.durationSec * 1000).toISOString();
  }

  // v1 has no in-call transfer, so even an escalated call is closed as
  // resolved_by_ai (the AI handled every turn and produced the handoff line).
  // Callers may override with an explicit, valid `outcome`.
  const outcome: Outcome =
    body.outcome && OUTCOMES.includes(body.outcome as Outcome) ? (body.outcome as Outcome) : 'resolved_by_ai';

  const result = endCall({ tenantId: call.tenant_id, callId, outcome, endedAt });
  return Response.json({ ok: true, callId, outcome, ...(result ?? {}) });
}

function secretMatches(provided: string | null, expected: string): boolean {
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
