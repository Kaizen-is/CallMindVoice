/**
 * /logistics — the public, login-free demo of a cargo company's phone agent:
 * the visitor calls and asks where their parcel from China is.
 * Everything that makes it safe to leave open lives in `@/lib/logistics`.
 */
import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import { after } from 'next/server';
import { demoLang } from '@/lib/demo-shared';
import { LOGISTICS_VOICES, TRY_TRACKS, logisticsAgent, logisticsVoice, warmLogistics } from '@/lib/logistics';
import { gapiConfigured } from '@/lib/speech/gapi';
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

export default async function LogisticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = demoLang(params.lang);
  const agent = logisticsAgent();
  // Render the greetings and fillers ahead of the visitor's tap.
  after(() => warmLogistics(agent));
  const tracks = TRY_TRACKS.join(' · ');

  return (
    <LogisticsCall
      fontClass={geist.variable}
      initialLang={lang}
      available={gapiConfigured()}
      identity={IDENTITY}
      persona={{ name: { uz: tracks, ru: tracks }, birthYear: '' }}
      voices={LOGISTICS_VOICES}
      initialVoice={logisticsVoice(params.voice)}
    />
  );
}
