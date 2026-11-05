'use client';

/**
 * Keeps the `.dark` class on <html> in step with the saved theme.
 *
 * The bootstrap script in the root layout sets the class before first paint,
 * but if React ever has to re-render the document on the client (a hydration
 * mismatch anywhere on the page), it rewrites <html>'s attributes and the class
 * is gone — the page flips to light mid-session. This watches for that and puts
 * the saved theme back. It never changes the theme itself; the toggle does.
 */
import { useEffect } from 'react';

const KEY = 'ovoz-theme';

function wantsDark(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored === 'dark';
  } catch {
    /* storage unavailable — fall back to the system setting */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeKeeper() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const dark = wantsDark();
      if (root.classList.contains('dark') !== dark) root.classList.toggle('dark', dark);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return null;
}
