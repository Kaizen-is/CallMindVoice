import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { listCustomVoices } from '@/lib/voices';
import { DesignLab } from './design-lab';

export const metadata: Metadata = { title: 'Voice Design' };
export const dynamic = 'force-dynamic';

export default async function VoiceDesignPage() {
  const { tenant, user } = await requireSession();
  const voices = listCustomVoices(tenant.id, 'design').map((v) => ({
    id: v.id,
    name: v.name,
    mode: v.mode,
    detail: v.voice_design,
    created_at: v.created_at,
  }));

  return (
    <DesignLab
      locale={user.locale}
      voices={voices}
      speech={{ tts: Boolean(process.env.TTS_CLIENT_SECRET || process.env.TTS_JWT_TOKEN) }}
    />
  );
}
