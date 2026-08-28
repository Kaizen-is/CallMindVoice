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
import { startRecording, micSupported, type Recording } from '@/lib/audio';
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

/* ── streamed playback helpers ──────────────────────────────────────────────
   The server sends raw 8 kHz mono PCM with no container, because a container
   needs its length up front and the whole point is that the length is not known
   yet. `<audio>` cannot start on that, so the Playground schedules the chunks
   through Web Audio instead — which also gives sample-accurate, gapless joins
   between sentences that chaining <audio> elements never achieves. ── */

const TTS_RATE = 8000;

/** One PCM chunk → an AudioBuffer ready to be scheduled. */
function pcmToAudioBuffer(ctx: AudioContext, pcm: Uint8Array): AudioBuffer | null {
  const frames = Math.floor(pcm.length / 2);
  if (!frames) return null;
  const buffer = ctx.createBuffer(1, frames, TTS_RATE);
  const channel = buffer.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

/** Everything that was streamed → a WAV blob URL, so ▶ replays the same audio. */
function pcmChunksToWavUrl(chunks: Uint8Array[]): string | null {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) return null;
  const out = new Uint8Array(44 + total);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + total, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TTS_RATE, true);
  view.setUint32(28, TTS_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, total, true);
  let at = 44;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return URL.createObjectURL(new Blob([out], { type: 'audio/wav' }));
}

/* Hands-free tuning: after this much continuous silence the utterance is
   considered finished and sent — no click needed. */
const SILENCE_STOP_MS = 5000;
/* No speech at all for this long → give up the take (exits the loop). */
const NO_SPEECH_GIVEUP_MS = 15000;
/* Sustained speech during agent playback longer than this = barge-in;
   shorter blips ("ha", coughs) are ignored as backchannels. */
const BARGE_SUSTAIN_MS = 500;
const VOICE_RMS = 0.012;

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
  const [level, setLevel] = useState(0);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<Recording | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechStartRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Msg[]>([]);
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
      messagesRef.current.forEach((x) =>
        [x.audioUrl, ...(x.audioUrls ?? [])].forEach((u) => u && URL.revokeObjectURL(u)),
      );
    },
    [],
  );

  /* ── speech synthesis ───────────────────────────────────────── */

  // Browser voice (used for RU/EN, and as a fallback when the internal TTS is
  // unavailable). `force` lets an explicit replay play even when auto-voice is off.
  const speak = useCallback(
    (text: string, lang: Locale, force = false) => {
      if ((!force && !ttsEnabled) || typeof window === 'undefined' || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = SPEECH_LANG[lang] ?? 'ru-RU';
      u.rate = agent?.speakingRate ?? 1;
      // Prefer a voice that actually matches the language rather than the default.
      const voices = window.speechSynthesis.getVoices();
      const match =
        voices.find((v) => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2))) ??
        voices.find((v) => v.lang.toLowerCase().startsWith('ru'));
      if (match) u.voice = match;
      window.speechSynthesis.speak(u);
    },
    [ttsEnabled, agent?.speakingRate],
  );

  // Play a stored audio URL through the one shared element, without revoking it —
  // the message keeps the URL so its ▶ button replays the identical audio.
  const playUrl = useCallback((url: string) => {
    window.speechSynthesis?.cancel();
    const audio = audioElRef.current ?? (audioElRef.current = new Audio());
    try {
      audio.pause();
    } catch {
      /* nothing playing */
    }
    audio.src = url;
    void audio.play().catch(() => {});
  }, []);

  // Like playUrl, but resolves when playback finishes — the streaming queue
  // chains chunks on this.
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

  // "Real talk" loop flag: set when the user starts talking with the mic; when
  // the agent's reply finishes playing, the mic re-opens by itself.
  const autoTalkRef = useRef(false);
  // Filled in below, after startInternalStt exists (declaration order).
  const autoRestartRef = useRef<() => void>(() => {});
  // Filled in below: ends the current take (same as clicking the mic).
  const autoStopRef = useRef<() => void>(() => {});
  const vadRef = useRef<{ ctx: AudioContext; raf: number } | null>(null);

  const endVad = useCallback(() => {
    const v = vadRef.current;
    vadRef.current = null;
    if (!v) return;
    cancelAnimationFrame(v.raf);
    void v.ctx.close().catch(() => {});
  }, []);

  // Watch the live mic level; once the user has spoken and then stays silent
  // for SILENCE_STOP_MS, the take ends and goes to the agent automatically.
  const beginVad = useCallback(
    (stream: MediaStream) => {
      endVad();
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const started = performance.now();
      let lastVoice = 0;
      const state = { ctx, raf: 0 };
      vadRef.current = state;
      const tick = () => {
        if (vadRef.current !== state) return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > VOICE_RMS) lastVoice = now;
        if (lastVoice && now - lastVoice > SILENCE_STOP_MS) {
          endVad();
          autoStopRef.current();
          return;
        }
        if (!lastVoice && now - started > NO_SPEECH_GIVEUP_MS) {
          endVad();
          autoStopRef.current();
          return;
        }
        state.raf = requestAnimationFrame(tick);
      };
      state.raf = requestAnimationFrame(tick);
    },
    [endVad],
  );

  // Barge-in monitor: while the agent speaks, a lightweight echo-cancelled mic
  // watches for sustained user speech; a short "ha" is ignored.
  const bargeRef = useRef(false);
  const bargeMonRef = useRef<{ ctx: AudioContext; raf: number; stream: MediaStream } | null>(null);

  const endBargeMonitor = useCallback(() => {
    const m = bargeMonRef.current;
    bargeMonRef.current = null;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    m.stream.getTracks().forEach((tr) => tr.stop());
    void m.ctx.close().catch(() => {});
  }, []);

  const beginBargeMonitor = useCallback(async () => {
    if (bargeMonRef.current) return;
    bargeRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let voiceSince = 0;
      const state = { ctx, raf: 0, stream };
      bargeMonRef.current = state;
      const tick = () => {
        if (bargeMonRef.current !== state) return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > VOICE_RMS) {
          if (!voiceSince) voiceSince = now;
          else if (now - voiceSince > BARGE_SUSTAIN_MS) {
            bargeRef.current = true;
            try {
              audioElRef.current?.pause();
            } catch {
              /* not playing */
            }
            return; // monitor done; speakReply reacts to the flag
          }
        } else {
          voiceSince = 0;
        }
        state.raf = requestAnimationFrame(tick);
      };
      state.raf = requestAnimationFrame(tick);
    } catch {
      /* no mic permission — playback simply is not interruptible */
    }
  }, []);

  // Web Audio context + the sources currently scheduled, so a barge-in can cut
  // playback instantly rather than waiting for the current sentence to finish.
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

  /**
   * Speak `text` from the streaming endpoint.
   *
   * Chunks are scheduled on the audio clock as they arrive — each sentence is
   * queued to start exactly where the previous one ends, so the joins are
   * inaudible — and the first one starts playing while the rest is still being
   * rendered on the server. Resolves once playback finishes, or when a barge-in
   * cuts it short. Returns false if the stream could not be used at all, so the
   * caller can fall back to the browser voice.
   */
  const speakStream = useCallback(
    async (msgId: string, text: string): Promise<boolean> => {
      const ctx = (audioCtxRef.current ??= new AudioContext());
      // Autoplay policy: the context starts suspended until a user gesture.
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
            stream: true,
          }),
          signal: controller.signal,
        });
      } catch {
        return false; // aborted or offline — the caller falls back
      }
      if (!res.ok || !res.body) return false;

      const reader = res.body.getReader();
      const received: Uint8Array[] = [];
      // A chunk boundary can land mid-sample; hold the odd byte for the next one.
      let leftover = new Uint8Array(0);
      // Where the next buffer should start on the audio clock. The initial
      // offset is a small cushion so the first buffer is scheduled slightly in
      // the future rather than in the past, which would clip its opening.
      let playhead = 0;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (bargeRef.current) break;
          received.push(value);

          const joined =
            leftover.length === 0
              ? value
              : (() => {
                  const merged = new Uint8Array(leftover.length + value.length);
                  merged.set(leftover);
                  merged.set(value, leftover.length);
                  return merged;
                })();
          const usable = joined.length - (joined.length % 2);
          leftover = joined.subarray(usable);
          if (!usable) continue;

          const buffer = pcmToAudioBuffer(ctx, joined.subarray(0, usable));
          if (!buffer) continue;

          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          playhead = Math.max(playhead, ctx.currentTime + 0.06);
          source.start(playhead);
          playhead += buffer.duration;
          scheduledRef.current.push(source);
        }
      } catch {
        /* aborted mid-stream — whatever was scheduled still plays out */
      }

      if (!received.length) return false;

      // Hand the assembled audio to the bubble so ▶ replays the identical take.
      const url = pcmChunksToWavUrl(received);
      if (url) setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, audioUrl: url } : x)));

      // Wait for the scheduled audio to finish, checking often enough that a
      // barge-in stops the voice mid-sentence rather than at the next boundary.
      while (ctx.currentTime < playhead) {
        if (bargeRef.current) {
          stopStream();
          break;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
      scheduledRef.current = [];
      streamAbortRef.current = null;
      return true;
    },
    [agent?.voiceId, voiceOverride, stopStream],
  );

  // Generate a reply's audio and play it — STREAMED for Uzbek: the text is cut
  // into small pieces (first one tiny, so speech starts almost immediately),
  // each piece is synthesised while the previous one plays, and long answers
  // open with a short spoken filler so the wait is never silent.
  const speakReply = useCallback(
    async (msgId: string, text: string, lang: Locale) => {
      if (!ttsEnabled || !text.trim()) return;
      if (speech.tts && lang === 'uz') {
        // Watch for the caller talking over the agent (barge-in).
        if (autoTalkRef.current) void beginBargeMonitor();
        // One request, played as it renders. The server splits the reply into
        // sentences and streams each as it lands, so speech starts after the
        // first sentence rather than after the last — no client-side chunking,
        // no round trip per piece.
        const spoken = await speakStream(msgId, text);
        endBargeMonitor();
        if (spoken) {
          // Barged or finished — either way the mic reopens for the caller.
          autoRestartRef.current();
          return;
        }
      }
      speak(text, lang);
    },
    [ttsEnabled, speech.tts, speakStream, speak, beginBargeMonitor, endBargeMonitor],
  );

  // Replay control on an agent bubble: the exact stored audio if we have it,
  // otherwise re-synthesise through the browser voice.
  const replay = useCallback(
    (m: Msg) => {
      if (m.audioUrls?.length) {
        void (async () => {
          for (const u of m.audioUrls ?? []) await playUrlAwait(u);
        })();
      } else if (m.audioUrl) playUrl(m.audioUrl);
      else if (m.text) speak(m.text, m.lang ?? 'uz', true);
    },
    [playUrl, playUrlAwait, speak],
  );

  /* ── the turn ───────────────────────────────────────────────── */

  // Voice here is "record then answer", exactly like a phone turn: we capture a
  // whole utterance, transcribe it, run the turn, and speak the reply. It is NOT
  // real-time streaming or barge-in — that is deliberately out of scope.
  const send = useCallback(
    async (text: string, sttMs = 0) => {
      const utterance = text.trim();
      if (!utterance || thinking) return;
      setMessages((m) => [
        ...m.filter((x) => !x.interim),
        { id: nextId(), role: 'caller', text: utterance },
      ]);
      setInput('');
      setThinking(true);

      const res = await playgroundTurnAction({
        callId,
        utterance,
        sttMs,
        agentId: selectedAgentId || undefined,
      });
      setThinking(false);

      if (!res.ok) {
        toast.error(t('play.toast.answerFailTitle', 'Could not answer'), res.message);
        return;
      }
      setCallId(res.callId ?? null);
      const replyLang = (res.language as Locale) ?? speechLang;
      const msgId = nextId();
      setMessages((m) => [...m, { id: msgId, role: 'agent', text: res.reply ?? '', reply: res, lang: replyLang }]);
      void speakReply(msgId, res.reply ?? '', replyLang);
      if (res.escalate) {
        toast.toast({
          tone: 'info',
          title: t('play.toast.handedTitle', 'Handed to an operator'),
          description: t('play.toast.handedBody', 'It is now waiting in the operator inbox with a summary.'),
        });
      }
    },
    [callId, thinking, selectedAgentId, speakReply, speechLang, toast, t],
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

  /* ── internal STT: record the mic, transcribe with your model ── */

  const startInternalStt = useCallback(async () => {
    try {
      // Barge-in: silence the agent before the mic opens, so its voice from
      // the speakers cannot leak into (or be echo-cancelled out of) the take.
      window.speechSynthesis?.cancel();
      audioElRef.current?.pause();
      recorderRef.current = await startRecording();
      // Push-to-talk: the user clicks to start and clicks to finish. The
      // hands-free VAD loop (beginVad + autoTalkRef) is disabled — silence
      // detection fed noise-hallucinated takes ("musiqa"…) back into the agent.
      speechStartRef.current = performance.now();
      setListening(true);
    } catch {
      toast.error(t('play.toast.micTitle', 'Microphone problem'), t('play.toast.micNoAccess', 'Could not access the microphone.'));
    }
  }, [beginVad, toast, t]);

  const stopInternalStt = useCallback(async () => {
    endVad();
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    setListening(false);
    setThinking(true);
    let text = '';
    let sttMs = 0;
    let failed = false;
    try {
      const { wav, durationSec, rms } = await rec.stop();
      // Diagnostic: open DevTools → Console to see the captured level.
      console.log('[stt] captured', { durationSec: +durationSec.toFixed(2), rms: +rms.toFixed(4), bytes: wav.size });
      // Reject a stray tap or true silence; thresholds are low so a quiet mic passes.
      if (durationSec < 0.35 || rms < 0.0015) {
        // Silence ends the hands-free loop — the natural way to stop talking.
        autoTalkRef.current = false;
        setThinking(false);
        toast.toast({
          tone: 'info',
          title: t('play.toast.nothingTitle', 'Nothing heard'),
          description: t(
            'play.toast.nothingDetail',
            'Recorded {sec}s at level {level}. If the level is near zero, your mic is muted or the wrong input device is selected.',
          )
            .replace('{sec}', durationSec.toFixed(1))
            .replace('{level}', rms.toFixed(4)),
        });
        return;
      }
      sttMs = performance.now() - speechStartRef.current;
      const upload = new FormData();
      upload.append('file', wav, 'speech.wav');
      const res = await fetch('/api/speech/stt', { method: 'POST', body: upload });
      if (res.ok) text = (((await res.json()) as { text?: string }).text ?? '').trim();
      else {
        failed = true;
        toast.error(
          t('play.toast.transcribeFailTitle', 'Transcription failed'),
          t('play.toast.transcribeFailBody', 'The STT service returned an error.'),
        );
      }
    } catch (e) {
      failed = true;
      toast.error(
        t('play.toast.micTitle', 'Microphone problem'),
        e instanceof Error ? e.message : t('play.toast.recordFail', 'Recording failed.'),
      );
    }
    if (failed) autoTalkRef.current = false;
    setThinking(false);
    if (text) void send(text, sttMs);
    else if (!failed)
      toast.toast({
        tone: 'info',
        title: t('play.toast.nothingTitle', 'Nothing heard'),
        description: t('play.toast.nothingRetry', 'No speech was detected — try again.'),
      });
  }, [endVad, send, toast, t]);

  // Close the "real talk" loop: when a spoken reply finishes and the loop is
  // active, the mic re-opens by itself. (Assigned each render so the ref used
  // inside speakReply — declared earlier — always sees the fresh closure.)
  useEffect(() => {
    autoRestartRef.current = () => {
      if (autoTalkRef.current && ttsEnabled && speech.stt && !recorderRef.current && !thinking) {
        void startInternalStt();
      }
    };
    autoStopRef.current = () => {
      if (recorderRef.current) void stopInternalStt();
    };
  });

  useEffect(
    () => () => {
      endVad();
      endBargeMonitor();
    },
    [endVad, endBargeMonitor],
  );

  // A simple animated level while listening — the Web Speech API gives no
  // amplitude, so this is an activity indicator rather than a real meter.
  useEffect(() => {
    if (!listening) {
      setLevel(0);
      return;
    }
    const iv = setInterval(() => setLevel(0.25 + Math.random() * 0.75), 110);
    return () => clearInterval(iv);
  }, [listening]);

  // Drop the current conversation, revoking any stored audio URLs first.
  const clearConversation = useCallback(() => {
    // Whatever the agent was mid-way through saying goes with it.
    stopStream();
    window.speechSynthesis?.cancel();
    setMessages((m) => {
      m.forEach((x) =>
        [x.audioUrl, ...(x.audioUrls ?? [])].forEach((u) => u && URL.revokeObjectURL(u)),
      );
      return [];
    });
    setCallId(null);
    try {
      audioElRef.current?.pause();
    } catch {
      /* nothing playing */
    }
  }, [stopStream]);

  const reset = async () => {
    if (callId) await endPlaygroundCallAction(callId, 5);
    clearConversation();
    router.refresh();
  };

  // Switching who you talk to starts a fresh session with a clean transcript.
  const switchAgent = (agentId: string) => {
    if (agentId === selectedAgentId) return;
    if (callId) void endPlaygroundCallAction(callId, 5);
    setSelectedAgentId(agentId);
    clearConversation();
  };

  const lastReply = [...messages].reverse().find((m) => m.reply)?.reply;

  // Uzbek speech goes to your STT model; RU/EN use the browser recogniser
  // (the internal model is Uzbek-only).
  const internalStt = speech.stt && speechLang === 'uz';
  const micReady = internalStt ? micSupported() : speechSupported;
  // Click-to-toggle: click once to start, again to stop. This avoids the
  // press-and-hold race where a quick tap or release-off-button left a stuck,
  // leaked recorder feeding the model a tiny clip.
  const micToggle = async () => {
    if (micBusy || !voiceInputAvailable(speechLang)) return;
    setMicBusy(true);
    try {
      if (listening) {
        if (internalStt) await stopInternalStt();
        else stopListening();
      } else if (internalStt) {
        await startInternalStt();
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
                if (ttsEnabled) window.speechSynthesis?.cancel();
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
                listening
                  ? 'bg-danger-soft text-danger'
                  : thinking
                    ? 'bg-warning-soft text-warning'
                    : 'bg-surface-3 text-ink-3',
              )}
            >
              {listening ? <IconMic size={12} /> : thinking ? <Spinner size={12} /> : <IconVolume size={12} />}
              {listening
                ? t('play.micRecording', 'Recording — tap the mic to stop')
                : thinking
                  ? t('play.thinking')
                  : t('play.voiceReady', 'Voice ready')}
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
                        onClick={() => available && setSpeechLang(l)}
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
                    disabled={!micReady || micBusy || (thinking && !listening)}
                    aria-label={listening ? t('play.micRecording') : t('play.micTap')}
                    className={cn(
                      'relative flex h-[72px] w-[72px] items-center justify-center rounded-full shadow-e2 transition-all duration-200 disabled:opacity-40',
                      listening
                        ? 'animate-pulse-ring bg-danger text-white'
                        : 'bg-brand text-white hover:scale-105 hover:brightness-110',
                    )}
                  >
                    <IconMic size={28} />
                    {listening && (
                      <span
                        className="absolute inset-0 rounded-full ring-4 ring-danger/30 transition-transform"
                        style={{ transform: `scale(${1 + level * 0.35})` }}
                      />
                    )}
                  </button>
                  <p className="max-w-[16rem] text-center text-[12px] leading-snug text-ink-3">
                    {!micReady
                      ? t('play.micHttps', 'Microphone needs localhost or HTTPS — open http://localhost:3000')
                      : listening
                        ? t('play.micRecording', 'Recording — tap the mic to stop')
                        : t('play.micTap', 'Tap the mic and speak')}
                  </p>
                </div>

                {/* Right: the escape hatch to the keyboard. */}
                <div className="flex justify-start sm:justify-end">
                  <Button variant="secondary" icon={<IconSend size={15} />} onClick={() => setTyping(true)}>
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
