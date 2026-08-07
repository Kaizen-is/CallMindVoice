import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Wordmark } from '@/components/icons';
import type { UiLocale } from '@/lib/types';

export function AuthShell({
  children,
  locale = 'uz',
}: {
  children: React.ReactNode;
  locale?: UiLocale;
}) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 aurora opacity-60" />

      <header className="relative z-10 flex items-center justify-between px-5 py-5">
        <Link href="/">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-2">
          <LocaleSwitcher locale={locale} />
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16">
        {children}
      </main>
    </div>
  );
}
