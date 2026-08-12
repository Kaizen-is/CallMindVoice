import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { overview } from '@/lib/analytics';
import { activeCalls, reapStaleCalls } from '@/lib/engine/calls';
import { simulatorLoad } from '@/lib/engine/simulator';
import { telephonyStatus } from '@/lib/telephony/status';
import type { Turn } from '@/lib/types';
import { LiveBoard } from './board';

export const metadata: Metadata = { title: 'Live calls' };
export const dynamic = 'force-dynamic';

export default async function LivePage() {
  const { tenant, user } = await requireSession();
  reapStaleCalls(tenant.id);
  const calls = activeCalls(tenant.id);
  const stats = overview(tenant.id, 1);

  const withLast = calls.map((c) => {
    const last = all<Turn>(
      `SELECT role, text, confidence, created_at FROM turns
       WHERE call_id=? AND text != '__unanswered__' ORDER BY ordinal DESC LIMIT 2`,
      c.id,
    );
    return { call: c, recent: last.reverse() };
  });

  return (
    <LiveBoard
      locale={user.locale}
      calls={withLast}
      todayCalls={stats.totalCalls}
      todayDeflection={stats.deflectionRate}
      waiting={stats.waitingEscalations}
      simulated={simulatorLoad(tenant.id)}
      telephony={telephonyStatus()}
    />
  );
}
