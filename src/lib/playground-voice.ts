/**
 * The Playground's real-time voice call, on the public demo's architecture
 * (`@/lib/demo`): one streamed response per turn carries what the STT heard,
 * the reply as the model writes it, and the reply's voice sentence by
 * sentence — with the phrase transcribed during the caller's pause, a cached
 * "bir daqiqa" while the agent thinks, and the caller free to talk over it.
 *
 * What differs from /demo is whose call it is: a signed-in team testing its own
 * agent, with the STT and TTS engines and the voice it picked in the
 * Playground. So the voice helpers here take those choices as arguments; the
 * demo's own copies (fixed to the agent's voice and the default engines) are
 * left exactly as they are.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { classifyIntent } from '@/lib/llm/provider';
import { detectLanguage } from '@/lib/rag/text';
import { fillerLines } from '@/lib/speech/fillers';
import { isSttEngine, transcribe, type SttEngine, type Transcript } from '@/lib/speech/stt';
import { ELEVEN_VOICES } from '@/lib/speech/speko';
import {
  cachedPcm,
  isTtsEngine,
  synthesizePcm,
  synthesizeStream,
  ttsConfigured,
  type SynthOptions,
  type TtsEngine,
} from '@/lib/speech/tts';
import { VOICES } from '@/lib/catalog';
import { agentTarget } from '@/lib/engine/conversation';
import type { Agent, Locale } from '@/lib/types';
import { listCustomVoices } from '@/lib/voices';
import { callVoice } from '@/lib/playground';
import type { CallEvent } from '@/lib/playground-shared';

export type Send = (event: CallEvent) => void;

/* ── the wire format: newline-delimited JSON, as the demo's ──── */

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
        console.warn('[playground] call request failed:', err instanceof Error ? err.message : err);
        send({ t: 'error', code: 'server' });
      } finally {
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      // Hung up or talked over: stop rendering the agent's voice.
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // nginx would otherwise hold every sentence back until the last rendered.
      'X-Accel-Buffering': 'no',
    },
  });
}

/* ── the engines and voice the Playground picked ─────────────── */

export interface VoicePick {
  engine: TtsEngine;
  voiceId: string;
}

/** The TTS engine and voice asked for, checked against what this deployment and tenant have. */
export function voicePick(agent: Agent, engine: unknown, voice: unknown): VoicePick {
  const tts: TtsEngine = isTtsEngine(engine) && ttsConfigured(engine) ? engine : 'default';
  if (tts === 'default') return { engine: tts, voiceId: callVoice(agent, voice) };
  const want = typeof voice === 'string' && voice ? voice : agent.tts_voice_id;
  return { engine: tts, voiceId: ELEVEN_VOICES.some((v) => v.id === want) ? want : ELEVEN_VOICES[0].id };
}

/** A voice's display name: built-in speaker, ElevenLabs voice or the tenant's own. */
function voiceName(agent: Agent, voiceId: string): string | null {
  return (
    VOICES.find((v) => v.id === voiceId)?.name ??
    ELEVEN_VOICES.find((v) => v.id === voiceId)?.name ??
    listCustomVoices(agent.tenant_id).find((v) => v.id === voiceId)?.name ??
    null
  );
}

/**
 * The agent as this call presents it. An agent that makes the call (a "Who to
 * call" person, like the banking agent) introduces itself by name — and the
 * name should be the voice the caller hears: with Nadya's voice it says "Men …
 * Nadyaman", not Isomiddin. So for such an agent the name in the system prompt
 * and in its greeting becomes the picked voice's name, for this call only; the
 * saved agent is unchanged. A receptionist keeps its own name.
 */
export function speakingAgent(agent: Agent, pick: VoicePick): Agent {
  if (!agentTarget(agent).fullName) return agent;
  const spoken = voiceName(agent, pick.voiceId);
  if (!spoken) return agent;
  const own = voiceName(agent, agent.voice_id);
  const greeting = own && own !== spoken ? agent.greeting.split(own).join(spoken) : agent.greeting;
  return { ...agent, name: spoken, greeting };
}

export function sttPick(value: unknown): SttEngine {
  return isSttEngine(value) ? value : 'auto';
}

function synthOptions(agent: Agent, lang: Locale, pick: VoicePick): SynthOptions {
  // Cached, like the demo: scripted calls repeat sentences, and a hit is a file read.
  return { tenantId: agent.tenant_id, voiceId: pick.voiceId, language: lang, tag: 'pg_call', cache: true, engine: pick.engine };
}

function canSpeak(pick: VoicePick): boolean {
  return ttsConfigured(pick.engine);
}

/* ── one turn at a time per call ─────────────────────────────── */

const state = ((globalThis as Record<string, unknown>).__callmindPlaygroundVoice ??= {}) as {
  busy?: Set<string>;
  fillers?: Map<string, number>;
  heard?: Map<string, { key: string; at: number; transcript: Promise<Transcript> }>;
  warmed?: Set<string>;
};
const busy = (state.busy ??= new Set<string>());
const fillers = (state.fillers ??= new Map<string, number>());
const heard = (state.heard ??= new Map());
const warmed = (state.warmed ??= new Set<string>());

/** Two turns in flight would interleave the transcript. */
export function claimCall(callId: string): boolean {
  if (busy.has(callId)) return false;
  busy.add(callId);
  return true;
}

export function releaseCall(callId: string) {
  busy.delete(callId);
}

/* ── the agent's voice ───────────────────────────────────────── */

/** Stream the agent's voice for `text`, sentence by sentence. */
export async function speak(agent: Agent, text: string, lang: Locale, pick: VoicePick, send: Send, signal: AbortSignal) {
  if (!canSpeak(pick)) {
    send({ t: 'voice', ok: false });
    return;
  }
  let sent = 0;
  try {
    for await (const pcm of synthesizeStream(text, synthOptions(agent, lang, pick))) {
      if (signal.aborted) break;
      send({ t: 'audio', pcm: pcm.toString('base64') });
      sent += 1;
    }
  } catch (err) {
    console.warn('[playground] tts failed:', err instanceof Error ? err.message : err);
  }
  if (!sent && !signal.aborted) send({ t: 'voice', ok: false });
}

/**
 * Voice a reply while the model is still writing it — the demo's
 * `speakAsWritten`, with the Playground's engine and voice. Each complete
 * sentence goes to the TTS as soon as the voice is free.
 */
export function speakAsWritten(agent: Agent, lang: Locale, pick: VoicePick, send: Send, signal: AbortSignal) {
  let text = '';
  let taken = 0;
  let finished = false;
  let shown = false;
  let sent = 0;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };

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
      if (!canSpeak(pick)) continue;
      try {
        for await (const pcm of synthesizeStream(segment, synthOptions(agent, lang, pick))) {
          if (signal.aborted) break;
          send({ t: 'audio', pcm: pcm.toString('base64') });
          sent += 1;
        }
      } catch (err) {
        console.warn('[playground] tts failed:', err instanceof Error ? err.message : err);
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
      if (!text.trim() || reply.startsWith(text.trimEnd())) text = reply;
      finished = true;
      notify();
      await worker;
      if (!sent && shown && !signal.aborted) send({ t: 'voice', ok: false });
    },
  };
}

/* ── "bir daqiqa" while the agent thinks ─────────────────────── */

/** Turns where "let me check" would be absurd: hello, yes, thanks, goodbye. */
const NO_FILLER = new Set(['greeting', 'goodbye', 'affirm', 'human']);

/**
 * Render the filler lines in the picked engine and voice once, in the
 * background, so turns can play them from the cache. Called when a call opens.
 */
export function warmFillers(agent: Agent, lang: Locale, pick: VoicePick) {
  const key = `${agent.tenant_id}:${pick.engine}:${pick.voiceId}:${lang}`;
  if (warmed.has(key) || !canSpeak(pick)) return;
  warmed.add(key);
  void (async () => {
    for (const line of fillerLines(lang)) {
      const opts = synthOptions(agent, lang, pick);
      if (!cachedPcm(line, opts)) await synthesizePcm(line, opts).catch(() => null);
    }
  })();
}

/** A cached filler for this turn, or null — never rendered now, to keep the line free for the answer. */
export function fillerFor(agent: Agent, callId: string, said: string, pick: VoicePick): string | null {
  if (!canSpeak(pick) || NO_FILLER.has(classifyIntent(said))) return null;
  const language = detectLanguage(said) as Locale;
  const lines = fillerLines(language);
  const turn = fillers.get(callId) ?? 0;
  const pcm = cachedPcm(lines[turn % lines.length], synthOptions(agent, language, pick));
  if (!pcm) return null;
  fillers.set(callId, turn + 1);
  if (fillers.size > 2000) fillers.clear();
  return pcm.toString('base64');
}

/* ── transcribing during the pause ───────────────────────────── */

const PREFETCH_TTL_MS = 20_000;

function audioKey(audio: ArrayBuffer, lang: Locale, engine: SttEngine): string {
  return `${engine}:${lang}:${createHash('sha1').update(Buffer.from(audio)).digest('hex')}`;
}

/** Start transcribing a phrase the page offered at an early pause. */
export function prefetchHeard(callId: string, audio: ArrayBuffer, lang: Locale, engine: SttEngine) {
  const transcript = transcribe(audio, { language: lang, denoise: true, engine });
  transcript.catch(() => {}); // a failure is retried by the turn itself
  heard.set(callId, { key: audioKey(audio, lang, engine), at: Date.now(), transcript });
  if (heard.size > 500) {
    const stale = Date.now() - PREFETCH_TTL_MS;
    for (const [id, entry] of heard) if (entry.at < stale) heard.delete(id);
  }
}

/** What the caller said: the prefetched transcript when it matches, else a fresh one. */
export async function heardIn(callId: string, audio: ArrayBuffer, lang: Locale, engine: SttEngine): Promise<Transcript> {
  const entry = heard.get(callId);
  heard.delete(callId);
  if (entry && entry.key === audioKey(audio, lang, engine) && Date.now() - entry.at < PREFETCH_TTL_MS) {
    try {
      return await entry.transcript;
    } catch {
      /* transcribe again below */
    }
  }
  return transcribe(audio, { language: lang, denoise: true, engine });
}
