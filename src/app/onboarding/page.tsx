import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { liveAgent } from '@/lib/engine/calls';
import { starterPackFor } from '@/lib/starter-packs';
import { translator } from '@/lib/i18n';
import type { Document, PhoneNumber } from '@/lib/types';
import { OnboardingWizard } from './wizard';

export async function generateMetadata(): Promise<Metadata> {
  const session = await currentSession();
  const t = translator(session?.user.locale ?? 'uz');
  return { title: t('onboarding.metaTitle', 'Set up your agent') };
}
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const session = await currentSession();
  if (!session) redirect('/login');
  if (session.tenant.onboarded) redirect('/app');

  const agent = liveAgent(session.tenant.id);
  const documents = all<Document>(
    `SELECT id, title, source_type, chunk_count, status FROM documents WHERE tenant_id=? ORDER BY created_at DESC`,
    session.tenant.id,
  );
  const numbers = all<PhoneNumber>('SELECT * FROM phone_numbers WHERE tenant_id=?', session.tenant.id);
  const pack = starterPackFor(session.tenant.industry);

  return (
    <OnboardingWizard
      locale={session.user.locale}
      company={session.tenant.name}
      userName={session.user.name}
      industry={session.tenant.industry}
      packTitle={pack.title}
      packDescription={pack.description}
      agent={
        agent
          ? {
              id: agent.id,
              name: agent.name,
              greeting: agent.greeting,
              persona: agent.persona,
              voiceId: agent.voice_id,
              primaryLang: agent.primary_lang,
              languages: JSON.parse(agent.languages_json || '["uz","ru","en"]'),
            }
          : null
      }
      documents={documents.map((d) => ({
        id: d.id,
        title: d.title,
        chunks: d.chunk_count,
        status: d.status,
      }))}
      phoneNumber={numbers[0]?.e164 ?? null}
    />
  );
}
