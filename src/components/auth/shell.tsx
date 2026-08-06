import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { Wordmark } from '@/components/icons';

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 grid-bg" />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 aurora opacity-60" />

      <header className="relative z-10 flex items-center justify-between px-5 py-5">
        <Link href="/">
          <Wordmark />
        </Link>
        <ThemeToggle />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16">
        {children}
      </main>
    </div>
  );
}
