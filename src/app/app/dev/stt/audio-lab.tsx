'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, Segmented } from '@/components/ui/primitives';
import { Select, Switch, Textarea } from '@/components/ui/forms';
import { IconChevronDown, IconChevronUp, IconDownload, IconPause, IconPlay, IconRefresh, IconZap } from '@/components/icons';
import { cer, wer, wordDiff } from '@/lib/voice/text-metrics';
import { peaks, spectrogram, wavSampleRate } from '@/lib/voice/waveform';
import { labText, type LabKey } from './lab-text';

/*
 * The Audio Processing Lab on For developers ▸ STT. Everything shown comes from real samples:
 * the original is decoded in the browser at its own rate where possible, processed by the
 * backend pipeline (POST /api/audio/process), and the processed waveform is drawn from the very
 * WAV the server says it would hand to STT. Nothing is stored beyond the server's short-lived
 * clips; settings (not audio) are remembered in this browser.
 */

export type LabSource = { kind: 'file'; file: File } | { kind: 'rec'; wav: Blob; encoded?: Blob };

type Settings = {
  highpass: boolean;
  gain: boolean;
  noiseSuppression: boolean;
  voiceIsolation: boolean;
  isolationProvider: string;
  vad: 'energy' | 'silero' | 'off';
  trim: boolean;
  minSpeechMs: number;
  endSilenceMs: number;
};

const RECOMMENDED: Settings = {
  highpass: true,
  gain: true,
  noiseSuppression: false,
  voiceIsolation: true,
  isolationProvider: 'inworld',
  vad: 'energy',
  trim: false,
  minSpeechMs: 250,
  endSilenceMs: 700,
};
const SETTINGS_KEY = 'callmind.audioLab.settings.v1';

type Caps = {
  enabled: boolean;
  noiseSuppression: { available: boolean };
  voiceIsolation: { id: string; model: string; nativeRates: number[]; available: boolean }[];
  vad: { id: string; available: boolean }[];
  sttRate: number;
};

type Stage = {
  name: string;
  status: 'ran' | 'bypassed' | 'disabled' | 'unavailable' | 'failed';
  ms: number;
  provider: string;
  model: string;
  sampleRateIn: number;
  sampleRateOut: number;
  levelInDb: number | null;
  levelOutDb: number | null;
  error: string;
  notes: string[];
};

type ProcessResult = {
  stages: Stage[];
  clips: Record<string, { token: string; sampleRate: number }>;
  vad: null | {
    engine: string;
    scoreKind: 'probability' | 'energy_score';
    hopMs: number;
    scores: number[];
    segments: { startMs: number; endMs: number }[];
  };
  metrics: {
    inputDurationMs: number;
    inputSampleRate: number;
    outputSampleRate: number;
    outputDurationMs: number;
    isolationMs: number | null;
    totalMs: number;
  };
  options: Settings;
};

type Decoded = { samples: Float32Array; rate: number; fileRate: number | null; format: string; url: string };
type Transcribed = { text: string; clientMs: number; serverMs: number | null; error?: string };

const STATUS_TONE = { ran: 'success', bypassed: 'info', disabled: 'neutral', unavailable: 'warning', failed: 'danger' } as const;
const STATUS_TEXT: Record<string, Record<Stage['status'], string>> = {
  uz: { ran: 'bajarildi', bypassed: 'o‘zgartirmadi', disabled: 'o‘chiq', unavailable: 'mavjud emas', failed: 'xato' },
  ru: { ran: 'выполнено', bypassed: 'без изменений', disabled: 'выкл.', unavailable: 'недоступно', failed: 'ошибка' },
  en: { ran: 'ran', bypassed: 'no change', disabled: 'off', unavailable: 'unavailable', failed: 'failed' },
};
const STAGE_TEXT: Record<string, Record<string, string>> = {
  uz: { highpass: 'Past chastota filtri', gain: 'Balandlik', noise_suppression: 'Shovqinni bostirish', voice_isolation: 'Ovozni ajratish', resample: 'Chastotani o‘zgartirish', vad: 'VAD', trim: 'Kesish' },
  ru: { highpass: 'Фильтр НЧ', gain: 'Громкость', noise_suppression: 'Шумоподавление', voice_isolation: 'Выделение голоса', resample: 'Смена частоты', vad: 'VAD', trim: 'Обрезка' },
  en: { highpass: 'High-pass', gain: 'Gain', noise_suppression: 'Noise suppression', voice_isolation: 'Voice isolation', resample: 'Resample', vad: 'VAD', trim: 'Trim' },
};
const CLIP_ORDER = ['raw', 'conditioned', 'denoised', 'isolated', 'final'] as const;

/* ── audio helpers ───────────────────────────────────────────────── */

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

/**
 * Decode at the file's own rate when it says what that is (WAV); compressed formats are decoded at
 * 48 kHz (Opus's own rate). An OfflineAudioContext decodes at ITS rate, so nothing is resampled
 * behind our back.
 */
async function decodeAt(blob: Blob): Promise<{ samples: Float32Array; rate: number; fileRate: number | null }> {
  const buf = await blob.arrayBuffer();
  const fileRate = wavSampleRate(buf.slice(0, 64));
  const rate = fileRate && fileRate >= 8000 && fileRate <= 96000 ? fileRate : 48000;
  const ctx = new OfflineAudioContext(1, 1, rate);
  const decoded = await ctx.decodeAudioData(buf);
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  return { samples: mono, rate: decoded.sampleRate, fileRate };
}

/** Plain band-limited resampling (no filter, no gain): the "original" as STT would take it. */
async function resampleTo(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to) return samples;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((samples.length * to) / from)), to);
  const buffer = off.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}.${Math.floor((sec % 1) * 10)}`;

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...RECOMMENDED, ...(JSON.parse(raw) as Partial<Settings>) } : RECOMMENDED;
  } catch {
    return RECOMMENDED;
  }
}

/* ── waveform with segments, scores and a playhead ───────────────── */

function Waveform({
  samples,
  rate,
  zoom,
  position,
  onSeek,
  segments,
  scores,
  hopMs,
  removedOutside,
  color,
}: {
  samples: Float32Array;
  rate: number;
  zoom: number;
  position: number;
  onSeek: (sec: number) => void;
  segments?: { startMs: number; endMs: number }[];
  scores?: number[];
  hopMs?: number;
  /** Shade what lies outside the segments as removed (trimmed output). */
  removedOutside?: boolean;
  color: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const height = 96;
  const total = samples.length / rate;
  const drawWidth = Math.max(1, Math.round(width * zoom));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = drawWidth * dpr;
    canvas.height = height * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, drawWidth, height);
    const css = getComputedStyle(canvas);
    const rgb = (name: string) => `rgb(${css.getPropertyValue(name).trim().split(' ').join(',')})`;
    const x = (ms: number) => (ms / 1000 / Math.max(total, 1e-9)) * drawWidth;
    if (segments) {
      g.fillStyle = `rgba(${css.getPropertyValue('--success').trim().split(' ').join(',')},0.12)`;
      for (const s of segments) g.fillRect(x(s.startMs), 0, Math.max(1, x(s.endMs) - x(s.startMs)), height);
      if (removedOutside) {
        g.fillStyle = 'rgba(128,128,128,0.18)';
        let at = 0;
        for (const s of [...segments, { startMs: total * 1000, endMs: total * 1000 }]) {
          if (x(s.startMs) > at) g.fillRect(at, 0, x(s.startMs) - at, height);
          at = x(s.endMs);
        }
      }
    }
    const p = peaks(samples, drawWidth);
    g.fillStyle = rgb(color);
    const mid = height / 2;
    for (let c = 0; c < drawWidth; c++) {
      const lo = p[c * 2];
      const hi = p[c * 2 + 1];
      g.fillRect(c, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }
    if (scores && hopMs) {
      g.strokeStyle = rgb('--warning');
      g.lineWidth = 1.25;
      g.beginPath();
      scores.forEach((s, i) => {
        const px = x(i * hopMs);
        const py = height - s * (height - 4) - 2;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      });
      g.stroke();
    }
  }, [samples, rate, drawWidth, segments, scores, hopMs, removedOutside, color, total]);

  return (
    <div ref={wrapRef} className="relative overflow-x-auto rounded-[10px] bg-surface-2">
      <div className="relative" style={{ width: drawWidth, height }}>
        <canvas
          ref={canvasRef}
          style={{ width: drawWidth, height }}
          className="cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek(((e.clientX - rect.left) / drawWidth) * total);
          }}
        />
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-brand"
          style={{ left: (position / Math.max(total, 1e-9)) * drawWidth }}
        />
      </div>
    </div>
  );
}

function Spectrogram({ samples, rate }: { samples: Float32Array; rate: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const frames = 400;
    const { db, bins } = spectrogram(samples, rate, frames, 512, Math.min(8000, rate / 2));
    canvas.width = frames;
    canvas.height = bins;
    const g = canvas.getContext('2d');
    if (!g) return;
    const img = g.createImageData(frames, bins);
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < bins; b++) {
        const v = Math.max(0, Math.min(1, (db[f * bins + b] + 100) / 70));
        const o = ((bins - 1 - b) * frames + f) * 4;
        img.data[o] = 255 * Math.min(1, v * 1.6);
        img.data[o + 1] = 255 * Math.max(0, v - 0.45) * 1.8;
        img.data[o + 2] = 90 * (1 - v);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, [samples, rate]);
  return <canvas ref={ref} className="h-24 w-full rounded-[10px]" style={{ imageRendering: 'pixelated' }} />;
}

/* ── one player panel ────────────────────────────────────────────── */

function usePlayer(url: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  useEffect(() => {
    if (!url) return;
    const a = new Audio(url);
    audioRef.current = a;
    const tick = () => setPosition(a.currentTime);
    const end = () => setPlaying(false);
    a.addEventListener('timeupdate', tick);
    a.addEventListener('ended', end);
    a.addEventListener('pause', end);
    a.addEventListener('play', () => setPlaying(true));
    return () => {
      a.pause();
      a.removeEventListener('timeupdate', tick);
      a.removeEventListener('ended', end);
      audioRef.current = null;
      setPlaying(false);
      setPosition(0);
    };
  }, [url]);
  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const seek = (sec: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = sec;
    setPosition(sec);
  };
  return { playing, position, toggle, seek };
}

/* ── the lab ─────────────────────────────────────────────────────── */

export function AudioLab({
  source,
  locale,
  model,
  modelName,
  modelReady,
}: {
  source: LabSource;
  locale: UiLocale;
  model: string;
  modelName: string;
  modelReady: boolean;
}) {
  const tx = labText(locale);
  const loc = locale === 'ru' ? 'ru' : locale === 'en' ? 'en' : 'uz';
  const [caps, setCaps] = useState<Caps | null>(null);
  const [settings, setSettings] = useState<Settings>(RECOMMENDED);
  const [open, setOpen] = useState(false);
  const [original, setOriginal] = useState<Decoded | null>(null);
  const [decodeError, setDecodeError] = useState('');
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [processed, setProcessed] = useState<{ samples: Float32Array; rate: number; url: string; blob: Blob } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState<'1' | '2' | '4' | '8'>('1');
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  const [stageUrl, setStageUrl] = useState<{ name: string; url: string } | null>(null);
  const [reference, setReference] = useState('');
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<{ original: Transcribed; processed: Transcribed; engine: string } | null>(null);

  useEffect(() => setSettings(loadSettings()), []);
  const update = (patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* settings just are not remembered */
      }
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    fetch('/api/audio/capabilities')
      .then((r) => (r.ok ? (r.json() as Promise<Caps>) : null))
      .then((c) => alive && setCaps(c))
      .catch(() => alive && setCaps(null));
    return () => {
      alive = false;
    };
  }, []);

  // The original: exactly what was uploaded or recorded (not the 16 kHz copy made for the STT).
  const originalBlob = source.kind === 'file' ? source.file : (source.encoded ?? source.wav);
  const alreadyProcessed = source.kind === 'rec' && !source.encoded;
  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(originalBlob);
    setOriginal(null);
    setResult(null);
    setProcessed(null);
    setComparison(null);
    setDecodeError('');
    decodeAt(originalBlob)
      .then((d) => {
        if (!alive) return;
        const format =
          source.kind === 'file'
            ? source.file.type || source.file.name.split('.').pop()?.toUpperCase() || '?'
            : originalBlob.type || 'audio/webm';
        setOriginal({ ...d, format, url });
      })
      .catch((e) => alive && setDecodeError(e instanceof Error ? e.message : 'decode failed'));
    return () => {
      alive = false;
      URL.revokeObjectURL(url);
    };
  }, [originalBlob, source]);

  useEffect(() => () => {
    if (processed) URL.revokeObjectURL(processed.url);
  }, [processed]);
  useEffect(() => () => {
    if (stageUrl) URL.revokeObjectURL(stageUrl.url);
  }, [stageUrl]);

  const origPlayer = usePlayer(original?.url ?? null);
  const procPlayer = usePlayer(processed?.url ?? null);
  const stagePlayer = usePlayer(stageUrl?.url ?? null);
  useEffect(() => {
    if (stageUrl) stagePlayer.toggle();
    // play as soon as a stage clip is picked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageUrl]);

  const isolationProviders = caps?.voiceIsolation ?? [];
  const isolationAvailable = isolationProviders.some((p) => p.id === settings.isolationProvider && p.available);
  const sileroAvailable = caps?.vad.some((v) => v.id === 'silero' && v.available) ?? false;
  const nsAvailable = caps?.noiseSuppression.available ?? false;

  const run = useCallback(async () => {
    if (!original || busy) return;
    setBusy(true);
    setError('');
    setComparison(null);
    try {
      const form = new FormData();
      form.append('file', encodeWav(original.samples, original.rate), 'original.wav');
      form.append('options', JSON.stringify(settings));
      const res = await fetch('/api/audio/process', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
      const body = (await res.json()) as ProcessResult;
      const final = body.clips.final;
      const blob = await (await fetch(`/api/audio/clip/${final.token}`)).blob();
      const { samples, rate } = await decodeAt(blob);
      setResult(body);
      setProcessed({ samples, rate, url: URL.createObjectURL(blob), blob });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [original, busy, settings]);

  const playStage = async (name: string, token: string) => {
    const blob = await (await fetch(`/api/audio/clip/${token}`)).blob();
    setStageUrl({ name, url: URL.createObjectURL(blob) });
  };

  const transcribe = async (wav: Blob): Promise<Transcribed> => {
    const form = new FormData();
    form.append('file', wav, 'speech.wav');
    form.append('engine', model);
    form.append('language', 'uz');
    const started = performance.now();
    try {
      const res = await fetch('/api/models/stt', { method: 'POST', body: form });
      const clientMs = performance.now() - started;
      const body = (await res.json().catch(() => ({}))) as { text?: string; ms?: number; error?: string };
      if (!res.ok) return { text: '', clientMs, serverMs: null, error: body.error ?? `HTTP ${res.status}` };
      return { text: (body.text ?? '').trim(), clientMs, serverMs: body.ms ?? null };
    } catch (e) {
      return { text: '', clientMs: performance.now() - started, serverMs: null, error: e instanceof Error ? e.message : 'failed' };
    }
  };

  /** Explicit only: two STT requests with the same engine (one per version). */
  const compare = async () => {
    if (!original || !processed || comparing) return;
    setComparing(true);
    try {
      const plain = encodeWav(await resampleTo(original.samples, original.rate, 16000), 16000);
      const before = await transcribe(plain);
      const after = await transcribe(processed.blob);
      setComparison({ original: before, processed: after, engine: modelName });
    } finally {
      setComparing(false);
    }
  };

  const nothingApplied = useMemo(
    () => !!result && !result.stages.some((s) => s.status === 'ran' && !['resample', 'vad'].includes(s.name)),
    [result],
  );
  const iso = result?.stages.find((s) => s.name === 'voice_isolation');
  const trimmed = result?.stages.find((s) => s.name === 'trim')?.status === 'ran';
  const z = Number(zoom);

  if (caps && !caps.enabled) {
    return (
      <Card>
        <p className="text-[13px] text-ink-3">{tx('labDisabled')}</p>
      </Card>
    );
  }

  const Toggle = ({ k, label, disabled, note }: { k: keyof Settings; label: string; disabled?: boolean; note?: string }) => (
    <Switch
      checked={Boolean(settings[k]) && !disabled}
      onChange={(v) => update({ [k]: v } as Partial<Settings>)}
      disabled={disabled}
      label={label}
      description={note}
    />
  );

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 hairline-b">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">{tx('title')}</h3>
          <p className="mt-0.5 text-[12px] text-ink-3">{tx('subtitle')}</p>
        </div>
        <Button
          variant="primary"
          loading={busy}
          disabled={!original || busy}
          icon={!busy ? <IconZap size={15} /> : undefined}
          onClick={() => void run()}
        >
          {busy ? tx('processing') : tx('process')}
        </Button>
      </div>

      <div className="space-y-4 p-5">
        {/* settings */}
        <div className="rounded-[12px] hairline">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] font-medium text-ink"
          >
            {tx('settings')}
            {open ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
          </button>
          {open && (
            <div className="space-y-3 px-4 pb-4">
              <Toggle
                k="voiceIsolation"
                label={tx('voiceIsolation')}
                disabled={!isolationAvailable}
                note={isolationAvailable ? tx('dominantNote') : `${settings.isolationProvider}: ${tx('notConfigured')}`}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[12px] text-ink-3">
                  {tx('provider')}
                  <Select value={settings.isolationProvider} onChange={(e) => update({ isolationProvider: e.target.value })}>
                    {isolationProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id} · {p.model} · {p.nativeRates.join('/')} Hz{p.available ? '' : ` (${tx('notConfigured')})`}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-[12px] text-ink-3">
                  {tx('vad')}
                  <Select value={settings.vad} onChange={(e) => update({ vad: e.target.value as Settings['vad'] })}>
                    <option value="energy">{tx('vadEnergy')}</option>
                    <option value="silero" disabled={!sileroAvailable}>
                      {tx('vadSilero')}
                      {sileroAvailable ? '' : ` (${tx('notConfigured')})`}
                    </option>
                    <option value="off">{tx('vadOff')}</option>
                  </Select>
                </label>
              </div>
              <Toggle
                k="noiseSuppression"
                label={tx('noiseSuppression')}
                disabled={!nsAvailable}
                note={nsAvailable ? undefined : tx('notConfigured')}
              />
              <Toggle k="highpass" label={tx('highpass')} />
              <Toggle k="gain" label={tx('gain')} />
              <Toggle k="trim" label={tx('trim')} disabled={settings.vad === 'off'} />
              <div className="grid gap-3 sm:grid-cols-2">
                {(['minSpeechMs', 'endSilenceMs'] as const).map((k) => (
                  <label key={k} className="text-[12px] text-ink-3">
                    {tx(k === 'minSpeechMs' ? 'minSpeech' : 'endSilence')}: <b className="text-ink">{settings[k]}</b>
                    <input
                      type="range"
                      min={k === 'minSpeechMs' ? 50 : 100}
                      max={k === 'minSpeechMs' ? 1000 : 2000}
                      step={50}
                      value={settings[k]}
                      onChange={(e) => update({ [k]: Number(e.target.value) } as Partial<Settings>)}
                      className="mt-1 w-full accent-[rgb(var(--brand))]"
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-ink-3">
                  {tx('effectiveRate')}: <b className="text-ink">{caps?.sttRate ?? 16000} Hz</b>
                </span>
                <Button size="xs" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => update(RECOMMENDED)}>
                  {tx('reset')}
                </Button>
              </div>
              <p className="text-[11.5px] leading-snug text-ink-3">{tx('browserNote')}</p>
            </div>
          )}
        </div>

        {alreadyProcessed && <p className="text-[12px] text-warning">{tx('alreadyProcessed')}</p>}
        {decodeError && <p className="text-[12px] text-danger">{decodeError}</p>}
        {error && <p className="text-[12px] text-danger">{tx('failed')}: {error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-[12px] text-ink-3">{tx('zoom')}</span>
          <Segmented
            size="sm"
            value={zoom}
            onChange={setZoom}
            options={(['1', '2', '4', '8'] as const).map((v) => ({ value: v, label: `${v}×` }))}
          />
          <Button size="xs" variant={showSpectrogram ? 'secondary' : 'ghost'} onClick={() => setShowSpectrogram((s) => !s)}>
            {tx('spectrogram')}
          </Button>
        </div>

        {/* original vs processed */}
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-2">
            <PanelHead
              title={tx('original')}
              playing={origPlayer.playing}
              onToggle={origPlayer.toggle}
              disabled={!original}
              tx={tx}
            />
            {original ? (
              <>
                <Waveform
                  samples={original.samples}
                  rate={original.rate}
                  zoom={z}
                  position={origPlayer.position}
                  onSeek={origPlayer.seek}
                  segments={result?.vad?.segments}
                  scores={result?.vad?.scores}
                  hopMs={result?.vad?.hopMs}
                  color="--text"
                />
                {showSpectrogram && <Spectrogram samples={original.samples} rate={original.rate} />}
                <Facts
                  items={[
                    [tx('duration'), `${fmtTime(origPlayer.position)} / ${fmtTime(original.samples.length / original.rate)}`],
                    [
                      tx('sampleRate'),
                      original.fileRate ? `${original.fileRate} Hz` : tx('decodedAt', { rate: original.rate }),
                    ],
                    [tx('format'), original.format],
                  ]}
                />
                {result?.vad && (
                  <p className="text-[11.5px] text-ink-3">
                    <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-success-soft align-middle" />
                    {tx('segments')}: {result.vad.segments.length} ·{' '}
                    <span className="text-warning">
                      ── {result.vad.scoreKind === 'probability' ? tx('scores') : tx('energyScores')} ({result.vad.engine})
                    </span>
                  </p>
                )}
              </>
            ) : (
              <div className="h-24 animate-pulse rounded-[10px] bg-surface-2" />
            )}
          </div>

          <div className="space-y-2">
            <PanelHead
              title={tx('processed')}
              playing={procPlayer.playing}
              onToggle={procPlayer.toggle}
              disabled={!processed}
              tx={tx}
              extra={
                processed && (
                  <a
                    href={processed.url}
                    download="processed.wav"
                    className="inline-flex items-center gap-1 text-[12px] text-brand hover:underline"
                  >
                    <IconDownload size={13} /> {tx('download')}
                  </a>
                )
              }
            />
            {processed && result ? (
              <>
                <Waveform
                  samples={processed.samples}
                  rate={processed.rate}
                  zoom={z}
                  position={procPlayer.position}
                  onSeek={procPlayer.seek}
                  segments={trimmed ? undefined : result.vad?.segments}
                  color="--brand"
                />
                {showSpectrogram && <Spectrogram samples={processed.samples} rate={processed.rate} />}
                <Facts
                  items={[
                    [tx('duration'), `${fmtTime(procPlayer.position)} / ${fmtTime(processed.samples.length / processed.rate)}`],
                    [tx('sampleRate'), `${result.metrics.outputSampleRate} Hz`],
                    [
                      tx('status'),
                      iso ? `${STAGE_TEXT[loc].voice_isolation}: ${STATUS_TEXT[loc][iso.status]}` : '—',
                    ],
                  ]}
                />
                {nothingApplied && <p className="text-[12px] font-medium text-warning">{tx('nothingApplied')}</p>}
                {trimmed && (
                  <p className="text-[11.5px] text-ink-3">
                    {tx('trim')}: {result.stages.find((s) => s.name === 'trim')?.notes.join(', ')} ({tx('removed')})
                  </p>
                )}
              </>
            ) : (
              <div className="flex h-24 items-center justify-center rounded-[10px] bg-surface-2 px-4 text-center text-[12px] text-ink-3">
                {tx('notYet')}
              </div>
            )}
          </div>
        </div>

        {result && (
          <>
            {/* stages */}
            <div>
              <h4 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{tx('stages')}</h4>
              <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))] rounded-[12px] hairline">
                {result.stages.map((s) => (
                  <div key={s.name} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-[12.5px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[loc][s.status]}</Badge>
                      <span className="font-medium text-ink">{STAGE_TEXT[loc][s.name] ?? s.name}</span>
                      {s.provider && <span className="text-ink-3">{s.provider}{s.model ? ` · ${s.model}` : ''}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-ink-3">
                      {[...s.notes, s.error].filter(Boolean).map((n) => (
                        <span key={n} className={cn(n === s.error && 'text-danger')}>{n}</span>
                      ))}
                      {s.levelInDb !== null && s.levelOutDb !== null && s.status === 'ran' && (
                        <span title={tx('levelNote')}>
                          {s.levelInDb} → {s.levelOutDb} dBFS
                        </span>
                      )}
                      {s.status === 'ran' && <span className="font-mono">{fmtMs(s.ms)}</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-ink-3">{tx('inspect')}:</span>
                {CLIP_ORDER.filter((c) => result.clips[c]).map((c) => (
                  <Button
                    key={c}
                    size="xs"
                    variant={stageUrl?.name === c ? 'secondary' : 'ghost'}
                    icon={stageUrl?.name === c && stagePlayer.playing ? <IconPause size={12} /> : <IconPlay size={12} />}
                    onClick={() => (stageUrl?.name === c ? stagePlayer.toggle() : void playStage(c, result.clips[c].token))}
                  >
                    {tx(c as LabKey)} · {result.clips[c].sampleRate / 1000} kHz
                  </Button>
                ))}
              </div>
            </div>

            {/* metrics */}
            <div>
              <h4 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{tx('metrics')}</h4>
              <Facts
                grid
                items={[
                  [tx('inputDuration'), fmtMs(result.metrics.inputDurationMs)],
                  [tx('outputDuration'), fmtMs(result.metrics.outputDurationMs)],
                  [tx('inputRate'), `${result.metrics.inputSampleRate} Hz`],
                  [tx('outputRate'), `${result.metrics.outputSampleRate} Hz`],
                  [tx('isolationMs'), result.metrics.isolationMs === null ? '—' : fmtMs(result.metrics.isolationMs)],
                  [tx('totalMs'), fmtMs(result.metrics.totalMs)],
                ]}
              />
              <p className="mt-1.5 text-[11.5px] text-ink-3">{tx('levelNote')}</p>
            </div>

            {/* before / after STT */}
            <div className="space-y-2 rounded-[12px] p-4 hairline">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[13px] font-semibold text-ink">
                  {tx('compare')} <span className="font-normal text-ink-3">· {modelName}</span>
                </h4>
                <Button size="sm" loading={comparing} disabled={!modelReady || comparing} onClick={() => void compare()}>
                  {tx('compare')}
                </Button>
              </div>
              <p className="text-[11.5px] text-ink-3">{tx('compareNote')}</p>
              <Textarea
                rows={2}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={tx('reference')}
              />
              {comparison && <ComparisonView c={comparison} reference={reference} tx={tx} isoProvider={iso} loc={loc} />}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function PanelHead({
  title,
  playing,
  onToggle,
  disabled,
  tx,
  extra,
}: {
  title: string;
  playing: boolean;
  onToggle: () => void;
  disabled: boolean;
  tx: ReturnType<typeof labText>;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-label={playing ? tx('pause') : tx('play')}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-white disabled:opacity-40"
        >
          {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        <span className="text-[13px] font-semibold text-ink">{title}</span>
      </div>
      {extra}
    </div>
  );
}

function Facts({ items, grid }: { items: [string, string][]; grid?: boolean }) {
  return (
    <dl className={cn('grid gap-x-4 gap-y-1 text-[12px]', grid ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-3')}>
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-ink-3">{k}</dt>
          <dd className="font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ComparisonView({
  c,
  reference,
  tx,
  isoProvider,
  loc,
}: {
  c: { original: Transcribed; processed: Transcribed; engine: string };
  reference: string;
  tx: ReturnType<typeof labText>;
  isoProvider?: Stage;
  loc: 'uz' | 'ru' | 'en';
}) {
  const diff = wordDiff(c.original.text, c.processed.text);
  const rows: [string, Transcribed][] = [
    [tx('originalText'), c.original],
    [tx('processedText'), c.processed],
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map(([label, r]) => {
          const w = wer(reference, r.text);
          const ch = cer(reference, r.text);
          return (
            <div key={label} className="rounded-[10px] bg-surface-2 p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-3">
                <span className="font-semibold text-ink-2">{label}</span>
                <span>
                  {tx('sttTime')}: {fmtMs(r.clientMs)}
                  {r.serverMs !== null ? ` (server ${fmtMs(r.serverMs)})` : ''}
                </span>
              </div>
              {r.error ? (
                <p className="text-[12.5px] text-danger">
                  {tx('failed')}: {r.error}
                </p>
              ) : (
                <p className="text-[13px] leading-relaxed text-ink">{r.text || <span className="text-ink-3">{tx('empty')}</span>}</p>
              )}
              {w !== null && ch !== null && (
                <p className="mt-1.5 font-mono text-[11.5px] text-ink-2">
                  WER {(w * 100).toFixed(1)}% · CER {(ch * 100).toFixed(1)}%
                </p>
              )}
            </div>
          );
        })}
      </div>
      {!reference.trim() && <p className="text-[11.5px] text-ink-3">{tx('noReference')}</p>}
      <div>
        <div className="mb-1 text-[11.5px] font-semibold text-ink-3">{tx('diff')}</div>
        <p className="text-[13px] leading-relaxed">
          {diff.map((d, i) => (
            <span
              key={i}
              className={cn(
                d.kind === 'removed' && 'bg-danger-soft text-danger line-through',
                d.kind === 'added' && 'bg-success-soft text-success',
                d.kind === 'same' && 'text-ink',
              )}
            >
              {d.text}{' '}
            </span>
          ))}
        </p>
      </div>
      <p className="text-[11.5px] text-ink-3">
        {tx('stt')}: {c.engine} ·{' '}
        {isoProvider
          ? `${STAGE_TEXT[loc].voice_isolation}: ${isoProvider.provider} (${STATUS_TEXT[loc][isoProvider.status]})${isoProvider.error ? ` — ${isoProvider.error}` : ''}`
          : ''}
      </p>
    </div>
  );
}
