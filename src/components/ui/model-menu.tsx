'use client';

/**
 * A compact model picker: a button showing the chosen model; a click opens the
 * list of model names. Models this server cannot run are dimmed (what they need
 * shows on hover).
 * Used by For developers ▸ STT, the Playground and Models ▸ Voices.
 */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { IconCheck, IconChevronDown } from '@/components/icons';

export interface ModelOption {
  id: string;
  name: string;
  /** A short note (vendor, price); kept for callers, not shown in the list. */
  detail?: string;
  ready: boolean;
  /** What it needs when not ready, e.g. an env var. */
  setup?: string;
}

export function ModelMenu({
  options,
  value,
  onChange,
  needsLabel = 'Needs {setup}',
  size = 'md',
  align = 'left',
  side = 'bottom',
  className,
}: {
  options: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  /** Shown for models that are not set up; `{setup}` is replaced. */
  needsLabel?: string;
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
  /** Open below the button (default) or above it, e.g. at the bottom of a card. */
  side?: 'bottom' | 'top';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
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
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Inline: the global `button { font: inherit }` reset outranks text-size classes.
        style={{ fontSize: size === 'sm' ? 11.5 : 12.5, lineHeight: size === 'sm' ? '16px' : '18px' }}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg bg-surface font-medium text-ink hairline transition-colors hover:bg-surface-2',
          size === 'sm' ? 'px-2 py-1' : 'px-3 py-1.5',
        )}
      >
        <span className="max-w-[180px] truncate">{current?.name ?? '—'}</span>
        <IconChevronDown size={size === 'sm' ? 12 : 14} className={cn('text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="listbox"
          className={cn(
            'absolute z-50 max-h-[320px] w-[260px] overflow-y-auto rounded-xl bg-overlay p-1 shadow-e3 hairline',
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {options.map((o) => {
            const selected = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={!o.ready}
                title={o.ready ? undefined : needsLabel.replace('{setup}', o.setup ?? '')}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                style={{ fontSize: 12.5, lineHeight: '18px' }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  o.ready ? 'hover:bg-surface-2' : 'cursor-not-allowed opacity-45',
                  selected && 'bg-surface-2',
                )}
              >
                <span className="flex w-3.5 shrink-0 justify-center text-brand">{selected && <IconCheck size={13} />}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{o.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
