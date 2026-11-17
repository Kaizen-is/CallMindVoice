import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { SttLab } from './stt-lab';

export const metadata: Metadata = { title: 'Speech to Text' };
export const dynamic = 'force-dynamic';

/** Recent tests and every STT model, from the Python backend (`GET /views/dev/stt`). */
type SttData = Omit<ComponentProps<typeof SttLab>, 'locale'>;

export default async function DevSttPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user } = await requireSession();
  const params = await searchParams;
  // ?model=… from Models ▸ Model lab ▸ Test; otherwise the first model set up here.
  const data = await coreGet<SttData>(
    params.model ? `/views/dev/stt?model=${encodeURIComponent(params.model)}` : '/views/dev/stt',
  );

  return <SttLab locale={user.locale} history={data.history} models={data.models} initialModel={data.initialModel} />;
}
