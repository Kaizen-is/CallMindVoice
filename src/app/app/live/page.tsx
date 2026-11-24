import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { Call } from '@/lib/types';
import { LiveBoard } from './board';

export const metadata: Metadata = { title: 'Live calls' };
export const dynamic = 'force-dynamic';

/** The wallboard's data, from the Python backend (backend/app/operations.py), which also closes stale calls. */
interface LiveData {
  calls: Array<{
    call: Call;
    recent: Array<{ role: string; text: string; confidence: number | null; created_at: string }>;
  }>;
  todayCalls: number;
  todayDeflection: number;
  waiting: number;
  simulated: number;
  telephony: { configured: boolean; mode: 'asterisk' | 'simulator' };
}

export default async function LivePage() {
  const { user } = await requireSession();
  const live = await coreGet<LiveData>('/views/live');

  return (
    <LiveBoard
      locale={user.locale}
      calls={live.calls}
      todayCalls={live.todayCalls}
      todayDeflection={live.todayDeflection}
      waiting={live.waiting}
      simulated={live.simulated}
      telephony={live.telephony}
    />
  );
}
