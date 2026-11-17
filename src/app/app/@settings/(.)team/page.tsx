import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { TeamData } from '@/lib/workspace-views';
import { TeamManager } from '@/app/app/team/manager';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/team.
export default async function TeamModal() {
  const { user } = await requireSession();
  const { members, audit } = await coreGet<TeamData>('/views/team');

  return (
    <>
      <SettingsModalSignal />
      <TeamManager
        members={members}
        audit={audit}
        currentUserId={user.id}
        canEdit={user.role === 'owner' || user.role === 'admin'}
        locale={user.locale}
      />
    </>
  );
}
