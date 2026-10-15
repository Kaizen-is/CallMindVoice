/**
 * The public logistics demo (`/logistics`): a customer calls a cargo company
 * that delivers from China to Uzbekistan and asks where their parcel is.
 *
 * Built on the bank demo's call engine (`@/lib/demo` — event stream, streamed
 * voice, fillers, per-call lock, rate limits), with three differences:
 *   • Uzbek speech is transcribed by GAPI (`@/lib/speech/gapi`) as recorded,
 *     instead of the internal Kotib model (Russian keeps the app's own path:
 *     GAPI writes Latin-script Uzbek only);
 *   • the visitor is the caller, so the agent answers with a greeting;
 *   • every turn looks the caller's tracking or phone number up in the demo
 *     shipment system (`./logistics-data`) and hands the model only that.
 *
 * It runs in its own tenant and agent, created on first use, so its calls and
 * knowledge never mix with the bank demo's. Demo minutes are never billed.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { all, get, id, now, run } from '@/lib/db';
import { publish } from '@/lib/engine/bus';
import { startCall } from '@/lib/engine/calls';
import { fillerLines } from '@/lib/speech/fillers';
import { gapiTranscribe } from '@/lib/speech/gapi';
import { transcribe, type Transcript } from '@/lib/speech/stt';
import { cachedPcm, synthesizePcm, ttsConfigured } from '@/lib/speech/tts';
import { classifyIntent } from '@/lib/llm/provider';
import { detectLanguage } from '@/lib/rag/text';
import type { Agent, Locale } from '@/lib/types';
import type { DemoLang } from './demo-shared';
import { LOGISTICS_VOCABULARY, logisticsContext, lookupNote } from './logistics-data';

export { TRY_TRACKS } from './logistics-data';

/* ── the demo's own tenant and agent ─────────────────────────── */

const TENANT_ID = 'ten_logistics_demo';
const AGENT_ID = 'agt_logistics_demo';

/** No knowledge-base escalations: every answer comes from the shipment system. */
const ESCALATION = {
  onLowConfidence: false,
  onExplicitRequest: true,
  onNegativeSentiment: false,
  onRepeatedFailure: false,
  maxFailedTurns: 2,
  afterHoursAction: 'answer_anyway',
  ringTimeoutSec: 30,
  fallbackNumber: '',
};

/** The demo's agent, created (once, idempotently) the first time it is needed. */
export function logisticsAgent(): Agent {
  const existing = get<Agent>('SELECT * FROM agents WHERE id=?', AGENT_ID);
  if (existing) return existing;
  const stamp = now();
  run(
    `INSERT OR IGNORE INTO tenants (id, name, slug, industry, created_at, updated_at)
     VALUES (?, 'Logistics demo', 'logistics-demo', 'logistics', ?, ?)`,
    TENANT_ID,
    stamp,
    stamp,
  );
  run(
    `INSERT OR IGNORE INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
       languages_json, primary_lang, voice_id, escalation_json, hours_json, tools_json, created_at, updated_at)
     VALUES (?, ?, 'Logistika operatori', 'live', 'friendly', '', '', '', '["uz","ru"]', 'uz', 'isomiddin', ?, '{}', '[]', ?, ?)`,
    AGENT_ID,
    TENANT_ID,
    JSON.stringify(ESCALATION),
    stamp,
    stamp,
  );
  return get<Agent>('SELECT * FROM agents WHERE id=?', AGENT_ID)!;
}

/* ── voices: the two built-in speakers only ──────────────────── */

export const LOGISTICS_VOICES = [
  { id: 'isomiddin', name: 'Isomiddin', group: 'builtin' as const },
  { id: 'laylo', name: 'Laylo', group: 'builtin' as const },
];

export function logisticsVoice(requested: unknown): string {
  return LOGISTICS_VOICES.some((v) => v.id === requested) ? (requested as string) : 'isomiddin';
}

/** The agent introduces itself by the name of the voice it speaks with. */
export function voiceName(voiceId: string): string {
  return LOGISTICS_VOICES.find((v) => v.id === voiceId)?.name ?? 'Isomiddin';
}

/** The system-prompt part for one turn, from everything the caller has said. */
export function turnContext(voiceId: string) {
  return (callerLines: string[]) => ({
    facts: logisticsContext(callerLines, voiceName(voiceId)),
    note: lookupNote(callerLines),
  });
}

/* ── call lifecycle (mirrors the bank demo; never billed) ────── */

const MAX_TURNS = 40;
const MAX_AGE_MS = 30 * 60_000;
const IDLE_MS = 10 * 60_000;

interface LogisticsCallRow {
  id: string;
  tenant_id: string;
  turns: number;
  started_at: string;
  ended_at: string | null;
}

function findCall(callId: string): LogisticsCallRow | undefined {
  return get<LogisticsCallRow>(
    `SELECT id, tenant_id, turns, started_at, ended_at FROM calls
     WHERE id=? AND agent_id=? AND from_e164='logistics'`,
    callId,
    AGENT_ID,
  );
}

export function openLogisticsCall(agent: Agent, lang: DemoLang): string {
  const cutoff = new Date(Date.now() - IDLE_MS).toISOString();
  const abandoned = all<{ id: string }>(
    `SELECT c.id FROM calls c
     WHERE c.agent_id=? AND c.from_e164='logistics' AND c.ended_at IS NULL
       AND COALESCE((SELECT MAX(t.created_at) FROM turns t WHERE t.call_id=c.id), c.started_at) < ?`,
    agent.id,
    cutoff,
  );
  for (const call of abandoned) closeLogisticsCall(call.id, 'abandoned');

  return startCall({
    tenantId: agent.tenant_id,
    agentId: agent.id,
    from: 'logistics',
    to: 'logistics',
    callerName: 'Logistics demo',
    channel: 'web',
    direction: 'inbound',
    language: lang,
  });
}

export function liveLogisticsCall(callId: string): LogisticsCallRow | null {
  const call = findCall(callId);
  if (!call || call.ended_at) return null;
  if (call.turns >= MAX_TURNS || Date.now() - Date.parse(call.started_at) > MAX_AGE_MS) {
    closeLogisticsCall(callId);
    return null;
  }
  return call;
}

/** End a logistics demo call. Nothing is billed: demo minutes are free. */
export function closeLogisticsCall(
  callId: string,
  outcome: 'resolved_by_ai' | 'resolved_by_operator' | 'abandoned' = 'resolved_by_ai',
) {
  const call = findCall(callId);
  if (!call || call.ended_at) return;
  const last = get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM turns WHERE call_id=?', callId)?.at;
  const endedAt = last ?? now();
  const durationMs = Math.max(1000, Date.parse(endedAt) - Date.parse(call.started_at));
  run(
    `UPDATE calls SET status='completed', outcome=?, ended_at=?, duration_ms=? WHERE id=? AND ended_at IS NULL`,
    outcome,
    endedAt,
    durationMs,
    callId,
  );
  publish(call.tenant_id, { type: 'call_ended', callId, outcome, durationMs, csat: null });
}

/* ── the greeting ────────────────────────────────────────────── */

/** The visitor rings the company, so the agent answers — no model call needed. */
export function greetingFor(lang: DemoLang, voiceId: string): string {
  const name = voiceName(voiceId);
  return lang === 'ru'
    ? `Здравствуйте! Служба доставки, меня зовут ${name}. Подскажите номер отслеживания или номер телефона, и я проверю, где ваш груз.`
    : `Assalomu alaykum! Yetkazib berish xizmati, men ${name}. Track raqamingizni yoki telefon raqamingizni ayting, yukingiz qayerdaligini tekshirib beraman.`;
}

/** Record the greeting as the call's first line, so the model knows it was said. */
export function seedGreeting(agent: Agent, callId: string, lang: DemoLang, text: string) {
  const stamp = now();
  run(
    `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
     VALUES (?,?,?,0,'agent',?,?,?)`,
    id('trn'),
    agent.tenant_id,
    callId,
    text,
    lang,
    stamp,
  );
  run(
    `UPDATE calls SET language=?, status = CASE WHEN status='ringing' THEN 'active' ELSE status END,
       answered_at = COALESCE(answered_at, ?) WHERE id=?`,
    lang,
    stamp,
    callId,
  );
  publish(agent.tenant_id, { type: 'turn', callId, utterance: '', reply: text, confidence: 1, escalated: false, latencyMs: 0 });
}

/* ── warming: greetings and fillers in both voices ───────────── */

const state = ((globalThis as Record<string, unknown>).__callmindLogistics ??= {}) as {
  warmed?: boolean;
  heard?: Map<string, { key: string; at: number; transcript: Promise<Transcript> }>;
};
const heard = (state.heard ??= new Map());

export function voiceOptions(agent: Agent, lang: DemoLang, voiceId: string) {
  return { tenantId: agent.tenant_id, voiceId, language: lang, tag: 'demo', cache: true };
}

/** Render the greetings and "bir daqiqa" fillers once, so the first visitor hears them instantly. */
export function warmLogistics(agent: Agent) {
  if (state.warmed || !ttsConfigured()) return;
  state.warmed = true;
  void (async () => {
    for (const voice of LOGISTICS_VOICES) {
      for (const lang of ['uz', 'ru'] as const) {
        const opts = voiceOptions(agent, lang, voice.id);
        for (const line of [greetingFor(lang, voice.id), ...fillerLines(lang)]) {
          if (!cachedPcm(line, opts)) await synthesizePcm(line, opts).catch(() => null);
        }
      }
    }
  })();
}

/* ── the "bir daqiqa" while the agent thinks ─────────────────── */

const fillerTurns = new Map<string, number>();

/**
 * A pre-rendered filler for this turn, or null. Like the bank demo's, except
 * a greeting that carries a number still gets one: callers open with
 * "Assalomu alaykum, track raqamim …", and that is exactly the turn that has
 * work to do — skipping the filler there left seconds of silence.
 */
export function logisticsFiller(agent: Agent, callId: string, heard: string, voiceId: string): string | null {
  if (!ttsConfigured()) return null;
  const intent = classifyIntent(heard);
  const hasNumber = /\d|\b(bir|ikki|uch|to'rt|besh|olti|yetti|sakkiz|to'qqiz|o'n|yigirma|qirq|ellik|yuz|ming)\b/i.test(
    heard.replace(/[‘’ʻʼ`]/g, "'"),
  );
  if (intent === 'goodbye' || intent === 'affirm' || intent === 'human' || (intent === 'greeting' && !hasNumber)) {
    return null;
  }
  const lang = (detectLanguage(heard) === 'ru' ? 'ru' : 'uz') as DemoLang;
  const lines = fillerLines(lang as Locale);
  const turn = fillerTurns.get(callId) ?? 0;
  const pcm = cachedPcm(lines[turn % lines.length], voiceOptions(agent, lang, voiceId));
  if (!pcm) return null;
  fillerTurns.set(callId, turn + 1);
  if (fillerTurns.size > 2000) fillerTurns.clear();
  return pcm.toString('base64');
}

/* ── transcribing (GAPI), also during the pause ─────────────── */

const PREFETCH_TTL_MS = 20_000;

function audioKey(audio: ArrayBuffer, lang: DemoLang): string {
  return `${lang}:${createHash('sha1').update(Buffer.from(audio)).digest('hex')}`;
}

/**
 * Uzbek goes to GAPI, as recorded — no noise cleaning: on these calls the
 * cleaner made GAPI's transcripts worse, not better. GAPI writes Latin-script
 * Uzbek only ("no Cyrillic on output"), so a Russian call uses the app's own
 * Russian path, as /demo does.
 */
function transcribeLogistics(audio: ArrayBuffer, lang: DemoLang): Promise<Transcript> {
  return lang === 'ru'
    ? transcribe(audio, { language: 'ru' })
    : gapiTranscribe(audio, { language: lang, vocabulary: LOGISTICS_VOCABULARY });
}

/** Start transcribing at an early pause; the turn that follows picks it up if the audio matches. */
export function prefetchHeard(callId: string, audio: ArrayBuffer, lang: DemoLang) {
  const transcript = transcribeLogistics(audio, lang);
  transcript.catch(() => {});
  heard.set(callId, { key: audioKey(audio, lang), at: Date.now(), transcript });
  if (heard.size > 500) {
    const stale = Date.now() - PREFETCH_TTL_MS;
    for (const [callKey, entry] of heard) if (entry.at < stale) heard.delete(callKey);
  }
}

/** What the visitor said: the prefetched transcript when it matches, else a fresh one. */
export async function heardIn(callId: string, audio: ArrayBuffer, lang: DemoLang): Promise<Transcript> {
  const entry = heard.get(callId);
  heard.delete(callId);
  if (entry && entry.key === audioKey(audio, lang) && Date.now() - entry.at < PREFETCH_TTL_MS) {
    try {
      return await entry.transcript;
    } catch {
      /* transcribe again below */
    }
  }
  return transcribeLogistics(audio, lang);
}
