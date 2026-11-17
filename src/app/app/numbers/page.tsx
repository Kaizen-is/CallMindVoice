import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { NumbersData } from '@/lib/workspace-views';
import { NumbersManager } from './manager';

export const metadata: Metadata = { title: 'Phone numbers' };
export const dynamic = 'force-dynamic';

export default async function NumbersPage() {
  const { user } = await requireSession();
  // The company's numbers with their agent and call count, and the telephony mode.
  const { numbers, telephony } = await coreGet<NumbersData>('/views/numbers');

  return (
    <NumbersManager
      numbers={numbers}
      telephony={telephony}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      locale={user.locale}
    />
  );
}
