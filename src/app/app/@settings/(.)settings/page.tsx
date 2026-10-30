import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import { knowledgeStats } from '@/lib/analytics';
import { engineIsHosted, engineLabel } from '@/lib/llm/provider';
import { embeddingEngine } from '@/lib/rag/embed';
import { telephonyStatus } from '@/lib/telephony/status';
import { SettingsPanel } from '@/app/app/settings/panel';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/settings.
export default async function SettingsModal() {
  const { tenant, user } = await requireSession();
  const embedding = embeddingEngine();
  const t = translator(user.locale);
  const telephony = telephonyStatus();

  return (
    <>
      <SettingsModalSignal />
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
        generation: engineIsHosted() ? engineLabel() : t('settings.engine.localGeneration', 'Local extractive synthesiser'),
        generationHosted: engineIsHosted(),
        embedding: embedding.id,
        embeddingHosted: embedding.hosted,
        telephony: telephony.mode === 'asterisk'
          ? t('settings.engine.asteriskBridge', 'Asterisk / FreePBX bridge')
          : telephony.mode === 'twilio'
            ? 'Twilio Elastic SIP'
            : t('settings.engine.builtinSimulator', 'Built-in simulator'),
        telephonyHosted: telephony.configured,
        telephonyHint: telephony.mode === 'asterisk'
          ? 'BRIDGE_SHARED_SECRET'
          : telephony.mode === 'twilio'
            ? 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN'
            : 'BRIDGE_SHARED_SECRET / TWILIO credentials',
      }}
      stats={knowledgeStats(tenant.id)}
      />
    </>
  );
}
