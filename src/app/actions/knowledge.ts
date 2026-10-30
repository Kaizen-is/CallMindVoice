'use server';

import { revalidatePath } from 'next/cache';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { all, get } from '@/lib/db';
import { deleteDocument, indexDocument, ingestFaq, ingestFile, ingestText, ingestUrl } from '@/lib/rag/ingest';
import { retrieve } from '@/lib/rag/retrieve';
import { starterPackFor } from '@/lib/starter-packs';
import { publish } from '@/lib/engine/bus';
import type { Document } from '@/lib/types';

export interface IngestResult {
  ok: boolean;
  message: string;
  documents?: Array<{ id: string; title: string; chunks: number }>;
}

const MAX_BYTES = 25 * 1024 * 1024;

export async function uploadDocumentsAction(formData: FormData): Promise<IngestResult> {
  const session = await requireSession();
  requireRole(session, 'admin');

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (!files.length) return { ok: false, message: 'No files were received.' };

  const done: Array<{ id: string; title: string; chunks: number }> = [];
  const failures: string[] = [];

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      failures.push(`${file.name} is larger than 25 MB`);
      continue;
    }
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await ingestFile({
        tenantId: session.tenant.id,
        userId: session.user.id,
        filename: file.name,
        mime: file.type,
        buffer,
      });
      done.push({ id: result.docId, title: result.title, chunks: result.chunkCount });
      publish(session.tenant.id, {
        type: 'document_indexed',
        documentId: result.docId,
        title: result.title,
        chunks: result.chunkCount,
      });
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`);
    }
  }

  if (done.length) {
    audit(session.tenant.id, session.user, 'kb.uploaded', null, {
      count: done.length,
      titles: done.map((d) => d.title),
    });
  }
  revalidatePath('/app/knowledge');
  revalidatePath('/app');

  if (!done.length) {
    return { ok: false, message: failures.join('; ') || 'Nothing could be indexed.' };
  }
  return {
    ok: true,
    documents: done,
    message: failures.length
      ? `Indexed ${done.length} of ${files.length}. ${failures.join('; ')}`
      : `Indexed ${done.length} document${done.length === 1 ? '' : 's'} into ${done.reduce((a, d) => a + d.chunks, 0)} passages.`,
  };
}

export async function addUrlAction(url: string): Promise<IngestResult> {
  const session = await requireSession();
  requireRole(session, 'admin');
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return { ok: false, message: 'That does not look like a valid address.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, message: 'Only http and https pages can be imported.' };
  }
  try {
    const result = await ingestUrl({
      tenantId: session.tenant.id,
      url: parsed.toString(),
      userId: session.user.id,
    });
    audit(session.tenant.id, session.user, 'kb.url_imported', result.docId, { url: parsed.toString() });
    revalidatePath('/app/knowledge');
    return {
      ok: true,
      documents: [{ id: result.docId, title: result.title, chunks: result.chunkCount }],
      message: `Imported “${result.title}” into ${result.chunkCount} passages.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not fetch that page.' };
  }
}

export async function addTextAction(title: string, text: string): Promise<IngestResult> {
  const session = await requireSession();
  requireRole(session, 'admin');
  if (text.trim().length < 40) {
    return { ok: false, message: 'Add a bit more text — at least a couple of sentences.' };
  }
  try {
    const result = await ingestText({
      tenantId: session.tenant.id,
      title: title.trim() || 'Pasted note',
      text,
      userId: session.user.id,
    });
    audit(session.tenant.id, session.user, 'kb.text_added', result.docId, { title });
    revalidatePath('/app/knowledge');
    return {
      ok: true,
      documents: [{ id: result.docId, title: result.title, chunks: result.chunkCount }],
      message: `Added ${result.chunkCount} passages.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not index that text.' };
  }
}

export async function addFaqAction(
  title: string,
  pairs: Array<{ q: string; a: string }>,
): Promise<IngestResult> {
  const session = await requireSession();
  requireRole(session, 'admin');
  const clean = pairs.filter((p) => p.q.trim() && p.a.trim());
  if (!clean.length) return { ok: false, message: 'Add at least one question and answer.' };
  try {
    const result = await ingestFaq({
      tenantId: session.tenant.id,
      title: title.trim() || 'FAQ',
      pairs: clean,
      userId: session.user.id,
    });
    audit(session.tenant.id, session.user, 'kb.faq_added', result.docId, { count: clean.length });
    revalidatePath('/app/knowledge');
    return {
      ok: true,
      documents: [{ id: result.docId, title: result.title, chunks: result.chunkCount }],
      message: `Added ${clean.length} question${clean.length === 1 ? '' : 's'}.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not index the FAQ.' };
  }
}

export async function addStarterPackAction(): Promise<IngestResult> {
  const session = await requireSession();
  requireRole(session, 'admin');
  const pack = starterPackFor(session.tenant.industry);
  try {
    const result = await ingestText({
      tenantId: session.tenant.id,
      title: pack.title,
      text: pack.body,
      userId: session.user.id,
    });
    audit(session.tenant.id, session.user, 'kb.starter_pack', result.docId, { industry: pack.industry });
    revalidatePath('/app/knowledge');
    revalidatePath('/app');
    return {
      ok: true,
      documents: [{ id: result.docId, title: result.title, chunks: result.chunkCount }],
      message: `Loaded a ${pack.industry} starter pack — ${result.chunkCount} passages your agent can answer from right now.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not load the starter pack.' };
  }
}

export async function deleteDocumentAction(documentId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  const doc = get<Document>(
    'SELECT * FROM documents WHERE id=? AND tenant_id=?',
    documentId,
    session.tenant.id,
  );
  if (!doc) return { ok: false, message: 'Document not found.' };
  deleteDocument(session.tenant.id, documentId);
  audit(session.tenant.id, session.user, 'kb.deleted', documentId, { title: doc.title });
  revalidatePath('/app/knowledge');
  return { ok: true, message: `Removed “${doc.title}”.` };
}

export async function reindexDocumentAction(documentId: string) {
  const session = await requireSession();
  requireRole(session, 'admin');
  const doc = get<Document>(
    'SELECT * FROM documents WHERE id=? AND tenant_id=?',
    documentId,
    session.tenant.id,
  );
  if (!doc?.content) return { ok: false, message: 'Nothing stored to reindex — upload the file again.' };
  try {
    const result = await indexDocument(session.tenant.id, documentId, doc.content);
    revalidatePath('/app/knowledge');
    return { ok: true, message: `Rebuilt ${result.chunkCount} passages.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Reindexing failed.' };
  }
}

/** Powers the retrieval inspector in the knowledge base. */
export async function testRetrievalAction(query: string) {
  const session = await requireSession();
  const result = await retrieve(session.tenant.id, query, { topK: 6, minScore: 0 });
  return {
    confidence: result.confidence,
    tookMs: Math.round(result.tookMs),
    strategy: result.strategy,
    totalChunks: result.totalChunks,
    hits: result.hits.map((h) => ({
      documentId: h.documentId,
      documentTitle: h.documentTitle,
      heading: h.heading,
      snippet: h.snippet,
      text: h.text.slice(0, 900),
      score: Number(h.score.toFixed(3)),
      lexical: Number(h.lexicalScore.toFixed(3)),
      dense: Number(h.denseScore.toFixed(3)),
    })),
  };
}

export async function listDocumentsAction() {
  const session = await requireSession();
  return all<Document>(
    `SELECT id, title, source_type, source_ref, byte_size, language, status, progress, error,
            chunk_count, token_count, char_count, created_at, updated_at
     FROM documents WHERE tenant_id=? ORDER BY created_at DESC`,
    session.tenant.id,
  );
}
