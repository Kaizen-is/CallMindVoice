'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  endPlaygroundCallAction,
  playgroundTurnAction,
  type PlaygroundReply,
} from '@/app/actions/agent';
import { translator } from '@/lib/i18n';
import type { Locale, UiLocale } from '@/lib/types';
import { cn, fmtLatency } from '@/lib/utils';
import { startRecording, micSupported, type Recording } from '@/lib/audio';
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, Spinner } from '@/components/ui/primitives';
import { Input } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import {
  IconAlert,
  IconBook,
  IconCheckCircle,
  IconHeadset,
  IconMic,
  IconMicOff,
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

interface Msg {
  role: 'caller' | 'agent';
  text: string;
  reply?: PlaygroundReply;
  interim?: boolean;
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
  locale,
  industry,
  chunks,
  engine,
  speech,
}: {
  agent: {
    name: string;
    greeting: string;
    voiceId: string;
    speakingRate: number;
    primaryLang: Locale;
    languages: Locale[];
    threshold: number;
    status: string;
  } | null;
  locale: UiLocale;
  industry: string;
  chunks: number;
  engine: string;
  speech: { stt: boolean; tts: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);

  const [mode, setMode] = useState<'voice' | 'text'>('text');
  const [callId, setCallId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [speechLang, setSpeechLang] = useState<Locale>(agent?.primaryLang ?? 'uz');
  const [speechSupported, setSpeechSupported] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [level, setLevel] = useState(0);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<Recording | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const speechStartRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  /* ── speech synthesis ───────────────────────────────────────── */

  const speak = useCallback(
    (text: string, lang: Locale) => {
      if (!ttsEnabled || typeof window === 'undefined' || !window.speechSynthesis) return;
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

  // Prefer the internal Uzbek TTS for Uzbek replies; fall back to the browser
  // voice for Russian/English (the internal model is Uzbek-only).
  const playTts = useCallback(
    async (text: string, lang: Locale) => {
      if (!ttsEnabled || !text.trim()) return;
      if (speech.tts && lang === 'uz') {
        try {
          const res = await fetch('/api/speech/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: agent?.voiceId }),
          });
          if (res.ok) {
            window.speechSynthesis?.cancel();
            const url = URL.createObjectURL(await res.blob());
            const audio = audioElRef.current ?? (audioElRef.current = new Audio());
            audio.src = url;
            audio.onended = () => URL.revokeObjectURL(url);
            void audio.play().catch(() => {});
            return;
          }
        } catch {
          /* fall through to the browser voice */
        }
      }
      speak(text, lang);
    },
    [ttsEnabled, speech.tts, speak, agent?.voiceId],
  );

  /* ── the turn ───────────────────────────────────────────────── */

  const send = useCallback(
    async (text: string, sttMs = 0) => {
      const utterance = text.trim();
      if (!utterance || thinking) return;
      setMessages((m) => [...m.filter((x) => !x.interim), { role: 'caller', text: utterance }]);
      setInput('');
      setThinking(true);

      const res = await playgroundTurnAction({ callId, utterance, sttMs });
      setThinking(false);

      if (!res.ok) {
        toast.error('Could not answer', res.message);
        return;
      }
      setCallId(res.callId ?? null);
      setMessages((m) => [...m, { role: 'agent', text: res.reply ?? '', reply: res }]);
      void playTts(res.reply ?? '', (res.language as Locale) ?? speechLang);
      if (res.escalate) {
        toast.toast({
          tone: 'info',
          title: 'Handed to an operator',
          description: 'It is now waiting in the operator inbox with a summary.',
        });
      }
    },
    [callId, thinking, playTts, speechLang, toast],
  );

  /* ── speech recognition ─────────────────────────────────────── */

  const startListening = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      toast.error('Speech input unavailable', 'Chrome or Edge is needed for in-browser recognition.');
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
          { role: 'caller', text: interim, interim: true },
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
        toast.error('Microphone problem', e.error);
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
  }, [speechLang, send, toast]);

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
      toast.error('Microphone problem', 'Could not access the microphone.');
    }
  }, [toast]);

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
          title: 'Nothing heard',
          description: `Recorded ${durationSec.toFixed(1)}s at level ${rms.toFixed(4)}. If the level is near zero, your mic is muted or the wrong input device is selected.`,
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
        toast.error('Transcription failed', 'The STT service returned an error.');
      }
    } catch (e) {
      failed = true;
      toast.error('Microphone problem', e instanceof Error ? e.message : 'Recording failed.');
    }
    setThinking(false);
    if (text) void send(text, sttMs);
    else if (!failed)
      toast.toast({ tone: 'info', title: 'Nothing heard', description: 'No speech was detected — try again.' });
  }, [send, toast]);

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

  const reset = async () => {
    if (callId) await endPlaygroundCallAction(callId, 5);
    setCallId(null);
    setMessages([]);
    window.speechSynthesis?.cancel();
    router.refresh();
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
    if (micBusy) return;
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
        title="No agent configured"
        description="Set one up in the agent studio first."
      />
    );
  }

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
              {ttsEnabled ? 'Voice on' : 'Voice off'}
            </Button>
            <Button variant="secondary" icon={<IconRefresh size={15} />} onClick={() => void reset()}>
              New call
            </Button>
          </>
        }
      />

      {chunks === 0 && (
        <Card className="mb-4 bg-warning-soft" padded>
          <div className="flex items-start gap-3">
            <IconAlert size={18} className="mt-px shrink-0 text-warning" />
            <div>
              <p className="text-[13.5px] font-medium text-warning">Your knowledge base is empty</p>
              <p className="mt-0.5 text-[12.5px] text-warning/80">
                Every question will escalate until you add a document.
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[1fr_340px]">
        <Card padded={false} className="flex min-h-[560px] flex-col overflow-hidden lg:min-h-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hairline-b">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-white">
                <IconSparkle size={16} />
              </span>
              <div>
                <div className="text-[13.5px] font-semibold text-ink">{agent.name}</div>
                <div className="text-[11.5px] text-ink-3">
                  {agent.status === 'live' ? 'Live' : 'Draft'} · {engine}
                </div>
              </div>
            </div>
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'text', label: 'Type' },
                { value: 'voice', label: 'Speak' },
              ]}
            />
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
                    <p className="text-[15px] font-semibold text-ink">Talk to {agent.name}</p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
                      Ask anything a caller might — it answers only from your knowledge base. Try one:
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
                  {messages.map((m, i) => (
                    <Bubble key={i} msg={m} />
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
            {mode === 'text' ? (
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
                  placeholder="Ask exactly what a caller would ask…"
                  className="flex-1"
                  disabled={thinking}
                />
                <Button type="submit" variant="primary" icon={<IconSend size={15} />} disabled={thinking}>
                  Send
                </Button>
              </form>
            ) : (
              <div className="flex flex-col items-center gap-3.5">
                <div className="flex items-center gap-1.5">
                  {agent.languages.map((l) => (
                    <button
                      key={l}
                      onClick={() => setSpeechLang(l)}
                      className={cn(
                        'rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
                        speechLang === l
                          ? 'bg-brand text-white shadow-e1'
                          : 'bg-surface-3 text-ink-2 hover:text-ink',
                      )}
                    >
                      {l.toUpperCase()}
                    </button>
                  ))}
                </div>

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
                  <p className="text-[12.5px] text-ink-3">
                    {!micReady
                      ? 'Microphone needs localhost or HTTPS — open http://localhost:3000'
                      : listening
                        ? 'Recording — tap the mic to stop'
                        : 'Tap the mic and speak'}
                  </p>
                  {speech.stt && (
                    <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-ink-3 hairline">
                      {internalStt ? 'Uzbek → your STT model' : `${speechLang.toUpperCase()} → browser voice`}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto">
          <Card>
            <h3 className="text-[14px] font-semibold text-ink">Last turn</h3>
            {lastReply ? (
              <div className="mt-4 space-y-3">
                <MetricRow
                  icon={<IconZap size={15} />}
                  label="Total"
                  value={fmtLatency(lastReply.timings?.totalMs)}
                  good={(lastReply.timings?.totalMs ?? 0) < 1000}
                />
                <StageBar timings={lastReply.timings ?? {}} />
                <div className="space-y-2 pt-2">
                  <MetricRow
                    icon={<IconCheckCircle size={15} />}
                    label="Confidence"
                    value={(lastReply.confidence ?? 0).toFixed(2)}
                    good={(lastReply.confidence ?? 0) >= agent.threshold}
                  />
                  <MetricRow
                    icon={<IconBook size={15} />}
                    label="Passages searched"
                    value={String(lastReply.retrieval?.totalChunks ?? 0)}
                  />
                  <MetricRow
                    icon={<IconSparkle size={15} />}
                    label="Intent"
                    value={lastReply.intent ?? '—'}
                  />
                  <MetricRow
                    icon={<IconHeadset size={15} />}
                    label="Outcome"
                    value={lastReply.escalate ? `Escalated (${lastReply.escalate})` : 'Answered'}
                    good={!lastReply.escalate}
                  />
                  <MetricRow
                    icon={<IconSparkle size={15} />}
                    label="Engine"
                    value={lastReply.engine ?? '—'}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">
                Ask something and the full pipeline breakdown appears here.
              </p>
            )}
          </Card>

          <Card>
            <h3 className="text-[14px] font-semibold text-ink">Sources used</h3>
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
                Each answer lists the exact passages it came from.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ── pieces ──────────────────────────────────────────────────── */

function Bubble({ msg }: { msg: Msg }) {
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
            <span className="tabular">{fmtLatency(msg.reply.timings?.totalMs)}</span>
            <span className="tabular">conf {(msg.reply.confidence ?? 0).toFixed(2)}</span>
            {msg.reply.escalate && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">
                → operator
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
  { key: 'sttMs', label: 'Speech', color: 'var(--series-1)' },
  { key: 'retrievalMs', label: 'Retrieval', color: 'var(--series-3)' },
  { key: 'llmMs', label: 'Generation', color: 'var(--series-2)' },
  { key: 'ttsMs', label: 'Synthesis', color: 'var(--series-4)' },
];

function StageBar({ timings }: { timings: Record<string, number> }) {
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
              title={`${s.label} ${Math.round(v)} ms`}
            />
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {STAGES.map((s) => (
          <div key={s.key} className="flex items-center justify-between text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 text-ink-3">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="text-ink-2 tabular">{Math.round(timings[s.key] ?? 0)} ms</span>
          </div>
        ))}
      </div>
    </div>
  );
}
