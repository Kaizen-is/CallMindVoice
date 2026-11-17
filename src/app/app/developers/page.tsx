import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { DevelopersData } from '@/lib/workspace-views';
import { DevelopersPanel } from './panel';

export const metadata: Metadata = { title: 'Developers' };
export const dynamic = 'force-dynamic';

export default async function DevelopersPage() {
  const { tenant, user } = await requireSession();
  // API keys and webhooks (newest first), and the number the code examples dial.
  const { keys, hooks, exampleNumber } = await coreGet<DevelopersData>('/views/developers');

  return (
    <DevelopersPanel
      keys={keys}
      hooks={hooks}
      tenantId={tenant.id}
      exampleNumber={exampleNumber}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      locale={user.locale}
    />
  );
}
