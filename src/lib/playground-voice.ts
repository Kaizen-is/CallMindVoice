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
import { fillerLines, fillersEnabled } from '@/lib/speech/fillers';
import { isSttEngine, transcribe, type SttEngine, type Transcript } from '@/lib/speech/stt';
import { ELEVEN_VOICES } from '@/lib/speech/speko';
import {
  cachedPcm,
  isTtsEngine,
  outputRate,
  SAMPLE_RATE,
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
  // Our BRB model has a single voice.
  if (tts === 'brb') return { engine: tts, voiceId: '' };
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

/**
 * The Playground call plays in a browser, not down a phone line: models that
 * render more than 8 kHz (BRB, ElevenLabs) are asked for 24 kHz, which keeps
 * s, sh, f and t clear. Our own TTS server only makes 8 kHz and ignores this.
 */
const WEB_RATE = 24000;

function synthOptions(agent: Agent, lang: Locale, pick: VoicePick, quickStart = false): SynthOptions {
  // Cached, like the demo: scripted calls repeat sentences, and a hit is a file read.
  return {
    tenantId: agent.tenant_id,
    voiceId: pick.voiceId,
    language: lang,
    tag: 'pg_call',
    cache: true,
    engine: pick.engine,
    sampleRate: WEB_RATE,
    quickStart,
  };
}

/** The `rate` an audio event carries: only when it is not the phone's 8 kHz, which the page assumes. */
function rateOf(opts: SynthOptions): { rate?: number } {
  const rate = outputRate(opts);
  return rate === SAMPLE_RATE ? {} : { rate };
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
  const opts = synthOptions(agent, lang, pick);
  let sent = 0;
  try {
    for await (const pcm of synthesizeStream(text, opts)) {
      if (signal.aborted) break;
      send({ t: 'audio', pcm: pcm.toString('base64'), ...rateOf(opts) });
      sent += 1;
    }
  } catch (err) {
    console.warn('[playground] tts failed:', err instanceof Error ? err.message : err);
  }
  if (!sent && !signal.aborted) send({ t: 'voice', ok: false });
}

/**
 * How a reply is voiced while it is written. `fast` (the default) is what the
 * latency work added; `fast: false` is the voice as it was before, kept so the
 * Playground can compare the two on the same agent (`?legacy=1`).
 */
export interface SpeakOptions {
  /**
   * The first piece may end at a clause (a comma after four words or more)
   * instead of a whole sentence; the next sentence renders while the current
   * one plays; and the first audio leaves after 0.1 s instead of 0.25 s.
   */
  fast?: boolean;
  /** The first piece of text was handed to the TTS. */
  onFirstSegment?: () => void;
  /** The first audio of the reply was sent. */
  onFirstAudio?: () => void;
}

/** A clause long enough to be said on its own: four words, 25 characters. */
const CLAUSE_MIN_WORDS = 4;
const CLAUSE_MIN_CHARS = 25;

/** One segment being rendered, possibly ahead of the one playing. */
interface Rendering {
  /** How much of the reply had been taken when this segment was cut — what is shown with it. */
  shownUpTo: number;
  chunks(): AsyncGenerator<Buffer, void, unknown>;
}

/**
 * Start rendering `segment` now and keep its audio until it is read. Lets the
 * next sentence render while the one before it is still playing.
 */
function renderAhead(segment: string, opts: SynthOptions, signal: AbortSignal, shownUpTo: number): Rendering {
  const pieces: Buffer[] = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    wake?.();
    wake = null;
  };
  // Talked over: the reader stops at once, not at the next piece of audio.
  signal.addEventListener('abort', poke, { once: true });
  void (async () => {
    try {
      for await (const pcm of synthesizeStream(segment, opts)) {
        if (signal.aborted) break;
        pieces.push(pcm);
        poke();
      }
    } catch (err) {
      failure = err;
    } finally {
      done = true;
      poke();
      signal.removeEventListener('abort', poke);
    }
  })();
  return {
    shownUpTo,
    async *chunks() {
      let read = 0;
      for (;;) {
        if (signal.aborted) return;
        if (read < pieces.length) {
          yield pieces[read++];
          continue;
        }
        if (done) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/**
 * Voice a reply while the model is still writing it — the demo's
 * `speakAsWritten`, with the Playground's engine and voice. Each complete
 * sentence goes to the TTS as soon as the voice is free (with `fast`: the
 * first clause goes at once, and the next sentence is rendered ahead).
 */
export function speakAsWritten(
  agent: Agent,
  lang: Locale,
  pick: VoicePick,
  send: Send,
  signal: AbortSignal,
  options: SpeakOptions = {},
) {
  const fast = options.fast !== false;
  const opts = synthOptions(agent, lang, pick, fast);
  let text = '';
  let taken = 0;
  let finished = false;
  let shown = false;
  let sent = 0;
  let segments = 0;
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
    if (last) {
      const cut = last.index + last[0].length;
      // A lone "Ha." sounds clipped on its own; it waits for the next sentence.
      if (rest.slice(0, cut).trim().length >= 12) {
        taken += cut;
        return rest.slice(0, cut).trim();
      }
    }
    // The very first words: a whole clause is enough to start speaking on.
    if (fast && segments === 0) {
      for (const m of rest.matchAll(/[,;:—–]+(?=\s)/g)) {
        const cut = m.index + m[0].length;
        const piece = rest.slice(0, cut).trim();
        if (piece.length >= CLAUSE_MIN_CHARS && piece.split(/\s+/).length >= CLAUSE_MIN_WORDS) {
          taken += cut;
          return piece;
        }
      }
    }
    return null;
  };

  /** Cut the next segment, if there is one, and start rendering it. */
  const take = (): Rendering | null => {
    const segment = nextSegment();
    if (!segment) return null;
    if (segments === 0) options.onFirstSegment?.();
    segments += 1;
    return canSpeak(pick)
      ? renderAhead(segment, opts, signal, taken)
      : { shownUpTo: taken, chunks: async function* () {} };
  };

  const worker = (async () => {
    let current: Rendering | null = null;
    for (;;) {
      if (signal.aborted) return;
      current ??= take();
      if (!current) {
        if (finished) return;
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      const said = text.slice(0, current.shownUpTo).trim();
      send(shown ? { t: 'more', text: said } : { t: 'reply', text: said, lang, end: null });
      shown = true;
      let next: Rendering | null = null;
      try {
        for await (const pcm of current.chunks()) {
          if (signal.aborted) break;
          send({ t: 'audio', pcm: pcm.toString('base64'), ...rateOf(opts) });
          if (sent === 0) options.onFirstAudio?.();
          sent += 1;
          // Render the next sentence while this one plays.
          if (fast && !next) next = take();
        }
      } catch (err) {
        console.warn('[playground] tts failed:', err instanceof Error ? err.message : err);
      }
      current = next;
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
  if (!fillersEnabled() || warmed.has(key) || !canSpeak(pick)) return;
  warmed.add(key);
  void (async () => {
    for (const line of fillerLines(lang)) {
      const opts = synthOptions(agent, lang, pick);
      if (!cachedPcm(line, opts)) await synthesizePcm(line, opts).catch(() => null);
    }
  })();
}

/**
 * A cached filler for this turn, as the `filler` event's fields, or null —
 * never rendered now, to keep the line free for the answer.
 */
export function fillerFor(
  agent: Agent,
  callId: string,
  said: string,
  pick: VoicePick,
): { pcm: string; rate?: number } | null {
  if (!fillersEnabled() || !canSpeak(pick) || NO_FILLER.has(classifyIntent(said))) return null;
  const language = detectLanguage(said) as Locale;
  const lines = fillerLines(language);
  const turn = fillers.get(callId) ?? 0;
  const opts = synthOptions(agent, language, pick);
  const pcm = cachedPcm(lines[turn % lines.length], opts);
  if (!pcm) return null;
  fillers.set(callId, turn + 1);
  if (fillers.size > 2000) fillers.clear();
  return { pcm: pcm.toString('base64'), ...rateOf(opts) };
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
