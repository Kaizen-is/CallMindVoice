'use client';

import { useEffect, useRef, useState } from 'react';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Card, PageHeader, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlays';
import { IconPlay, IconStop } from '@/components/icons';

export interface GalleryVoice {
  id: string;
  name: string;
  note: string;
  /** The TTS model this card plays the voice on. */
  model: string;
}

interface Model {
  id: string;
  name: string;
  ready: boolean;
  setup: string;
}

/** A different line for every voice; under 120 characters, so the server caches each render. */
const SAMPLES = [
  'Assalomu alaykum! Sizga qanday yordam bera olaman?',
  'Buyurtmangiz ertaga soat o‘n birda yetkaziladi.',
  'Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.',
  'To‘lov muddati yigirma beshinchi noyabr kuni tugaydi.',
  'Kechirasiz, operatorimiz hozir band, birozdan so‘ng sizga qo‘ng‘iroq qilamiz.',
  'Biz dushanbadan jumagacha, ertalab to‘qqizdan kechki oltigacha ishlaymiz.',
  'Hisobingizda o‘n ikki ming so‘m mablag‘ qoldi.',
  'Qo‘ng‘irog‘ingiz uchun rahmat, kuningiz xayrli o‘tsin!',
];

export function VoicesGallery({
  locale,
  models,
  voices,
  initialModel,
}: {
  locale: UiLocale;
  models: Model[];
  voices: GalleryVoice[];
  initialModel: string;
}) {
  const t = translator(locale);
  const toast = useToast();
  const [filter, setFilter] = useState(initialModel);
  const [loading, setLoading] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const cache = useRef(new Map<string, string>());

  // Every voice keeps the same line on every model, so models compare fairly.
  const names = [...new Set(voices.map((v) => v.id))];
  const sampleFor = (voiceId: string) => SAMPLES[names.indexOf(voiceId) % SAMPLES.length];
  const modelOf = (id: string) => models.find((m) => m.id === id);
  const shown = voices.filter((v) => filter === 'all' || v.model === filter);

  useEffect(
    () => () => {
      audio.current?.pause();
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
    },
    [],
  );

  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };

  const play = async (v: GalleryVoice) => {
    const key = `${v.model}:${v.id}`;
    if (playing === key) return stop();
    stop();
    let url = cache.current.get(key);
    if (!url) {
      setLoading(key);
      const res = await fetch('/api/speech/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 24 kHz for the ElevenLabs models; our own TTS answers 8 kHz regardless.
        body: JSON.stringify({ text: sampleFor(v.id), voice: v.id, engine: v.model, language: 'uz', rate: 24000 }),
      }).catch(() => null);
      setLoading(null);
      if (!res?.ok) {
        toast.error(t('voices.failed'), `${v.name} · ${modelOf(v.model)?.name ?? v.model}`);
        return;
      }
      url = URL.createObjectURL(await res.blob());
      cache.current.set(key, url);
    }
    const el = new Audio(url);
    audio.current = el;
    el.onended = () => setPlaying((p) => (p === key ? null : p));
    setPlaying(key);
    void el.play().catch(() => setPlaying(null));
  };

  const chips = [{ id: 'all', name: t('voices.all') }, ...models.map((m) => ({ id: m.id, name: m.name }))];

  return (
    <div className="w-full">
      <PageHeader title={t('voices.title')} />

      <div role="group" aria-label={t('voices.filter')} className="mb-5 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={filter === c.id}
            onClick={() => setFilter(c.id)}
            style={{ fontSize: 12.5, lineHeight: '18px' }}
            className={cn(
              'rounded-full px-3 py-1.5 font-medium transition-colors',
              filter === c.id ? 'bg-brand text-white' : 'bg-surface-2 text-ink-2 hairline hover:text-ink',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((v) => {
          const key = `${v.model}:${v.id}`;
          const model = modelOf(v.model);
          const ready = Boolean(model?.ready);
          return (
            <Card key={key} padded={false} className={cn('flex items-start gap-3 p-4', !ready && 'opacity-50')}>
              <button
                type="button"
                disabled={!ready || loading !== null}
                onClick={() => void play(v)}
                aria-label={`${t('voices.listen')} ${v.name}`}
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed',
                  playing === key ? 'bg-brand text-white' : 'bg-surface-2 text-ink hairline hover:bg-surface-3',
                )}
              >
                {loading === key ? (
                  <Spinner size={14} />
                ) : playing === key ? (
                  <IconStop size={14} />
                ) : (
                  <IconPlay size={14} />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink">{v.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">{model?.name}</span>
                </div>
                <div className="truncate text-[11.5px] text-ink-3">
                  {ready ? v.note : t('lab.missing').replace('{setup}', model?.setup ?? '')}
                </div>
                <p className="mt-2 text-[12.5px] leading-snug text-ink-2">“{sampleFor(v.id)}”</p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
