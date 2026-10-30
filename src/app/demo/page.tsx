/**
 * /demo — the public, login-free demo of the bank's loan-reminder agent.
 * Everything that makes it safe to leave open lives in `@/lib/demo`.
 */
import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { DEMO_IDENTITY, DEMO_PERSONA, demoAgent, demoVoices, warmDemo } from '@/lib/demo';
import { demoLang } from '@/lib/demo-shared';
import { DemoCall } from './demo-call';
import './view-transitions.css';

const geist = Geist({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  display: 'swap',
  variable: '--font-demo',
});

/** Where the public reaches this server, used when the forwarded host is internal. */
const PUBLIC_ORIGIN = process.env.DEMO_PUBLIC_URL || 'https://callmind.brb-tech.uz';

/**
 * A link preview needs an absolute image URL, and behind nginx the request may
 * name the upstream (127.0.0.1:3000) rather than the public domain.
 */
async function publicOrigin(): Promise<URL> {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0].trim();
  if (!host || /^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(host)) return new URL(PUBLIC_ORIGIN);
  const proto = (h.get('x-forwarded-proto') ?? 'https').split(',')[0].trim();
  return new URL(`${proto}://${host}`);
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: await publicOrigin(),
    title: 'Isomiddin — AI bank assistant',
    description:
      'Javob bering va bank yordamchisi bilan gaplashing. Ответьте на звонок и поговорите с банковским AI-ассистентом.',
    robots: { index: false, follow: false },
    openGraph: {
      title: 'Isomiddin — AI bank assistant',
      description: 'Javob bering va gaplashing · Ответьте и поговорите',
      type: 'website',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafd' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0d14' },
  ],
};

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = demoLang(params.lang);
  const agent = demoAgent();
  const voices = agent ? demoVoices(agent) : [];
  const voice = typeof params.voice === 'string' && voices.some((v) => v.id === params.voice) ? params.voice : '';
  // Render both opening lines ahead of the visitor's tap.
  if (agent) after(() => warmDemo(agent));

  return (
    <DemoCall
      fontClass={geist.variable}
      initialLang={lang}
      available={Boolean(agent)}
      identity={{ agent: { ...DEMO_IDENTITY.agent }, org: { ...DEMO_IDENTITY.org } }}
      persona={{ name: { ...DEMO_PERSONA.name }, birthYear: DEMO_PERSONA.birthYear }}
      voices={voices}
      initialVoice={voice}
    />
  );
}
