/**
 * The turn engine.
 *
 * One caller utterance in → one spoken reply out, plus every side effect that
 * has to happen along the way: retrieval, generation, escalation decisioning,
 * transcript persistence, latency instrumentation and knowledge-gap capture.
 *
 * Both the telephony path and the browser playground call this, which is what
 * makes the playground a true rehearsal of a real call rather than a demo toy.
 */
import 'server-only';
import { all, get, id, now, run } from '@/lib/db';
import { retrieve, type RetrievalHit } from '@/lib/rag/retrieve';
import { detectLanguage } from '@/lib/rag/text';
import { generateAnswer, sentimentOf, engineName } from '@/lib/llm/provider';
import { summarizeCall } from '@/lib/llm/provider';
import type {
  Agent,
  BusinessHours,
  Call,
  Citation,
  EscalationPolicy,
  Locale,
  Timings,
  Turn,
} from '@/lib/types';
import { safeJson } from '@/lib/utils';
import { publish } from './bus';

export const DEFAULT_ESCALATION: EscalationPolicy = {
  onLowConfidence: true,
  onExplicitRequest: true,
  onNegativeSentiment: true,
  onRepeatedFailure: true,
  maxFailedTurns: 2,
  afterHoursAction: 'answer_anyway',
  ringTimeoutSec: 30,
  fallbackNumber: '',
};

export const DEFAULT_HOURS: BusinessHours = {
  enabled: false,
  timezone: 'Asia/Tashkent',
  days: {
    '1': { open: '09:00', close: '18:00', closed: false },
    '2': { open: '09:00', close: '18:00', closed: false },
    '3': { open: '09:00', close: '18:00', closed: false },
    '4': { open: '09:00', close: '18:00', closed: false },
    '5': { open: '09:00', close: '18:00', closed: false },
    '6': { open: '10:00', close: '15:00', closed: false },
    '0': { open: '00:00', close: '00:00', closed: true },
  },
};

export type EscalationReason =
  | 'low_confidence'
  | 'explicit_request'
  | 'negative_sentiment'
  | 'repeated_failure'
  | 'after_hours'
  | 'max_turns';

export interface TurnResult {
  callId: string;
  reply: string;
  language: Locale;
  intent: string;
  confidence: number;
  answered: boolean;
  citations: Citation[];
  timings: Timings;
  escalate: EscalationReason | null;
  summary?: string;
  turnOrdinal: number;
  engine: string;
  retrievalDebug: {
    strategy: string;
    totalChunks: number;
    hits: Array<{ title: string; heading: string | null; score: number; lexical: number; dense: number }>;
  };
}

/* ── helpers ─────────────────────────────────────────────────── */

export function agentEscalation(agent: Agent): EscalationPolicy {
  return { ...DEFAULT_ESCALATION, ...safeJson<Partial<EscalationPolicy>>(agent.escalation_json, {}) };
}

export function agentHours(agent: Agent): BusinessHours {
  const parsed = safeJson<Partial<BusinessHours>>(agent.hours_json, {});
  return { ...DEFAULT_HOURS, ...parsed, days: { ...DEFAULT_HOURS.days, ...(parsed.days ?? {}) } };
}

export function isWithinHours(hours: BusinessHours, at = new Date()): boolean {
  if (!hours.enabled) return true;
  // Tenant-local wall clock, not server time — a Tashkent clinic's hours must
  // not shift because the box happens to run in UTC.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: hours.timezone || 'Asia/Tashkent',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  const spec = hours.days[String(dayIndex < 0 ? 1 : dayIndex)];
  if (!spec || spec.closed) return false;
  const minutes = Number(hh) * 60 + Number(mm);
  const [oh, om] = spec.open.split(':').map(Number);
  const [ch, cm] = spec.close.split(':').map(Number);
  return minutes >= oh * 60 + om && minutes < ch * 60 + cm;
}

function toCitations(hits: RetrievalHit[]): Citation[] {
  return hits.map((h) => ({
    chunkId: h.chunkId,
    documentId: h.documentId,
    documentTitle: h.documentTitle,
    heading: h.heading,
    snippet: h.snippet,
    score: Number(h.score.toFixed(3)),
  }));
}

function recordGap(tenantId: string, question: string, score: number) {
  const normalized = question.trim().slice(0, 300);
  if (normalized.length < 6) return;
  const existing = get<{ id: string; hits: number }>(
    'SELECT id, hits FROM knowledge_gaps WHERE tenant_id=? AND lower(question)=lower(?)',
    tenantId,
    normalized,
  );
  if (existing) {
    run(
      'UPDATE knowledge_gaps SET hits=?, best_score=MAX(best_score, ?), last_seen=? WHERE id=?',
      existing.hits + 1,
      score,
      now(),
      existing.id,
    );
  } else {
    run(
      `INSERT INTO knowledge_gaps (id, tenant_id, question, hits, best_score, status, last_seen, created_at)
       VALUES (?,?,?,1,?, 'open', ?, ?)`,
      id('gap'),
      tenantId,
      normalized,
      score,
      now(),
      now(),
    );
  }
}

/* ── the turn ────────────────────────────────────────────────── */

export async function runTurn(params: {
  tenantId: string;
  callId: string;
  agent: Agent;
  utterance: string;
  /** Simulated speech-recognition time; the browser path measures it for real. */
  sttMs?: number;
  persist?: boolean;
}): Promise<TurnResult> {
  const { tenantId, callId, agent, utterance } = params;
  const persist = params.persist !== false;
  const t0 = performance.now();

  const call = get<Call>('SELECT * FROM calls WHERE id=? AND tenant_id=?', callId, tenantId);
  const history = all<Turn>(
    'SELECT * FROM turns WHERE call_id=? ORDER BY ordinal ASC',
    callId,
  ).map((t) => ({ role: t.role, text: t.text }));

  const language = detectLanguage(utterance) as Locale;
  const policy = agentEscalation(agent);
  const threshold = agent.confidence_threshold ?? 0.55;

  /* retrieval */
  const tRetrieve = performance.now();
  const retrieval = await retrieve(tenantId, utterance, { topK: 5 });
  const retrievalMs = performance.now() - tRetrieve;

  /* generation */
  const tGen = performance.now();
  const generated = await generateAnswer({
    question: utterance,
    hits: retrieval.hits,
    confidence: retrieval.confidence,
    language,
    agentName: agent.name,
    threshold,
    history,
    persona: agent.persona,
    instructions: agent.instructions,
  });
  const llmMs = performance.now() - tGen;

  /* escalation decisioning */
  const sentiment = sentimentOf(utterance);
  const failedBefore = history.filter(
    (h) => h.role === 'system' && h.text === '__unanswered__',
  ).length;

  let escalate: EscalationReason | null = null;
  if (policy.onExplicitRequest && generated.intent === 'human') escalate = 'explicit_request';
  else if (policy.onLowConfidence && !generated.answered) escalate = 'low_confidence';
  else if (policy.onNegativeSentiment && sentiment <= -0.5) escalate = 'negative_sentiment';
  else if (policy.onRepeatedFailure && !generated.answered && failedBefore + 1 >= policy.maxFailedTurns)
    escalate = 'repeated_failure';
  else if (
    policy.afterHoursAction !== 'answer_anyway' &&
    !isWithinHours(agentHours(agent)) &&
    generated.intent !== 'goodbye'
  )
    escalate = 'after_hours';
  else if (call && call.turns >= agent.max_turns) escalate = 'max_turns';

  // Text-to-speech is measured on the client for browser calls; for telephony
  // legs we model it from the utterance length at a realistic synthesis rate.
  const ttsMs = Math.round(40 + generated.answer.length * 1.15);
  const timings: Timings = {
    sttMs: Math.round(params.sttMs ?? 0),
    retrievalMs: Math.round(retrievalMs),
    llmMs: Math.round(llmMs),
    ttsMs,
    totalMs: Math.round(performance.now() - t0 + (params.sttMs ?? 0) + ttsMs),
  };

  const citations = toCitations(generated.usedHits.length ? generated.usedHits : retrieval.hits.slice(0, 2));
  const ordinal = history.length;

  if (persist) {
    const stamp = now();
    run(
      `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, confidence,
         citations_json, timings_json, latency_ms, created_at)
       VALUES (?,?,?,?, 'caller', ?,?,?,'[]','{}',NULL,?)`,
      id('trn'),
      tenantId,
      callId,
      ordinal,
      utterance,
      language,
      null,
      stamp,
    );
    run(
      `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, confidence,
         citations_json, timings_json, latency_ms, created_at)
       VALUES (?,?,?,?, 'agent', ?,?,?,?,?,?,?)`,
      id('trn'),
      tenantId,
      callId,
      ordinal + 1,
      generated.answer,
      language,
      retrieval.confidence,
      JSON.stringify(citations),
      JSON.stringify(timings),
      timings.totalMs,
      stamp,
    );
    if (!generated.answered) {
      run(
        `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, created_at)
         VALUES (?,?,?,?, 'system', '__unanswered__', ?)`,
        id('trn'),
        tenantId,
        callId,
        ordinal + 2,
        stamp,
      );
      recordGap(tenantId, utterance, retrieval.confidence);
    }

    // The call's headline intent is the first *substantive* one — "greeting"
    // and "goodbye" describe the etiquette, not what the caller wanted.
    const substantive = !['greeting', 'goodbye', 'affirm'].includes(generated.intent);

    run(
      `UPDATE calls SET turns = turns + 1, language=?,
         intent = CASE WHEN ? = 1 AND (intent IS NULL OR intent IN ('greeting','goodbye','affirm'))
                       THEN ? ELSE COALESCE(intent, ?) END,
         confidence=?, sentiment=?, first_response_ms=COALESCE(first_response_ms, ?),
         status = CASE WHEN status='ringing' THEN 'active' ELSE status END,
         answered_at = COALESCE(answered_at, ?)
       WHERE id=?`,
      language,
      substantive ? 1 : 0,
      generated.intent,
      generated.intent,
      retrieval.confidence,
      sentiment,
      timings.totalMs,
      stamp,
      callId,
    );
  }

  let summary: string | undefined;
  if (escalate && persist) {
    const transcript = [...history, { role: 'caller', text: utterance }];
    summary = await summarizeCall(transcript, language, escalate);
    escalateCall(tenantId, callId, escalate, summary, sentiment);
  }

  publish(tenantId, {
    type: 'turn',
    callId,
    reply: generated.answer,
    utterance,
    confidence: retrieval.confidence,
    escalated: Boolean(escalate),
    latencyMs: timings.totalMs,
  });

  return {
    callId,
    reply: generated.answer,
    language,
    intent: generated.intent,
    confidence: retrieval.confidence,
    answered: generated.answered,
    citations,
    timings,
    escalate,
    summary,
    turnOrdinal: ordinal,
    engine: generated.engine || engineName(),
    retrievalDebug: {
      strategy: retrieval.strategy,
      totalChunks: retrieval.totalChunks,
      hits: retrieval.hits.map((h) => ({
        title: h.documentTitle,
        heading: h.heading,
        score: Number(h.score.toFixed(3)),
        lexical: Number(h.lexicalScore.toFixed(3)),
        dense: Number(h.denseScore.toFixed(3)),
      })),
    },
  };
}

/* ── escalation ──────────────────────────────────────────────── */

export function escalateCall(
  tenantId: string,
  callId: string,
  reason: EscalationReason,
  summary: string,
  sentiment = 0,
) {
  const existing = get<{ id: string }>(
    `SELECT id FROM escalations WHERE call_id=? AND status IN ('waiting','assigned')`,
    callId,
  );
  if (existing) return existing.id;

  const priority =
    reason === 'negative_sentiment' || sentiment <= -0.5
      ? 'urgent'
      : reason === 'explicit_request'
        ? 'high'
        : 'normal';

  const escId = id('esc');
  run(
    `INSERT INTO escalations (id, tenant_id, call_id, reason, priority, status, summary, created_at)
     VALUES (?,?,?,?,?, 'waiting', ?, ?)`,
    escId,
    tenantId,
    callId,
    reason,
    priority,
    summary,
    now(),
  );
  run(
    `UPDATE calls SET status='escalating', escalated=1, escalation_reason=?, summary=? WHERE id=?`,
    reason,
    summary,
    callId,
  );
  publish(tenantId, { type: 'escalation', callId, escalationId: escId, reason, priority });
  return escId;
}

export function assignEscalation(tenantId: string, escalationId: string, operatorId: string) {
  const esc = get<{ id: string; call_id: string; created_at: string; status: string }>(
    'SELECT id, call_id, created_at, status FROM escalations WHERE id=? AND tenant_id=?',
    escalationId,
    tenantId,
  );
  if (!esc || esc.status !== 'waiting') return null;
  const waited = Date.now() - new Date(esc.created_at).getTime();
  run(
    `UPDATE escalations SET status='assigned', operator_id=?, assigned_at=?, waited_ms=? WHERE id=?`,
    operatorId,
    now(),
    waited,
    escalationId,
  );
  run(`UPDATE calls SET status='with_operator', operator_id=? WHERE id=?`, operatorId, esc.call_id);
  publish(tenantId, { type: 'escalation_assigned', escalationId, callId: esc.call_id, operatorId });
  return esc.call_id;
}

export function resolveEscalation(
  tenantId: string,
  escalationId: string,
  resolution: string,
  notes = '',
) {
  const esc = get<{ call_id: string; assigned_at: string | null; created_at: string }>(
    'SELECT call_id, assigned_at, created_at FROM escalations WHERE id=? AND tenant_id=?',
    escalationId,
    tenantId,
  );
  if (!esc) return null;
  const handled = Date.now() - new Date(esc.assigned_at ?? esc.created_at).getTime();
  run(
    `UPDATE escalations SET status='resolved', resolution=?, notes=?, resolved_at=?, handled_ms=? WHERE id=?`,
    resolution,
    notes,
    now(),
    handled,
    escalationId,
  );
  publish(tenantId, { type: 'escalation_resolved', escalationId, callId: esc.call_id });
  return esc.call_id;
}
