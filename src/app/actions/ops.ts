'use server';

import { revalidatePath } from 'next/cache';
import { corePost } from '@/lib/core';
import type { Escalation, Locale, Role, SpeechTest, Turn } from '@/lib/types';

/** What most workspace actions answer (the Python backend, `backend/app/workspace.py`). */
type ActionResult = { ok: boolean; message: string };
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
