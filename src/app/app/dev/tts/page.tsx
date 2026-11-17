import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { TtsLab } from './tts-lab';

export const metadata: Metadata = { title: 'Text to Speech' };
export const dynamic = 'force-dynamic';

/** Agents with their voices, every voice, recent tests and what is set up, from `GET /views/dev/tts`. */
type TtsData = Omit<ComponentProps<typeof TtsLab>, 'locale'>;

export default async function DevTtsPage() {
  const { user } = await requireSession();
  const data = await coreGet<TtsData>('/views/dev/tts');

  return (
    <TtsLab
      locale={user.locale}
      agents={data.agents}
      voices={data.voices}
      customVoices={data.customVoices}
      elevenVoices={data.elevenVoices}
      history={data.history}
      speech={data.speech}
    />
  );
}
