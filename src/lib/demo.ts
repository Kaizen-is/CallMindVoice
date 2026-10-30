/**
 * The public bank demo (`/demo`): one agent, one fictional borrower, no login.
 *
 * Anyone holding the link can open the page, so everything here is shaped by
 * that:
 *   • the borrower is invented — a real customer's name and debt never reach a
 *     public page, whatever is saved in the agent's "Who to call" card;
 *   • every endpoint is rate-limited per address and in total, because each turn
 *     spends real STT, LLM and TTS capacity;
 *   • demo minutes are never drawn from the tenant's wallet;
 *   • the only text that can be voiced is what the agent itself just said.
 *
 * Demo calls are otherwise ordinary calls in the agent's tenant (from "demo"),
 * so every conversation shows up in the console's call log and live board.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { all, get, id, now, run, tx } from '@/lib/db';
import { publish } from '@/lib/engine/bus';
import { startCall } from '@/lib/engine/calls';
import { agentHours, agentTarget } from '@/lib/engine/conversation';
import { classifyIntent, generateAnswer } from '@/lib/llm/provider';
import { detectLanguage } from '@/lib/rag/text';
import { fillerLines } from '@/lib/speech/fillers';
import { transcribe, type Transcript } from '@/lib/speech/stt';
import { cachedPcm, synthesizePcm, synthesizeStream, ttsConfigured, type SynthOptions } from '@/lib/speech/tts';
import { VOICES } from '@/lib/catalog';
import type { Agent, CallTarget, Locale } from '@/lib/types';
import { listCustomVoices } from '@/lib/voices';
import type { DemoEvent, DemoLang } from './demo-shared';

export { demoLang, type DemoLang } from './demo-shared';

/* ── who is talking to whom ──────────────────────────────────── */

/** The "Banking theme" agent. DEMO_AGENT_ID points the page at another one. */
const agentId = () => process.env.DEMO_AGENT_ID || 'agt_1qi9jqhzhd7pygpd';

export function demoAgent(): Agent | null {
  return get<Agent>('SELECT * FROM agents WHERE id=?', agentId()) ?? null;
}

/** How the page names the agent and its bank. */
export const DEMO_IDENTITY = {
  agent: { uz: 'Isomiddin', ru: 'Исомиддин' },
  org: { uz: 'Biznesni rivojlantirish banki', ru: 'Банк развития бизнеса' },
} as const;

/** The borrower the visitor plays. */
export const DEMO_PERSONA = {
  name: { uz: 'Aziz Karimov', ru: 'Азиз Каримов' },
  birthYear: '1992',
  loanAmount: "7 800 000 so'm",
} as const;

const DEFAULT_CALL_PROMPT =
  'Siz Biznesni rivojlantirish banki nomidan qoʻngʻiroq qilyapsiz. Mijozga kredit boʻyicha ' +
  'muddati oʻtgan toʻlovni eslating. Agar u toʻliq toʻlay olmasa, summani uch oyga boʻlib ' +
  'toʻlashni taklif qiling. Toʻlovni bank ilovasi orqali yoki istalgan filialda qilish mumkin.';

export function demoTarget(agent: Agent): CallTarget {
  return {
    fullName: DEMO_PERSONA.name.uz,
    birthYear: DEMO_PERSONA.birthYear,
    loanAmount: DEMO_PERSONA.loanAmount,
    // The bank's own call script when it has written one.
    prompt: agentTarget(agent).prompt.trim() || DEFAULT_CALL_PROMPT,
  };
}

/* ── rate limits ─────────────────────────────────────────────── */

const WINDOW_MS = 10 * 60_000;

/**
 * Per address and in total, per ten minutes. A booth's visitors may all share
 * one venue Wi-Fi address, so the per-address limits leave room for a crowd;
 * the totals are what cap the spend.
 */
const LIMITS = { call: [20, 200], turn: [200, 1500], prefetch: [300, 2000] } as const;

/**
 * Process-wide state. Each route is its own bundle, so plain module variables
 * would give the page and every API route a private copy; pinning them to
 * globalThis gives the whole server one.
 */
const state = ((globalThis as Record<string, unknown>).__callmindDemo ??= {}) as {
  hits?: Map<string, number[]>;
  busy?: Set<string>;
  openings?: Map<string, Promise<string>>;
  warmed?: Set<string>;
  /** How many fillers each call has heard, to rotate through the lines. */
  fillers?: Map<string, number>;
  heard?: Map<string, Prefetched>;
};
// Field by field, so a server that reloads this module keeps working.
const hits = (state.hits ??= new Map<string, number[]>());
const busy = (state.busy ??= new Set<string>());
const openings = (state.openings ??= new Map<string, Promise<string>>());
const warmed = (state.warmed ??= new Set<string>());
const fillers = (state.fillers ??= new Map<string, number>());
const heard = (state.heard ??= new Map<string, Prefetched>());

function recent(key: string, at: number): number[] {
  const list = (hits.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
  hits.set(key, list);
  return list;
}

function clientAddress(request: Request): string {
  // nginx sits in front and sets X-Forwarded-For; its first hop is the visitor.
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'direct';
}

/** Count one request of this kind, or refuse it when a limit is reached. */
export function admit(kind: keyof typeof LIMITS, request: Request): boolean {
  const at = Date.now();
  const [perAddress, total] = LIMITS[kind];
  const keys = [
    [`${kind}:${clientAddress(request)}`, perAddress],
    [`${kind}:*`, total],
  ] as const;
  if (keys.some(([key, max]) => recent(key, at).length >= max)) return false;
  for (const [key] of keys) recent(key, at).push(at);
  if (hits.size > 5000) for (const [key, list] of hits) if (!list.some((t) => at - t < WINDOW_MS)) hits.delete(key);
  return true;
}

/* ── call lifecycle ──────────────────────────────────────────── */

const MAX_TURNS = 40;
const MAX_AGE_MS = 30 * 60_000;
/** A demo call nobody has spoken on for this long was left open in a closed tab. */
const IDLE_MS = 10 * 60_000;

interface DemoCallRow {
  id: string;
  tenant_id: string;
  turns: number;
  started_at: string;
  ended_at: string | null;
}

function findDemoCall(callId: string): DemoCallRow | undefined {
  return get<DemoCallRow>(
    `SELECT id, tenant_id, turns, started_at, ended_at FROM calls
     WHERE id=? AND agent_id=? AND from_e164='demo'`,
    callId,
    agentId(),
  );
}

export function openDemoCall(agent: Agent, lang: DemoLang): string {
  const cutoff = new Date(Date.now() - IDLE_MS).toISOString();
  const abandoned = all<{ id: string }>(
    `SELECT c.id FROM calls c
     WHERE c.agent_id=? AND c.from_e164='demo' AND c.ended_at IS NULL
       AND COALESCE((SELECT MAX(t.created_at) FROM turns t WHERE t.call_id=c.id), c.started_at) < ?`,
    agent.id,
    cutoff,
  );
  for (const call of abandoned) closeDemoCall(call.id, 'abandoned');

  return startCall({
    tenantId: agent.tenant_id,
    agentId: agent.id,
    from: 'demo',
    to: 'demo',
    callerName: 'Demo',
    channel: 'web',
    direction: 'outbound',
    language: lang,
  });
}

/** A demo call that may take another turn, or null once it is over. */
export function liveDemoCall(callId: string): DemoCallRow | null {
  const call = findDemoCall(callId);
  if (!call || call.ended_at) return null;
  if (call.turns >= MAX_TURNS || Date.now() - Date.parse(call.started_at) > MAX_AGE_MS) {
    closeDemoCall(callId);
    return null;
  }
  return call;
}

/** End a demo call. Unlike `endCall`, nothing is billed: demo minutes are free. */
export function closeDemoCall(
  callId: string,
  outcome: 'resolved_by_ai' | 'resolved_by_operator' | 'abandoned' = 'resolved_by_ai',
) {
  const call = findDemoCall(callId);
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

/** One turn at a time per call: two in flight would interleave the transcript. */
export function claimCall(callId: string): boolean {
  if (busy.has(callId)) return false;
  busy.add(callId);
  return true;
}

export function releaseCall(callId: string) {
  busy.delete(callId);
}

/* ── the opening line ────────────────────────────────────────── */

/** What the visitor "says" on picking up — the caller's side of a real call. */
const PICKUP: Record<DemoLang, string> = { uz: 'Allo', ru: 'Алло' };

const FALLBACK_OPENING: Record<DemoLang, string> = {
  uz:
    `Assalomu alaykum! ${DEMO_IDENTITY.org.uz}dan qoʻngʻiroq qilyapman. ` +
    `${DEMO_PERSONA.name.uz} bilan gaplashyapmanmi? Iltimos, tugʻilgan yilingizni ayting.`,
  // The name is declined here ("с Азизом Каримовым"), so it is not interpolated.
  ru:
    `Здравствуйте! Вас беспокоит ${DEMO_IDENTITY.org.ru}. ` +
    'Я говорю с Азизом Каримовым? Пожалуйста, назовите год вашего рождения.',
};

function openingKey(agent: Agent, lang: DemoLang) {
  // Today's date is part of the loan-call prompt, so the opening can change daily.
  return `${agent.id}:${agent.updated_at}:${lang}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * The agent's first line once the visitor picks up. Generated by the model once
 * and then reused, so picking up is instant instead of a model round-trip —
 * and its audio, rendered once, comes straight from the TTS disk cache.
 */
export function openingLine(agent: Agent, lang: DemoLang): Promise<string> {
  const key = openingKey(agent, lang);
  const cached = openings.get(key);
  if (cached) return cached;

  const line = generateAnswer({
    question: PICKUP[lang],
    hits: [],
    confidence: 0,
    language: lang,
    agentName: agent.name,
    threshold: agent.confidence_threshold,
    history: [],
    persona: agent.persona,
    instructions: agent.instructions,
    target: demoTarget(agent),
    greeting: agent.greeting,
    timeZone: agentHours(agent).timezone,
  }).then((out) => {
    // The local engine is the no-model fallback and knows nothing of the
    // borrower: use a fixed line this time, and ask the model again next call.
    if (out.engine === 'local') {
      openings.delete(key);
      return FALLBACK_OPENING[lang];
    }
    return out.answer;
  });
  openings.set(key, line);
  line.catch(() => openings.delete(key));
  return line;
}

/** Record the pickup and the opening as the call's first exchange, as `runTurn` would. */
export function seedOpening(agent: Agent, callId: string, lang: DemoLang, text: string) {
  const stamp = now();
  tx(() => {
    run(
      `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
       VALUES (?,?,?,0,'caller',?,?,?)`,
      id('trn'),
      agent.tenant_id,
      callId,
      PICKUP[lang],
      lang,
      stamp,
    );
    run(
      `INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
       VALUES (?,?,?,1,'agent',?,?,?)`,
      id('trn'),
      agent.tenant_id,
      callId,
      text,
      lang,
      stamp,
    );
    run(
      `UPDATE calls SET turns = turns + 1, language=?,
         status = CASE WHEN status='ringing' THEN 'active' ELSE status END,
         answered_at = COALESCE(answered_at, ?)
       WHERE id=?`,
      lang,
      stamp,
      callId,
    );
  });
  publish(agent.tenant_id, {
    type: 'turn',
    callId,
    utterance: PICKUP[lang],
    reply: text,
    confidence: 1,
    escalated: false,
    latencyMs: 0,
  });
}

/* ── the agent's voice ───────────────────────────────────────── */

export interface DemoVoice {
  id: string;
  name: string;
  group: 'builtin' | 'clone' | 'design';
}

/** Voices a visitor may pick: the built-in speakers plus the bank's own saved voices. */
export function demoVoices(agent: Agent): DemoVoice[] {
  return [
    ...VOICES.map((v) => ({ id: v.id, name: v.name, group: 'builtin' as const })),
    ...listCustomVoices(agent.tenant_id).map((v) => ({ id: v.id, name: v.name, group: v.mode })),
  ];
}

/**
 * The voice a request asked for, when it is one of `demoVoices`; otherwise the
 * agent's own. The id arrives from a public page, so it is checked against the
 * list rather than handed to the TTS layer as-is.
 */
export function demoVoice(agent: Agent, requested: unknown): string {
  const id = typeof requested === 'string' ? requested.trim() : '';
  return id && demoVoices(agent).some((v) => v.id === id) ? id : agent.voice_id;
}

function voiceOptions(agent: Agent, lang: Locale, voiceId = agent.voice_id): SynthOptions {
  // Cached: in a scripted call the same sentences recur ("Tasdiqlaganingiz
  // uchun rahmat."), and a cache hit is a file read instead of a render.
  return { tenantId: agent.tenant_id, voiceId, language: lang, tag: 'demo', cache: true };
}

/**
 * Render both openings ahead of the first visitor, so even their pickup is
 * instant. One language after the other: rendering both at once would crowd
 * the TTS server just as a visitor might be picking up.
 */
export function warmDemo(agent: Agent) {
  const pending = (['uz', 'ru'] as const).filter((lang) => !warmed.has(openingKey(agent, lang)));
  if (!pending.length) return;
  for (const lang of pending) warmed.add(openingKey(agent, lang));
  void (async () => {
    for (const lang of pending) {
      try {
        const text = await openingLine(agent, lang);
        if (!ttsConfigured()) continue;
        for await (const pcm of synthesizeStream(text, voiceOptions(agent, lang))) void pcm;
      } catch (err) {
        warmed.delete(openingKey(agent, lang));
        console.warn('[demo] warm-up failed:', err instanceof Error ? err.message : err);
      }
    }
    // Then the fillers, which are only ever played from the cache.
    for (const lang of pending) {
      for (const line of fillerLines(lang)) {
        await synthesizePcm(line, voiceOptions(agent, lang)).catch(() => null);
      }
    }
  })();
}

/** Turns where "let me check" would be absurd: hello, yes, thanks, goodbye. */
const NO_FILLER = new Set(['greeting', 'goodbye', 'affirm', 'human']);

/**
 * A short "bir daqiqa" while the agent thinks. Without one the line goes quiet
 * for the seconds the model and the voice take, and on a call silence sounds
 * like a dropped line. Lines rotate so none repeats back to back, and only a
 * cached rendering is ever used: rendering one now would queue in front of the
 * real answer on the TTS server, which works one request at a time.
 */
export function fillerFor(agent: Agent, callId: string, heard: string, voiceId = agent.voice_id): string | null {
  if (!ttsConfigured() || NO_FILLER.has(classifyIntent(heard))) return null;
  const language = detectLanguage(heard) as Locale;
  const lines = fillerLines(language);
  const turn = fillers.get(callId) ?? 0;
  // Fillers are pre-rendered in the agent's own voice only; a visitor's other
  // pick simply gets no filler rather than a mismatched one.
  const pcm = cachedPcm(lines[turn % lines.length], voiceOptions(agent, language, voiceId));
  if (!pcm) return null;
  fillers.set(callId, turn + 1);
  if (fillers.size > 2000) fillers.clear();
  return pcm.toString('base64');
}

/* ── the wire format (see `./demo-shared`) ─────────────────── */

type Send = (event: DemoEvent) => void;

export function eventStream(work: (send: Send, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (event) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await work(send, abort.signal);
      } catch (err) {
        console.warn('[demo] request failed:', err instanceof Error ? err.message : err);
        send({ t: 'error', code: 'server' });
      } finally {
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      // The visitor hung up or talked over the agent: stop rendering its voice.
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // nginx buffers proxied responses by default, which would hold every
      // sentence of audio back until the last one had rendered.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Stream the agent's voice for `text`, sentence by sentence. */
export async function speak(
  agent: Agent,
  text: string,
  lang: Locale,
  send: Send,
  signal: AbortSignal,
  voiceId = agent.voice_id,
) {
  if (!ttsConfigured()) {
    send({ t: 'voice', ok: false });
    return;
  }
  let sent = 0;
  try {
    for await (const pcm of synthesizeStream(text, voiceOptions(agent, lang, voiceId))) {
      if (signal.aborted) break;
      send({ t: 'audio', pcm: pcm.toString('base64') });
      sent += 1;
    }
  } catch (err) {
    console.warn('[demo] tts failed:', err instanceof Error ? err.message : err);
  }
  // Nothing rendered: the browser speaks the line itself rather than go silent.
  if (!sent && !signal.aborted) send({ t: 'voice', ok: false });
}

/**
 * Voice a reply while the model is still writing it. Each complete sentence
 * goes to the TTS as soon as the voice is free, so the visitor hears the first
 * one while the rest is generated. The text shown grows with what is voiced:
 * `reply` with the first sentence, then `more` with each next one.
 */
export function speakAsWritten(
  agent: Agent,
  lang: Locale,
  send: Send,
  signal: AbortSignal,
  voiceId = agent.voice_id,
) {
  let text = '';
  let taken = 0; // how much of `text` has been handed to the voice
  let finished = false;
  let shown = false;
  let sent = 0;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };

  /** The next run of complete sentences, or null to wait for more text. */
  const nextSegment = (): string | null => {
    const rest = text.slice(taken);
    if (finished) {
      taken = text.length;
      return rest.trim() || null;
    }
    const ends = [...rest.matchAll(/[.!?…]+(?=\s)/g)];
    const last = ends[ends.length - 1];
    if (!last) return null;
    const cut = last.index + last[0].length;
    // A lone "Ha." sounds clipped on its own; it waits for the next sentence.
    if (rest.slice(0, cut).trim().length < 12) return null;
    taken += cut;
    return rest.slice(0, cut).trim();
  };

  const worker = (async () => {
    for (;;) {
      if (signal.aborted) return;
      const segment = nextSegment();
      if (!segment) {
        if (finished) return;
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      const said = text.slice(0, taken).trim();
      send(shown ? { t: 'more', text: said } : { t: 'reply', text: said, lang, end: null });
      shown = true;
      if (!ttsConfigured()) continue;
      try {
        for await (const pcm of synthesizeStream(segment, voiceOptions(agent, lang, voiceId))) {
          if (signal.aborted) break;
          send({ t: 'audio', pcm: pcm.toString('base64') });
          sent += 1;
        }
      } catch (err) {
        console.warn('[demo] tts failed:', err instanceof Error ? err.message : err);
      }
    }
  })();

  return {
    push(delta: string) {
      if (finished) return;
      text = taken ? text + delta : (text + delta).trimStart();
      notify();
    },
    /** The reply is complete; resolves once all of it has been voiced. */
    async finish(reply: string) {
      // The final reply begins with what streamed (see `generateAnswer`); when
      // nothing streamed it is the whole reply, voiced the old way.
      if (!text.trim() || reply.startsWith(text.trimEnd())) text = reply;
      finished = true;
      notify();
      await worker;
      if (!sent && shown && !signal.aborted) send({ t: 'voice', ok: false });
    },
  };
}

/* ── transcribing during the pause ───────────────────────────── */

interface Prefetched {
  key: string;
  at: number;
  transcript: Promise<Transcript>;
}

const PREFETCH_TTL_MS = 20_000;

function audioKey(audio: ArrayBuffer, lang: DemoLang): string {
  return `${lang}:${createHash('sha1').update(Buffer.from(audio)).digest('hex')}`;
}

/**
 * Start transcribing an utterance the page offered at an early pause (see
 * EARLY_SILENCE_MS). If the pause holds, the turn arrives with the same bytes
 * and picks the transcript up — already done, or well under way.
 */
export function prefetchHeard(callId: string, audio: ArrayBuffer, lang: DemoLang) {
  const transcript = transcribe(audio, { language: lang, denoise: true });
  transcript.catch(() => {}); // a failure is retried by the turn itself
  heard.set(callId, { key: audioKey(audio, lang), at: Date.now(), transcript });
  if (heard.size > 500) {
    const stale = Date.now() - PREFETCH_TTL_MS;
    for (const [id, entry] of heard) if (entry.at < stale) heard.delete(id);
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
  return transcribe(audio, { language: lang, denoise: true });
}
