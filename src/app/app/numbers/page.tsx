import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import * as twilio from '@/lib/telephony/twilio';
import type { PhoneNumber } from '@/lib/types';
import { NumbersManager } from './manager';

export const metadata: Metadata = { title: 'Phone numbers' };
export const dynamic = 'force-dynamic';

export default async function NumbersPage() {
  const { tenant, user } = await requireSession();
  const numbers = all<PhoneNumber & { agent_name: string | null; call_count: number }>(
    `SELECT n.*, a.name AS agent_name,
            (SELECT COUNT(*) FROM calls c WHERE c.number_id = n.id) AS call_count
     FROM phone_numbers n
     LEFT JOIN agents a ON a.id = n.agent_id
     WHERE n.tenant_id=? ORDER BY n.created_at ASC`,
    tenant.id,
  );

  return (
    <NumbersManager
      numbers={numbers}
      telephony={twilio.status()}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      webhookUrl={`${process.env.TWILIO_WEBHOOK_BASE_URL ?? 'https://your-domain.example'}/api/telephony/twilio/voice`}
      locale={user.locale}
    />
  );
}
