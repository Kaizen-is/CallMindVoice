import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { inboxAction } from '@/app/actions/ops';
import { OperatorInbox } from './inbox';

export const metadata: Metadata = { title: 'Operator inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const { user } = await requireSession();
  const items = await inboxAction();
  return <OperatorInbox items={items} locale={user.locale} operatorId={user.id} />;
}
