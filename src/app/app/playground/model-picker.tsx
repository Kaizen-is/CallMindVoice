'use client';

/**
 * The Playground's model picker: a small tab on the right edge of the screen
 * that opens a panel for choosing which STT and TTS engines the next turns
 * use. Deliberately out of the way — it is for comparing engines, not part of
 * rehearsing a call. Unavailable engines are listed but disabled, with the
 * env var that turns them on.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { IconSettings, IconX } from '@/components/icons';
import type { Translate } from '@/lib/i18n';

export type SttChoice = 'auto' | 'gapi' | 'local' | 'gemini';
export type TtsChoice = 'default' | 'eleven_v3_conversational' | 'eleven_v4_turbo';

const STT_OPTIONS: Array<{ id: SttChoice; label: string; hint: string; env: string }> = [
  { id: 'auto', label: 'Own (Kotib)', hint: 'Internal Uzbek model, Whisper/Gemini for other languages', env: 'STT_TRANSCRIBE_URL' },
  { id: 'gapi', label: 'GAPI', hint: 'Hosted, one shot per utterance · WER ~8–10%', env: 'GAPIAPI' },
  { id: 'local', label: 'Zipformer (streaming)', hint: 'Runs inside the app, word by word · ~0.2 s', env: 'models/uzbek-zipformer' },
  { id: 'gemini', label: 'gemini-3.5', hint: 'Google Gemini Transcribe via Speko · accurate, ~5 s', env: 'SPEKO_API_KEY' },
];

const TTS_OPTIONS: Array<{ id: TtsChoice; label: string; hint: string; env: string }> = [
  { id: 'default', label: 'Internal (OmniVoice)', hint: 'Uses the voice selected above', env: 'TTS_BASE_URL' },
  { id: 'eleven_v4_turbo', label: 'ElevenLabs v4 turbo', hint: 'via Speko · fastest (~0.5 s)', env: 'SPEKO_API_KEY' },
  { id: 'eleven_v3_conversational', label: 'ElevenLabs v3 conversational', hint: 'via Speko', env: 'SPEKO_API_KEY' },
];

const STORAGE_KEY = 'ovoz_pg_models';

/** The saved choice, falling back to the first available engine. */
export function useModelChoice(stt: Record<SttChoice, boolean>, tts: Record<TtsChoice, boolean>) {
  const firstStt = (STT_OPTIONS.find((o) => stt[o.id])?.id ?? 'auto') as SttChoice;
  const firstTts = (TTS_OPTIONS.find((o) => tts[o.id])?.id ?? 'default') as TtsChoice;
  const [sttEngine, setSttState] = useState<SttChoice>(firstStt);
  const [ttsEngine, setTtsState] = useState<TtsChoice>(firstTts);
  const choice = useRef({ stt: firstStt, tts: firstTts });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { stt?: SttChoice; tts?: TtsChoice };
      if (saved.stt && stt[saved.stt]) {
        choice.current.stt = saved.stt;
        setSttState(saved.stt);
      }
      if (saved.tts && tts[saved.tts]) {
        choice.current.tts = saved.tts;
        setTtsState(saved.tts);
      }
    } catch {
      /* storage unavailable — keep the defaults */
    }
    // Only on mount: availability is fixed for the page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved when the user picks, never on mount: saving the starting default
  // there overwrote the remembered choice before it had been read back.
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice.current));
    } catch {
      /* storage unavailable */
    }
  };
  const setSttEngine = (id: SttChoice) => {
    choice.current.stt = id;
    setSttState(id);
    save();
  };
  const setTtsEngine = (id: TtsChoice) => {
    choice.current.tts = id;
    setTtsState(id);
    save();
  };

  return { sttEngine, setSttEngine, ttsEngine, setTtsEngine };
}

export function ModelPicker({
  stt,
  tts,
  sttEngine,
  ttsEngine,
  onStt,
  onTts,
  t,
}: {
  stt: Record<SttChoice, boolean>;
  tts: Record<TtsChoice, boolean>;
  sttEngine: SttChoice;
  ttsEngine: TtsChoice;
  onStt: (id: SttChoice) => void;
  onTts: (id: TtsChoice) => void;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={panelRef} className="fixed right-0 top-1/2 z-40 -translate-y-1/2">
      {!open && (
        <button
          type="button"
          aria-label={t('play.models', 'Models')}
          title={t('play.models', 'Models')}
          onClick={() => setOpen(true)}
          className="flex h-8 w-5 items-center justify-center rounded-l-md bg-surface-3/60 text-ink-3 opacity-40 transition-all hover:w-6 hover:opacity-100"
        >
          <IconSettings size={12} />
        </button>
      )}
      {open && (
        <div className="mr-3 w-[280px] rounded-xl bg-surface p-3 shadow-lg hairline">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] font-semibold text-ink">{t('play.models', 'Models')}</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            >
              <IconX size={14} />
            </button>
          </div>
          <Group t={t} title={t('play.modelsStt', 'Speech-to-text')} options={STT_OPTIONS} available={stt} value={sttEngine} onChange={onStt} />
          <Group t={t} title={t('play.modelsTts', 'Text-to-speech')} options={TTS_OPTIONS} available={tts} value={ttsEngine} onChange={onTts} />
        </div>
      )}
    </div>
  );
}

function Group<T extends string>({
  t,
  title,
  options,
  available,
  value,
  onChange,
}: {
  t: Translate;
  title: string;
  options: Array<{ id: T; label: string; hint: string; env: string }>;
  available: Record<T, boolean>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset className="mb-2 last:mb-0">
      <legend className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</legend>
      <div className="flex flex-col gap-0.5">
        {options.map((o) => {
          const on = available[o.id];
          return (
            <label
              key={o.id}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[12.5px]',
                on ? 'hover:bg-surface-2' : 'cursor-not-allowed opacity-45',
                value === o.id && on && 'bg-brand-soft',
              )}
            >
              <input
                type="radio"
                className="mt-0.5 accent-[var(--color-brand,currentColor)]"
                checked={value === o.id}
                disabled={!on}
                onChange={() => onChange(o.id)}
              />
              <span>
                <span className="block text-ink">{o.label}</span>
                <span className="block text-[11px] text-ink-3">{on ? o.hint : t('play.setToEnable', 'Set {env} to enable').replace('{env}', o.env)}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
