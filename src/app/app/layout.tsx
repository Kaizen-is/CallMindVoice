import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { get } from '@/lib/db';
import { ConsoleShell } from '@/components/console/shell';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({
  children,
  settings,
}: {
  children: React.ReactNode;
  settings: React.ReactNode;
}) {
  const session = await currentSession();
  if (!session) redirect('/login');
  if (!session.tenant.onboarded) redirect('/onboarding');

  const tenantId = session.tenant.id;
  const counts = {
    waitingEscalations:
      get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM escalations WHERE tenant_id=? AND status='waiting'`,
        tenantId,
      )?.c ?? 0,
    activeCalls:
      get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM calls WHERE tenant_id=? AND status IN ('ringing','active','escalating','with_operator')`,
        tenantId,
      )?.c ?? 0,
    documents:
      get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE tenant_id=?', tenantId)?.c ?? 0,
  };

  return (
    <>
      <ConsoleShell user={session.user} tenant={session.tenant} counts={counts}>
        {children}
      </ConsoleShell>
      {settings}
    </>
  );
}
