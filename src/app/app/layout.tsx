import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
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

  // Python closes Playground tests left open (closed tab, dropped line) so they do not count as
  // live calls, and returns the sidebar counts.
  const { counts } = await coreGet<{
    counts: { waitingEscalations: number; activeCalls: number; documents: number };
  }>('/views/console-layout');

  return (
    <>
      <ConsoleShell user={session.user} tenant={session.tenant} counts={counts}>
        {children}
      </ConsoleShell>
      {settings}
    </>
  );
}
