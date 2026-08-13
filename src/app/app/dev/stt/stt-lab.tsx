'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { saveSpeechTestAction } from '@/app/actions/ops';
import { translator } from '@/lib/i18n';
import type { SpeechTest, UiLocale } from '@/lib/types';
import { cn, relativeTime } from '@/lib/utils';
import { startRecording, micSupported, type Recording } from '@/lib/audio';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Segmented,
  Spinner,
} from '@/components/ui/primitives';
import { FileDrop } from '@/components/ui/forms';
import { useToast } from '@/components/ui/overlays';
import {
  IconAlert,
  IconCode,
  IconCopy,
  IconMic,
  IconStop,
  IconWave,
  IconX,
} from '@/components/icons';

/* ── audio helpers: decode any uploaded file → 16 kHz mono WAV, the exact
   contract the internal STT expects (mirrors src/lib/audio.ts). ── */

const TARGET_RATE = 16000;

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function fileToWav16k(file: File): Promise<Blob> {
  const buf = await file.arrayBuffer();
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    void ctx.close();
  }
  const pcm = resample(decoded.getChannelData(0), decoded.sampleRate, TARGET_RATE);
  return encodeWav(pcm, TARGET_RATE);
}

/* ── source: either an uploaded file or a fresh mic recording ── */

type Source = { kind: 'file'; file: File } | { kind: 'rec'; wav: Blob };

export function SttLab({
  locale,
  history: initialHistory,
  speech,
}: {
  locale: UiLocale;
  history: SpeechTest[];
  speech: { stt: boolean };
}) {
  const t = translator(locale);
  const toast = useToast();

  const [history, setHistory] = useState<SpeechTest[]>(initialHistory);
  const [source, setSource] = useState<Source | null>(null);
  const [listening, setListening] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const recorderRef = useRef<Recording | null>(null);

  useEffect(() => setMicReady(micSupported()), []);
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
    },
    [],
  );

  const sourceLabel =
    source?.kind === 'file' ? source.file.name : source ? t('dev.stt.recordedNote') : '';

  const startRec = useCallback(async () => {
    try {
      recorderRef.current = await startRecording();
      setSource(null);
      setResult(null);
      setListening(true);
    } catch {
      toast.error(t('dev.stt.micProblem'), t('dev.stt.micNoAccess'));
    }
  }, [toast, t]);

  const stopRec = useCallback(async () => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) return;
    setListening(false);
    try {
      const { wav, durationSec, rms } = await rec.stop();
      if (durationSec < 0.35 || rms < 0.0015) {
        toast.toast({ tone: 'info', title: t('dev.stt.nothingTitle'), description: t('dev.stt.nothingBody') });
        return;
      }
      setSource({ kind: 'rec', wav });
    } catch (e) {
      toast.error(t('dev.stt.micProblem'), e instanceof Error ? e.message : t('dev.stt.micNoAccess'));
    }
  }, [toast, t]);

  const toggleRec = () => {
    if (listening) void stopRec();
    else void startRec();
  };

  const clearSource = () => {
    setSource(null);
    setResult(null);
  };

  const generate = async () => {
    if (!speech.stt || !source || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const wav = source.kind === 'file' ? await fileToWav16k(source.file) : source.wav;
      const marker = source.kind === 'file' ? source.file.name : 'recording';
      const res = await fetch('/api/speech/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
      if (!res.ok) {
        toast.error(t('dev.stt.failTitle'), t('dev.stt.failBody'));
        return;
      }
      const text = (((await res.json()) as { text?: string }).text ?? '').trim();
      if (!text) {
        toast.toast({ tone: 'info', title: t('dev.stt.nothingTitle'), description: t('dev.stt.nothingBody') });
        return;
      }
      setResult(text);
      const saved = await saveSpeechTestAction({ kind: 'stt', input: marker, output: text });
      if (saved.ok) setHistory((h) => [saved.test, ...h].slice(0, 20));
    } catch (e) {
      toast.error(t('dev.stt.failTitle'), e instanceof Error ? e.message : t('dev.stt.failBody'));
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      toast.success(t('dev.copied'));
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title={t('dev.stt.title')} subtitle={t('dev.stt.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── MAIN: input + result ── */}
        <div className="space-y-4">
          <Card padded={false}>
            <div className="flex items-center gap-2 px-5 py-4 hairline-b">
              <IconWave size={16} className="text-ink-3" />
              <h3 className="text-[14px] font-semibold text-ink">{t('dev.stt.inputTitle')}</h3>
            </div>

            {!speech.stt ? (
              <EmptyState
                icon={<IconAlert size={20} />}
                title={t('dev.stt.notConfiguredTitle')}
                description={t('dev.stt.notConfiguredBody')}
              />
            ) : (
              <div className="space-y-4 p-5">
                <FileDrop
                  accept="audio/*"
                  multiple={false}
                  busy={listening}
                  onFiles={(files) => {
                    if (files[0]) {
                      setSource({ kind: 'file', file: files[0] });
                      setResult(null);
                    }
                  }}
                  dropLabel={t('filedrop.drop', 'Drop files or')}
                  browseLabel={t('filedrop.browse', 'browse')}
                  hint={t('dev.stt.uploadHint')}
                />

                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
                  <span className="text-[11.5px] tracking-wide text-ink-3 uppercase">{t('dev.stt.or')}</span>
                  <span className="h-px flex-1 bg-[rgb(var(--line)/var(--line-alpha))]" />
                </div>

                <div className="flex flex-col items-center gap-2">
                  <Button
                    variant={listening ? 'danger' : 'secondary'}
                    icon={listening ? <IconStop size={15} /> : <IconMic size={15} />}
                    onClick={toggleRec}
                    disabled={!micReady}
                    className={cn(listening && 'animate-pulse')}
                  >
                    {listening ? t('dev.stt.stop') : t('dev.stt.record')}
                  </Button>
                  {listening && <p className="text-[12px] text-ink-3">{t('dev.stt.recording')}</p>}
                </div>

                {source && !listening && (
                  <div className="flex items-center justify-between gap-3 rounded-[10px] bg-surface-2 px-3.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone="success" dot>
                        {t('dev.stt.ready')}
                      </Badge>
                      <span className="truncate text-[12.5px] text-ink-2">{sourceLabel}</span>
                    </div>
                    <button
                      type="button"
                      onClick={clearSource}
                      aria-label={t('dev.stt.clear')}
                      title={t('dev.stt.clear')}
                      className="shrink-0 rounded-full p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                )}

                <Button
                  variant="primary"
                  full
                  loading={busy}
                  disabled={!source || listening}
                  icon={!busy ? <IconWave size={15} /> : undefined}
                  onClick={() => void generate()}
                >
                  {busy ? t('dev.stt.generating') : t('dev.stt.generate')}
                </Button>
              </div>
            )}
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-ink">{t('dev.stt.resultTitle')}</h3>
              {result && (
                <Button size="xs" variant="ghost" icon={<IconCopy size={13} />} onClick={() => void copyResult()}>
                  {t('dev.copy')}
                </Button>
              )}
            </div>
            {busy ? (
              <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-3">
                <Spinner size={14} />
                {t('dev.stt.generating')}
              </div>
            ) : result ? (
              <p className="mt-3 rounded-[10px] bg-surface-2 p-3.5 text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
                {result}
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-ink-3">{t('dev.stt.resultEmpty')}</p>
            )}
          </Card>
        </div>

        {/* ── RIGHT: history ── */}
        <Card padded={false} className="lg:sticky lg:top-20 h-max">
          <div className="px-5 py-4 hairline-b">
            <h3 className="text-[14px] font-semibold text-ink">{t('dev.stt.historyTitle')}</h3>
          </div>
          {history.length ? (
            <div className="max-h-[560px] divide-y divide-[rgb(var(--line)/var(--line-alpha))] overflow-y-auto">
              {history.map((h) => (
                <div key={h.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px] font-medium text-ink-2">
                      {h.input === 'recording' ? t('dev.stt.recordedNote') : h.input}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-3">{relativeTime(h.created_at, locale)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink">{h.output}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-[13px] text-ink-3">{t('dev.stt.historyEmpty')}</div>
          )}
        </Card>
      </div>

      <SttDocsCard locale={locale} />
    </div>
  );
}

/* ── API docs — POST /api/speech/stt (mirrors the developers panel style) ── */

function SttDocsCard({ locale }: { locale: UiLocale }) {
  const t = translator(locale);
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');

  const snippet =
    lang === 'curl'
      ? `curl -X POST http://localhost:3001/api/speech/stt \\
  -H "Content-Type: audio/wav" \\
  --data-binary @speech.wav \\
  --cookie "$OVOZ_SESSION"`
      : lang === 'node'
        ? `import { readFile } from "node:fs/promises";

const wav = await readFile("speech.wav");
const res = await fetch("/api/speech/stt", {
  method: "POST",
  headers: { "Content-Type": "audio/wav" },
  body: wav,
});
const { text, language } = await res.json();`
        : `import requests

audio = open("speech.wav", "rb").read()
res = requests.post(
    "http://localhost:3001/api/speech/stt",
    headers={"Content-Type": "audio/wav"},
    data=audio,
    cookies={"ovoz_session": "..."},
)
print(res.json())  # { "text": ..., "language": ... }`;

  const response = `{
  "text": "Assalomu alaykum, qanday yordam bera olaman?",
  "language": "uz"
}`;

  return (
    <Card className="mt-4" padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hairline-b">
        <div className="flex items-center gap-2">
          <IconCode size={16} className="text-ink-3" />
          <h3 className="text-[14px] font-semibold text-ink">{t('dev.docsTitle')}</h3>
          <Badge tone="success">POST</Badge>
          <span className="font-mono text-[12px] text-ink">/api/speech/stt</span>
        </div>
        <Segmented
          size="sm"
          value={lang}
          onChange={setLang}
          options={[
            { value: 'curl', label: 'cURL' },
            { value: 'node', label: 'Node' },
            { value: 'python', label: 'Python' },
          ]}
        />
      </div>
      <div className="space-y-4 p-5">
        <p className="text-[13px] text-ink-2">{t('dev.stt.docsDesc')}</p>
        <p className="text-[12.5px] text-ink-3">{t('dev.docsSessionNote')}</p>
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
            {t('dev.docsRequest')}
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            {snippet}
          </pre>
        </div>
        <div>
          <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
            {t('dev.docsResponse')}
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
            {response}
          </pre>
        </div>
      </div>
    </Card>
  );
}
