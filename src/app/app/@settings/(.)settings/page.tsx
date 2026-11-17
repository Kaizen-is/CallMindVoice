import { requireSession } from '@/lib/auth';
import { translator } from '@/lib/i18n';
import { coreGet } from '@/lib/core';
import type { SettingsData } from '@/lib/workspace-views';
import { SettingsPanel } from '@/app/app/settings/panel';
import { SettingsModalSignal } from '@/components/console/settings-modal';

export const dynamic = 'force-dynamic';

// Intercepted (modal) view of /app/settings.
export default async function SettingsModal() {
  const { tenant, user } = await requireSession();
  const t = translator(user.locale);
  const { llm, embedding, telephony, stats } = await coreGet<SettingsData>('/views/settings');

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
        generation: llm.hosted ? llm.label : t('settings.engine.localGeneration', 'Local extractive synthesiser'),
        generationHosted: llm.serverHosted,
        embedding: embedding.id,
        embeddingHosted: embedding.hosted,
        telephony: telephony.mode === 'asterisk'
          ? t('settings.engine.asteriskBridge', 'Asterisk / FreePBX bridge')
          : t('settings.engine.builtinSimulator', 'Built-in simulator'),
        telephonyHosted: telephony.configured,
        telephonyHint: telephony.mode === 'asterisk'
          ? 'BRIDGE_SHARED_SECRET'
          : 'BRIDGE_SHARED_SECRET',
      }}
      stats={stats}
      />
    </>
  );
}
