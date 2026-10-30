import { cn } from '@/lib/utils';
import { IconMoon, IconSun } from '@/components/icons';

/**
 * Light/dark switch.
 *
 * Deliberately hook-free. The toggling itself is done by a global, delegated
 * click listener installed once in the root layout's inline bootstrap script
 * (see `THEME_BOOTSTRAP` in layout.tsx) — it runs at page-parse time, so the
 * button works even if React never hydrates this subtree (e.g. when a browser
 * extension mutates the sticky header and breaks its hydration). Which icon is
 * shown follows the `.dark` class purely through CSS, so there is no client
 * state and therefore no server/client hydration mismatch to recover from.
 */
export function ThemeToggle({ className }: { className?: string }) {
  return (
    <button
      type="button"
      data-theme-toggle
      aria-label="Toggle light or dark mode"
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 transition-all duration-200 hover:bg-surface-3 hover:text-ink active:scale-95',
        className,
      )}
    >
      <IconMoon size={18} className="dark:hidden" />
      <IconSun size={18} className="hidden dark:block" />
    </button>
  );
}
