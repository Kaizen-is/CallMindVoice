import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { listSpeechTests } from '@/lib/engine/calls';
import { VOICES } from '@/lib/catalog';
import { TtsLab } from './tts-lab';

export const metadata: Metadata = { title: 'Text to Speech' };
export const dynamic = 'force-dynamic';

export default async function DevTtsPage() {
  const { tenant, user } = await requireSession();

  // The voice selector needs each agent's voice, so load id/name/voice_id
  // directly (listAgents intentionally exposes only id/name/status).
  const agents = all<{ id: string; name: string; voice_id: string }>(
    'SELECT id, name, voice_id FROM agents WHERE tenant_id=? ORDER BY created_at ASC',
    tenant.id,
  );
  const history = listSpeechTests(tenant.id, 'tts');

  return (
    <TtsLab
      locale={user.locale}
      agents={agents.map((a) => ({ id: a.id, name: a.name, voiceId: a.voice_id }))}
      voices={VOICES.map((v) => ({ id: v.id, name: v.name }))}
      history={history}
      speech={{ tts: Boolean(process.env.TTS_CLIENT_SECRET || process.env.TTS_JWT_TOKEN) }}
    />
  );
}
