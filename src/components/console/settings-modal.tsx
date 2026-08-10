'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { IconX } from '@/components/icons';

export interface SettingsSection {
  href: string;
  label: string;
  icon: ReactNode;
}

const ModalOpenContext = createContext<(open: boolean) => void>(() => {});

/**
 * Tells the persistent chrome whether a section is actually open. Rendered by
 * each intercepting page (open) and by the slot's `default` (open={false}), so
 * the modal appears only when a section was reached via soft navigation — never
 * as an empty overlay on a direct/hard visit to a section URL. Because only the
 * `default` signal sets it back to false, switching between sections keeps the
 * modal continuously open (no flicker).
 */
export function SettingsModalSignal({ open = true }: { open?: boolean }) {
  const setOpen = useContext(ModalOpenContext);
  useEffect(() => {
    setOpen(open);
  }, [open, setOpen]);
  return null;
}

/**
 * Claude-style settings modal chrome: blurred dark backdrop and a fixed-size
 * dialog with a left sidebar. Lives in the `@settings` slot layout so it stays
 * mounted across section switches (only the content swaps). Closing (backdrop,
 * ✕, Escape) does router.back() to the page it was opened over.
 */
export function SettingsModalChrome({
  sections,
  title,
  children,
}: {
  sections: SettingsSection[];
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && router.back();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, router]);

  const overlay = (
    <div
      className={cn(
        'fixed inset-0 z-[100] flex items-center justify-center p-4 transition-opacity duration-200',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[4px] dark:bg-black/70"
        onClick={() => router.back()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex h-[600px] max-h-[calc(100vh-2rem)] w-full max-w-[880px] overflow-hidden rounded-[18px] bg-overlay shadow-e4 hairline"
      >
        {/* sidebar */}
        <aside className="hidden w-[220px] shrink-0 flex-col bg-surface-2 p-3 hairline-r sm:flex">
          <div className="px-2.5 pt-2 pb-3 text-[13px] font-semibold text-ink">{title}</div>
          <nav className="space-y-0.5">
            {sections.map((s) => {
              const active = pathname === s.href || pathname.startsWith(s.href + '/');
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  replace
                  scroll={false}
                  className={cn(
                    'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium transition-colors',
                    active ? 'bg-brand-soft text-brand-ink' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                  )}
                >
                  <span className={cn('shrink-0', active ? 'text-brand' : 'text-ink-3')}>{s.icon}</span>
                  {s.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-end px-3 hairline-b">
            <button
              type="button"
              onClick={() => router.back()}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <IconX size={18} />
            </button>
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        </div>
      </div>
    </div>
  );

  return (
    <ModalOpenContext.Provider value={setOpen}>
      {mounted ? createPortal(overlay, document.body) : null}
    </ModalOpenContext.Provider>
  );
}
