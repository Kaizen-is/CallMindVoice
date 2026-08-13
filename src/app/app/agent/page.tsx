import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { get } from '@/lib/db';
import { liveAgent, listAgents } from '@/lib/engine/calls';
import { agentEscalation, agentHours } from '@/lib/engine/conversation';
import { knowledgeStats } from '@/lib/analytics';
import { translator } from '@/lib/i18n';
import type { Agent, Locale } from '@/lib/types';
import { safeJson } from '@/lib/utils';
import { AgentStudio } from './studio';

export const metadata: Metadata = { title: 'Agent studio' };
export const dynamic = 'force-dynamic';

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);
  const params = await searchParams;
  const agents = listAgents(tenant.id);

  // The studio edits the agent named in ?agent=<id> (verified against the tenant),
  // defaulting to the live agent — which stays the telephony/simulator default.
  const agent =
    (params.agent
      ? get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', params.agent, tenant.id)
      : undefined) ?? liveAgent(tenant.id);

  if (!agent) {
    return (
      <div className="mx-auto max-w-2xl py-20 text-center">
        <h1 className="text-[22px] font-semibold text-ink">{t('agent.noAgent.title', 'No agent yet')}</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          {t(
            'agent.noAgent.body',
            'Something went wrong during setup. Contact support and we will re-provision your agent.',
          )}
        </p>
      </div>
    );
  }

  return (
    <AgentStudio
      key={agent.id}
      locale={user.locale}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      knowledgeChunks={knowledgeStats(tenant.id).chunks}
      agents={agents}
      agent={{
        id: agent.id,
        name: agent.name,
        status: agent.status,
        persona: agent.persona,
        greeting: agent.greeting,
        fallbackLine: agent.fallback_line,
        instructions: agent.instructions,
        languages: safeJson<Locale[]>(agent.languages_json, ['uz', 'ru', 'en']),
        primaryLang: agent.primary_lang,
        voiceId: agent.voice_id,
        speakingRate: agent.speaking_rate,
        maxTurns: agent.max_turns,
        confidenceThreshold: agent.confidence_threshold,
        version: agent.version,
        escalation: agentEscalation(agent),
        hours: agentHours(agent),
      }}
    />
  );
}
