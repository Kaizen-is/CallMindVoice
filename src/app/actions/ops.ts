'use server';

import { revalidatePath } from 'next/cache';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { all, get, id, now, run } from '@/lib/db';
import { assignEscalation, resolveEscalation } from '@/lib/engine/conversation';
import { endCall, liveAgent } from '@/lib/engine/calls';
import { simulateBurst, simulateCall, simulatorLoad, stopSimulation } from '@/lib/engine/simulator';
import { clearDemoHistory, seedDemoHistory } from '@/lib/engine/demo-data';
import { agentLlm, tenantDefaultLlm } from '@/lib/llm/choice';
import { summarizeCall } from '@/lib/llm/provider';
import { telephonyStatus } from '@/lib/telephony/status';
import type { Agent, Call, Escalation, Locale, SpeechTest, Turn } from '@/lib/types';
import { corePost } from '@/lib/core';
import type { Role } from '@/lib/types';

/** What most workspace actions answer (the Python backend, `backend/app/workspace.py`). */
type ActionResult = { ok: boolean; message: string };

/* ── simulator ───────────────────────────────────────────────── */

export async function simulateCallAction(opts?: { language?: Locale; difficulty?: number }) {
  const session = await requireSession();
  requireRole(session, 'operator');
  if (!liveAgent(session.tenant.id)) {
    return { ok: false, message: 'Create an agent before running a simulated call.' };
  }
  const callId = await simulateCall({
    tenantId: session.tenant.id,
    language: opts?.language,
    difficulty: opts?.difficulty,
    speed: 6,
  });
  revalidatePath('/app/live');
  return { ok: Boolean(callId), callId, message: callId ? 'Call started.' : 'Could not start a call.' };
}

export async function simulateBurstAction(count: number) {
  const session = await requireSession();
  requireRole(session, 'operator');
  const started = await simulateBurst({
    tenantId: session.tenant.id,
    count: Math.min(24, Math.max(1, count)),
    speed: 8,
    difficulty: 0.3,
  });
  audit(session.tenant.id, session.user, 'simulator.burst', null, { count: started.length });
  revalidatePath('/app/live');
  return { ok: true, message: `${started.length} calls queued.`, callIds: started };
}

export async function stopSimulationAction() {
  const session = await requireSession();
  requireRole(session, 'operator');
  const stopped = stopSimulation(session.tenant.id);
  run(
    `UPDATE calls SET status='abandoned', outcome='abandoned', ended_at=?
     WHERE tenant_id=? AND status IN ('ringing','active')`,
    now(),
    session.tenant.id,
  );
  revalidatePath('/app/live');
  return { ok: true, message: `Stopped ${stopped} simulated call${stopped === 1 ? '' : 's'}.` };
}

export async function simulatorStatusAction() {
  const session = await requireSession();
  return { running: simulatorLoad(session.tenant.id), telephony: telephonyStatus() };
}

/* ── demo data ───────────────────────────────────────────────── */

export async function seedDemoHistoryAction() {
  const session = await requireSession();
  requireRole(session, 'admin');
  const result = await seedDemoHistory({ tenantId: session.tenant.id });
  audit(session.tenant.id, session.user, 'demo.seeded', null, { created: result.created });
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  revalidatePath('/app/calls');
  revalidatePath('/app/billing');
  return result;
}

export async function clearHistoryAction() {
  const session = await requireSession();
  requireRole(session, 'admin');
  const removed = clearDemoHistory(session.tenant.id);
  audit(session.tenant.id, session.user, 'demo.cleared', null, { removed });
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  revalidatePath('/app/calls');
  return { ok: true, message: `Removed ${removed} call records.` };
}

/* ── escalations ─────────────────────────────────────────────── */

export async function acceptEscalationAction(escalationId: string) {
  const session = await requireSession();
  requireRole(session, 'operator');
  const callId = assignEscalation(session.tenant.id, escalationId, session.user.id);
  if (!callId) return { ok: false, message: 'Someone else already took this call.' };
  audit(session.tenant.id, session.user, 'escalation.accepted', escalationId, { callId });
  revalidatePath('/app/inbox');
  return { ok: true, callId, message: 'You are on the call.' };
}

export async function resolveEscalationAction(
  escalationId: string,
  resolution: string,
  notes: string,
  csat?: number,
) {
  const session = await requireSession();
  requireRole(session, 'operator');
  const callId = resolveEscalation(session.tenant.id, escalationId, resolution, notes);
  if (!callId) return { ok: false, message: 'Escalation not found.' };
  endCall({
    tenantId: session.tenant.id,
    callId,
    outcome: 'resolved_by_operator',
    csat: csat ?? null,
  });
  audit(session.tenant.id, session.user, 'escalation.resolved', escalationId, { resolution });
  revalidatePath('/app/inbox');
  revalidatePath('/app');
  return { ok: true, message: 'Call closed.' };
}

export async function operatorReplyAction(callId: string, text: string) {
  const session = await requireSession();
  requireRole(session, 'operator');
  const call = get<Call>('SELECT * FROM calls WHERE id=? AND tenant_id=?', callId, session.tenant.id);
  if (!call) return { ok: false, message: 'Call not found.' };
  const ordinal =
    (get<{ n: number }>('SELECT COALESCE(MAX(ordinal), -1) AS n FROM turns WHERE call_id=?', callId)
      ?.n ?? -1) + 1;
  run(
    `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, citations_json, timings_json, created_at)
     VALUES (?,?,?,?, 'operator', ?, ?, '[]', '{}', ?)`,
    id('trn'),
    session.tenant.id,
    callId,
    ordinal,
    text,
    call.language,
    now(),
  );
  revalidatePath('/app/inbox');
  return { ok: true };
}

export async function inboxAction() {
  const session = await requireSession();
  const rows = all<
    Escalation & {
      from_e164: string;
      caller_name: string | null;
      language: string;
      started_at: string;
      intent: string | null;
      sentiment: number | null;
      turns: number;
      operator_name: string | null;
    }
  >(
    `SELECT e.*, c.from_e164, c.caller_name, c.language, c.started_at, c.intent, c.sentiment, c.turns,
            u.name AS operator_name
     FROM escalations e
     JOIN calls c ON c.id = e.call_id
     LEFT JOIN users u ON u.id = e.operator_id
     WHERE e.tenant_id=? AND e.status IN ('waiting','assigned') AND c.channel = 'voice'
     ORDER BY CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              e.created_at ASC`,
    session.tenant.id,
  );

  return rows.map((r) => ({
    ...r,
    transcript: all<Turn>(
      `SELECT ordinal, role, text, confidence, citations_json, timings_json, created_at
       FROM turns WHERE call_id=? AND text != '__unanswered__' ORDER BY ordinal ASC`,
      r.call_id,
    ),
  }));
}

/** Regenerate the hand-off summary — useful after the operator adds context. */
export async function refreshSummaryAction(escalationId: string) {
  const session = await requireSession();
  requireRole(session, 'operator');
  const esc = get<{ call_id: string; reason: string }>(
    'SELECT call_id, reason FROM escalations WHERE id=? AND tenant_id=?',
    escalationId,
    session.tenant.id,
  );
  if (!esc) return { ok: false, message: 'Escalation not found.' };
  const call = get<Call>('SELECT * FROM calls WHERE id=?', esc.call_id);
  const turns = all<Turn>(
    `SELECT role, text FROM turns WHERE call_id=? AND text != '__unanswered__' ORDER BY ordinal ASC`,
    esc.call_id,
  );
  const agent = call?.agent_id
    ? get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', call.agent_id, session.tenant.id)
    : undefined;
  const summary = await summarizeCall(
    turns,
    (call?.language ?? 'en') as Locale,
    esc.reason,
    agent ? agentLlm(agent) : tenantDefaultLlm(session.tenant.id),
  );
  run('UPDATE escalations SET summary=? WHERE id=?', summary, escalationId);
  run('UPDATE calls SET summary=? WHERE id=?', summary, esc.call_id);
  revalidatePath('/app/inbox');
  return { ok: true, summary };
}

/*
 * Workspace administration: the work happens in Python (`POST /actions/<name>`,
 * backend/app/workspace.py) with the same role checks, rows and audit entries;
 * a failed check throws here (CoreError 403), as ForbiddenError did. These
 * proxies only forward the arguments and refresh the pages that changed.
 */

/* ── numbers ─────────────────────────────────────────────────── */

export async function addNumberAction(input: { e164: string; label: string; provider: string }) {
  const r = await corePost<ActionResult>('/actions/addNumberAction', { input });
  if (r.ok) revalidatePath('/app/numbers');
  return r;
}

export async function removeNumberAction(numberId: string) {
  const r = await corePost<ActionResult>('/actions/removeNumberAction', { numberId });
  revalidatePath('/app/numbers');
  return r;
}

/* ── team ────────────────────────────────────────────────────── */

export async function inviteMemberAction(input: {
  name: string;
  email: string;
  role: Role;
  password: string;
}) {
  const r = await corePost<ActionResult>('/actions/inviteMemberAction', { input });
  if (r.ok) revalidatePath('/app/team');
  return r;
}

export async function changeRoleAction(userId: string, role: Role) {
  const r = await corePost<ActionResult>('/actions/changeRoleAction', { userId, role });
  if (r.ok) revalidatePath('/app/team');
  return r;
}

export async function setMemberStatusAction(userId: string, status: 'active' | 'disabled') {
  const r = await corePost<ActionResult>('/actions/setMemberStatusAction', { userId, status });
  if (r.ok) revalidatePath('/app/team');
  return r;
}

/* ── developers ──────────────────────────────────────────────── */

export async function createApiKeyAction(name: string, scopes: string) {
  // The key is returned exactly once — only its hash is stored.
  const r = await corePost<{ ok: boolean; key: string; message: string }>('/actions/createApiKeyAction', {
    name,
    scopes,
  });
  revalidatePath('/app/developers');
  return r;
}

export async function revokeApiKeyAction(keyId: string) {
  const r = await corePost<ActionResult>('/actions/revokeApiKeyAction', { keyId });
  revalidatePath('/app/developers');
  return r;
}

export async function saveWebhookAction(url: string, events: string) {
  const r = await corePost<ActionResult>('/actions/saveWebhookAction', { url, events });
  if (r.ok) revalidatePath('/app/developers');
  return r;
}

export async function deleteWebhookAction(hookId: string) {
  const r = await corePost<ActionResult>('/actions/deleteWebhookAction', { hookId });
  revalidatePath('/app/developers');
  return r;
}

/* ── developer speech lab ────────────────────────────────────── */

/**
 * Persist one speech-lab run (a transcription or a synthesis) so it shows up in
 * the history rail on the /app/dev pages. Any signed-in member may record a
 * test; the row is scoped to the session tenant and user.
 */
export async function saveSpeechTestAction(input: {
  kind: 'stt' | 'tts';
  input?: string | null;
  output?: string | null;
  voice?: string | null;
}): Promise<{ ok: true; test: SpeechTest } | { ok: false; message: string }> {
  const r = await corePost<{ ok: true; test: SpeechTest } | { ok: false; message: string }>(
    '/actions/saveSpeechTestAction',
    { input },
  );
  if (r.ok) revalidatePath(input.kind === 'stt' ? '/app/dev/stt' : '/app/dev/tts');
  return r;
}

/* ── settings & billing ──────────────────────────────────────── */

export async function updateTenantAction(input: {
  name: string;
  industry: string;
  timezone: string;
  country: string;
}) {
  const r = await corePost<ActionResult>('/actions/updateTenantAction', { input });
  revalidatePath('/app', 'layout');
  return r;
}

export async function changePlanAction(plan: string) {
  const r = await corePost<ActionResult>('/actions/changePlanAction', { plan });
  revalidatePath('/app/billing');
  revalidatePath('/app', 'layout');
  return r;
}

/**
 * Credit the prepaid so'm balance. Owner-only. This is a manual top-up — a real
 * payment gateway (Click / Payme / card) is a later phase; here the owner simply
 * records money added to the wallet.
 */
export async function topUpAction(
  amountUzs: number,
): Promise<{ ok: false; message: string } | { ok: true; balance: number; message: string }> {
  const r = await corePost<{ ok: false; message: string } | { ok: true; balance: number; message: string }>(
    '/actions/topUpAction',
    { amountUzs },
  );
  if (r.ok) revalidatePath('/app/billing');
  return r;
}

export async function resolveGapAction(gapId: string, answer: string) {
  const r = await corePost<ActionResult>('/actions/resolveGapAction', { gapId, answer });
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  return r;
}

export async function ignoreGapAction(gapId: string) {
  const r = await corePost<ActionResult>('/actions/ignoreGapAction', { gapId });
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  return r;
}
