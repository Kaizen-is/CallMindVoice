'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  endPlaygroundCallAction,
  playgroundTurnAction,
  type PlaygroundReply,
} from '@/app/actions/agent';
import { translator, type Translate } from '@/lib/i18n';
import type { Locale, UiLocale } from '@/lib/types';
import { cn, fmtLatency } from '@/lib/utils';
import { voiceInputAvailable } from '@/lib/catalog';
import { micSupported, type RecordingResult } from '@/lib/audio';
import { useVoiceSession, type VoiceState } from '@/hooks/use-voice-session';
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
  IconPlay,
  IconRefresh,
  IconSend,
  IconSparkle,
  IconVolume,
  IconZap,
} from '@/components/icons';

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

/* ── streaming TTS: cut a reply into speakable pieces at SENTENCE boundaries
   only. Mid-sentence cuts reset the synthesiser's prosody per piece (worst in
   clone mode, where each piece re-derives the voice) and sound stitched. The
   first sentence alone still starts playback early; consecutive short
   sentences are merged so pieces stay ~12+ words. ── */
function chunkForTts(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length <= 1) return [clean];
  const chunks: string[] = [sentences[0]];
  for (const sentence of sentences.slice(1)) {
    const last = chunks[chunks.length - 1];
    if (last.split(' ').length + sentence.split(' ').length <= 24 && chunks.length > 1) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

/** Short spoken fillers that cover the synthesis of a long answer. */
const FILLERS_UZ = [
  'Hmm, qiziq savol.',
  'Bir soniya, hozir javob beraman.',
  'Yaxshi, hozir aytaman.',
];

interface Msg {
  id: string;
  role: 'caller' | 'agent';
  text: string;
  reply?: PlaygroundReply;
  interim?: boolean;
  /** Object URL of this reply's synthesised audio — set once, replayable, kept until reset. */
  audioUrl?: string;
  /** Streamed replies: every chunk's object URL, in order, for exact replay. */
  audioUrls?: string[];
  /** Spoken language of the reply, for the browser-voice replay fallback. */
  lang?: Locale;
}

const SUGGESTIONS: Record<string, string[]> = {
  clinic: [
    'Ish vaqtingiz qanday?',
    'Kardiolog qabuli qancha turadi?',
    'Вы принимаете страховой полис?',
    'Какие документы нужны для ребёнка?',
    'When will my blood test results be ready?',
    'Menga operator kerak',
  ],
  insurance: [
    'OSAGO narxi qancha?',
    'Какие документы нужны для выплаты?',
    'Что не покрывается полисом?',
    'How long does a claim take?',
  ],
  retail: [
    'Yetkazib berish qancha turadi?',
    'Как вернуть товар?',
    'Do you offer instalments?',
    'Где мой заказ?',
  ],
};

export function Playground({
  agent,
  agents,
  allVoices,
  locale,
  industry,
  chunks,
  engine,
  speech,
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
  locale: UiLocale;
  industry: string;
  chunks: number;
  engine: string;
  speech: { stt: boolean; tts: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
  const langName = (l: Locale) => t(`play.lang.${l}`, LANG_NAME[l]);

  // Which agent the conversation is aimed at. The server resolves this exact
  // agent for every turn; the client's voice/language chrome stays with the
  // initially-loaded agent DTO (a known, minor cosmetic limitation).
  const [selectedAgentId, setSelectedAgentId] = useState<string>(agent?.id ?? '');
  // '' = speak with the selected agent's own voice; anything else overrides it
  // (built-in speakers plus the tenant's cloned/designed voices).
  const [voiceOverride, setVoiceOverride] = useState<string>('');
  const [callId, setCallId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
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
  const [ttsEnabled, setTtsEnabled] = useState(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechStartRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Msg[]>([]);
  const processingRef = useRef<number | null>(null);
  const processingSeqRef = useRef(0);
  const voiceRunRef = useRef(0);
  const ttsPlaybackRef = useRef(0);
  const voiceUtteranceRef = useRef<(recording: RecordingResult, turnId: number) => Promise<void>>(
    async () => {},
  );
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
  } = useVoiceSession({
    onUtterance: (recording, turnId) => voiceUtteranceRef.current(recording, turnId),
    onBargeIn: () => {
      ttsPlaybackRef.current += 1;
      window.speechSynthesis?.cancel();
      try {
        audioElRef.current?.pause();
      } catch {
        /* playback already ended */
      }
    },
    onError: (message) => toast.error(t('play.toast.micTitle', 'Microphone problem'), message),
  });
  const suggestions = SUGGESTIONS[industry] ?? SUGGESTIONS.clinic;

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

  // Mirror messages into a ref so unmount cleanup can revoke object URLs.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(
    () => () => {
      const urls = new Set(synthCacheRef.current.values());
      messagesRef.current.forEach((x) => [x.audioUrl, ...(x.audioUrls ?? [])].forEach((u) => u && urls.add(u)));
      urls.forEach((url) => URL.revokeObjectURL(url));
      synthCacheRef.current.clear();
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

  // Ask the internal Uzbek TTS for a real audio blob and hand back an object URL
  // (the caller stores it on the message so it can be replayed as-is).
  // Repeated snippets (fillers, common phrases) are synthesised once per voice
  // and reused — instant playback, no GPU round-trip.
  const synthCacheRef = useRef<Map<string, string>>(new Map());

  const synthUz = useCallback(
    async (text: string): Promise<string | null> => {
      const key = `${voiceOverride || agent?.voiceId || ''}|${text}`;
      const cached = synthCacheRef.current.get(key);
      if (cached) return cached;
      try {
        const res = await fetch('/api/speech/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: voiceOverride || agent?.voiceId }),
        });
        if (res.ok) {
          const url = URL.createObjectURL(await res.blob());
          if (synthCacheRef.current.size < 60) synthCacheRef.current.set(key, url);
          return url;
        }
      } catch {
        /* fall back to the browser voice */
      }
      return null;
    },
    [agent?.voiceId, voiceOverride],
  );

  // Resolve when playback finishes so TTS chunks and the listening state can be
  // sequenced through one shared audio element.
  const playUrlAwait = useCallback(
    (url: string) =>
      new Promise<void>((resolve) => {
        window.speechSynthesis?.cancel();
        const audio = audioElRef.current ?? (audioElRef.current = new Audio());
        try {
          audio.pause();
        } catch {
          /* nothing playing */
        }
        audio.src = url;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.onpause = () => resolve();
        void audio.play().catch(() => resolve());
      }),
    [],
  );

  // Generate a reply's audio and play it — STREAMED for Uzbek: the text is cut
  // into small pieces (first one tiny, so speech starts almost immediately),
  // each piece is synthesised while the previous one plays, and long answers
  // open with a short spoken filler so the wait is never silent.
  const speakReply = useCallback(
    async (msgId: string, text: string, lang: Locale, continueSession = false) => {
      const playbackId = continueSession ? ++ttsPlaybackRef.current : 0;
      if (!ttsEnabled || !text.trim()) {
        if (continueSession) resumeListening();
        return;
      }
      if (speech.tts && lang === 'uz') {
        const chunks = chunkForTts(text);
        if (text.split(/\s+/).length > 20) {
          chunks.unshift(FILLERS_UZ[Math.floor((Date.now() / 1000) % FILLERS_UZ.length)]);
        }
        const urls: string[] = [];
        let playbackStarted = false;
        let inFlight = synthUz(chunks[0]);
        for (let i = 0; i < chunks.length; i++) {
          const url = await inFlight;
          // Pipeline: request the next chunk before playing this one.
          if (i + 1 < chunks.length) inFlight = synthUz(chunks[i + 1]);
          if (!url) continue;
          urls.push(url);
          setMessages((m) =>
            m.map((x) => (x.id === msgId ? { ...x, audioUrl: urls[0], audioUrls: [...urls] } : x)),
          );
          if (continueSession && !sessionIsActive()) return;
          if (continueSession && !playbackStarted) {
            playbackStarted = true;
            setAiSpeaking();
          }
          await playUrlAwait(url);
          if (continueSession && ttsPlaybackRef.current !== playbackId) return;
        }
        if (urls.length) {
          if (continueSession && ttsPlaybackRef.current === playbackId) resumeListening();
          return;
        }
      }
      if (continueSession) {
        if (!sessionIsActive()) return;
        setAiSpeaking();
      }
      await speak(text, lang);
      if (continueSession && ttsPlaybackRef.current === playbackId) resumeListening();
    },
    [ttsEnabled, speech.tts, synthUz, playUrlAwait, speak, resumeListening, sessionIsActive, setAiSpeaking],
  );

  // Replay control on an agent bubble: the exact stored audio if we have it,
  // otherwise re-synthesise through the browser voice.
  const replay = useCallback(
    (m: Msg) => {
      void (async () => {
        const pausesSession = sessionIsActive();
        const playbackId = pausesSession ? ++ttsPlaybackRef.current : 0;
        if (pausesSession) setAiSpeaking();
        if (m.audioUrls?.length) {
          for (const u of m.audioUrls ?? []) await playUrlAwait(u);
        } else if (m.audioUrl) await playUrlAwait(m.audioUrl);
        else if (m.text) await speak(m.text, m.lang ?? 'uz', true);
        if (pausesSession && ttsPlaybackRef.current === playbackId) resumeListening();
      })();
    },
    [playUrlAwait, resumeListening, sessionIsActive, setAiSpeaking, speak],
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
        res = await playgroundTurnAction({
          callId,
          utterance,
          sttMs,
          agentId: selectedAgentId || undefined,
        });
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
    [callId, failAndResume, selectedAgentId, sessionIsActive, speakReply, speechLang, toast, t],
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

  /* ── internal STT: each VAD-finalized utterance uses the existing endpoint ── */

  voiceUtteranceRef.current = async ({ wav, durationSec, rms }, turnId) => {
    const voiceRun = voiceRunRef.current;
    if (process.env.NODE_ENV !== 'production') {
      console.debug('[VOICE] sending_to_stt', {
        turnId,
        durationMs: Math.round(durationSec * 1000),
        rms: Number(rms.toFixed(4)),
        bytes: wav.size,
      });
    }

    // VAD already filters noise; this final media-level guard protects the STT
    // from a broken/muted input or a browser recorder that returned no audio.
    if (durationSec < 0.25 || rms < 0.0015 || wav.size <= 44) {
      failAndResume(t('play.toast.nothingRetry', 'No speech was detected — try again.'), false);
      return;
    }

    setThinking(true);
    const sttStarted = performance.now();
    try {
      const upload = new FormData();
      upload.append('file', wav, `speech-${turnId}.wav`);
      upload.append('language', speechLang);
      const res = await fetch('/api/speech/stt', { method: 'POST', body: upload });
      if (!res.ok) {
        const message = t('play.toast.transcribeFailBody', 'The STT service returned an error.');
        toast.error(t('play.toast.transcribeFailTitle', 'Transcription failed'), message);
        failAndResume(message, false);
        return;
      }
      const text = (((await res.json()) as { text?: string }).text ?? '').trim();
      if (voiceRunRef.current !== voiceRun || !sessionIsActive()) return;
      if (process.env.NODE_ENV !== 'production') console.debug('[VOICE] transcript_received', { turnId });
      if (!text) {
        const message = t('play.toast.nothingRetry', 'No speech was detected — try again.');
        toast.toast({ tone: 'info', title: t('play.toast.nothingTitle', 'Nothing heard'), description: message });
        failAndResume(message, false);
        return;
      }
      setThinking(false);
      await send(text, performance.now() - sttStarted, true, voiceRun);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('play.toast.recordFail', 'Recording failed.');
      toast.error(t('play.toast.transcribeFailTitle', 'Transcription failed'), message);
      failAndResume(message, false);
    } finally {
      if (voiceRunRef.current === voiceRun) setThinking(false);
    }
  };

  // Drop the current conversation, revoking any stored audio URLs first.
  const clearConversation = useCallback(() => {
    setMessages((m) => {
      const keep = new Set(synthCacheRef.current.values());
      m.forEach((x) =>
        [x.audioUrl, ...(x.audioUrls ?? [])].forEach((u) => u && !keep.has(u) && URL.revokeObjectURL(u)),
      );
      return [];
    });
    setCallId(null);
    window.speechSynthesis?.cancel();
    try {
      audioElRef.current?.pause();
    } catch {
      /* nothing playing */
    }
  }, []);

  const stopVoiceConversation = useCallback(() => {
    ttsPlaybackRef.current += 1;
    voiceRunRef.current += 1;
    processingRef.current = null;
    setThinking(false);
    stopSession();
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
    window.speechSynthesis?.cancel();
    try {
      audioElRef.current?.pause();
    } catch {
      /* nothing playing */
    }
  }, [stopSession]);

  const reset = async () => {
    stopVoiceConversation();
    if (callId) await endPlaygroundCallAction(callId, 5);
    clearConversation();
    router.refresh();
  };

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
  const internalStt = speech.stt && speechLang === 'uz';
  const micReady = internalStt ? micSupported() : speechSupported;
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

  // One click starts a persistent session; the active button is the explicit
  // escape hatch that ends it and releases the browser microphone indicator.
  const micToggle = async () => {
    if (micBusy || !voiceInputAvailable(speechLang)) return;
    setMicBusy(true);
    try {
      if (internalStt) {
        if (isSessionActive) stopVoiceConversation();
        else {
          voiceRunRef.current += 1;
          window.speechSynthesis?.cancel();
          audioElRef.current?.pause();
          await startSession();
        }
      } else if (listening) {
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
      </div>

      {chunks === 0 && (
        <Card className="mb-4 bg-warning-soft" padded>
          <div className="flex items-start gap-3">
            <IconAlert size={18} className="mt-px shrink-0 text-warning" />
            <div>
              <p className="text-[13.5px] font-medium text-warning">{t('play.kbEmptyTitle', 'Your knowledge base is empty')}</p>
              <p className="mt-0.5 text-[12.5px] text-warning/80">
                {t('play.kbEmptyBody', 'Every question will escalate until you add a document.')}
              </p>
            </div>
          </div>
        </Card>
      )}

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
                  {agentStatus === 'live' ? t('play.statusLive', 'Live') : t('play.statusDraft', 'Draft')} · {engine}
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
            {/* Inner column keeps the conversation to a readable width and lets the
                empty state center itself vertically instead of hugging the top. */}
            <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-3 p-5">
              {messages.length === 0 && !thinking ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-5 py-8 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <IconSparkle size={22} />
                  </span>
                  <div className="max-w-sm">
                    <p className="text-[15px] font-semibold text-ink">
                      {t('play.emptyTitle', 'Talk to {name}').replace('{name}', agentName)}
                    </p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
                      {t(
                        'play.emptyBody',
                        'Ask anything a caller might — it answers only from your knowledge base. Try one:',
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        onClick={() => void send(s)}
                        className="rounded-full bg-surface-2 px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hairline hover:bg-surface-3 hover:text-ink"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((m) => (
                    <Bubble key={m.id} msg={m} t={t} onReplay={replay} />
                  ))}

                  {thinking && (
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
                      <Spinner size={14} />
                      {t('play.thinking')}
                    </div>
                  )}
                </>
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
                        title={
                          available
                            ? undefined
                            : t('play.voiceSoonTitle', '{lang} voice recognition — available soon').replace(
                                '{lang}',
                                langName(l),
                              )
                        }
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                          active
                            ? 'bg-brand text-white shadow-e1'
                            : available
                              ? 'bg-surface-3 text-ink-2 hover:text-ink'
                              : 'cursor-not-allowed bg-surface-3/40 text-ink-3 opacity-60',
                        )}
                      >
                        {l.toUpperCase()}
                        {!available && (
                          <span className="rounded-full bg-surface px-1 py-[1px] text-[8.5px] font-semibold tracking-wide uppercase text-ink-3 hairline">
                            {t('play.soon', 'soon')}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {speech.stt && (
                    <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-3 hairline">
                      {internalStt
                        ? t('play.sttInternal', 'Uzbek → your STT model')
                        : t('play.sttBrowser', '{lang} → browser voice').replace('{lang}', speechLang.toUpperCase())}
                    </span>
                  )}
                </div>

                {/* Centre: the reason this page exists. */}
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
            <h3 className="text-[14px] font-semibold text-ink">{t('play.lastTurn', 'Last turn')}</h3>
            {lastReply ? (
              <div className="mt-4 space-y-3">
                <MetricRow
                  icon={<IconZap size={15} />}
                  label={t('play.metric.total', 'Total')}
                  value={fmtLatency(lastReply.timings?.totalMs)}
                  good={(lastReply.timings?.totalMs ?? 0) < 1000}
                />
                <StageBar timings={lastReply.timings ?? {}} t={t} />
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

function Bubble({ msg, t, onReplay }: { msg: Msg; t: Translate; onReplay: (m: Msg) => void }) {
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
        {!isCaller && msg.text && !msg.interim && (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onReplay(msg)}
              title={t('play.replay', 'Play')}
              className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3 transition-colors hairline hover:bg-surface-3 hover:text-ink"
            >
              <IconPlay size={11} />
              {t('play.replay', 'Play')}
            </button>
          </div>
        )}
        {msg.reply && (
          <div
            className={cn(
              'mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-3',
              isCaller ? 'justify-end' : 'justify-start',
            )}
          >
            <span className="tabular">{fmtLatency(msg.reply.timings?.totalMs)}</span>
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
