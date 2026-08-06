import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { knowledgeStats } from '@/lib/analytics';
import { liveAgent } from '@/lib/engine/calls';
import { engineIsHosted, engineName } from '@/lib/llm/provider';
import type { Locale } from '@/lib/types';
import { safeJson } from '@/lib/utils';
import { Playground } from './playground';

export const metadata: Metadata = { title: 'Playground' };
export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  const { tenant, user } = await requireSession();
  const agent = liveAgent(tenant.id);
  const kb = knowledgeStats(tenant.id);

  return (
    <Playground
      locale={user.locale}
      industry={tenant.industry}
      chunks={kb.chunks}
      engine={engineIsHosted() ? engineName().replace('claude:', 'Claude ') : 'Local synthesiser'}
      agent={
        agent
          ? {
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
