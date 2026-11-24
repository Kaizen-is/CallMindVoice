import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { OperatorInbox, type InboxItem } from './inbox';

export const metadata: Metadata = { title: 'Operator inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const { user } = await requireSession();
  // Open escalations with their transcripts, from the Python backend (backend/app/operations.py).
  const items = await coreGet<InboxItem[]>('/views/inbox');
  return <OperatorInbox items={items} locale={user.locale} operatorId={user.id} />;
}
