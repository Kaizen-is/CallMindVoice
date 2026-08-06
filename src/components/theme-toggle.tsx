'use client';

import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from '@/components/icons';
import { cn } from '@/lib/utils';

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('ovoz-theme', next ? 'dark' : 'light');
    } catch {
      /* private mode — theme just won't persist */
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 transition-all duration-200 hover:bg-surface-3 hover:text-ink active:scale-95',
        className,
      )}
    >
      <span className={cn('transition-transform duration-300', mounted && dark && 'rotate-180')}>
        {mounted && dark ? <IconSun size={18} /> : <IconMoon size={18} />}
      </span>
    </button>
  );
}
