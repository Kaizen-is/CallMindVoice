/**
 * POST /v1/documents  (scope: write)
 *
 * Push a document into the tenant's knowledge base and index it synchronously,
 * reusing the same ingest+chunk+embed pipeline the dashboard upload path runs
 * (`ingestText`). On success emits the `document.indexed` webhook.
 */
import { requireApiKey } from '@/lib/api-auth';
import { ingestText, type SourceType } from '@/lib/rag/ingest';
import { dispatchWebhook } from '@/lib/webhooks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SOURCE_TYPES: SourceType[] = ['pdf', 'docx', 'txt', 'md', 'csv', 'url', 'faq'];

function invalid(message: string): Response {
  return Response.json({ error: { type: 'invalid_request', message } }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = requireApiKey(req, 'write');
  if (auth instanceof Response) return auth;

  let body: { title?: unknown; text?: unknown; sourceType?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalid('Request body must be valid JSON.');
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.text === 'string' ? body.text : '';
  if (!title) return invalid('`title` is required.');
  if (!text.trim()) return invalid('`text` is required.');

  const sourceType: SourceType =
    typeof body.sourceType === 'string' && SOURCE_TYPES.includes(body.sourceType as SourceType)
      ? (body.sourceType as SourceType)
      : 'txt';

  try {
    const result = await ingestText({
      tenantId: auth.tenantId,
      title,
      text,
      sourceType,
    });

    void dispatchWebhook(auth.tenantId, 'document.indexed', {
      id: result.docId,
      title: result.title,
      chunks: result.chunkCount,
      status: 'ready',
    });

    return Response.json({ id: result.docId, chunks: result.chunkCount, status: 'ready' });
  } catch (err) {
    // Ingest throws on unreadable/empty content — surface as 422, not 500.
    const message = err instanceof Error ? err.message : 'Could not index the document.';
    return Response.json({ error: { type: 'ingest_failed', message } }, { status: 422 });
  }
}
