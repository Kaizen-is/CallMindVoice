import { requireSession, recentAudit } from '@/lib/auth';
import { all } from '@/lib/db';
import type { SafeUser } from '@/lib/types';
import { TeamManager } from '@/app/app/team/manager';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/team.
export default async function TeamModal() {
  const { tenant, user } = await requireSession();
  const members = all<SafeUser & { handled: number }>(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.avatar_hue, u.locale, u.status,
            u.presence, u.last_seen_at, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM escalations e WHERE e.operator_id = u.id AND e.status='resolved') AS handled
     FROM users u WHERE u.tenant_id=? ORDER BY
       CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
       u.created_at ASC`,
    tenant.id,
  );
  const audit = recentAudit(tenant.id, 25) as Array<{
    id: string;
    actor_name: string | null;
    action: string;
    target: string | null;
    created_at: string;
  }>;

  return (
    <>
      <SettingsModalSignal />
      <TeamManager
        members={members}
        audit={audit}
        currentUserId={user.id}
        canEdit={user.role === 'owner' || user.role === 'admin'}
      />
    </>
  );
}
