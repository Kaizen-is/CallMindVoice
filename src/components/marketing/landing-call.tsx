'use client';

/**
 * The landing page's hero: one real, short clinic call you can hear.
 *
 * The audio is pre-rendered (ElevenLabs, via `npm run render:landing-call`)
 * and served as static files, so the live site never calls a speech API. The
 * whole transcript is visible before playing — the page reads without sound —
 * and while playing, each line's words light up in step with its audio.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import DATA from './landing-call-data.json';
import { cn } from '@/lib/utils';

type Lang = keyof typeof DATA;
interface Turn {
  who: string;
  text: string;
  source?: string;
  audio: string;
  ms: number;
}

const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'uz', label: 'UZ' },
  { id: 'ru', label: 'RU' },
  { id: 'en', label: 'EN' },
];

export interface LandingCallLabels {
  title: string;
  play: string;
  pause: string;
  caller: string;
  agent: string;
  source: string;
  note: string;
}

export function LandingCall({ initialLang, labels }: { initialLang: Lang; labels: LandingCallLabels }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [playing, setPlaying] = useState(false);
  // Which turn is speaking and how far through it (0–1); -1 = not started.
  const [turn, setTurn] = useState(-1);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);
  const turns = DATA[lang] as Turn[];

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => stop, [stop]);

  const playFrom = useCallback(
    (index: number) => {
      if (index >= turns.length) {
        stop();
        setTurn(-1);
        return;
      }
      const audio = new Audio(turns[index].audio);
      audioRef.current = audio;
      setTurn(index);
      setProgress(0);
      const tick = () => {
        if (audioRef.current !== audio) return;
        const total = audio.duration || turns[index].ms / 1000;
        setProgress(Math.min(1, audio.currentTime / total));
        rafRef.current = requestAnimationFrame(tick);
      };
      audio.onended = () => {
        if (audioRef.current !== audio) return;
        cancelAnimationFrame(rafRef.current);
        // A short pause between speakers, like a real line.
        setTimeout(() => audioRef.current === audio && playFrom(index + 1), 350);
      };
      void audio.play().then(
        () => (rafRef.current = requestAnimationFrame(tick)),
        () => stop(),
      );
    },
    [turns, stop],
  );

  const toggle = () => {
    if (playing) {
      stop();
      setTurn(-1);
      return;
    }
    setPlaying(true);
    playFrom(0);
  };

  const switchLang = (next: Lang) => {
    if (next === lang) return;
    stop();
    setTurn(-1);
    setLang(next);
  };

  return (
    <figure className="rounded-[20px] bg-surface p-5 shadow-e2 hairline sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggle}
          // Inline: the global `button { color: inherit }` reset outranks utility classes.
          style={{ color: '#ffffff' }}
          className="inline-flex items-center gap-2.5 rounded-full bg-brand px-4 py-2 text-[14px] font-medium transition-colors hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
          {playing ? labels.pause : labels.play}
        </button>
        <div role="group" aria-label="Language" className="inline-flex rounded-full bg-surface-3 p-0.5">
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={lang === l.id}
              onClick={() => switchLang(l.id)}
              className={cn(
                'rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors',
                lang === l.id ? 'bg-surface text-ink shadow-e1' : 'text-ink-3 hover:text-ink',
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <figcaption className="mt-4 flex items-center gap-2 text-[13px] text-ink-3">
        <span
          className={cn('h-2 w-2 rounded-full', playing ? 'lp-live-dot animate-pulse' : 'bg-ink-3/40')}
          aria-hidden="true"
        />
        {labels.title}
      </figcaption>

      <ol className="mt-4 space-y-4" aria-live="polite">
        {turns.map((t, i) => {
          const words = t.text.split(' ');
          // Before or after playback, everything is readable; during playback,
          // lines ahead stay dim and the speaking line fills in word by word.
          const shown = turn === -1 || i < turn ? words.length : i > turn ? 0 : Math.ceil(progress * words.length);
          const agent = t.who === 'agent';
          return (
            <li key={`${lang}-${i}`} className={cn('max-w-[34rem]', agent && 'ml-auto text-right')}>
              <div className={cn('text-[12px] font-medium', agent ? 'lp-agent' : 'text-ink-3')}>
                {agent ? labels.agent : labels.caller}
              </div>
              <p className={cn('mt-1 text-[15.5px] leading-relaxed', agent ? 'text-ink' : 'text-ink-2')}>
                {words.map((w, wi) => (
                  <span key={wi} className="lp-word" data-hidden={wi >= shown}>
                    {w}{' '}
                  </span>
                ))}
              </p>
              {t.source && (
                <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface-3 px-2.5 py-0.5 text-[12px] text-ink-2">
                  <DocGlyph />
                  {labels.source}: {t.source}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <p className="mt-5 text-[12px] text-ink-3">{labels.note}</p>
    </figure>
  );
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 1.8v10.4a.6.6 0 0 0 .9.5l8.6-5.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect x="3" y="2" width="3" height="10" rx="0.8" fill="currentColor" />
      <rect x="8" y="2" width="3" height="10" rx="0.8" fill="currentColor" />
    </svg>
  );
}

function DocGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M3 1h4l2.5 2.5V10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );
}
