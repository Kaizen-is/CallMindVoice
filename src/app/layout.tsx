import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import { ToastProvider } from '@/components/ui/overlays';
import { ThemeKeeper } from '@/components/theme-keeper';

export const metadata: Metadata = {
  title: {
    default: 'CallMind AI — the AI that answers your phones',
    template: '%s · CallMind AI',
  },
  description:
    'Upload your documents. CallMind AI turns them into a voice agent that answers calls in Uzbek, Russian and English — and hands the hard ones to your team with full context.',
  applicationName: 'CallMind AI',
  keywords: [
    'AI contact center', 'voice agent', 'Uzbekistan', 'call center automation',
    'RAG', 'customer service', 'ovozli agent', 'голосовой агент',
  ],
  authors: [{ name: 'CallMind AI' }],
  openGraph: {
    title: 'CallMind AI — the AI that answers your phones',
    description:
      'Turn your company documents into a voice agent that answers calls in Uzbek, Russian and English.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0d' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * Runs before first paint (theme applied so a dark-mode user never sees a white
 * flash) and wires the theme toggle via a single delegated listener on the
 * document. Doing the toggle here — rather than with a React onClick — means the
 * light/dark switch keeps working even if a header subtree fails to hydrate
 * (e.g. a browser extension mutating the sticky header). Any element carrying
 * `data-theme-toggle` flips the theme when clicked.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('ovoz-theme');
    var dark = stored ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
    if (!btn) return;
    var isDark = document.documentElement.classList.toggle('dark');
    try { localStorage.setItem('ovoz-theme', isDark ? 'dark' : 'light'); } catch (e) {}
  });
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {/* Injected into the server HTML and run before hydration, so a
            dark-mode user never sees a white flash — without a raw <script>
            in the React tree, which React refuses to run on a client render. */}
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {THEME_BOOTSTRAP}
        </Script>
        <ThemeKeeper />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
