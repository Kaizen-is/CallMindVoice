import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { translator } from '@/lib/i18n';
import { Playground } from './playground';

export const metadata: Metadata = { title: 'Playground' };
export const dynamic = 'force-dynamic';

/**
 * The Playground's data, from the Python backend (`GET /views/playground`), which also adds the
 * /demo banking agent to the account once. `engine` is the account default's label, or null when
 * the local synthesiser answers (worded here, in the visitor's language).
 */
type PlaygroundData = Omit<ComponentProps<typeof Playground>, 'locale' | 'engine'> & { engine: string | null };

export default async function PlaygroundPage() {
  const { user } = await requireSession();
  const data = await coreGet<PlaygroundData>('/views/playground');
  const t = translator(user.locale);

  return (
    <Playground
      locale={user.locale}
      industry={data.industry}
      engine={data.engine ?? t('play.localSynth', 'Local synthesiser')}
      agentVoices={data.agentVoices}
      agentEngines={data.agentEngines}
      speech={data.speech}
      agents={data.agents}
      elevenVoices={data.elevenVoices}
      geminiVoices={data.geminiVoices}
      allVoices={data.allVoices}
      agent={data.agent}
    />
  );
}
