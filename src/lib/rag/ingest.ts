/**
 * Ingestion pipeline: bytes → text → chunks → vectors → index.
 *
 * Each stage writes its progress back onto the document row, so the UI can show
 * a truthful indexing state instead of a fake spinner.
 */
import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_DIR, all, get, id, now, run, tx } from '@/lib/db';
import type { Document } from '@/lib/types';
import { chunkDocument, chunkFaq, type RawChunk } from './chunk';
import { embeddingEngine, packVector } from './embed';
import { invalidateCorpus } from './retrieve';
import { detectLanguage, estimateTokens, stem, stems } from './text';

export type SourceType = Document['source_type'];

/* ── extraction ──────────────────────────────────────────────── */

export async function extractText(
  buffer: Buffer,
  filename: string,
  mime?: string,
): Promise<{ text: string; type: SourceType }> {
  const ext = path.extname(filename).toLowerCase().replace('.', '');

  if (ext === 'pdf' || mime === 'application/pdf') {
    const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfExtract(pdf, { mergePages: true });
    return { text: cleanupPdf(String(text)), type: 'pdf' };
  }

  if (ext === 'docx' || mime?.includes('wordprocessingml')) {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value, type: 'docx' };
  }

  if (ext === 'csv' || ext === 'tsv') {
    return { text: csvToText(buffer.toString('utf8'), ext === 'tsv' ? '\t' : ','), type: 'csv' };
  }

  if (ext === 'md' || ext === 'markdown') {
    return { text: buffer.toString('utf8'), type: 'md' };
  }

  if (ext === 'html' || ext === 'htm') {
    return { text: htmlToText(buffer.toString('utf8')), type: 'txt' };
  }

  if (ext === 'json') {
    try {
      return { text: jsonToText(JSON.parse(buffer.toString('utf8'))), type: 'txt' };
    } catch {
      /* fall through to plain text */
    }
  }

  return { text: buffer.toString('utf8'), type: 'txt' };
}

/** PDF text extraction leaves hard line-wraps and hyphenation; repair them. */
function cleanupPdf(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/-\n(?=\p{Ll})/gu, '')
    .replace(/([^\n.!?:;])\n(?=\p{Ll})/gu, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function csvToText(csv: string, delim: string): string {
  const rows = csv
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => splitCsvLine(line, delim));
  if (!rows.length) return '';
  const header = rows[0];
  const out: string[] = [];
  for (const row of rows.slice(1)) {
    const pairs = header
      .map((h, i) => (row[i] ? `${h.trim()}: ${row[i].trim()}` : null))
      .filter(Boolean);
    if (pairs.length) out.push(pairs.join(' · '));
  }
  return out.join('\n');
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delim && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<\/(h[1-6]|p|div|li|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<h([1-6])[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function jsonToText(value: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map((v) => jsonToText(v, depth + 1)).join('\n');
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${jsonToText(v, depth + 1)}`)
    .join('\n');
}

/* ── document creation ───────────────────────────────────────── */

export interface CreateDocInput {
  tenantId: string;
  title: string;
  sourceType: SourceType;
  sourceRef?: string | null;
  byteSize?: number;
  uploadedBy?: string | null;
}

export function createDocument(input: CreateDocInput): string {
  const docId = id('doc');
  run(
    `INSERT INTO documents (id, tenant_id, title, source_type, source_ref, byte_size,
       language, status, progress, uploaded_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'auto','queued',0,?,?,?)`,
    docId,
    input.tenantId,
    input.title.slice(0, 200),
    input.sourceType,
    input.sourceRef ?? null,
    input.byteSize ?? 0,
    input.uploadedBy ?? null,
    now(),
    now(),
  );
  return docId;
}

function setStatus(docId: string, status: Document['status'], progress: number, error?: string) {
  run(
    `UPDATE documents SET status=?, progress=?, error=?, updated_at=? WHERE id=?`,
    status,
    progress,
    error ?? null,
    now(),
    docId,
  );
}

/* ── the pipeline ────────────────────────────────────────────── */

/** Strip control characters that survive PDF and DOCX extraction. */
function sanitize(text: string): string {
  // Built from escapes rather than a literal class so no raw control byte
  // can ever end up in this source file.
  const CONTROL = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFEFF]', 'g');
  return text.replace(CONTROL, '').trim();
}

export async function indexDocument(
  tenantId: string,
  docId: string,
  text: string,
  opts: { chunks?: RawChunk[] } = {},
): Promise<{ chunkCount: number; tokenCount: number }> {
  const doc = get<Document>('SELECT * FROM documents WHERE id=? AND tenant_id=?', docId, tenantId);
  if (!doc) throw new Error('Document not found');

  try {
    setStatus(docId, 'parsing', 0.15);
    const clean = sanitize(text);
    if (clean.length < 20) throw new Error('No readable text could be extracted from this file.');

    setStatus(docId, 'chunking', 0.35);
    const raw = opts.chunks ?? chunkDocument(clean, doc.title);
    if (!raw.length) throw new Error('Document produced no indexable content.');

    setStatus(docId, 'embedding', 0.55);
    const engine = embeddingEngine();
    const vectors: Float32Array[] = [];
    const BATCH = 64;
    for (let i = 0; i < raw.length; i += BATCH) {
      const batch = raw.slice(i, i + BATCH).map((c) => c.text);
      vectors.push(...(await engine.embed(batch)));
      setStatus(docId, 'embedding', 0.55 + 0.35 * ((i + batch.length) / raw.length));
    }

    const language = detectLanguage(clean.slice(0, 4000));
    const totalTokens = raw.reduce((a, c) => a + c.tokenCount, 0);
    const stamp = now();

    tx(() => {
      run('DELETE FROM chunks WHERE document_id=?', docId);
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        const counts: Record<string, number> = {};
        for (const t of stems(c.text)) counts[t] = (counts[t] ?? 0) + 1;
        // Heading terms are boosted — they carry the topic of the chunk.
        if (c.heading) for (const t of stems(c.heading)) counts[t] = (counts[t] ?? 0) + 2;
        run(
          `INSERT INTO chunks (id, tenant_id, document_id, ordinal, heading, text, token_count, embedding, terms_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          id('chk'),
          tenantId,
          docId,
          i,
          c.heading,
          c.text,
          c.tokenCount,
          packVector(vectors[i]),
          JSON.stringify(counts),
          stamp,
        );
      }
      run(
        `UPDATE documents SET status='ready', progress=1, error=NULL, chunk_count=?, token_count=?,
           char_count=?, language=?, content=?, updated_at=? WHERE id=?`,
        raw.length,
        totalTokens,
        clean.length,
        language,
        clean.slice(0, 400_000),
        stamp,
        docId,
      );
    });

    invalidateCorpus(tenantId);
    return { chunkCount: raw.length, tokenCount: totalTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Indexing failed';
    setStatus(docId, 'failed', 0, message);
    invalidateCorpus(tenantId);
    throw err;
  }
}

export async function ingestFile(params: {
  tenantId: string;
  userId?: string | null;
  filename: string;
  mime?: string;
  buffer: Buffer;
}) {
  const { tenantId, filename, buffer, mime } = params;
  const { text, type } = await extractText(buffer, filename, mime);

  const title = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || filename;
  const docId = createDocument({
    tenantId,
    title,
    sourceType: type,
    sourceRef: filename,
    byteSize: buffer.byteLength,
    uploadedBy: params.userId ?? null,
  });

  await fs.mkdir(path.join(UPLOAD_DIR, tenantId), { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, tenantId, `${docId}${path.extname(filename)}`), buffer);

  const result = await indexDocument(tenantId, docId, text);
  return { docId, title, ...result };
}

export async function ingestUrl(params: { tenantId: string; url: string; userId?: string | null }) {
  const { tenantId, url } = params;
  const res = await fetch(url, {
    headers: { 'user-agent': 'OvozAI-KnowledgeCrawler/1.0 (+https://ovoz.ai/bot)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Could not fetch page (HTTP ${res.status})`);
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]{1,150})<\/title>/i);
  const title = (titleMatch?.[1] ?? new URL(url).hostname).trim();
  const text = htmlToText(html);

  const docId = createDocument({
    tenantId,
    title,
    sourceType: 'url',
    sourceRef: url,
    byteSize: html.length,
    uploadedBy: params.userId ?? null,
  });
  const result = await indexDocument(tenantId, docId, text);
  return { docId, title, ...result };
}

export async function ingestText(params: {
  tenantId: string;
  title: string;
  text: string;
  sourceType?: SourceType;
  userId?: string | null;
}) {
  const docId = createDocument({
    tenantId: params.tenantId,
    title: params.title,
    sourceType: params.sourceType ?? 'txt',
    sourceRef: 'pasted',
    byteSize: Buffer.byteLength(params.text),
    uploadedBy: params.userId ?? null,
  });
  const result = await indexDocument(params.tenantId, docId, params.text);
  return { docId, title: params.title, ...result };
}

export async function ingestFaq(params: {
  tenantId: string;
  title: string;
  pairs: Array<{ q: string; a: string }>;
  userId?: string | null;
}) {
  const body = params.pairs.map((p) => `${p.q}\n${p.a}`).join('\n\n');
  const docId = createDocument({
    tenantId: params.tenantId,
    title: params.title,
    sourceType: 'faq',
    sourceRef: `${params.pairs.length} pairs`,
    byteSize: Buffer.byteLength(body),
    uploadedBy: params.userId ?? null,
  });
  const result = await indexDocument(params.tenantId, docId, body, { chunks: chunkFaq(params.pairs) });
  return { docId, title: params.title, ...result };
}

export function deleteDocument(tenantId: string, docId: string) {
  run('DELETE FROM documents WHERE id=? AND tenant_id=?', docId, tenantId);
  invalidateCorpus(tenantId);
}

export function listDocuments(tenantId: string) {
  return all<Document>(
    'SELECT * FROM documents WHERE tenant_id=? ORDER BY created_at DESC',
    tenantId,
  );
}

export { estimateTokens, stem };
