import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { primaryNumber } from '@/lib/engine/calls';
import type { ApiKey, Webhook } from '@/lib/types';
import { DevelopersPanel } from './panel';

export const metadata: Metadata = { title: 'Developers' };
export const dynamic = 'force-dynamic';

export default async function DevelopersPage() {
  const { tenant, user } = await requireSession();
  const keys = all<ApiKey>(
    'SELECT * FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC',
    tenant.id,
  );
  const hooks = all<Webhook>(
    'SELECT * FROM webhooks WHERE tenant_id=? ORDER BY created_at DESC',
    tenant.id,
  );
  const number = primaryNumber(tenant.id);

  return (
    <DevelopersPanel
      keys={keys}
      hooks={hooks}
      tenantId={tenant.id}
      exampleNumber={number?.e164 ?? '+998712000000'}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      locale={user.locale}
    />
  );
}
