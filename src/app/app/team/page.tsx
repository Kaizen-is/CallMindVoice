import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { TeamData } from '@/lib/workspace-views';
import { TeamManager } from './manager';

export const metadata: Metadata = { title: 'Team' };
export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const { user } = await requireSession();
  // Members (owners first) with their resolved hand-offs, and the last 25 audit entries.
  const { members, audit } = await coreGet<TeamData>('/views/team');

  return (
    <TeamManager
      members={members}
      audit={audit}
      currentUserId={user.id}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      locale={user.locale}
    />
  );
}
