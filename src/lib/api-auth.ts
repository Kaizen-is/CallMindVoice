/**
 * Public REST API authentication.
 *
 * The dashboard is protected by session cookies (see `auth.ts`); the `/v1`
 * surface that third parties call is protected by bearer API keys instead. A
 * key carries a comma-separated scope string (`read`, `write`, `admin`); each
 * endpoint declares the scope it needs and `requireApiKey` enforces it.
 *
 * The raw key is never logged, and only its SHA-256 hash is ever compared —
 * `verifyApiKey` does the hashing and the constant-time-safe DB lookup.
 */
import 'server-only';
import { verifyApiKey } from './auth';
import { now, run } from './db';

export type Scope = 'read' | 'write' | 'admin';

export interface ApiAuth {
  tenantId: string;
  keyId: string;
  scopes: string[];
}

function fail(status: 401 | 403, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * Resolve the calling API key and check it carries `scope`.
 *
 * Returns `{ tenantId, keyId, scopes }` on success, or a ready-to-return
 * `Response` (401 when the key is missing/invalid/revoked, 403 when it is valid
 * but under-scoped). Callers do `if (auth instanceof Response) return auth;`.
 */
export function requireApiKey(req: Request, scope: Scope): ApiAuth | Response {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    return fail(401, 'unauthorized', 'Provide an API key as `Authorization: Bearer ovoz_sk_...`.');
  }

  const raw = match[1];
  // Only the shape is checked here; the value itself is never logged.
  if (!raw.startsWith('ovoz_sk_')) {
    return fail(401, 'unauthorized', 'Malformed API key. Keys start with `ovoz_sk_`.');
  }

  const key = verifyApiKey(raw);
  if (!key) {
    return fail(401, 'unauthorized', 'Invalid or revoked API key.');
  }

  const scopes = key.scopes
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!scopes.includes(scope)) {
    return fail(403, 'forbidden', `This API key is missing the \`${scope}\` scope.`);
  }

  // Best-effort last-used stamp so the Developers panel can show real activity.
  // Never let a bookkeeping write break an otherwise-authorised request.
  try {
    run('UPDATE api_keys SET last_used=? WHERE id=?', now(), key.id);
  } catch {
    /* ignore */
  }

  return { tenantId: key.tenant_id, keyId: key.id, scopes };
}
