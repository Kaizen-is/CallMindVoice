'use client';

/** Shared bits for the voice-clone and voice-design labs. */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteCustomVoiceAction } from '@/app/actions/voices';
import { translator } from '@/lib/i18n';
import type { UiLocale } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlays';
import { IconMic, IconTrash, IconVolume } from '@/components/icons';

/* ── format guard: the speech services accept only flac/mp3/ogg/opus/wav.
   Anything else (m4a, aac, webm…) is decoded in the browser and re-encoded
   as 16 kHz mono WAV before upload. ── */

const SUPPORTED_EXT = new Set(['.flac', '.mp3', '.ogg', '.opus', '.wav']);
const TARGET_RATE = 16000;

/** Resample via OfflineAudioContext — proper anti-aliasing, unlike naive interpolation. */
async function resampleBuffer(decoded: AudioBuffer, to: number): Promise<Float32Array> {
  if (decoded.sampleRate === to && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }
  const frames = Math.ceil((decoded.duration || decoded.length / decoded.sampleRate) * to);
  const off = new OfflineAudioContext(1, Math.max(1, frames), to);
  const src = off.createBufferSource();
  src.buffer = decoded;
  // Classical clean-up (no AI): high-pass strips hum/rumble below speech.
  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 75;
  src.connect(hp);
  hp.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
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

/**
 * Return the file as-is if the speech services support it, else convert to WAV.
 * With `clean: true` every file is decoded and re-encoded through the filter
 * chain (high-pass + peak normalisation) — used for clone reference samples.
 */
export async function ensureSupportedAudio(file: File, opts?: { clean?: boolean }): Promise<File> {
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
  if (!opts?.clean && SUPPORTED_EXT.has(ext)) return file;
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
  const pcm = await resampleBuffer(decoded, TARGET_RATE);
  // Peak-normalise a quiet take toward full scale (capped gain, no AI).
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak > 0 && peak < 0.9) {
    const gain = Math.min(6, 0.95 / peak);
    for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  }
  const base = file.name.replace(/\.[a-z0-9]+$/i, '') || 'sample';
  return new File([encodeWav(pcm, TARGET_RATE)], `${base}.wav`, { type: 'audio/wav' });
}

export interface SavedVoice {
  id: string;
  name: string;
  mode: 'clone' | 'design';
  detail: string | null; // design string, or the ref transcript excerpt
  created_at: string;
}

/** Synthesize a short sample through /api/speech/tts with the given voice id. */
export function usePreview(locale: UiLocale) {
  const t = translator(locale);
  const toast = useToast();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Generated samples are cached per voice, so Preview after a prefetch plays
  // instantly instead of waiting on the GPU queue.
  const cacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  const synth = async (voiceId: string, text?: string): Promise<string | null> => {
    const cached = cacheRef.current.get(voiceId);
    if (cached) return cached;
    const res = await fetch('/api/speech/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text?.trim() || t('dev.voices.previewText', 'Assalomu alaykum! Men sizning yangi ovozingizman.'),
        voice: voiceId,
      }),
    });
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    cacheRef.current.set(voiceId, url);
    return url;
  };

  /** Generate and cache the sample in the background — no playback. */
  const prefetch = (voiceId: string, text?: string) => {
    void synth(voiceId, text).catch(() => null);
  };

  const preview = async (voiceId: string, text?: string) => {
    if (previewing) return;
    setPreviewing(voiceId);
    try {
      const url = await synth(voiceId, text);
      if (!url) {
        toast.error(t('dev.tts.failTitle'), t('dev.tts.failBody'));
        return;
      }
      const audio = audioRef.current ?? (audioRef.current = new Audio());
      audio.src = url;
      await audio.play().catch(() => {});
    } finally {
      setPreviewing(null);
    }
  };

  return { preview, prefetch, previewing };
}

/** List of a tenant's saved voices with preview + delete. */
export function SavedVoiceList({
  locale,
  voices,
  emptyTitle,
  emptyBody,
}: {
  locale: UiLocale;
  voices: SavedVoice[];
  emptyTitle: string;
  emptyBody: string;
}) {
  const t = translator(locale);
  const toast = useToast();
  const router = useRouter();
  const { preview, previewing } = usePreview(locale);
  const [removed, setRemoved] = useState<Set<string>>(new Set());

  const visible = voices.filter((v) => !removed.has(v.id));

  const remove = async (id: string) => {
    try {
      const res = await deleteCustomVoiceAction(id);
      if (res.ok) {
        setRemoved((s) => new Set(s).add(id));
        toast.toast({ tone: 'success', title: t('dev.voices.deleted', 'Voice deleted') });
        router.refresh();
      } else {
        toast.error(t('dev.voices.deleteFail', 'Could not delete the voice'), '');
      }
    } catch (e) {
      // Surfaces stale-tab action failures instead of failing silently.
      toast.error(
        t('dev.voices.deleteFail', 'Could not delete the voice'),
        e instanceof Error ? e.message : '',
      );
    }
  };

  return (
    <Card padded={false} className="lg:sticky lg:top-20 h-max">
      <div className="px-5 py-4 hairline-b">
        <h3 className="text-[14px] font-semibold text-ink">{t('dev.voices.savedTitle', 'Saved voices')}</h3>
      </div>
      {visible.length ? (
        <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
          {visible.map((v) => (
            <div key={v.id} className="px-5 py-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-ink">{v.name}</span>
                  <Badge tone={v.mode === 'clone' ? 'violet' : 'brand'}>
                    {v.mode === 'clone'
                      ? t('dev.voices.badgeClone', 'Clone')
                      : t('dev.voices.badgeDesign', 'Design')}
                  </Badge>
                </div>
                <span className="shrink-0 text-[11px] text-ink-3">{relativeTime(v.created_at, locale)}</span>
              </div>
              {v.detail && (
                <p className="mt-1 line-clamp-1 text-[12px] text-ink-3">{v.detail}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={previewing === v.id}
                  icon={previewing !== v.id ? <IconVolume size={13} /> : undefined}
                  onClick={() => void preview(v.id)}
                >
                  {t('dev.voices.preview', 'Preview')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconTrash size={13} />}
                  onClick={() => void remove(v.id)}
                >
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon={<IconMic size={20} />} title={emptyTitle} description={emptyBody} />
      )}
    </Card>
  );
}
