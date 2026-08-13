'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { get, id, now, run } from '@/lib/db';
import { contentLocale, type Agent, type BusinessHours, type EscalationPolicy, type Locale } from '@/lib/types';
import { runTurn, DEFAULT_ESCALATION, DEFAULT_HOURS } from '@/lib/engine/conversation';
import { liveAgent } from '@/lib/engine/calls';
import { startCall, endCall } from '@/lib/engine/calls';
import { GREETINGS, FALLBACKS } from '@/lib/provision';

export interface AgentDraft {
  name: string;
  persona: string;
  greeting: string;
  fallbackLine: string;
  instructions: string;
  languages: Locale[];
  primaryLang: Locale;
  voiceId: string;
  speakingRate: number;
  maxTurns: number;
  confidenceThreshold: number;
  status: 'draft' | 'live' | 'paused';
  escalation: EscalationPolicy;
  hours: BusinessHours;
}

export async function saveAgentAction(agentId: string, draft: AgentDraft) {
  const session = await requireSession();
  requireRole(session, 'admin');

  const existing = get<Agent>(
    'SELECT * FROM agents WHERE id=? AND tenant_id=?',
    agentId,
    session.tenant.id,
  );
  if (!existing) return { ok: false, message: 'Agent not found.' };

  run(
    `UPDATE agents SET name=?, persona=?, greeting=?, fallback_line=?, instructions=?,
       languages_json=?, primary_lang=?, voice_id=?, speaking_rate=?, max_turns=?,
       confidence_threshold=?, status=?, escalation_json=?, hours_json=?,
       version = version + 1, updated_at=? WHERE id=?`,
    draft.name.trim() || existing.name,
    draft.persona,
    draft.greeting,
    draft.fallbackLine,
    draft.instructions.slice(0, 4000),
    JSON.stringify(draft.languages.length ? draft.languages : ['uz']),
    draft.primaryLang,
    draft.voiceId,
    draft.speakingRate,
    draft.maxTurns,
    draft.confidenceThreshold,
    draft.status,
    JSON.stringify(draft.escalation),
    JSON.stringify(draft.hours),
    now(),
    agentId,
  );

  audit(session.tenant.id, session.user, 'agent.updated', agentId, {
    status: draft.status,
    version: existing.version + 1,
  });
  revalidatePath('/app/agent');
  revalidatePath('/app');
  return { ok: true, message: 'Agent updated.', version: existing.version + 1 };
}

export async function setAgentStatusAction(agentId: string, status: 'draft' | 'live' | 'paused') {
  const session = await requireSession();
  requireRole(session, 'admin');
  run(
    'UPDATE agents SET status=?, updated_at=? WHERE id=? AND tenant_id=?',
    status,
    now(),
    agentId,
    session.tenant.id,
  );
  audit(session.tenant.id, session.user, 'agent.status', agentId, { status });
  revalidatePath('/app/agent');
  revalidatePath('/app');
  return { ok: true, message: status === 'live' ? 'Agent is live.' : `Agent set to ${status}.` };
}

/**
 * Create an additional agent for the session tenant. The schema already supports
 * many agents per tenant; this is the app-level entry point. Field defaults mirror
 * the single INSERT in provisionTenant so a fresh agent is immediately usable.
 */
export async function createAgentAction(name?: string) {
  const session = await requireSession();
  requireRole(session, 'admin');

  const agentId = id('agt');
  const stamp = now();
  const primaryLang = contentLocale(session.tenant.locale);
  const displayName = name?.trim() || 'New agent';

  run(
    `INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
       languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
       confidence_threshold, escalation_json, hours_json, tools_json, version, created_at, updated_at)
     VALUES (?,?,?, 'draft', 'professional', ?, ?, '', ?, ?, 'nilufar', 1.0, 0.3, 24, 0.45, ?, ?, '[]', 1, ?, ?)`,
    agentId,
    session.tenant.id,
    displayName,
    GREETINGS[primaryLang](session.tenant.name),
    FALLBACKS[primaryLang],
    JSON.stringify(['uz', 'ru', 'en']),
    primaryLang,
    JSON.stringify(DEFAULT_ESCALATION),
    JSON.stringify(DEFAULT_HOURS),
    stamp,
    stamp,
  );

  audit(session.tenant.id, session.user, 'agent.created', agentId, { name: displayName });
  revalidatePath('/app/agent');
  revalidatePath('/app');
  return { ok: true, agentId };
}

/* ── playground ──────────────────────────────────────────────── */

export interface PlaygroundReply {
  ok: boolean;
  callId?: string;
  reply?: string;
  language?: string;
  intent?: string;
  confidence?: number;
  answered?: boolean;
  escalate?: string | null;
  summary?: string;
  timings?: Record<string, number>;
  citations?: Array<{ documentTitle: string; heading: string | null; snippet: string; score: number }>;
  retrieval?: { strategy: string; totalChunks: number; hits: Array<Record<string, unknown>> };
  engine?: string;
  message?: string;
}

export async function playgroundTurnAction(params: {
  callId: string | null;
  utterance: string;
  sttMs?: number;
  /** When set, talk to this specific agent (verified against the session tenant). */
  agentId?: string;
}): Promise<PlaygroundReply> {
  const session = await requireSession();
  const agent = params.agentId
    ? get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', params.agentId, session.tenant.id)
    : liveAgent(session.tenant.id);
  if (!agent) return { ok: false, message: 'Create an agent first.' };
  if (!params.utterance.trim()) return { ok: false, message: 'Nothing was said.' };

  let callId = params.callId;
  if (!callId) {
    callId = startCall({
      tenantId: session.tenant.id,
      agentId: agent.id,
      from: 'playground',
      to: 'playground',
      callerName: `${session.user.name} (test)`,
      channel: 'web',
    });
  } else {
    const owned = get('SELECT id FROM calls WHERE id=? AND tenant_id=?', callId, session.tenant.id);
    if (!owned) return { ok: false, message: 'That test session has expired.' };
  }

  const result = await runTurn({
    tenantId: session.tenant.id,
    callId,
    agent,
    utterance: params.utterance,
    sttMs: params.sttMs ?? 0,
  });

  return {
    ok: true,
    callId,
    reply: result.reply,
    language: result.language,
    intent: result.intent,
    confidence: result.confidence,
    answered: result.answered,
    escalate: result.escalate,
    summary: result.summary,
    timings: result.timings as unknown as Record<string, number>,
    citations: result.citations.map((c) => ({
      documentTitle: c.documentTitle,
      heading: c.heading,
      snippet: c.snippet,
      score: c.score,
    })),
    retrieval: result.retrievalDebug,
    engine: result.engine,
  };
}

export async function endPlaygroundCallAction(callId: string, csat?: number) {
  const session = await requireSession();
  const owned = get<{ escalated: number }>(
    'SELECT escalated FROM calls WHERE id=? AND tenant_id=?',
    callId,
    session.tenant.id,
  );
  if (!owned) return { ok: false };
  endCall({
    tenantId: session.tenant.id,
    callId,
    outcome: owned.escalated ? 'resolved_by_operator' : 'resolved_by_ai',
    csat: csat ?? null,
  });
  revalidatePath('/app');
  return { ok: true };
}

/* ── onboarding ──────────────────────────────────────────────── */

export async function completeOnboardingAction(payload: {
  greeting: string;
  primaryLang: Locale;
  languages: Locale[];
  voiceId: string;
  persona: string;
  goLive: boolean;
}) {
  const session = await requireSession();
  requireRole(session, 'admin');
  const agent = liveAgent(session.tenant.id);
  if (!agent) return { ok: false, message: 'No agent to configure.' };

  run(
    `UPDATE agents SET greeting=?, primary_lang=?, languages_json=?, voice_id=?, persona=?,
       status=?, updated_at=? WHERE id=?`,
    payload.greeting,
    payload.primaryLang,
    JSON.stringify(payload.languages.length ? payload.languages : ['uz']),
    payload.voiceId,
    payload.persona,
    payload.goLive ? 'live' : 'draft',
    now(),
    agent.id,
  );
  run('UPDATE tenants SET onboarded=1, updated_at=? WHERE id=?', now(), session.tenant.id);
  audit(session.tenant.id, session.user, 'onboarding.completed', agent.id, { goLive: payload.goLive });
  revalidatePath('/app', 'layout');
  redirect('/app');
}

export async function skipOnboardingAction() {
  const session = await requireSession();
  run('UPDATE tenants SET onboarded=1, updated_at=? WHERE id=?', now(), session.tenant.id);
  revalidatePath('/app', 'layout');
  redirect('/app');
}
