import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { TurnLab } from './turn-lab';

export const metadata: Metadata = { title: 'Turn lab' };
export const dynamic = 'force-dynamic';

/** Whether the lab is on (TURN_LAB=on) and what is saved, from the Python backend (`GET /turn-lab/status`). */
type TurnLabStatus = { enabled: boolean; saved: number; mine: string[] };

export default async function TurnLabPage() {
  const { user } = await requireSession();
  const status = await coreGet<TurnLabStatus>('/turn-lab/status');

  return <TurnLab locale={user.locale} enabled={status.enabled} saved={status.saved} mine={status.mine} />;
}
