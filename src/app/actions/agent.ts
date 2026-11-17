'use server';

/**
 * Agents, the Playground's text chat and history, and onboarding. The work is done by the Python
 * backend (`backend/app/routers/agent_studio.py`, `POST /actions/<name>`); these keep the names,
 * parameters and return shapes the pages use, and the Next.js cache and redirect calls.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { corePost } from '@/lib/core';
import type { BusinessHours, CallTarget, EscalationPolicy, Locale } from '@/lib/types';

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
  target: CallTarget;
  /** `provider:model`, or '' for the account default. */
  llmModel: string;
  /** '' = own TTS (`voiceId`), else an ElevenLabs model through Speko. */
  ttsEngine: string;
  /** The ElevenLabs voice for `ttsEngine`. */
  ttsVoiceId: string;
}

export async function saveAgentAction(agentId: string, draft: AgentDraft) {
  const r = await corePost<{ ok: boolean; message: string; version?: number }>('/actions/saveAgentAction', {
    agentId,
    draft,
  });
  if (r.ok) {
    revalidatePath('/app/agent');
    revalidatePath('/app');
  }
  return r;
}

export async function setAgentStatusAction(agentId: string, status: 'draft' | 'live' | 'paused') {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/setAgentStatusAction', { agentId, status });
  revalidatePath('/app/agent');
  revalidatePath('/app');
  return r;
}

/**
 * Create an additional agent for the session tenant, with the same defaults as the one made at
 * sign-up, so a fresh agent is immediately usable.
 */
export async function createAgentAction(name?: string) {
  const r = await corePost<{ ok: boolean; agentId: string }>('/actions/createAgentAction', { name });
  revalidatePath('/app/agent');
  revalidatePath('/app');
  return r;
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
  return corePost<PlaygroundReply>('/actions/playgroundTurnAction', { params });
}

export async function endPlaygroundCallAction(callId: string, csat?: number) {
  // Billed once, up to the last message; a chat that was already closed is left alone.
  const r = await corePost<{ ok: true; closed: boolean }>('/actions/endPlaygroundCallAction', { callId, csat });
  if (r.closed) revalidatePath('/app');
  return { ok: r.ok };
}

/* ── playground chat history ─────────────────────────────────── */

export interface PlaygroundChat {
  callId: string;
  title: string;
  turns: number;
  lastAt: string;
}

/** Saved playground conversations with one agent, most recent first. */
export async function listPlaygroundChatsAction(agentId: string): Promise<PlaygroundChat[]> {
  return corePost<PlaygroundChat[]>('/actions/listPlaygroundChatsAction', { agentId });
}

export interface PlaygroundChatTurn {
  role: 'caller' | 'agent';
  text: string;
  language: Locale | null;
  reply?: PlaygroundReply;
}

/** The transcript of one saved playground conversation, for reopening it. */
export async function loadPlaygroundChatAction(
  callId: string,
): Promise<{ ok: boolean; turns?: PlaygroundChatTurn[]; message?: string }> {
  return corePost<{ ok: boolean; turns?: PlaygroundChatTurn[]; message?: string }>(
    '/actions/loadPlaygroundChatAction',
    { callId },
  );
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
  const r = await corePost<{ ok: boolean; message?: string }>('/actions/completeOnboardingAction', { payload });
  if (!r.ok) return r; // { ok: false, message: 'No agent to configure.' }
  revalidatePath('/app', 'layout');
  redirect('/app');
}

export async function skipOnboardingAction() {
  await corePost('/actions/skipOnboardingAction');
  revalidatePath('/app', 'layout');
  redirect('/app');
}
