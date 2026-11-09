import type { Metadata } from 'next';
import { can, requireSession } from '@/lib/auth';
import { modelStats } from '@/lib/lab';
import { tenantDefaultLlm } from '@/lib/llm/choice';
import { engineLabel } from '@/lib/llm/provider';
import { ModelLab } from './model-lab';

export const metadata: Metadata = { title: 'Model lab' };
export const dynamic = 'force-dynamic';

export default async function ModelLabPage() {
  const { tenant, user } = await requireSession();
  const chosen = tenantDefaultLlm(tenant.id);

  return (
    <ModelLab
      locale={user.locale}
      stats={modelStats()}
      canEdit={can(user.role, 'admin')}
      llmDefault={chosen}
      llmInUse={engineLabel(chosen)}
      llmServerDefaultLabel={engineLabel(null)}
    />
  );
}
