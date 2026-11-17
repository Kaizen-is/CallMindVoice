import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { DesignLab } from './design-lab';

export const metadata: Metadata = { title: 'Voice Design' };
export const dynamic = 'force-dynamic';

/** The account's designed voices and whether the own TTS is set up, from `GET /views/dev/voice-design`. */
type DesignData = Omit<ComponentProps<typeof DesignLab>, 'locale'>;

export default async function VoiceDesignPage() {
  const { user } = await requireSession();
  const data = await coreGet<DesignData>('/views/dev/voice-design');

  return <DesignLab locale={user.locale} voices={data.voices} speech={data.speech} />;
}
