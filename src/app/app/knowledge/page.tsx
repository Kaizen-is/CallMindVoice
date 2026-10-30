import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { all } from '@/lib/db';
import { knowledgeStats } from '@/lib/analytics';
import { starterPackFor } from '@/lib/starter-packs';
import type { Document } from '@/lib/types';
import { KnowledgeManager } from './manager';

export const metadata: Metadata = { title: 'Knowledge base' };
export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const { tenant, user } = await requireSession();
  const documents = all<Document>(
    `SELECT id, title, source_type, source_ref, byte_size, language, status, progress, error,
            chunk_count, token_count, char_count, created_at, updated_at
     FROM documents WHERE tenant_id=? ORDER BY created_at DESC`,
    tenant.id,
  );
  const stats = knowledgeStats(tenant.id);
  const pack = starterPackFor(tenant.industry);

  return (
    <KnowledgeManager
      documents={documents}
      stats={stats}
      locale={user.locale}
      packTitle={pack.title}
      packDescription={pack.description}
      canEdit={user.role === 'owner' || user.role === 'admin'}
    />
  );
}
