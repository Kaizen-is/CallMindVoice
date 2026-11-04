import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { ensureBankAgent } from '@/lib/bank-agent';
import { liveAgent, listAgents } from '@/lib/engine/calls';
import { engineIsHosted, engineLabel } from '@/lib/llm/provider';
import { translator } from '@/lib/i18n';
import type { Locale } from '@/lib/types';
import { safeJson } from '@/lib/utils';
import { listCustomVoices } from '@/lib/voices';
import { VOICES } from '@/lib/catalog';
import { sttEngines } from '@/lib/speech/stt';
import { ttsEngines } from '@/lib/speech/tts';
import { ELEVEN_VOICES } from '@/lib/speech/speko';
import { Playground } from './playground';

export const metadata: Metadata = { title: 'Playground' };
export const dynamic = 'force-dynamic';

/** ws://… for the sidecar's /stream, from STT_STREAM_PUBLIC_URL or STT_STREAM_URL. */
function streamSocketUrl(): string | null {
  const base = process.env.STT_STREAM_PUBLIC_URL || process.env.STT_STREAM_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '').replace(/^http/, 'ws')}/stream`;
}

export default async function PlaygroundPage() {
  const { tenant, user } = await requireSession();
  // Every account gets the /demo banking agent to try, once (see bank-agent.ts).
  ensureBankAgent(tenant.id);
  const agent = liveAgent(tenant.id);
  const agents = listAgents(tenant.id);
  const t = translator(user.locale);

  return (
    <Playground
      locale={user.locale}
      industry={tenant.industry}
      engine={engineIsHosted() ? engineLabel() : t('play.localSynth', 'Local synthesiser')}
      speech={{
        stt: sttEngines(),
        tts: ttsEngines(),
        // The browser streams mic audio straight to the local STT sidecar.
        streamUrl: streamSocketUrl(),
      }}
      agents={agents}
      elevenVoices={ELEVEN_VOICES.map((v) => ({ id: v.id, name: v.name }))}
      allVoices={[
        ...VOICES.map((v) => ({ id: v.id, name: v.name, group: 'builtin' as const })),
        ...listCustomVoices(tenant.id).map((v) => ({
          id: v.id,
          name: v.name,
          group: v.mode,
        })),
      ]}
      agent={
        agent
          ? {
              id: agent.id,
              name: agent.name,
              greeting: agent.greeting,
              voiceId: agent.voice_id,
              speakingRate: agent.speaking_rate,
              primaryLang: agent.primary_lang,
              languages: safeJson<Locale[]>(agent.languages_json, ['uz', 'ru', 'en']),
              threshold: agent.confidence_threshold,
              status: agent.status,
            }
          : null
      }
    />
  );
}
