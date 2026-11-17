import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { DevelopersData } from '@/lib/workspace-views';
import { DevelopersPanel } from '@/app/app/developers/panel';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/developers.
export default async function DevelopersModal() {
  const { tenant, user } = await requireSession();
  const { keys, hooks, exampleNumber } = await coreGet<DevelopersData>('/views/developers');

  return (
    <>
      <SettingsModalSignal />
      <DevelopersPanel
        keys={keys}
        hooks={hooks}
        tenantId={tenant.id}
        exampleNumber={exampleNumber}
        canEdit={user.role === 'owner' || user.role === 'admin'}
        locale={user.locale}
      />
    </>
  );
}
