'use server';

import { revalidatePath } from 'next/cache';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { all, get, id, now, run } from '@/lib/db';
import { assignEscalation, resolveEscalation } from '@/lib/engine/conversation';
import { endCall, liveAgent } from '@/lib/engine/calls';
import { simulateBurst, simulateCall, simulatorLoad, stopSimulation } from '@/lib/engine/simulator';
import { clearDemoHistory, seedDemoHistory } from '@/lib/engine/demo-data';
import { summarizeCall } from '@/lib/llm/provider';
import { telephonyStatus } from '@/lib/telephony/status';
import type { Call, Escalation, Locale, Turn } from '@/lib/types';
import { generateApiKey } from '@/lib/auth';
import { inviteMember } from '@/lib/provision';
import type { Role } from '@/lib/types';

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
     WHERE e.tenant_id=? AND e.status IN ('waiting','assigned')
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
  const summary = await summarizeCall(turns, (call?.language ?? 'en') as Locale, esc.reason);
  run('UPDATE escalations SET summary=? WHERE id=?', summary, escalationId);
  run('UPDATE calls SET summary=? WHERE id=?', summary, esc.call_id);
  revalidatePath('/app/inbox');
  return { ok: true, summary };
}

/* ── numbers ─────────────────────────────────────────────────── */

export async function addNumberAction(input: { e164: string; label: string; provider: string }) {
  const session = await requireSession();
  requireRole(session, 'admin');
  const e164 = input.e164.trim();
  if (!/^\+\d{7,15}$/.test(e164)) {
    return { ok: false, message: 'Use international format, for example +998712000000.' };
  }
  if (get('SELECT id FROM phone_numbers WHERE tenant_id=? AND e164=?', session.tenant.id, e164)) {
    return { ok: false, message: 'That number is already connected.' };
  }
  const agent = liveAgent(session.tenant.id);
  const numberId = id('num');
  run(
    `INSERT INTO phone_numbers (id, tenant_id, e164, label, provider, region, agent_id, status,
       capabilities, monthly_cost, created_at)
     VALUES (?,?,?,?,?, 'Tashkent', ?, 'active', 'voice', 3.0, ?)`,
    numberId,
    session.tenant.id,
    e164,
    input.label.trim() || 'Line',
    input.provider,
    agent?.id ?? null,
    now(),
  );
  audit(session.tenant.id, session.user, 'number.added', numberId, { e164 });
  revalidatePath('/app/numbers');
  return { ok: true, message: `${e164} connected.` };
}

export async function removeNumberAction(numberId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run('DELETE FROM phone_numbers WHERE id=? AND tenant_id=?', numberId, session.tenant.id);
  audit(session.tenant.id, session.user, 'number.removed', numberId);
  revalidatePath('/app/numbers');
  return { ok: true, message: 'Number released.' };
}

/* ── team ────────────────────────────────────────────────────── */

export async function inviteMemberAction(input: {
  name: string;
  email: string;
  role: Role;
  password: string;
}) {
  const session = await requireSession();
  requireRole(session, 'admin');
  if (input.password.length < 8) return { ok: false, message: 'Password must be 8+ characters.' };
  try {
    inviteMember({
      tenantId: session.tenant.id,
      email: input.email,
      name: input.name,
      role: input.role,
      password: input.password,
      actor: { id: session.user.id, name: session.user.name },
    });
    revalidatePath('/app/team');
    return { ok: true, message: `${input.name} added as ${input.role}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not add that person.' };
  }
}

export async function changeRoleAction(userId: string, role: Role) {
  const session = await requireSession();
  requireRole(session, 'admin');
  if (userId === session.user.id) return { ok: false, message: 'You cannot change your own role.' };
  run(
    'UPDATE users SET role=?, updated_at=? WHERE id=? AND tenant_id=?',
    role,
    now(),
    userId,
    session.tenant.id,
  );
  audit(session.tenant.id, session.user, 'team.role_changed', userId, { role });
  revalidatePath('/app/team');
  return { ok: true, message: 'Role updated.' };
}

export async function setMemberStatusAction(userId: string, status: 'active' | 'disabled') {
  const session = await requireSession();
  requireRole(session, 'admin');
  if (userId === session.user.id) return { ok: false, message: 'You cannot disable yourself.' };
  run(
    'UPDATE users SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    status,
    now(),
    userId,
    session.tenant.id,
  );
  if (status === 'disabled') run('DELETE FROM sessions WHERE user_id=?', userId);
  audit(session.tenant.id, session.user, 'team.status_changed', userId, { status });
  revalidatePath('/app/team');
  return { ok: true, message: status === 'disabled' ? 'Access revoked.' : 'Access restored.' };
}

/* ── developers ──────────────────────────────────────────────── */

export async function createApiKeyAction(name: string, scopes: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  const { raw, prefix, hash } = generateApiKey();
  const keyId = id('key');
  run(
    `INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    keyId,
    session.tenant.id,
    name.trim() || 'API key',
    prefix,
    hash,
    scopes,
    session.user.id,
    now(),
  );
  audit(session.tenant.id, session.user, 'apikey.created', keyId, { name, scopes });
  revalidatePath('/app/developers');
  // Returned exactly once — only the hash is stored.
  return { ok: true, key: raw, message: 'Copy this key now — it will not be shown again.' };
}

export async function revokeApiKeyAction(keyId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run(
    'UPDATE api_keys SET revoked_at=? WHERE id=? AND tenant_id=?',
    now(),
    keyId,
    session.tenant.id,
  );
  audit(session.tenant.id, session.user, 'apikey.revoked', keyId);
  revalidatePath('/app/developers');
  return { ok: true, message: 'Key revoked.' };
}

export async function saveWebhookAction(url: string, events: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { ok: false, message: 'Webhook URLs must use HTTPS.' };
  } catch {
    return { ok: false, message: 'That is not a valid URL.' };
  }
  const hookId = id('whk');
  run(
    `INSERT INTO webhooks (id, tenant_id, url, events, secret, status, created_at)
     VALUES (?,?,?,?,?, 'active', ?)`,
    hookId,
    session.tenant.id,
    url,
    events,
    generateApiKey().raw.replace('ovoz_sk_', 'whsec_'),
    now(),
  );
  audit(session.tenant.id, session.user, 'webhook.created', hookId, { url });
  revalidatePath('/app/developers');
  return { ok: true, message: 'Webhook registered.' };
}

export async function deleteWebhookAction(hookId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run('DELETE FROM webhooks WHERE id=? AND tenant_id=?', hookId, session.tenant.id);
  revalidatePath('/app/developers');
  return { ok: true, message: 'Webhook removed.' };
}

/* ── settings & billing ──────────────────────────────────────── */

export async function updateTenantAction(input: {
  name: string;
  industry: string;
  timezone: string;
  country: string;
}) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run(
    'UPDATE tenants SET name=?, industry=?, timezone=?, country=?, updated_at=? WHERE id=?',
    input.name.trim(),
    input.industry,
    input.timezone,
    input.country,
    now(),
    session.tenant.id,
  );
  audit(session.tenant.id, session.user, 'tenant.updated', session.tenant.id, input);
  revalidatePath('/app', 'layout');
  return { ok: true, message: 'Saved.' };
}

export async function changePlanAction(plan: string) {
  const session = await requireSession();
  requireRole(session, 'owner');
  run(
    'UPDATE tenants SET plan=?, plan_started=?, updated_at=? WHERE id=?',
    plan,
    now(),
    now(),
    session.tenant.id,
  );
  audit(session.tenant.id, session.user, 'billing.plan_changed', session.tenant.id, { plan });
  revalidatePath('/app/billing');
  revalidatePath('/app', 'layout');
  return { ok: true, message: `Switched to the ${plan} plan.` };
}

export async function resolveGapAction(gapId: string, answer: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run(
    `UPDATE knowledge_gaps SET status='answered', answer=? WHERE id=? AND tenant_id=?`,
    answer,
    gapId,
    session.tenant.id,
  );
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  return { ok: true, message: 'Marked as answered.' };
}

export async function ignoreGapAction(gapId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  run(
    `UPDATE knowledge_gaps SET status='ignored' WHERE id=? AND tenant_id=?`,
    gapId,
    session.tenant.id,
  );
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  return { ok: true, message: 'Dismissed.' };
}
