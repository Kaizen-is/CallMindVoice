import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { ModelLab } from './model-lab';

export const metadata: Metadata = { title: 'Model lab' };
export const dynamic = 'force-dynamic';

/** The lab's numbers and the account's model choice, from the Python backend (`GET /views/models/lab`). */
type ModelLabData = Omit<ComponentProps<typeof ModelLab>, 'locale'>;

export default async function ModelLabPage() {
  const { user } = await requireSession();
  const data = await coreGet<ModelLabData>('/views/models/lab');

  return (
    <ModelLab
      locale={user.locale}
      stats={data.stats}
      canEdit={data.canEdit}
      llmDefault={data.llmDefault}
      llmInUse={data.llmInUse}
      llmServerDefaultLabel={data.llmServerDefaultLabel}
    />
  );
}
