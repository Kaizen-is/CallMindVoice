'use server';

/**
 * Knowledge-base server actions — thin proxies to the Python backend (backend/app/knowledge.py,
 * POST /actions/<name>). Same names, parameters and return shapes as before; the role checks,
 * ingestion, audit rows and bus events happen in Python (a failed role check is a 403, which
 * `corePost` throws). Only the page revalidation stays here, on the same conditions as before.
 */
import { revalidatePath } from 'next/cache';
import { corePost, corePostForm } from '@/lib/core';
import type { Document } from '@/lib/types';

export interface IngestResult {
  ok: boolean;
  message: string;
  documents?: Array<{ id: string; title: string; chunks: number }>;
}

export async function uploadDocumentsAction(formData: FormData): Promise<IngestResult> {
  const r = await corePostForm<IngestResult>('/actions/uploadDocumentsAction', formData);
  if (formData.getAll('files').some((f) => f instanceof File)) {
    revalidatePath('/app/knowledge');
    revalidatePath('/app');
  }
  return r;
}

export async function addUrlAction(url: string): Promise<IngestResult> {
  const r = await corePost<IngestResult>('/actions/addUrlAction', { url });
  if (r.ok) revalidatePath('/app/knowledge');
  return r;
}

export async function addTextAction(title: string, text: string): Promise<IngestResult> {
  const r = await corePost<IngestResult>('/actions/addTextAction', { title, text });
  if (r.ok) revalidatePath('/app/knowledge');
  return r;
}

export async function addFaqAction(
  title: string,
  pairs: Array<{ q: string; a: string }>,
): Promise<IngestResult> {
  const r = await corePost<IngestResult>('/actions/addFaqAction', { title, pairs });
  if (r.ok) revalidatePath('/app/knowledge');
  return r;
}

export async function addStarterPackAction(): Promise<IngestResult> {
  const r = await corePost<IngestResult>('/actions/addStarterPackAction');
  if (r.ok) {
    revalidatePath('/app/knowledge');
    revalidatePath('/app');
  }
  return r;
}

export async function deleteDocumentAction(documentId: string) {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/deleteDocumentAction', { documentId });
  if (r.ok) revalidatePath('/app/knowledge');
  return r;
}

export async function reindexDocumentAction(documentId: string) {
  const r = await corePost<{ ok: boolean; message: string }>('/actions/reindexDocumentAction', { documentId });
  if (r.ok) revalidatePath('/app/knowledge');
  return r;
}

/** Powers the retrieval inspector in the knowledge base. */
export async function testRetrievalAction(query: string) {
  return corePost<{
    confidence: number;
    tookMs: number;
    strategy: string;
    totalChunks: number;
    hits: Array<{
      documentId: string;
      documentTitle: string;
      heading: string | null;
      snippet: string;
      text: string;
      score: number;
      lexical: number;
      dense: number;
    }>;
  }>('/actions/testRetrievalAction', { query });
}

export async function listDocumentsAction() {
  return corePost<Document[]>('/actions/listDocumentsAction');
}
