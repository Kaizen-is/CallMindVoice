import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { knowledgeStats } from '@/lib/analytics';
import { engineIsHosted, engineLabel } from '@/lib/llm/provider';
import { embeddingEngine } from '@/lib/rag/embed';
import * as twilio from '@/lib/telephony/twilio';
import { SettingsPanel } from './panel';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { tenant, user } = await requireSession();
  const embedding = embeddingEngine();

  return (
    <SettingsPanel
      tenant={{
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        industry: tenant.industry,
        country: tenant.country,
        timezone: tenant.timezone,
        plan: tenant.plan,
        createdAt: tenant.created_at,
      }}
      user={{ name: user.name, email: user.email, role: user.role, locale: user.locale }}
      canEdit={user.role === 'owner' || user.role === 'admin'}
      engines={{
        generation: engineIsHosted() ? engineLabel() : 'Local extractive synthesiser',
        generationHosted: engineIsHosted(),
        embedding: embedding.id,
        embeddingHosted: embedding.hosted,
        telephony: twilio.isConfigured() ? 'Twilio Elastic SIP' : 'Built-in simulator',
        telephonyHosted: twilio.isConfigured(),
      }}
      stats={knowledgeStats(tenant.id)}
    />
  );
}
