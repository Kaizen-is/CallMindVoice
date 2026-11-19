import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import { translator } from '@/lib/i18n';
import { AgentStudio } from './studio';

export const metadata: Metadata = { title: 'Agent studio' };
export const dynamic = 'force-dynamic';

type StudioProps = ComponentProps<typeof AgentStudio>;

/** The studio's data, from the Python backend (`GET /views/agent`); `agent` is null when the tenant has none. */
type AgentPageData =
  | { agent: null }
  | (Omit<StudioProps, 'locale' | 'agent'> & { agent: StudioProps['agent'] });

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user } = await requireSession();
  const t = translator(user.locale);
  const params = await searchParams;

  // The studio edits the agent named in ?agent=<id> (verified against the tenant),
  // defaulting to the live agent — which stays the telephony/simulator default.
  const data = await coreGet<AgentPageData>(
    params.agent ? `/views/agent?agent=${encodeURIComponent(params.agent)}` : '/views/agent',
  );

  if (!data.agent) {
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

  const studio = data as Exclude<AgentPageData, { agent: null }>;
  return (
    <AgentStudio
      key={studio.agent.id}
      locale={user.locale}
      canEdit={studio.canEdit}
      knowledgeChunks={studio.knowledgeChunks}
      agents={studio.agents}
      customVoices={studio.customVoices}
      llmOptions={studio.llmOptions}
      // What "Account default" means here, e.g. "OpenAI gpt-5.5".
      llmDefaultLabel={studio.llmDefaultLabel}
      // Speko models (ElevenLabs, Gemini) and the BRB model an agent can speak with; '' = own TTS.
      ttsModels={studio.ttsModels}
      elevenVoices={studio.elevenVoices}
      geminiVoices={studio.geminiVoices}
      agent={studio.agent}
    />
  );
}
