import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { VOICES } from '@/lib/catalog';
import { ENGINES } from '@/lib/speech/registry';
import { ELEVEN_VOICES } from '@/lib/speech/speko';
import { ttsEngines } from '@/lib/speech/tts';
import { listCustomVoices } from '@/lib/voices';
import { VoicesGallery, type GalleryVoice } from './voices';

export const metadata: Metadata = { title: 'Voices' };
export const dynamic = 'force-dynamic';

export default async function VoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { tenant, user } = await requireSession();
  const params = await searchParams;
  const ready = ttsEngines() as Record<string, boolean>;
  const models = ENGINES.filter((e) => e.kind === 'tts').map((e) => ({
    id: e.id,
    name: e.name,
    ready: Boolean(ready[e.id]),
    setup: e.setup,
  }));

  // Own TTS speaks the built-in and the account's cloned/designed voices; the
  // ElevenLabs voices (through Speko) speak on every ElevenLabs model.
  const own: Array<Omit<GalleryVoice, 'model'>> = [
    ...VOICES.map((v) => ({ id: v.id, name: v.name, note: `${v.gender === 'female' ? '♀' : '♂'} ${v.note}` })),
    ...listCustomVoices(tenant.id).map((v) => ({ id: v.id, name: v.name, note: v.mode })),
  ];
  const eleven = ELEVEN_VOICES.map((v) => ({ id: v.id, name: v.name, note: `${v.gender === 'female' ? '♀' : '♂'} ${v.note}` }));
  // The BRB model (our own, through the VPN) has one voice.
  const brb = [{ id: 'brb', name: 'BRB TTS', note: 'own model' }];
  const voices: GalleryVoice[] = models.flatMap((m) =>
    (m.id === 'default' ? own : m.id === 'brb' ? brb : eleven).map((v) => ({ ...v, model: m.id })),
  );

  return (
    <VoicesGallery
      locale={user.locale}
      models={models}
      voices={voices}
      initialModel={models.some((m) => m.id === params.model) ? (params.model as string) : 'all'}
    />
  );
}
