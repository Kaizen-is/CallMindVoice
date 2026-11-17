import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { VoicesGallery } from './voices';

export const metadata: Metadata = { title: 'Voices' };
export const dynamic = 'force-dynamic';

/**
 * Every TTS model with its voices, from the Python backend (`GET /views/models/voices`): own TTS
 * speaks the built-in and the account's cloned/designed voices, the ElevenLabs voices (through
 * Speko) speak on every ElevenLabs model, and the BRB model has one voice.
 */
type VoicesData = Omit<ComponentProps<typeof VoicesGallery>, 'locale'>;

export default async function VoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user } = await requireSession();
  const params = await searchParams;
  const data = await coreGet<VoicesData>(
    params.model ? `/views/models/voices?model=${encodeURIComponent(params.model)}` : '/views/models/voices',
  );

  return (
    <VoicesGallery locale={user.locale} models={data.models} voices={data.voices} initialModel={data.initialModel} />
  );
}
