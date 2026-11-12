import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { ensureBankAgent } from '@/lib/bank-agent';
import { liveAgent, listAgents } from '@/lib/engine/calls';
import { engineIsHosted, engineLabel } from '@/lib/llm/provider';
import { agentEngineLabel, tenantDefaultLlm } from '@/lib/llm/choice';
import { get } from '@/lib/db';
import type { Agent } from '@/lib/types';
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
      engine={
        engineIsHosted(tenantDefaultLlm(tenant.id))
          ? engineLabel(tenantDefaultLlm(tenant.id))
          : t('play.localSynth', 'Local synthesiser')
      }
      agentVoices={Object.fromEntries(
        agents.flatMap((a) => {
          const row = get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', a.id, tenant.id);
          // The BRB model has no voice to pick, so its agents carry the engine alone.
          return row?.tts_engine && (row.tts_voice_id || row.tts_engine === 'brb')
            ? [[a.id, { engine: row.tts_engine, voice: row.tts_voice_id }]]
            : [];
        }),
      )}
      agentEngines={Object.fromEntries(
        agents.map((a) => {
          const row = get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', a.id, tenant.id);
          return [a.id, row ? agentEngineLabel(row) : engineLabel(tenantDefaultLlm(tenant.id))];
        }),
      )}
      speech={{
        stt: sttEngines(),
        tts: ttsEngines(),
        // Live Zipformer words come from the in-app model (/api/speech/live).
        streamUrl: sttEngines().local ? '/api/speech/live' : null,
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
