import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/overlays';

export const metadata: Metadata = {
  title: {
    default: 'Ovoz — AI that answers your phones',
    template: '%s · Ovoz',
  },
  description:
    'Upload your documents. Ovoz turns them into a voice agent that answers calls in Uzbek, Russian and English — and hands the hard ones to your team with full context.',
  applicationName: 'Ovoz',
  keywords: [
    'AI contact center', 'voice agent', 'Uzbekistan', 'call center automation',
    'RAG', 'customer service', 'ovozli agent', 'голосовой агент',
  ],
  authors: [{ name: 'Ovoz AI' }],
  openGraph: {
    title: 'Ovoz — AI that answers your phones',
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
 * Applied before first paint so a dark-mode user never sees a white flash.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem('ovoz-theme');
    var dark = stored ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
