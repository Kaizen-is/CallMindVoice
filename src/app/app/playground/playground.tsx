'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  endPlaygroundCallAction,
  listPlaygroundChatsAction,
  loadPlaygroundChatAction,
  playgroundTurnAction,
  type PlaygroundChat,
  type PlaygroundReply,
} from '@/app/actions/agent';
import { translator, type Translate } from '@/lib/i18n';
import type { Locale, UiLocale } from '@/lib/types';
import { cn, fmtLatency } from '@/lib/utils';
import { voiceInputAvailable } from '@/lib/catalog';
import { micSupported, type RecordingResult } from '@/lib/audio';
import { useVoiceSession, type UtteranceTiming, type VoiceState } from '@/hooks/use-voice-session';
import { useLiveTranscript } from '@/hooks/use-live-transcript';
import { decodePcm, speakWithBrowser, VoiceOut } from '@/app/demo/voice-out';
import { IconHandset, IconHangUp } from '@/app/demo/icons';
import { readCallEvents, type TurnDetail } from '@/lib/playground-shared';
import { ModelMenu } from '@/components/ui/model-menu';
import { modelOptions, STT_MODELS, TTS_MODELS, useModelChoice, type SttChoice, type TtsChoice } from './model-picker';
import { ScenarioCard } from './scenario-card';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/primitives';
import { Input, Select } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import {
  IconAlert,
  IconBook,
  IconCheckCircle,
  IconHeadset,
  IconMic,
  IconMicOff,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSparkle,
  IconVolume,
  IconZap,
} from '@/components/icons';
import { TimeAgo } from '@/components/ui/time-ago';

/* ── Web Speech typings (not in lib.dom for all targets) ─────── */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

const SPEECH_LANG: Record<Locale, string> = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-GB' };
const LANG_NAME: Record<Locale, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' };

// Simple client-side unique id for transcript rows, so a reply's stored audio
// can be attached back to the exact message it belongs to.
let _seq = 0;
const nextId = () => `m${Date.now().toString(36)}_${(_seq++).toString(36)}`;

// The chat that was on screen for each agent, so a page refresh reopens it.
const chatKey = (agentId: string) => `callmind.playground.chat.${agentId}`;
function rememberChat(agentId: string, callId: string | null) {
  try {
    if (callId) localStorage.setItem(chatKey(agentId), callId);
    else localStorage.removeItem(chatKey(agentId));
  } catch {
    /* storage unavailable — the history still lives on the server */
  }
}
function rememberedChat(agentId: string): string | null {
  try {
    return localStorage.getItem(chatKey(agentId));
  } catch {
    return null;
  }
}

/* ── streamed playback ──────────────────────────────────────────────────────
   /api/speech/tts streams raw mono PCM with no container (8 kHz, or 24 kHz
   for an ElevenLabs model — the X-Audio-Rate header says which), because a
   container needs its length up front and the whole point is that the length is
   not known yet — the server is still rendering later sentences. `<audio>`
   cannot start on that, so chunks are scheduled through Web Audio instead,
   which also joins sentences on the audio clock rather than by chaining
   elements, so the seams are inaudible. ── */

/** What the server sends when it says nothing else (our own TTS, phone format). */
const TTS_RATE = 8000;
/** What the Playground asks ElevenLabs for: 8 kHz cuts everything above 4 kHz and sounds muffled. */
const WEB_TTS_RATE = 24000;

/** One PCM chunk → an AudioBuffer ready to be scheduled. */
function pcmToAudioBuffer(ctx: AudioContext, pcm: Uint8Array, rate: number = TTS_RATE): AudioBuffer | null {
  const frames = Math.floor(pcm.length / 2);
  if (!frames) return null;
  const buffer = ctx.createBuffer(1, frames, rate);
  const channel = buffer.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

/**
 * One voice turn's clock on the page (`performance.now()`): when the caller
 * really stopped talking, and when the phrase left for the server.
 */
interface TurnClock {
  speechEndedAt: number;
  sentAt: number;
}

/**
 * `?legacy=1` on the Playground's address voices turns the way they were
 * before the latency work, to compare both on the same agent.
 */
function legacyVoice(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('legacy') === '1';
}

/**
 * The agent picked needs the Python backend (a goal-led call, a shared knowledge
 * library, grouped website search): set from the page's `pythonAgents` on every
 * render, so the helpers below follow the agent without `?py=1`.
 */
let agentNeedsPython = false;

/**
 * `?py=1` on the Playground's address serves the voice call from the Python
 * backend (`/api/core/*`, FastAPI) instead of this app's own routes — the same
 * call, to compare both on the same agent while the server code moves. Agents
 * that only work in Python use it without the flag.
 */
function pythonBackend(): boolean {
  if (agentNeedsPython) return true;
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('py') === '1';
}

/** A voice-call endpoint (`/playground/call`, `/speech/live`…) on the backend this page talks to. */
function callApi(path: string): string {
  return pythonBackend() ? `/api/core${path}` : `/api${path}`;
}

/** A typed turn served by Python (`POST /api/core/playground/say`, the twin of `playgroundTurnAction`). */
async function sayToPython(turn: {
  callId: string | null;
  utterance: string;
  sttMs: number;
  agentId?: string;
}): Promise<PlaygroundReply> {
  const res = await fetch('/api/core/playground/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(turn),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PlaygroundReply;
}

/** The hang-up body: JSON in a Blob, so `keepalive` and beacons say `application/json` (the edge refuses text/plain). */
function hangUpBody(callId: string): Blob {
  return new Blob([JSON.stringify({ callId })], { type: 'application/json' });
}

interface Msg {
  id: string;
  role: 'caller' | 'agent';
  text: string;
  reply?: PlaygroundReply;
  interim?: boolean;
  /** Spoken language of the reply. */
  lang?: Locale;
}


export function Playground({
  agent,
  agents,
  allVoices,
  elevenVoices,
  locale,
  industry,
  engine,
  agentEngines,
  agentVoices = {},
  speech,
  pythonAgents = [],
}: {
  agent: {
    id: string;
    name: string;
    greeting: string;
    voiceId: string;
    speakingRate: number;
    primaryLang: Locale;
    languages: Locale[];
    threshold: number;
    status: string;
  } | null;
  agents: Array<{ id: string; name: string; status: 'draft' | 'live' | 'paused' }>;
  allVoices: Array<{ id: string; name: string; group: 'builtin' | 'clone' | 'design' }>;
  elevenVoices: Array<{ id: string; name: string }>;
  locale: UiLocale;
  industry: string;
  engine: string;
  /** The model each agent answers with, by agent id (its own choice or the account default). */
  agentEngines?: Record<string, string>;
  /** Agents set to an ElevenLabs model in the agent editor: their model and voice, by agent id. */
  agentVoices?: Record<string, { engine: string; voice: string }>;
  speech: { stt: Record<SttChoice, boolean>; tts: Record<TtsChoice, boolean>; streamUrl: string | null };
  /** Agents whose calls go to the Python backend without `?py=1` (see page.tsx). */
  pythonAgents?: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
  // Which STT/TTS engines the turns use — the model buttons by the voice and under the call button.
  const { sttEngine, setSttEngine, ttsEngine, setTtsEngine } = useModelChoice(speech.stt, speech.tts);
  const sttOn = speech.stt[sttEngine];
  const ttsOn = speech.tts[ttsEngine];
  // Whose voices speak: our own TTS (Laylo, Isomiddin, clones), the chosen
  // ElevenLabs model's voices (through Speko), or the BRB model's single voice.
  const voiceProvider: 'own' | 'eleven' | 'brb' =
    ttsEngine === 'default' ? 'own' : ttsEngine === 'brb' ? 'brb' : 'eleven';
  const modelVoices = elevenVoices;
  const langName = (l: Locale) => t(`play.lang.${l}`, LANG_NAME[l]);

  // Which agent the conversation is aimed at. The server resolves this exact
  // agent for every turn; the client's voice/language chrome stays with the
  // initially-loaded agent DTO (a known, minor cosmetic limitation).
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agent?.id ?? '');
  agentNeedsPython = pythonAgents.includes(selectedAgentId);
  // '' = speak with the selected agent's own voice; anything else overrides it
  // (built-in speakers plus the tenant's cloned/designed voices).
  const [voiceOverride, setVoiceOverride] = useState<string>('');
  // The voice list belongs to the model: switching to another model's voices
  // lands on that model's first voice.
  useEffect(() => {
    const ofModel = modelVoices.some((v) => v.id === voiceOverride);
    if (voiceProvider === 'eleven' && !ofModel) setVoiceOverride(modelVoices[0]?.id ?? '');
    if (voiceProvider !== 'eleven' && ofModel) setVoiceOverride('');
  }, [voiceProvider, voiceOverride, modelVoices]);
  // An agent set to an ElevenLabs model in the agent editor starts on that
  // model and voice; both can still be switched here. Agents on our own TTS
  // keep whatever model is picked. Declared after the effect above so its
  // voice is set last when both run in the same render.
  useEffect(() => {
    const own = agentVoices[selectedAgentId];
    if (!own || !speech.tts[own.engine as TtsChoice]) return;
    setTtsEngine(own.engine as TtsChoice);
    setVoiceOverride(own.voice);
    // Only when the agent changes; the setters are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId]);
  const [callId, setCallId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  // Saved conversations with the selected agent, most recent first.
  const [chats, setChats] = useState<PlaygroundChat[]>([]);
  const [openingChat, setOpeningChat] = useState<string | null>(null);
  const refreshChats = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      setChats(await listPlaygroundChatsAction(selectedAgentId));
    } catch {
      /* keep the list we have */
    }
  }, [selectedAgentId]);
  const [input, setInput] = useState('');
  /** The keyboard is opt-in: this page is for talking, not typing. */
  const [typing, setTyping] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  // Voice input is gated to languages with a working recogniser (Uzbek today).
  // Start on the agent's primary language only if it is available, else the
  // first available one, else Uzbek — never RU/EN, which are "available soon".
  const [speechLang, setSpeechLang] = useState<Locale>(
    agent?.primaryLang && voiceInputAvailable(agent.primaryLang)
      ? agent.primaryLang
      : agent?.languages?.find(voiceInputAvailable) ?? 'uz',
  );
  const [speechSupported, setSpeechSupported] = useState(false);
  // Read after mount, like `speechSupported`: the server cannot see the browser's
  // microphone, and checking during render made the first paint disagree.
  const [micAvailable, setMicAvailable] = useState(false);
  useEffect(() => setMicAvailable(micSupported()), []);
  const [ttsEnabled, setTtsEnabled] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechStartRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef<number | null>(null);
  const processingSeqRef = useRef(0);
  const voiceRunRef = useRef(0);
  const ttsPlaybackRef = useRef(0);
  // Web Audio playback of the streamed reply. The scheduled sources are kept so
  // a barge-in can cut the voice mid-sentence instead of at the next boundary.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);
  const streamAbortRef = useRef<AbortController | null>(null);

  const stopStream = useCallback(() => {
    for (const src of scheduledRef.current) {
      try {
        src.stop();
      } catch {
        /* already finished */
      }
    }
    scheduledRef.current = [];
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
  }, []);
  /* ── the voice call: the public /demo's architecture ───────────
     One button answers the call (the agent speaks first when it is the one
     calling), one mutes the mic, one hangs up. Each phrase is one streamed
     request to /api/playground/turn — what was heard, the reply as the model
     writes it, and its voice — played back to back on one Web Audio clock,
     with the phrase transcribed during the pause and the caller free to talk
     over the agent. */
  const outRef = useRef<VoiceOut | null>(null);
  /** Bumped whenever the turn in flight stops mattering (barge-in, hang-up). */
  const callSeqRef = useRef(0);
  const callAbortRef = useRef<AbortController | null>(null);
  const callIdRef = useRef<string | null>(null);
  const [callPhase, setCallPhaseState] = useState<'idle' | 'connecting' | 'live'>('idle');
  const callPhaseRef = useRef<'idle' | 'connecting' | 'live'>('idle');
  const setCallPhase = (next: 'idle' | 'connecting' | 'live') => {
    callPhaseRef.current = next;
    setCallPhaseState(next);
  };
  const [muted, setMuted] = useState(false);
  const callUtteranceRef = useRef<(recording: RecordingResult, timing?: UtteranceTiming) => Promise<void>>(
    async () => {},
  );
  const callPrefetchRef = useRef<(recording: RecordingResult) => void>(() => {});

  /** Stop the agent mid-word and forget the turn that was speaking. */
  const silenceAgent = () => {
    callSeqRef.current += 1;
    callAbortRef.current?.abort();
    callAbortRef.current = null;
    outRef.current?.stop();
    ttsPlaybackRef.current += 1;
    stopStream();
    window.speechSynthesis?.cancel();
    setThinking(false);
  };

  const {
    voiceState,
    level: voiceLevel,
    error: voiceError,
    isSessionActive,
    startSession,
    stopSession,
    setAiSpeaking,
    resumeListening,
    failAndResume,
    sessionIsActive,
    setMuted: setMicMuted,
  } = useVoiceSession({
    onUtterance: (recording, _turn, timing) => callUtteranceRef.current(recording, timing),
    onSpeculate: (recording) => callPrefetchRef.current(recording),
    onBargeIn: () => silenceAgent(),
    onError: (message) => toast.error(t('play.toast.micTitle', 'Microphone problem'), message),
  });

  // With the local streaming model picked, words appear while the caller is
  // still speaking; the turn itself still uses the finished utterance.
  // Muting closes this stream too: it opens its own microphone, so a muted
  // caller would otherwise still be transcribed, and those words would be sent
  // with the next phrase.
  const live = useLiveTranscript({
    url: speech.streamUrl && pythonBackend() ? callApi('/speech/live') : speech.streamUrl,
    active: sttEngine === 'local' && speech.stt.local && isSessionActive && !muted,
  });
  // The agent's own voice is not the caller's words; drop it between turns.
  useEffect(() => {
    if (voiceState === 'ai_speaking') live.reset();
  }, [voiceState, live.reset]);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setSpeechSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  useEffect(
    () => () => {
      stopStream();
      recognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
      const audio = audioElRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    },
    [],
  );

  /* ── speech synthesis ───────────────────────────────────────── */

  // Browser voice (used for RU/EN, and as a fallback when the internal TTS is
  // unavailable). `force` lets an explicit replay play even when auto-voice is off.
  const speak = useCallback(
    (text: string, lang: Locale, force = false) =>
      new Promise<void>((resolve) => {
        if ((!force && !ttsEnabled) || typeof window === 'undefined' || !window.speechSynthesis) {
          resolve();
          return;
        }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = SPEECH_LANG[lang] ?? 'ru-RU';
        u.rate = agent?.speakingRate ?? 1;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        // Prefer a voice that actually matches the language rather than the default.
        const voices = window.speechSynthesis.getVoices();
        const match =
          voices.find((v) => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2))) ??
          voices.find((v) => v.lang.toLowerCase().startsWith('ru'));
        if (match) u.voice = match;
        window.speechSynthesis.speak(u);
      }),
    [ttsEnabled, agent?.speakingRate],
  );

  // The picked voice model failed and the browser's own voice read the reply:
  // said once, not on every reply, until a model voice plays again.
  const voiceWarnedRef = useRef(false);
  const warnBrowserVoice = useCallback(() => {
    if (voiceWarnedRef.current) return;
    voiceWarnedRef.current = true;
    toast.toast({
      tone: 'error',
      title: t('play.toast.voiceFallbackTitle', 'Voice model did not answer'),
      description:
        ttsEngine === 'brb'
          ? t(
              'play.toast.voiceFallbackBrb',
              'BRB TTS could not be reached, so the browser read the reply in its own voice. BRB works only through the BRB VPN.',
            )
          : t(
              'play.toast.voiceFallbackBody',
              'The voice model did not answer, so the browser read the reply in its own voice.',
            ),
    });
  }, [toast, t, ttsEngine]);
  useEffect(() => {
    voiceWarnedRef.current = false;
  }, [ttsEngine]);

  /**
   * Speak `text` from the streaming TTS endpoint.
   *
   * One request: the server splits the reply into sentences and streams each as
   * it renders, so speech starts after the first sentence rather than after the
   * last. Chunks are queued on the audio clock, each starting exactly where the
   * previous ended, so the seams are inaudible.
   *
   * `stale()` is polled throughout — it reports a barge-in or a superseded
   * playback generation, and stopping on it is what lets the caller cut the
   * agent off mid-sentence. Resolves false if the stream was unusable, so the
   * caller can fall back to the browser voice.
   */
  const speakStream = useCallback(
    async (
      msgId: string,
      text: string,
      lang: Locale,
      stale: () => boolean,
      onFirstAudio: () => void,
    ): Promise<boolean> => {
      const ctx = (audioCtxRef.current ??= new AudioContext());
      // Autoplay policy keeps the context suspended until a user gesture; by the
      // time a reply exists the caller has clicked or spoken, so this succeeds.
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

      const controller = new AbortController();
      streamAbortRef.current = controller;
      scheduledRef.current = [];

      let res: Response;
      try {
        res = await fetch('/api/speech/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voice: voiceOverride || agent?.voiceId,
            language: lang,
            engine: ttsEngine,
            stream: true,
            rate: WEB_TTS_RATE,
          }),
          signal: controller.signal,
        });
      } catch {
        return false; // aborted or offline — fall back to the browser voice
      }
      if (!res.ok || !res.body) return false;
      const rate = Number(res.headers.get('x-audio-rate')) || TTS_RATE;

      const reader = res.body.getReader();
      const received: Uint8Array[] = [];
      // A chunk boundary can land mid-sample; carry the odd byte forward.
      let leftover = new Uint8Array(0);
      // Where the next buffer starts on the audio clock. The small cushion keeps
      // the first buffer just ahead of "now" so its opening is not clipped.
      let playhead = 0;
      let announced = false;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (stale()) break;
          received.push(value);

          let joined = value;
          if (leftover.length) {
            joined = new Uint8Array(leftover.length + value.length);
            joined.set(leftover);
            joined.set(value, leftover.length);
          }
          const usable = joined.length - (joined.length % 2);
          leftover = joined.subarray(usable);
          if (!usable) continue;

          const buffer = pcmToAudioBuffer(ctx, joined.subarray(0, usable), rate);
          if (!buffer) continue;

          if (!announced) {
            announced = true;
            onFirstAudio();
          }
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          playhead = Math.max(playhead, ctx.currentTime + 0.06);
          source.start(playhead);
          playhead += buffer.duration;
          scheduledRef.current.push(source);
        }
      } catch {
        /* aborted mid-stream — whatever was already scheduled still plays out */
      }

      if (!received.length) return false;

      // Wait out the scheduled audio, polling often enough that a barge-in stops
      // the voice mid-sentence rather than at the next chunk boundary.
      while (ctx.currentTime < playhead) {
        if (stale()) {
          stopStream();
          break;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      scheduledRef.current = [];
      streamAbortRef.current = null;
      return true;
    },
    [agent?.voiceId, voiceOverride, ttsEngine, stopStream],
  );

  // Generate a reply's audio and play it. For Uzbek this is a single streamed
  // request that starts speaking as soon as the first sentence renders; other
  // languages fall back to the browser synthesiser.
  const speakReply = useCallback(
    async (msgId: string, text: string, lang: Locale, continueSession = false) => {
      const playbackId = continueSession ? ++ttsPlaybackRef.current : 0;
      if (!ttsEnabled || !text.trim()) {
        if (continueSession) resumeListening();
        return;
      }
      // The internal and BRB voices are Uzbek-only; ElevenLabs speaks every language.
      if (ttsOn && (lang === 'uz' || (ttsEngine !== 'default' && ttsEngine !== 'brb'))) {
        // Stale once this playback has been superseded (barge-in, new call) or
        // the session has ended under us.
        const stale = () =>
          continueSession && (ttsPlaybackRef.current !== playbackId || !sessionIsActive());
        const spoke = await speakStream(msgId, text, lang, stale, () => {
          if (continueSession && !stale()) setAiSpeaking();
        });
        if (spoke) {
          voiceWarnedRef.current = false;
          if (continueSession && ttsPlaybackRef.current === playbackId) resumeListening();
          return;
        }
        // Stopped on purpose (talked over, new call) is not a failure.
        if (!stale()) warnBrowserVoice();
      }
      if (continueSession) {
        if (!sessionIsActive()) return;
        setAiSpeaking();
      }
      await speak(text, lang);
      if (continueSession && ttsPlaybackRef.current === playbackId) resumeListening();
    },
    [ttsEnabled, ttsOn, ttsEngine, speakStream, speak, resumeListening, sessionIsActive, setAiSpeaking, warnBrowserVoice],
  );

  /* ── the turn ───────────────────────────────────────────────── */

  // The existing agent/RAG turn remains unchanged; `fromVoice` only controls
  // whether playback returns the active hands-free session to listening.
  const send = useCallback(
    async (text: string, sttMs = 0, fromVoice = false, voiceRun = 0) => {
      const utterance = text.trim();
      if (!utterance || processingRef.current !== null) return;
      const requestId = ++processingSeqRef.current;
      processingRef.current = requestId;
      setMessages((m) => [
        ...m.filter((x) => !x.interim),
        { id: nextId(), role: 'caller', text: utterance },
      ]);
      setInput('');
      setThinking(true);

      let res: PlaygroundReply;
      let obsolete = false;
      try {
        const turn = { callId, utterance, sttMs, agentId: selectedAgentId || undefined };
        // With `?py=1` typed turns go to Python too, so they get its features (grouped search, goal calls).
        res = pythonBackend() ? await sayToPython(turn) : await playgroundTurnAction(turn);
      } catch (cause) {
        if (processingRef.current !== requestId) return;
        const message = cause instanceof Error ? cause.message : t('play.toast.answerFailTitle', 'Could not answer');
        toast.error(t('play.toast.answerFailTitle', 'Could not answer'), message);
        if (fromVoice) failAndResume(message, false);
        return;
      } finally {
        obsolete = processingRef.current !== requestId;
        if (!obsolete) {
          processingRef.current = null;
          setThinking(false);
        }
      }

      if (obsolete || (fromVoice && (voiceRunRef.current !== voiceRun || !sessionIsActive()))) return;

      if (!res.ok) {
        toast.error(t('play.toast.answerFailTitle', 'Could not answer'), res.message);
        if (fromVoice) failAndResume(res.message ?? t('play.toast.answerFailTitle', 'Could not answer'), false);
        return;
      }
      setCallId(res.callId ?? null);
      if (res.callId) rememberChat(selectedAgentId, res.callId);
      void refreshChats();
      const replyLang = (res.language as Locale) ?? speechLang;
      const msgId = nextId();
      setMessages((m) => [...m, { id: msgId, role: 'agent', text: res.reply ?? '', reply: res, lang: replyLang }]);
      await speakReply(msgId, res.reply ?? '', replyLang, fromVoice);
      if (res.escalate) {
        toast.toast({
          tone: 'info',
          title: t('play.toast.handedTitle', 'Handed to an operator'),
          description: t('play.toast.handedBody', 'It is now waiting in the operator inbox with a summary.'),
        });
      }
    },
    [callId, failAndResume, refreshChats, selectedAgentId, sessionIsActive, speakReply, speechLang, toast, t],
  );

  /* ── speech recognition ─────────────────────────────────────── */

  const startListening = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      toast.error(
        t('play.toast.speechUnavailTitle', 'Speech input unavailable'),
        t('play.toast.speechUnavailBody', 'Chrome or Edge is needed for in-browser recognition.'),
      );
      return;
    }
    const rec = new Ctor();
    rec.lang = SPEECH_LANG[speechLang];
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    speechStartRef.current = performance.now();

    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) {
        setMessages((m) => [
          ...m.filter((x) => !x.interim),
          { id: nextId(), role: 'caller', text: interim, interim: true },
        ]);
      }
      if (final) {
        const sttMs = performance.now() - speechStartRef.current;
        void send(final, sttMs);
      }
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        toast.error(t('play.toast.micTitle', 'Microphone problem'), e.error);
      }
      setMessages((m) => m.filter((x) => !x.interim));
    };
    rec.onend = () => {
      setListening(false);
      setMessages((m) => m.filter((x) => !x.interim));
    };

    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [speechLang, send, toast, t]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  /* ── the voice call (see the note at `outRef`) ─────────────────── */

  /** The fields every call request carries: who, which language, which engines and voice. */
  const callForm = (wav: Blob, streamedText = '') => {
    const form = new FormData();
    // Streaming Zipformer already has the words: send them, not the audio.
    if (streamedText) form.append('text', streamedText);
    else form.append('audio', wav, 'speech.wav');
    form.append('callId', callIdRef.current ?? '');
    form.append('lang', speechLang);
    form.append('sttEngine', sttEngine);
    form.append('ttsEngine', ttsEngine);
    form.append('voice', voiceOverride || agent?.voiceId || '');
    if (legacyVoice()) form.append('legacy', '1');
    return form;
  };

  /**
   * Play one streamed response: register the call, show what was heard, add the
   * reply and voice it as it arrives, fill the side panels, then hand the line
   * back to the caller.
   */
  const exchange = async (res: Response, seq: number, userMsgId?: string, clock?: TurnClock) => {
    const out = outRef.current!;
    // Measured on this page: when the filler and the reply's first audio
    // actually start playing, and any gaps between the reply's audio pieces.
    let fillerPlayAt = 0;
    let replyPlayAt = 0;
    let replyRecvAt = 0;
    let lastEnd = 0;
    let gapCount = 0;
    let gapMs = 0;
    let serverMs: Record<string, number> | undefined;
    let agentMsgId = '';
    let replyText = '';
    let replyLang: Locale = speechLang;
    let voiced = false;
    let dropped = false;
    let detail: TurnDetail | null = null;
    let heardBack = false;
    // Superseded (the caller spoke again, or hung up) before the STT answered:
    // the phrase's "…" placeholder would never fill in, so it goes.
    const dropPlaceholder = () => {
      if (userMsgId && !heardBack) setMessages((m) => m.filter((x) => x.id !== userMsgId));
    };

    try {
      for await (const event of readCallEvents(res)) {
        if (seq !== callSeqRef.current) return dropPlaceholder();
        if (event.t === 'call') {
          callIdRef.current = event.callId;
          setCallId(event.callId);
          rememberChat(selectedAgentId, event.callId);
        } else if (event.t === 'heard' && userMsgId) {
          heardBack = true;
          live.reset();
          const heard = event.text.trim();
          setMessages((m) =>
            heard
              ? m.map((x) => (x.id === userMsgId ? { ...x, text: heard, interim: false } : x))
              : m.filter((x) => x.id !== userMsgId),
          );
        } else if (event.t === 'reply') {
          replyText = event.text;
          replyLang = event.lang;
          agentMsgId = nextId();
          const id = agentMsgId;
          setMessages((m) => [...m, { id, role: 'agent', text: event.text, lang: event.lang }]);
        } else if ((event.t === 'more' || event.t === 'final') && agentMsgId) {
          // The reply grows a sentence at a time as the model writes it.
          replyText = event.text;
          if (event.t === 'final') serverMs = event.ms;
          const id = agentMsgId;
          setMessages((m) => m.map((x) => (x.id === id ? { ...x, text: event.text } : x)));
        } else if ((event.t === 'filler' || event.t === 'audio') && ttsEnabled) {
          const nowPage = performance.now();
          const nowAudio = out.now;
          const span = out.enqueue(decodePcm(event.pcm), event.rate);
          if (span) {
            const playAt = nowPage + (span.start - nowAudio) * 1000;
            if (event.t === 'filler') {
              fillerPlayAt ||= playAt;
            } else {
              if (!replyPlayAt) {
                replyPlayAt = playAt;
                replyRecvAt = nowPage;
              } else if (span.start - lastEnd > 0.015) {
                // The voice ran dry and restarted: an audible gap.
                gapCount += 1;
                gapMs += (span.start - lastEnd) * 1000;
              }
              lastEnd = span.end;
            }
          }
          if (event.t === 'audio' && span && !voiced) {
            voiced = true;
            voiceWarnedRef.current = false;
            setThinking(false);
            setAiSpeaking();
          }
        } else if (event.t === 'detail') {
          detail = event.detail;
        } else if (event.t === 'error') {
          if (event.code === 'stt') {
            toast.error(
              t('play.toast.transcribeFailTitle', 'Transcription failed'),
              t('play.toast.transcribeFailBody', 'The STT service returned an error.'),
            );
            dropPlaceholder();
            heardBack = true; // handled: no second "line dropped" message
            break;
          }
          throw new Error(event.code);
        }
      }
    } catch {
      if (seq !== callSeqRef.current) return dropPlaceholder(); // stopped on purpose
      dropped = true; // the line dropped mid-reply: what arrived still plays out
    }
    if (seq !== callSeqRef.current) return dropPlaceholder();
    callAbortRef.current = null;
    setThinking(false);

    if (detail && agentMsgId) {
      const id = agentMsgId;
      const timings: Record<string, number> = { ...detail.timings };
      if (serverMs) {
        // Server marks, in ms from when the server read the phrase.
        for (const [key, value] of Object.entries(serverMs)) timings[`srv_${key}`] = value;
      }
      if (clock && replyPlayAt) {
        timings.mouthToEarMs = replyPlayAt - clock.speechEndedAt;
        timings.endpointMs = clock.sentAt - clock.speechEndedAt;
        if (fillerPlayAt) timings.fillerAtMs = fillerPlayAt - clock.speechEndedAt;
        timings.gapCount = gapCount;
        timings.gapMs = gapMs;
        timings.replyRecvMs = replyRecvAt - clock.speechEndedAt;
      }
      const reply: PlaygroundReply = {
        ok: true,
        callId: callIdRef.current ?? undefined,
        reply: replyText,
        ...detail,
        timings,
      };
      setMessages((m) => m.map((x) => (x.id === id ? { ...x, reply } : x)));
    }
    if (dropped) toast.error(t('play.toast.answerFailTitle', 'Could not answer'), t('play.callDropped', 'The line dropped.'));

    if (agentMsgId && ttsEnabled) {
      if (!voiced) {
        // No voice could be rendered: the browser reads the line rather than go silent.
        // A dropped line already has its own message; it is not the voice model's fault.
        if (ttsOn && !dropped) warnBrowserVoice();
        setAiSpeaking();
        await speakWithBrowser(replyText, replyLang, () => seq !== callSeqRef.current);
      } else {
        while (out.remaining > 0.02 && seq === callSeqRef.current) await new Promise((r) => setTimeout(r, 40));
      }
    }
    if (seq !== callSeqRef.current) return;
    if (callPhaseRef.current === 'live') resumeListening();
  };

  /** Zipformer is streaming the call: the words exist as they are spoken. */
  const streamingStt = () => sttEngine === 'local' && live.connected;

  /** The caller paused: send the phrase ahead so it is already being transcribed. */
  callPrefetchRef.current = ({ wav, durationSec, rms }) => {
    if (streamingStt()) return; // nothing to prefetch: the transcript is already live
    if (callPhaseRef.current !== 'live' || !callIdRef.current || durationSec < 0.3 || rms < 0.0015 || wav.size <= 44) return;
    void fetch(callApi('/playground/turn?prefetch=1'), { method: 'POST', body: callForm(wav) }).catch(() => {});
  };

  callUtteranceRef.current = async ({ wav, durationSec, rms }, timing) => {
    // A cough, a click, or a phrase while the line is still connecting.
    if (callPhaseRef.current !== 'live' || !callIdRef.current || durationSec < 0.3 || rms < 0.0015 || wav.size <= 44) {
      if (callPhaseRef.current === 'live') resumeListening();
      return;
    }
    const seq = ++callSeqRef.current;
    const userMsgId = nextId();
    // Streaming Zipformer: flush its last words (milliseconds) and the phrase is
    // known before anything is uploaded. Empty — sidecar gone, nothing caught —
    // falls back to sending the audio.
    const streamedText = streamingStt() ? await live.finish() : '';
    if (streamedText) live.reset();
    if (seq !== callSeqRef.current) return;
    setMessages((m) => [...m, { id: userMsgId, role: 'caller', text: streamedText || '…', interim: !streamedText }]);
    setThinking(true);

    const controller = new AbortController();
    callAbortRef.current = controller;
    let res: Response | null = null;
    const clock: TurnClock | undefined = timing
      ? { speechEndedAt: timing.speechEndedAt, sentAt: performance.now() }
      : undefined;
    // A 409 means the previous turn is still being written down — a moment's wait.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(callApi('/playground/turn'), {
          method: 'POST',
          body: callForm(wav, streamedText),
          signal: controller.signal,
        });
      } catch {
        res = null;
        break;
      }
      if (res.status !== 409) break;
      await new Promise((r) => setTimeout(r, 350));
    }
    if (seq !== callSeqRef.current) {
      setMessages((m) => m.filter((x) => x.id !== userMsgId));
      return;
    }

    if (res?.status === 410) {
      hangUpCall();
      return;
    }
    if (!res || !res.ok || !res.body) {
      setMessages((m) => m.filter((x) => x.id !== userMsgId));
      setThinking(false);
      toast.error(t('play.toast.answerFailTitle', 'Could not answer'), t('play.callDropped', 'The line dropped.'));
      resumeListening();
      return;
    }
    await exchange(res, seq, userMsgId, clock);
  };

  /** Pick up: open the mic and the call together; the agent speaks first. */
  const answerCall = async () => {
    if (callPhaseRef.current !== 'idle') return;
    // Created inside the click: the only moment every browser lets audio start.
    const out = (outRef.current ??= new VoiceOut());
    void out.resume();
    stopVoiceConversation();
    clearConversation();
    rememberChat(selectedAgentId, null);
    callIdRef.current = null;
    setMuted(false);
    setMicMuted(false);
    setCallPhase('connecting');
    setThinking(true);

    const seq = ++callSeqRef.current;
    const controller = new AbortController();
    callAbortRef.current = controller;
    const call = fetch(callApi('/playground/call'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: selectedAgentId || undefined,
        lang: speechLang,
        voice: voiceOverride || agent?.voiceId || '',
        ttsEngine,
      }),
      signal: controller.signal,
    }).catch(() => null);
    const [micReady, res] = await Promise.all([startSession({ context: out.ctx }), call]);
    if (seq !== callSeqRef.current) return; // hung up while connecting

    if (!micReady || !res?.ok || !res.body) {
      controller.abort();
      callAbortRef.current = null;
      stopSession();
      setThinking(false);
      setCallPhase('idle');
      // A mic failure has already said why, through onError.
      if (micReady) toast.error(t('play.toast.answerFailTitle', 'Could not answer'), t('play.callDropped', 'The line dropped.'));
      return;
    }
    out.tone('connect');
    setCallPhase('live');
    await exchange(res, seq);
    void refreshChats();
  };

  /** End the call: stop the voice and the mic, and bill the call once. */
  const hangUpCall = () => {
    if (callPhaseRef.current === 'idle') return;
    silenceAgent();
    stopSession();
    setMicMuted(false);
    setMuted(false);
    const id = callIdRef.current;
    callIdRef.current = null;
    if (id) {
      void fetch(callApi('/playground/end'), { method: 'POST', body: hangUpBody(id), keepalive: true }).catch(() => {});
    }
    outRef.current?.tone('hangup');
    setCallPhase('idle');
    // The transcript stays on screen; the next message or call starts a new chat.
    setCallId(null);
    rememberChat(selectedAgentId, null);
    void refreshChats();
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setMicMuted(next);
  };

  // Closing the tab mid-call still ends (and bills) it.
  useEffect(() => {
    const onHide = () => {
      const id = callIdRef.current;
      if (id && callPhaseRef.current !== 'idle') {
        navigator.sendBeacon?.(callApi('/playground/end'), hangUpBody(id));
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // Drop the current conversation.
  const clearConversation = useCallback(() => {
    setMessages([]);
    setCallId(null);
    stopStream();
    window.speechSynthesis?.cancel();
    try {
      audioElRef.current?.pause();
    } catch {
      /* nothing playing */
    }
  }, [stopStream]);

  // Switching agent, opening a saved chat or starting over also ends a live call.
  const hangUpRef = useRef(hangUpCall);
  hangUpRef.current = hangUpCall;
  const stopVoiceConversation = useCallback(() => {
    hangUpRef.current();
    ttsPlaybackRef.current += 1;
    voiceRunRef.current += 1;
    processingRef.current = null;
    setThinking(false);
    stopSession();
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
    stopStream();
    window.speechSynthesis?.cancel();
    try {
      audioElRef.current?.pause();
    } catch {
      /* nothing playing */
    }
  }, [stopSession, stopStream]);

  const reset = async () => {
    stopVoiceConversation();
    if (callId) await endPlaygroundCallAction(callId, 5);
    clearConversation();
    rememberChat(selectedAgentId, null);
    void refreshChats();
    router.refresh();
  };

  // Reopen a saved conversation: its transcript returns to the screen and the
  // next message continues it, so the agent remembers everything said there.
  const openChat = useCallback(
    async (id: string) => {
      if (id === callId) return;
      stopVoiceConversation();
      if (callId) void endPlaygroundCallAction(callId, 5);
      clearConversation();
      setOpeningChat(id);
      try {
        const res = await loadPlaygroundChatAction(id);
        if (!res.ok || !res.turns) {
          rememberChat(selectedAgentId, null);
          toast.error(t('play.chatOpenFail', 'Could not open this chat'), res.message);
          void refreshChats();
          return;
        }
        setMessages(
          res.turns.map((turn) => ({
            id: nextId(),
            role: turn.role,
            text: turn.text,
            reply: turn.reply,
            lang: (turn.language ?? undefined) as Locale | undefined,
          })),
        );
        setCallId(id);
        rememberChat(selectedAgentId, id);
      } catch (cause) {
        toast.error(
          t('play.chatOpenFail', 'Could not open this chat'),
          cause instanceof Error ? cause.message : undefined,
        );
      } finally {
        setOpeningChat(null);
      }
    },
    [callId, clearConversation, refreshChats, selectedAgentId, stopVoiceConversation, t, toast],
  );

  // Each agent keeps its own history: load its chats and reopen the one that
  // was on screen last time. Runs on first load and whenever the agent changes.
  useEffect(() => {
    void refreshChats();
    const saved = selectedAgentId ? rememberedChat(selectedAgentId) : null;
    if (saved) void openChat(saved);
  }, [selectedAgentId]);

  // Switching who you talk to starts a fresh session with a clean transcript.
  const switchAgent = (agentId: string) => {
    if (agentId === selectedAgentId) return;
    stopVoiceConversation();
    if (callId) void endPlaygroundCallAction(callId, 5);
    setSelectedAgentId(agentId);
    clearConversation();
  };

  const lastReply = [...messages].reverse().find((m) => m.reply)?.reply;

  // Uzbek speech goes to your STT model; RU/EN use the browser recogniser
  // (the internal model is Uzbek-only).
  const internalStt = sttOn && speechLang === 'uz';
  const micReady = internalStt ? micAvailable : speechSupported;
  const displayedVoiceState: VoiceState = internalStt
    ? voiceState
    : listening
      ? 'user_speaking'
      : thinking
        ? 'processing'
        : 'idle';
  const voiceSessionRunning = internalStt ? isSessionActive : listening;
  const voiceStatusText: Record<VoiceState, string> = {
    idle: t('play.voice.idle', 'Ovozli suhbatni boshlash'),
    listening: t('play.voice.listening', 'Tinglayapman...'),
    user_speaking: t('play.voice.userSpeaking', 'Siz gapiryapsiz...'),
    processing: t('play.voice.processing', 'Javob tayyorlanmoqda...'),
    ai_speaking: t('play.voice.aiSpeaking', 'Agent gapiryapti...'),
    error: voiceError ?? t('play.voice.error', 'Mikrofon bilan xatolik yuz berdi'),
  };

  // The browser's own recogniser (languages our STT does not cover yet): one
  // click starts listening, the next stops it. Uzbek uses the call controls.
  const micToggle = async () => {
    if (micBusy || !voiceInputAvailable(speechLang)) return;
    setMicBusy(true);
    try {
      if (listening) {
        stopListening();
      } else {
        startListening();
      }
    } finally {
      setMicBusy(false);
    }
  };

  if (!agent) {
    return (
      <EmptyState
        icon={<IconAlert size={20} />}
        title={t('play.noAgentTitle', 'No agent configured')}
        description={t('play.noAgentBody', 'Set one up in the agent studio first.')}
      />
    );
  }

  // Name/status follow the picked agent; the rest of the DTO is the initial agent.
  const selected = agents.find((a) => a.id === selectedAgentId);
  const agentName = selected?.name ?? agent.name;
  const agentStatus = selected?.status ?? agent.status;

  return (
    // On desktop, fill the viewport (100vh − 64px top bar − 48px main padding) and
    // lay out as a column so the chat card's own header/footer stay pinned and only
    // the message list scrolls. On mobile the height is auto and the page flows.
    <div className="flex w-full flex-col lg:h-[calc(100vh_-_112px)]">
      <PageHeader
        title={t('play.title')}
        subtitle={t('play.subtitle')}
        actions={
          <>
            <Button
              variant="secondary"
              icon={ttsEnabled ? <IconVolume size={15} /> : <IconMicOff size={15} />}
              onClick={() => {
                setTtsEnabled((v) => !v);
                if (ttsEnabled) {
                  ttsPlaybackRef.current += 1;
                  stopStream();
                  window.speechSynthesis?.cancel();
                  audioElRef.current?.pause();
                  if (sessionIsActive()) resumeListening();
                }
              }}
            >
              {ttsEnabled ? t('play.voiceOn', 'Voice on') : t('play.voiceOff', 'Voice off')}
            </Button>
            <Button variant="secondary" icon={<IconRefresh size={15} />} onClick={() => void reset()}>
              {t('play.newCall', 'New call')}
            </Button>
          </>
        }
      />

      {/* Choose which of the tenant's agents to talk to — switching resets the chat. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">{t('play.talkingTo', 'Talking to')}</span>
        <Select
          value={selectedAgentId}
          onChange={(e) => switchAgent(e.target.value)}
          className="w-auto min-w-[200px]"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <span className="text-[12.5px] text-ink-3">{t('play.voiceLabel', 'Voice')}</span>
        <ModelMenu
          options={modelOptions(TTS_MODELS, speech.tts)}
          value={ttsEngine}
          onChange={(id) => setTtsEngine(id as TtsChoice)}
          needsLabel={t('lab.missing', 'Needs {setup}')}
        />
        {voiceProvider === 'brb' ? null : voiceProvider === 'eleven' ? (
          <Select
            value={voiceOverride}
            onChange={(e) => setVoiceOverride(e.target.value)}
            className="w-auto min-w-[180px]"
          >
            {modelVoices.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </Select>
        ) : (
        <Select
          value={voiceOverride}
          onChange={(e) => setVoiceOverride(e.target.value)}
          className="w-auto min-w-[180px]"
        >
          <option value="">{t('play.voiceAgentDefault', 'Agent voice')}</option>
          <optgroup label={t('dev.tts.voiceBaseGroup', 'Base voices')}>
            {allVoices.filter((v) => v.group === 'builtin').map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </optgroup>
          {allVoices.some((v) => v.group === 'clone') && (
            <optgroup label={t('dev.voices.badgeClone', 'Clone')}>
              {allVoices.filter((v) => v.group === 'clone').map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </optgroup>
          )}
          {allVoices.some((v) => v.group === 'design') && (
            <optgroup label={t('dev.voices.badgeDesign', 'Design')}>
              {allVoices.filter((v) => v.group === 'design').map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </optgroup>
          )}
        </Select>
        )}
      </div>

      {/* A goal-led agent calls the tester: who to play and what it will ask (Python backend only). */}
      <ScenarioCard agentId={selectedAgentId} callId={callId} t={t} />

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_320px]">
        {/* ── The call surface. This page exists to rehearse a real phone call,
            so the microphone is the anchor of the layout and the transcript is
            what it produces. Typing is still available — it is the same engine
            and the same transcript — but it is deliberately the secondary
            affordance, one tap away rather than occupying the composer. ── */}
        <Card padded={false} className="flex min-h-[560px] flex-col overflow-hidden lg:min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hairline-b">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white">
                <IconSparkle size={16} />
              </span>
              <div>
                <div className="text-[13.5px] font-semibold text-ink">{agentName}</div>
                <div className="text-[11.5px] text-ink-3">
                  {agentStatus === 'live' ? t('play.statusLive', 'Live') : t('play.statusDraft', 'Draft')} ·{' '}
                  {agentEngines?.[selectedAgentId] ?? engine}
                </div>
              </div>
            </div>
            {/* Call state, so the caller-facing status is legible at a glance
                from across the room while you are actually speaking. */}
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium',
                displayedVoiceState === 'user_speaking'
                  ? 'bg-danger-soft text-danger'
                  : displayedVoiceState === 'processing'
                    ? 'bg-warning-soft text-warning'
                    : displayedVoiceState === 'listening'
                      ? 'bg-brand-soft text-brand'
                      : 'bg-surface-3 text-ink-3',
              )}
            >
              {displayedVoiceState === 'processing' ? (
                <Spinner size={12} />
              ) : displayedVoiceState === 'ai_speaking' ? (
                <IconVolume size={12} />
              ) : displayedVoiceState === 'error' ? (
                <IconAlert size={12} />
              ) : (
                <IconMic size={12} />
              )}
              {voiceStatusText[displayedVoiceState]}
            </span>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {/* Inner column keeps the conversation to a readable width. Before the
                first message it stays empty: the call controls below say what to do. */}
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-3 p-5">
              {messages.map((m) => (
                <Bubble key={m.id} msg={m} t={t} />
              ))}
              {live.text && voiceState !== 'ai_speaking' && (
                <Bubble msg={{ id: 'live', role: 'caller', text: live.text, interim: true }} t={t} />
              )}

              {thinking && (
                <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
                  <Spinner size={14} />
                  {t('play.thinking')}
                </div>
              )}
            </div>
          </div>

          {/* ── The dock. Three columns on desktop so the mic sits optically
              centred under the transcript regardless of how wide the language
              pills or the type toggle grow. ── */}
          <div className="bg-surface-2 px-5 py-4 hairline-t">
            {typing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
                className="flex gap-2"
              >
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t('play.inputPlaceholder', 'Ask exactly what a caller would ask…')}
                  className="flex-1"
                  disabled={thinking}
                  autoFocus
                />
                <Button type="submit" variant="primary" icon={<IconSend size={15} />} disabled={thinking}>
                  {t('play.send', 'Send')}
                </Button>
                <Button variant="secondary" icon={<IconMic size={15} />} onClick={() => setTyping(false)}>
                  {t('play.backToVoice', 'Back to voice')}
                </Button>
              </form>
            ) : (
              <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                {agent.languages.some((l) => !voiceInputAvailable(l)) && (
                  <p className="text-[11px] leading-snug text-ink-3 sm:col-span-3 sm:text-center">
                    {t(
                      'play.voiceUzOnly',
                      'Voice input is Uzbek-only for now — Russian and English recognition are coming soon.',
                    )}
                  </p>
                )}
                {/* Left: what the mic will do — which language, which engine. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {agent.languages.map((l) => {
                    const available = voiceInputAvailable(l);
                    const active = speechLang === l && available;
                    return (
                      <button
                        key={l}
                        type="button"
                        onClick={() => {
                          if (!available || l === speechLang) return;
                          stopVoiceConversation();
                          setSpeechLang(l);
                        }}
                        disabled={!available}
                        aria-disabled={!available}
                        // Inline: the global `button { font: inherit }` reset outranks text-size classes.
                        style={{ fontSize: 11, lineHeight: '16px' }}
                        title={
                          available
                            ? undefined
                            : t('play.voiceSoonTitle', '{lang} voice recognition — available soon').replace(
                                '{lang}',
                                langName(l),
                              )
                        }
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium transition-colors',
                          active
                            ? 'bg-brand text-white shadow-e1'
                            : available
                              ? 'bg-surface-3 text-ink-2 hover:text-ink'
                              : 'cursor-not-allowed bg-surface-3/40 text-ink-3 opacity-60',
                        )}
                      >
                        {l.toUpperCase()}
                        {!available && (
                          <span className="rounded-full bg-surface px-1 text-[8px] leading-[12px] font-semibold text-ink-3 hairline">
                            {t('play.soon', 'soon')}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {speechLang === 'uz' ? (
                    // Which recogniser hears Uzbek: our own model, GAPI, the in-app
                    // streaming Zipformer or gemini-3.5.
                    <ModelMenu
                      size="sm"
                      side="top"
                      options={modelOptions(STT_MODELS, speech.stt)}
                      value={sttEngine}
                      onChange={(id) => setSttEngine(id as SttChoice)}
                      needsLabel={t('lab.missing', 'Needs {setup}')}
                    />
                  ) : (
                    <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-3 hairline">
                      {t('play.sttBrowser', '{lang} → browser voice').replace('{lang}', speechLang.toUpperCase())}
                    </span>
                  )}
                </div>

                {/* Centre: the reason this page exists. Uzbek runs as a real call,
                    as on /demo: answer, then mute or hang up. */}
                {internalStt ? (
                  <div className="flex flex-col items-center gap-2 justify-self-center">
                    {callPhase === 'idle' ? (
                      <button
                        type="button"
                        onClick={() => void answerCall()}
                        disabled={!micReady}
                        aria-label={t('play.call.answer', 'Answer')}
                        style={{ color: '#ffffff' }}
                        className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-success shadow-e2 transition-all duration-200 hover:scale-105 hover:brightness-110 disabled:opacity-40"
                      >
                        <IconHandset width={30} height={30} fill="currentColor" stroke="none" />
                      </button>
                    ) : (
                      <div className="flex items-center gap-4">
                        <button
                          type="button"
                          onClick={toggleMute}
                          disabled={callPhase !== 'live'}
                          aria-pressed={muted}
                          aria-label={muted ? t('play.call.unmute', 'Turn mic on') : t('play.call.mute', 'Turn mic off')}
                          title={muted ? t('play.call.unmute', 'Turn mic on') : t('play.call.mute', 'Turn mic off')}
                          className={cn(
                            'relative flex h-[56px] w-[56px] items-center justify-center rounded-full shadow-e1 transition-colors disabled:opacity-40',
                            muted ? 'bg-surface-3 text-ink-3' : 'bg-surface-2 text-ink hairline hover:bg-surface-3',
                          )}
                        >
                          {muted ? <IconMicOff size={24} /> : <IconMic size={24} />}
                          {!muted && voiceState === 'user_speaking' && (
                            <span
                              className="absolute inset-0 rounded-full ring-4 ring-brand/30 transition-transform"
                              style={{ transform: `scale(${1 + voiceLevel * 0.35})` }}
                            />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={hangUpCall}
                          aria-label={t('play.call.hangUp', 'Hang up')}
                          title={t('play.call.hangUp', 'Hang up')}
                          style={{ color: '#ffffff' }}
                          className="flex h-[64px] w-[64px] items-center justify-center rounded-full bg-danger shadow-e2 transition-all hover:brightness-110"
                        >
                          <IconHangUp width={28} height={28} fill="currentColor" stroke="none" />
                        </button>
                      </div>
                    )}
                    <p className="max-w-[16rem] text-center text-[12px] leading-snug text-ink-3">
                      {!micReady
                        ? t('play.micHttps', 'Microphone needs localhost or HTTPS — open http://localhost:3000')
                        : callPhase === 'idle'
                          ? t('play.call.answer', 'Answer')
                          : callPhase === 'connecting'
                            ? t('play.call.connecting', 'Connecting…')
                            : muted
                              ? t('play.call.muted', 'Your mic is off')
                              : voiceStatusText[displayedVoiceState]}
                    </p>
                  </div>
                ) : (
                <div className="flex flex-col items-center gap-2 justify-self-center">
                  <button
                    onClick={() => void micToggle()}
                    disabled={!micReady || micBusy}
                    aria-label={
                      voiceSessionRunning
                        ? t('play.voice.end', 'Ovozli suhbatni tugatish')
                        : t('play.voice.start', 'Ovozli suhbatni boshlash')
                    }
                    className={cn(
                      'relative flex h-[72px] w-[72px] items-center justify-center rounded-full shadow-e2 transition-all duration-200 disabled:opacity-40',
                      displayedVoiceState === 'user_speaking'
                        ? 'animate-pulse-ring bg-danger text-white'
                        : voiceSessionRunning
                          ? 'bg-brand text-white hover:brightness-110'
                        : 'bg-brand text-white hover:scale-105 hover:brightness-110',
                    )}
                  >
                    {voiceSessionRunning ? <IconMicOff size={28} /> : <IconMic size={28} />}
                    {(displayedVoiceState === 'listening' || displayedVoiceState === 'user_speaking') && (
                      <span
                        className={cn(
                          'absolute inset-0 rounded-full ring-4 transition-transform',
                          displayedVoiceState === 'user_speaking' ? 'ring-danger/30' : 'ring-brand/20',
                        )}
                        style={{ transform: `scale(${1 + voiceLevel * 0.35})` }}
                      />
                    )}
                  </button>
                  <p className="max-w-[16rem] text-center text-[12px] leading-snug text-ink-3">
                    {!micReady
                      ? t('play.micHttps', 'Microphone needs localhost or HTTPS — open http://localhost:3000')
                      : voiceStatusText[displayedVoiceState]}
                  </p>
                </div>
                )}

                {/* Right: the escape hatch to the keyboard. */}
                <div className="flex justify-start sm:justify-end">
                  <Button
                    variant="secondary"
                    icon={<IconSend size={15} />}
                    onClick={() => {
                      stopVoiceConversation();
                      setTyping(true);
                    }}
                  >
                    {t('play.typeInstead', 'Type instead')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* ── Right: what the last turn actually did. The live-voice controls
            used to live here; they now sit in the call surface's dock, because
            a 360 px sidebar is the wrong place for this page's primary action. ── */}
        <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto">
          <Card>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-ink">{t('play.chatsTitle', 'Chats')}</h3>
              <Button size="xs" variant="secondary" icon={<IconPlus size={13} />} onClick={() => void reset()}>
                {t('play.newChat', 'New chat')}
              </Button>
            </div>
            {chats.length ? (
              <ul className="mt-3 max-h-56 space-y-0.5 overflow-y-auto">
                {chats.map((c) => (
                  <li key={c.callId}>
                    <button
                      type="button"
                      onClick={() => void openChat(c.callId)}
                      disabled={openingChat !== null || thinking}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left transition-colors disabled:opacity-60',
                        c.callId === callId ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        {c.title || t('play.chatUntitled', 'Untitled chat')}
                      </span>
                      {openingChat === c.callId ? (
                        <Spinner size={12} />
                      ) : (
                        <span className="shrink-0 text-[11px] text-ink-3"><TimeAgo iso={c.lastAt} locale={locale} /></span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">
                {t(
                  'play.chatsEmpty',
                  'Conversations with this agent are saved here. Reopen one and the agent remembers everything said in it.',
                )}
              </p>
            )}
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-ink">{t('play.lastTurn', 'Last turn')}</h3>
            {lastReply ? (
              <div className="mt-4 space-y-3">
                {lastReply.timings?.mouthToEarMs != null ? (
                  <>
                    <MetricRow
                      icon={<IconZap size={15} />}
                      label={t('play.metric.mouthToEar', 'You stopped → agent spoke')}
                      value={fmtLatency(lastReply.timings.mouthToEarMs)}
                      good={lastReply.timings.mouthToEarMs < 1000}
                    />
                    <TurnWaterfall timings={lastReply.timings} t={t} />
                  </>
                ) : (
                  <>
                    <MetricRow
                      icon={<IconZap size={15} />}
                      label={t('play.metric.total', 'Total')}
                      value={fmtLatency(lastReply.timings?.totalMs)}
                      good={(lastReply.timings?.totalMs ?? 0) < 1000}
                    />
                    <StageBar timings={lastReply.timings ?? {}} t={t} />
                  </>
                )}
                <div className="space-y-2 pt-2">
                  <MetricRow
                    icon={<IconCheckCircle size={15} />}
                    label={t('play.metric.confidence', 'Confidence')}
                    value={(lastReply.confidence ?? 0).toFixed(2)}
                    good={(lastReply.confidence ?? 0) >= agent.threshold}
                  />
                  <MetricRow
                    icon={<IconBook size={15} />}
                    label={t('play.metric.passages', 'Passages searched')}
                    value={String(lastReply.retrieval?.totalChunks ?? 0)}
                  />
                  <MetricRow
                    icon={<IconSparkle size={15} />}
                    label={t('play.metric.intent', 'Intent')}
                    value={lastReply.intent ?? '—'}
                  />
                  <MetricRow
                    icon={<IconHeadset size={15} />}
                    label={t('play.metric.outcome', 'Outcome')}
                    value={
                      lastReply.escalate
                        ? t('play.escalated', 'Escalated ({reason})').replace('{reason}', lastReply.escalate)
                        : t('play.answered', 'Answered')
                    }
                    good={!lastReply.escalate}
                  />
                  <MetricRow
                    icon={<IconSparkle size={15} />}
                    label={t('play.metric.engine', 'Engine')}
                    value={lastReply.engine ?? '—'}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">
                {t('play.metricEmpty', 'Ask something and the full pipeline breakdown appears here.')}
              </p>
            )}
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-ink">{t('play.sourcesUsed', 'Sources used')}</h3>
            {lastReply?.citations?.length ? (
              <div className="mt-3 space-y-2.5">
                {lastReply.citations.map((c, i) => (
                  <div key={i} className="rounded-[10px] bg-surface-2 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink">
                        {c.documentTitle}
                        {c.heading && <span className="text-ink-3"> › {c.heading}</span>}
                      </span>
                      <Badge tone="brand">{c.score.toFixed(2)}</Badge>
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">{c.snippet}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">
                {t('play.sourcesEmpty', 'Each answer lists the exact passages it came from.')}
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

function Bubble({ msg, t }: { msg: Msg; t: Translate }) {
  const isCaller = msg.role === 'caller';
  return (
    <div className={cn('flex', isCaller ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[78%]', isCaller && 'text-right')}>
        <div
          className={cn(
            'inline-block rounded-[14px] px-3.5 py-2.5 text-left text-[13.5px] leading-relaxed',
            isCaller
              ? 'rounded-br-[5px] bg-brand text-white'
              : 'rounded-bl-[5px] bg-surface-3 text-ink',
            msg.interim && 'opacity-55',
          )}
        >
          {msg.text}
        </div>
        {msg.reply && (
          <div
            className={cn(
              'mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3',
              isCaller ? 'justify-end' : 'justify-start',
            )}
          >
            <span className="tabular">
              {fmtLatency(msg.reply.timings?.mouthToEarMs ?? msg.reply.timings?.totalMs)}
            </span>
            <span className="tabular">
              {t('play.confShort', 'conf')} {(msg.reply.confidence ?? 0).toFixed(2)}
            </span>
            {msg.reply.escalate && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">
                {t('play.toOperator', '→ operator')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricRow({
  icon,
  label,
  value,
  good,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn('shrink-0', good === undefined ? 'text-ink-3' : good ? 'text-success' : 'text-warning')}>
        {icon}
      </span>
      <span className="flex-1 text-[12.5px] text-ink-3">{label}</span>
      <span className="text-[13px] font-medium text-ink tabular">{value}</span>
    </div>
  );
}

/**
 * Where one voice turn's time went, measured end to end: from the moment the
 * caller stopped talking to the moment the agent's voice started playing.
 * Each stage ends at a mark; stages whose mark is missing fold into the next.
 */
function TurnWaterfall({ timings, t }: { timings: Record<string, number>; t: Translate }) {
  const endpoint = timings.endpointMs ?? 0;
  const at = (offset: number | undefined) => (offset == null ? undefined : endpoint + offset);
  const sttEnd = at(timings.srv_stt);
  const marks: Array<{ key: string; label: string; at: number | undefined }> = [
    { key: 'endpoint', label: t('play.wf.endpoint', 'Silence wait (end of speech)'), at: endpoint },
    { key: 'stt', label: t('play.wf.stt', 'Speech-to-text'), at: sttEnd },
    {
      key: 'retrieval',
      label: t('play.wf.retrieval', 'Knowledge search'),
      at: sttEnd != null && timings.srv_retrieval != null ? sttEnd + timings.srv_retrieval : undefined,
    },
    { key: 'llm', label: t('play.wf.llm', 'AI first words'), at: at(timings.srv_llmFirst) },
    { key: 'segment', label: t('play.wf.segment', 'First phrase ready'), at: at(timings.srv_firstSegment) },
    { key: 'tts', label: t('play.wf.tts', 'Voice first audio'), at: at(timings.srv_firstAudio) },
    { key: 'play', label: t('play.wf.play', 'Network + playback'), at: timings.mouthToEarMs },
  ];
  const stages: Array<{ key: string; label: string; ms: number }> = [];
  let prev = 0;
  for (const mark of marks) {
    if (mark.at == null || mark.at < prev) continue;
    stages.push({ key: mark.key, label: mark.label, ms: mark.at - prev });
    prev = mark.at;
  }
  const total = timings.mouthToEarMs || 1;
  const colors = ['var(--series-1)', 'var(--series-3)', 'var(--series-4)', 'var(--series-2)'];
  return (
    <div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
        {stages.map((s, i) =>
          s.ms > 0 ? (
            <div
              key={s.key}
              style={{ width: `${(s.ms / total) * 100}%`, background: colors[i % colors.length] }}
              title={`${s.label} ${Math.round(s.ms)} ms`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 space-y-1">
        {stages.map((s, i) => (
          <div key={s.key} className="flex items-center justify-between text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 text-ink-3">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: colors[i % colors.length] }} />
              {s.label}
            </span>
            <span className="text-ink-2 tabular">{Math.round(s.ms)} ms</span>
          </div>
        ))}
        {timings.fillerAtMs != null && (
          <div className="flex items-center justify-between text-[11.5px] text-ink-3">
            <span>{t('play.wf.filler', '“One moment” filler started at')}</span>
            <span className="tabular">{Math.round(timings.fillerAtMs)} ms</span>
          </div>
        )}
        {(timings.gapCount ?? 0) > 0 && (
          <div className="flex items-center justify-between text-[11.5px] text-warning">
            <span>{t('play.wf.gaps', 'Gaps in the voice')}</span>
            <span className="tabular">
              {timings.gapCount} · {Math.round(timings.gapMs ?? 0)} ms
            </span>
          </div>
        )}
        <div className="pt-1 text-[11px] text-ink-3">
          {timings.srv_fast === 0
            ? t('play.wf.legacy', 'Legacy voice (?legacy=1): answer in one piece, no render-ahead')
            : t('play.wf.fast', 'Streaming voice: first phrase starts early, next sentence renders ahead')}
        </div>
      </div>
    </div>
  );
}

const STAGES = [
  { key: 'sttMs', labelKey: 'play.stage.speech', label: 'Speech', color: 'var(--series-1)' },
  { key: 'retrievalMs', labelKey: 'play.stage.retrieval', label: 'Retrieval', color: 'var(--series-3)' },
  { key: 'llmMs', labelKey: 'play.stage.generation', label: 'Generation', color: 'var(--series-2)' },
  { key: 'ttsMs', labelKey: 'play.stage.synthesis', label: 'Synthesis', color: 'var(--series-4)' },
];

function StageBar({ timings, t }: { timings: Record<string, number>; t: Translate }) {
  const total = STAGES.reduce((a, s) => a + (timings[s.key] ?? 0), 0) || 1;
  return (
    <div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
        {STAGES.map((s) => {
          const v = timings[s.key] ?? 0;
          if (!v) return null;
          return (
            <div
              key={s.key}
              style={{ width: `${(v / total) * 100}%`, background: s.color }}
              title={`${t(s.labelKey, s.label)} ${Math.round(v)} ms`}
            />
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {STAGES.map((s) => (
          <div key={s.key} className="flex items-center justify-between text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 text-ink-3">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
              {t(s.labelKey, s.label)}
            </span>
            <span className="text-ink-2 tabular">{Math.round(timings[s.key] ?? 0)} ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
