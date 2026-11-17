import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { CloneLab } from './clone-lab';

export const metadata: Metadata = { title: 'Voice Cloning' };
export const dynamic = 'force-dynamic';

/** The account's cloned voices and whether the own TTS is set up, from `GET /views/dev/voice-clone`. */
type CloneData = Omit<ComponentProps<typeof CloneLab>, 'locale'>;

export default async function VoiceClonePage() {
  const { user } = await requireSession();
  const data = await coreGet<CloneData>('/views/dev/voice-clone');

  return <CloneLab locale={user.locale} voices={data.voices} speech={data.speech} />;
}
