'use server';

import { revalidatePath } from 'next/cache';
import { corePost } from '@/lib/core';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { all, get, id, now, run } from '@/lib/db';
import { endCall, liveAgent } from '@/lib/engine/calls';
import type { Agent, Call, Escalation, Locale, SpeechTest, Turn } from '@/lib/types';
import { generateApiKey } from '@/lib/auth';
import { inviteMember } from '@/lib/provision';
import type { Role } from '@/lib/types';

/*
 * The simulator, demo-data, escalation and inbox actions are served by the Python backend
 * (backend/app/routers/operations.py): each forwards its arguments with `corePost` and returns
 * Python's answer unchanged (role checks and audit rows happen there); revalidatePath stays here.
 */

/* ── simulator ───────────────────────────────────────────────── */

export async function simulateCallAction(opts?: { language?: Locale; difficulty?: number }) {
  const r = await corePost<{ ok: boolean; callId?: string | null; message: string }>(
    '/actions/simulateCallAction',
    { opts },
  );
  revalidatePath('/app/live');
  return r;
}

export async function simulateBurstAction(count: number) {
  const r = await corePost<{ ok: boolean; message: string; callIds: string[] }>('/actions/simulateBurstAction', {
    count,
  });
  revalidatePath('/app/live');
  return r;
}

export async function stopSimulationAction() {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/stopSimulationAction');
  revalidatePath('/app/live');
  return r;
}

export async function simulatorStatusAction() {
  const r = await corePost<{ running: number; telephony: { configured: boolean; mode: 'asterisk' | 'simulator' } }>(
    '/actions/simulatorStatusAction',
  );
  return r;
}

/* ── demo data ───────────────────────────────────────────────── */

export async function seedDemoHistoryAction() {
  const r = await corePost<
    { ok: false; created: 0; message: string } | { ok: true; created: number; realCalls: number; message: string }
  >('/actions/seedDemoHistoryAction');
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  revalidatePath('/app/calls');
  revalidatePath('/app/billing');
  return r;
}

export async function clearHistoryAction() {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/clearHistoryAction');
  revalidatePath('/app');
  revalidatePath('/app/analytics');
  revalidatePath('/app/calls');
  return r;
}

/* ── escalations ─────────────────────────────────────────────── */

export async function acceptEscalationAction(escalationId: string) {
  const r = await corePost<{ ok: boolean; callId?: string; message: string }>('/actions/acceptEscalationAction', {
    escalationId,
  });
  revalidatePath('/app/inbox');
  return r;
}

export async function resolveEscalationAction(
  escalationId: string,
  resolution: string,
  notes: string,
  csat?: number,
) {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/resolveEscalationAction', {
    escalationId,
    resolution,
    notes,
    csat,
  });
  revalidatePath('/app/inbox');
  revalidatePath('/app');
  return r;
}

export async function operatorReplyAction(callId: string, text: string) {
  const r = await corePost<{ ok: boolean; message?: string }>('/actions/operatorReplyAction', { callId, text });
  revalidatePath('/app/inbox');
  return r;
}

/** An open escalation with its call's facts and transcript, as the operator inbox lists it. */
type InboxRow = Escalation & {
  from_e164: string;
  caller_name: string | null;
  language: string;
  started_at: string;
  intent: string | null;
  sentiment: number | null;
  turns: number;
  operator_name: string | null;
  transcript: Turn[];
};

export async function inboxAction() {
  const r = await corePost<InboxRow[]>('/actions/inboxAction');
  return r;
}

/** Regenerate the hand-off summary — useful after the operator adds context. */
export async function refreshSummaryAction(escalationId: string) {
  const r = await corePost<{ ok: boolean; message?: string; summary?: string }>('/actions/refreshSummaryAction', {
    escalationId,
  });
  revalidatePath('/app/inbox');
  return r;
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
  const session = await requireSession();
  if (input.kind !== 'stt' && input.kind !== 'tts') {
    return { ok: false, message: 'Unknown test kind.' };
  }
  const test: SpeechTest = {
    id: id('spt'),
    tenant_id: session.tenant.id,
    user_id: session.user.id,
    kind: input.kind,
    input: input.input?.slice(0, 4000) ?? null,
    output: input.output?.slice(0, 8000) ?? null,
    voice: input.voice ?? null,
    created_at: now(),
  };
  run(
    `INSERT INTO speech_tests (id, tenant_id, user_id, kind, input, output, voice, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    test.id,
    test.tenant_id,
    test.user_id,
    test.kind,
    test.input,
    test.output,
    test.voice,
    test.created_at,
  );
  revalidatePath(input.kind === 'stt' ? '/app/dev/stt' : '/app/dev/tts');
  return { ok: true, test };
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

/**
 * Credit the prepaid so'm balance. Owner-only. This is a manual top-up — a real
 * payment gateway (Click / Payme / card) is a later phase; here the owner simply
 * records money added to the wallet.
 */
export async function topUpAction(
  amountUzs: number,
): Promise<{ ok: false; message: string } | { ok: true; balance: number; message: string }> {
  const session = await requireSession();
  requireRole(session, 'owner');
  const amount = Math.round(Number(amountUzs));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Enter an amount greater than zero.' };
  }
  run(
    'UPDATE tenants SET balance_uzs = balance_uzs + ?, updated_at=? WHERE id=?',
    amount,
    now(),
    session.tenant.id,
  );
  const balance =
    get<{ balance_uzs: number }>('SELECT balance_uzs FROM tenants WHERE id=?', session.tenant.id)
      ?.balance_uzs ?? 0;
  run(
    `INSERT INTO wallet_ledger (id, tenant_id, kind, amount_uzs, balance_after, note, created_at)
     VALUES (?,?, 'topup', ?, ?, ?, ?)`,
    id('wl'),
    session.tenant.id,
    amount,
    balance,
    'Manual top-up',
    now(),
  );
  audit(session.tenant.id, session.user, 'billing.topup', session.tenant.id, { amount });
  revalidatePath('/app/billing');
  return { ok: true, balance, message: 'Balance topped up.' };
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
