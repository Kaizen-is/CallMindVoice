import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { listCustomVoices } from '@/lib/voices';
import { CloneLab } from './clone-lab';

export const metadata: Metadata = { title: 'Voice Cloning' };
export const dynamic = 'force-dynamic';

export default async function VoiceClonePage() {
  const { tenant, user } = await requireSession();
  const voices = listCustomVoices(tenant.id, 'clone').map((v) => ({
    id: v.id,
    name: v.name,
    mode: v.mode,
    detail: v.ref_text,
    created_at: v.created_at,
  }));

  return (
    <CloneLab
      locale={user.locale}
      voices={voices}
      speech={{ tts: Boolean(process.env.TTS_CLIENT_SECRET || process.env.TTS_JWT_TOKEN) }}
    />
  );
}
