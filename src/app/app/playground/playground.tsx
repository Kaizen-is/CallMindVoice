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

interface Msg {
  id: string;
  role: 'caller' | 'agent';
  text: string;
  reply?: PlaygroundReply;
  interim?: boolean;
  /** Object URL of this reply's synthesised audio — set once, replayable, kept until reset. */
  audioUrl?: string;
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
  const [callId, setCallId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
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
      messagesRef.current.forEach((x) => x.audioUrl && URL.revokeObjectURL(x.audioUrl));
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

  // Ask the internal Uzbek TTS for a real audio blob and hand back an object URL
  // (the caller stores it on the message so it can be replayed as-is).
  const synthUz = useCallback(
    async (text: string): Promise<string | null> => {
      try {
        const res = await fetch('/api/speech/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: agent?.voiceId }),
        });
        if (res.ok) return URL.createObjectURL(await res.blob());
      } catch {
        /* fall back to the browser voice */
      }
      return null;
    },
    [agent?.voiceId],
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

  // Generate a reply's audio once, attach it to that message, and auto-play it.
  const speakReply = useCallback(
    async (msgId: string, text: string, lang: Locale) => {
      if (!ttsEnabled || !text.trim()) return;
      // Prefer the internal Uzbek TTS for Uzbek replies; fall back to the browser
      // voice for Russian/English (the internal model is Uzbek-only).
      if (speech.tts && lang === 'uz') {
        const url = await synthUz(text);
        if (url) {
          setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, audioUrl: url } : x)));
          playUrl(url);
          return;
        }
      }
      speak(text, lang);
    },
    [ttsEnabled, speech.tts, synthUz, playUrl, speak],
  );

  // Replay control on an agent bubble: the exact stored audio if we have it,
  // otherwise re-synthesise through the browser voice.
  const replay = useCallback(
    (m: Msg) => {
      if (m.audioUrl) playUrl(m.audioUrl);
      else if (m.text) speak(m.text, m.lang ?? 'uz', true);
    },
    [playUrl, speak],
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
      recorderRef.current = await startRecording();
      speechStartRef.current = performance.now();
      setListening(true);
    } catch {
      toast.error(t('play.toast.micTitle', 'Microphone problem'), t('play.toast.micNoAccess', 'Could not access the microphone.'));
    }
  }, [toast, t]);

  const stopInternalStt = useCallback(async () => {
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
      const res = await fetch('/api/speech/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
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
    setThinking(false);
    if (text) void send(text, sttMs);
    else if (!failed)
      toast.toast({
        tone: 'info',
        title: t('play.toast.nothingTitle', 'Nothing heard'),
        description: t('play.toast.nothingRetry', 'No speech was detected — try again.'),
      });
  }, [send, toast, t]);

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
    setMessages((m) => {
      m.forEach((x) => x.audioUrl && URL.revokeObjectURL(x.audioUrl));
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
    <div className="mx-auto flex max-w-[1400px] flex-col lg:h-[calc(100vh_-_112px)]">
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

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_360px]">
        {/* ── Left: the text chat. Both this composer and the live-voice mic on
            the right feed the same transcript below. ── */}
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
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-2.5 py-1 text-[11.5px] font-medium text-ink-3">
              <IconSend size={12} />
              {t('play.textPanel', 'Text chat')}
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

          <div className="bg-surface-2 px-5 py-4 hairline-t">
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
              />
              <Button type="submit" variant="primary" icon={<IconSend size={15} />} disabled={thinking}>
                {t('play.send', 'Send')}
              </Button>
            </form>
          </div>
        </Card>

        {/* ── Right: live voice panel + the pipeline metrics. ── */}
        <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto">
          <Card>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-soft text-brand">
                <IconMic size={15} />
              </span>
              <div>
                <h3 className="text-[14px] font-semibold text-ink">{t('play.livePanel', 'Live voice')}</h3>
                <p className="text-[11.5px] text-ink-3">
                  {t('play.livePanelHint', 'Speak and it answers right away, like a call.')}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-col items-center gap-3.5">
              <div className="flex items-center gap-1.5">
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
                        'inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
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
              </div>
              {agent.languages.some((l) => !voiceInputAvailable(l)) && (
                <p className="max-w-[15rem] text-center text-[11px] leading-snug text-ink-3">
                  {t(
                    'play.voiceUzOnly',
                    'Voice input is Uzbek-only for now — Russian and English recognition are coming soon.',
                  )}
                </p>
              )}

              <button
                onClick={() => void micToggle()}
                disabled={!micReady || micBusy || (thinking && !listening)}
                className={cn(
                  'relative flex h-16 w-16 items-center justify-center rounded-full shadow-e2 transition-all duration-200 disabled:opacity-40',
                  listening
                    ? 'animate-pulse-ring bg-danger text-white'
                    : 'bg-brand text-white hover:scale-105 hover:brightness-110',
                )}
              >
                <IconMic size={25} />
                {listening && (
                  <span
                    className="absolute inset-0 rounded-full ring-4 ring-danger/30 transition-transform"
                    style={{ transform: `scale(${1 + level * 0.35})` }}
                  />
                )}
              </button>

              <div className="flex flex-col items-center gap-1.5">
                <p className="text-center text-[12.5px] text-ink-3">
                  {!micReady
                    ? t('play.micHttps', 'Microphone needs localhost or HTTPS — open http://localhost:3000')
                    : listening
                      ? t('play.micRecording', 'Recording — tap the mic to stop')
                      : t('play.micTap', 'Tap the mic and speak')}
                </p>
                {speech.stt && (
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-3 hairline">
                    {internalStt
                      ? t('play.sttInternal', 'Uzbek → your STT model')
                      : t('play.sttBrowser', '{lang} → browser voice').replace('{lang}', speechLang.toUpperCase())}
                  </span>
                )}
              </div>
            </div>
          </Card>

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
