/**
 * /logistics — the public, login-free demo of a cargo company's phone agent:
 * the visitor calls and asks where their parcel from China is.
 * Everything that makes it safe to leave open lives in the Python backend
 * (`backend/app/logistics.py`); this page reads its data from `GET /views/logistics`.
 */
import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import { coreGet } from '@/lib/core';
import { demoLang } from '@/lib/demo-shared';
import { LogisticsCall } from './logistics-call';
import '@/app/demo/view-transitions.css';

const geist = Geist({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  display: 'swap',
  variable: '--font-demo',
});

export const metadata: Metadata = {
  title: 'Logistika — AI operator',
  description:
    'Qoʻngʻiroq qiling va yukingiz qayerdaligini soʻrang. Позвоните и спросите, где ваш груз.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafd' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0d14' },
  ],
};

export const dynamic = 'force-dynamic';

const IDENTITY = {
  agent: { uz: 'Logistika operatori', ru: 'Оператор логистики' },
  org: { uz: 'Xitoy → Oʻzbekiston yuk yetkazib berish', ru: 'Доставка грузов Китай → Узбекистан' },
};

/** `GET /views/logistics`: whether GAPI is set up, the two voices, the numbers to try, the picked voice. */
interface LogisticsView {
  available: boolean;
  voices: Array<{ id: string; name: string; group: 'builtin' }>;
  tracks: string[];
  initialVoice: string;
}

export default async function LogisticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = demoLang(params.lang);
  // Python creates the demo's agent on first use and renders the greetings ahead of the visitor's tap.
  const voice = typeof params.voice === 'string' ? `?voice=${encodeURIComponent(params.voice)}` : '';
  const view = await coreGet<LogisticsView>(`/views/logistics${voice}`);
  const tracks = view.tracks.join(' · ');

  return (
    <LogisticsCall
      fontClass={geist.variable}
      initialLang={lang}
      available={view.available}
      identity={IDENTITY}
      persona={{ name: { uz: tracks, ru: tracks }, birthYear: '' }}
      voices={view.voices}
      initialVoice={view.initialVoice}
    />
  );
}
