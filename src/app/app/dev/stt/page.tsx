import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { listSpeechTests } from '@/lib/engine/calls';
import { SttLab } from './stt-lab';

export const metadata: Metadata = { title: 'Speech to Text' };
export const dynamic = 'force-dynamic';

export default async function DevSttPage() {
  const { tenant, user } = await requireSession();
  const history = listSpeechTests(tenant.id, 'stt');

  return (
    <SttLab
      locale={user.locale}
      history={history}
      speech={{ stt: Boolean(process.env.STT_TRANSCRIBE_URL) }}
    />
  );
}
