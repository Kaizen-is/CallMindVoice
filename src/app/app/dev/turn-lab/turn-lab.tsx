'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { UiLocale } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/primitives';
import { IconChevronRight, IconMic, IconRefresh, IconStop } from '@/components/icons';
import { VOICE_MIC_CONSTRAINTS, encodeWav, micSupported, startRecording, type Recording } from '@/lib/audio';
import { TURN_PROMPTS } from './prompts';

/*
 * The turn lab (L3): people read set phrases into the Playground's microphone settings, one clip per
 * phrase, saved on this computer only (POST /api/core/turn-lab/clip → data/turn-lab/). The clips are
 * then used to measure an end-of-turn model on Uzbek (backend/tools/turn_lab_eval.py).
 */

const MAX_SECONDS = 20;

const TEXT = {
  en: {
    title: 'Turn lab',
    subtitle:
      'Record the phrases below so we can test how well a model hears that a caller has finished. Recordings stay on this computer.',
    howTo:
      'Press Record (or Space), say the phrase as a caller would on the phone, and press Stop about a second after you finish. Where you see “…”, stop for about a second, as if thinking.',
    record: 'Record',
    stop: 'Stop',
    redo: 'Record again',
    skip: 'Skip',
    saving: 'Saving…',
    asked: 'The agent asked:',
    pause: 'pause',
    done: 'All phrases are recorded. Thank you! Pick any number to record it again.',
    off: 'The turn lab is off. Set TURN_LAB=on in .env and restart the API.',
    noMic: 'This browser cannot record from the microphone.',
    micError: 'The microphone could not start.',
    saveError: 'The recording was not saved. Try again.',
    saved: 'Recordings saved (all speakers)',
    progress: 'phrases recorded',
  },
  ru: {
    title: 'Лаборатория конца реплики',
    subtitle:
      'Запишите фразы ниже: так мы проверим, насколько точно модель слышит, что собеседник закончил говорить. Записи остаются на этом компьютере.',
    howTo:
      'Нажмите «Записать» (или пробел), произнесите фразу как в телефонном разговоре и нажмите «Стоп» примерно через секунду после конца. Там, где «…», сделайте паузу примерно на секунду, как будто задумались.',
    record: 'Записать',
    stop: 'Стоп',
    redo: 'Перезаписать',
    skip: 'Пропустить',
    saving: 'Сохранение…',
    asked: 'Агент спросил:',
    pause: 'пауза',
    done: 'Все фразы записаны. Спасибо! Выберите любой номер, чтобы записать фразу заново.',
    off: 'Лаборатория выключена. Укажите TURN_LAB=on в .env и перезапустите API.',
    noMic: 'Этот браузер не может записывать с микрофона.',
    micError: 'Не удалось включить микрофон.',
    saveError: 'Запись не сохранилась. Попробуйте ещё раз.',
    saved: 'Сохранено записей (все дикторы)',
    progress: 'фраз записано',
  },
  uz: {
    title: 'Gap oxiri laboratoriyasi',
    subtitle:
      'Quyidagi iboralarni yozib oling: model suhbatdosh gapini tugatganini qanchalik to‘g‘ri eshitishini sinaymiz. Yozuvlar faqat shu kompyuterda saqlanadi.',
    howTo:
      '“Yozish”ni (yoki Probel) bosing, iborani telefonda gaplashayotgandek ayting va tugatganingizdan taxminan bir soniya keyin “To‘xtatish”ni bosing. “…” bor joyda o‘ylayotgandek bir soniyacha to‘xtang.',
    record: 'Yozish',
    stop: 'To‘xtatish',
    redo: 'Qayta yozish',
    skip: 'O‘tkazib yuborish',
    saving: 'Saqlanmoqda…',
    asked: 'Agent so‘radi:',
    pause: 'pauza',
    done: 'Barcha iboralar yozildi. Rahmat! Qayta yozish uchun istalgan raqamni tanlang.',
    off: 'Laboratoriya o‘chiq. .env faylida TURN_LAB=on qilib, API ni qayta ishga tushiring.',
    noMic: 'Bu brauzer mikrofondan yoza olmaydi.',
    micError: 'Mikrofon ishga tushmadi.',
    saveError: 'Yozuv saqlanmadi. Yana urinib ko‘ring.',
    saved: 'Saqlangan yozuvlar (barcha so‘zlovchilar)',
    progress: 'ibora yozildi',
  },
} as const;

type Phase = 'idle' | 'recording' | 'saving';

/** The first phrase from `from` on (wrapping round) not yet recorded; the list's length when all are. */
function firstOpen(done: Set<string>, from: number): number {
  for (let k = 0; k < TURN_PROMPTS.length; k++) {
    const i = (from + k) % TURN_PROMPTS.length;
    if (!done.has(TURN_PROMPTS[i].id)) return i;
  }
  return TURN_PROMPTS.length;
}

export function TurnLab({
  locale,
  enabled,
  saved: savedAtStart,
  mine,
}: {
  locale: UiLocale;
  enabled: boolean;
  saved: number;
  mine: string[];
}) {
  const t = TEXT[locale === 'uz-Cyrl' ? 'uz' : locale] ?? TEXT.en;
  const [done, setDone] = useState<Set<string>>(() => new Set(mine));
  const [index, setIndex] = useState(() => firstOpen(new Set(mine), 0));
  const [phase, setPhase] = useState<Phase>('idle');
  const [saved, setSaved] = useState(savedAtStart);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [canRecord, setCanRecord] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<Recording | null>(null);
  const meterRef = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const startedRef = useRef(0);
  const prompt = index < TURN_PROMPTS.length ? TURN_PROMPTS[index] : null;

  useEffect(() => setCanRecord(micSupported()), []);

  const openMeter = (stream: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
      if (recRef.current) setElapsed((performance.now() - startedRef.current) / 1000);
      meterRef.current = { ctx, raf: requestAnimationFrame(tick) };
    };
    meterRef.current = { ctx, raf: requestAnimationFrame(tick) };
  };

  // Let go of the microphone when the page closes.
  useEffect(
    () => () => {
      recRef.current?.cancel();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (meterRef.current) {
        cancelAnimationFrame(meterRef.current.raf);
        void meterRef.current.ctx.close();
      }
    },
    [],
  );

  const start = useCallback(async () => {
    if (!prompt) return;
    setError(null);
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: VOICE_MIC_CONSTRAINTS });
        openMeter(streamRef.current);
      }
      recRef.current = await startRecording(streamRef.current);
      startedRef.current = performance.now();
      setElapsed(0);
      setPhase('recording');
    } catch {
      setError(t.micError);
    }
  }, [prompt, t]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec || !prompt) return;
    recRef.current = null;
    setPhase('saving');
    try {
      const raw = await rec.stopRaw();
      const form = new FormData();
      form.append('audio', encodeWav(raw.pcm, 16000), 'clip.wav');
      form.append('promptId', prompt.id);
      form.append('text', prompt.text);
      form.append('kind', prompt.kind);
      if (prompt.asked) form.append('asked', prompt.asked);
      const res = await fetch('/api/core/turn-lab/clip', { method: 'POST', body: form });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { saved: number };
      setSaved(body.saved);
      const next = new Set(done).add(prompt.id);
      setDone(next);
      setIndex(firstOpen(next, index + 1));
    } catch {
      setError(t.saveError);
    }
    setPhase('idle');
  }, [done, index, prompt, t]);

  const toggle = useCallback(() => {
    if (phase === 'idle') void start();
    else if (phase === 'recording') void stop();
  }, [phase, start, stop]);

  // A phrase never runs past MAX_SECONDS: it stops itself (the user forgot to press Stop).
  useEffect(() => {
    if (phase === 'recording' && elapsed >= MAX_SECONDS) void stop();
  }, [elapsed, phase, stop]);

  // Space records and stops, except on a button (which handles Space itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !enabled) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, toggle]);

  if (!enabled || !canRecord) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t.title} subtitle={t.subtitle} />
        <Card>
          <p className="text-[14px] text-ink-2">{enabled ? t.noMic : t.off}</p>
        </Card>
      </div>
    );
  }

  const recording = phase === 'recording';
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <Badge tone="neutral">
            {t.saved}: {saved}
          </Badge>
        }
      />
      <Card className="space-y-5">
        <p className="text-[13.5px] leading-relaxed text-ink-2">{t.howTo}</p>
        <div className="flex items-center gap-3">
          <Progress value={(done.size / TURN_PROMPTS.length) * 100} className="flex-1" />
          <span className="text-[12.5px] text-ink-3 tabular">
            {done.size} / {TURN_PROMPTS.length} {t.progress}
          </span>
        </div>

        {prompt ? (
          <div className="rounded-[12px] bg-surface-2 p-5">
            <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-3">
              <span className="tabular">{prompt.id.toUpperCase()}</span>
              {done.has(prompt.id) && <Badge tone="success">✓</Badge>}
            </div>
            {prompt.asked && (
              <p className="mb-2 text-[13px] text-ink-3">
                {t.asked} <span className="text-ink-2">{prompt.asked}</span>
              </p>
            )}
            <p className="text-[24px] leading-snug font-semibold tracking-[-0.01em] text-ink">
              {prompt.text.split('…').map((part, i) => (
                <span key={i}>
                  {i > 0 && (
                    <span className="mx-1 inline-block rounded-md bg-brand-soft px-1.5 align-middle text-[13px] font-medium text-brand">
                      … {t.pause}
                    </span>
                  )}
                  {part}
                </span>
              ))}
            </p>
          </div>
        ) : (
          <p className="rounded-[12px] bg-surface-2 p-5 text-[14px] text-ink-2">{t.done}</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={recording ? 'danger' : 'primary'}
            size="lg"
            icon={recording ? <IconStop size={16} /> : <IconMic size={16} />}
            loading={phase === 'saving'}
            disabled={!prompt}
            onClick={toggle}
          >
            {phase === 'saving' ? t.saving : recording ? t.stop : prompt && done.has(prompt.id) ? t.redo : t.record}
          </Button>
          <Button
            variant="ghost"
            icon={<IconChevronRight size={15} />}
            disabled={phase !== 'idle' || !prompt}
            onClick={() => setIndex(firstOpen(done, index + 1))}
          >
            {t.skip}
          </Button>
          {recording && (
            <span className="flex items-center gap-2 text-[13px] text-ink-3 tabular">
              <span className="h-2 w-24 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full bg-danger transition-[width]" style={{ width: `${level * 100}%` }} />
              </span>
              {elapsed.toFixed(1)} s
            </span>
          )}
          {error && (
            <span className="flex items-center gap-1.5 text-[13px] text-danger">
              <IconRefresh size={14} />
              {error}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 border-t border-line pt-4">
          {TURN_PROMPTS.map((p, i) => (
            <button
              key={p.id}
              type="button"
              disabled={phase !== 'idle'}
              onClick={() => setIndex(i)}
              className={cn(
                'h-7 min-w-9 rounded-md px-1.5 text-[11.5px] font-medium tabular transition-colors',
                i === index ? 'bg-brand text-white' : done.has(p.id) ? 'bg-success-soft text-success' : 'bg-surface-2 text-ink-3',
              )}
              title={p.text}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
