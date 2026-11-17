import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth';
import { coreGet } from '@/lib/core';
import type { Document } from '@/lib/types';
import { KnowledgeManager } from './manager';

export const metadata: Metadata = { title: 'Knowledge base' };
export const dynamic = 'force-dynamic';

/** GET /views/knowledge (backend/app/knowledge.py): what this page used to read from the database. */
interface KnowledgeView {
  documents: Document[];
  stats: { documents: number; ready: number; chunks: number; tokens: number; bytes: number };
  pack: { industry: string; title: string; description: string };
}

export default async function KnowledgePage() {
  const { user } = await requireSession();
  const { documents, stats, pack } = await coreGet<KnowledgeView>('/views/knowledge');

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
