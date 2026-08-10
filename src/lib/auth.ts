/**
 * Authentication: scrypt password hashing + HMAC-signed session cookies.
 *
 * No third-party auth dependency — the whole surface is ~150 lines of
 * node:crypto, which keeps the trust boundary small and auditable.
 */
import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cookies, headers } from 'next/headers';
import { all, get, id, now, run } from './db';
import type { Role, SafeUser, Tenant } from './types';

const COOKIE = 'ovoz_session';
const SESSION_DAYS = 30;

/* ── secret ──────────────────────────────────────────────────── */

let cachedSecret: string | null = null;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  if (process.env.OVOZ_SESSION_SECRET) {
    cachedSecret = process.env.OVOZ_SESSION_SECRET;
    return cachedSecret;
  }
  const file = path.join(process.cwd(), 'data', '.secret');
  try {
    cachedSecret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret!;
}

/* ── passwords ───────────────────────────────────────────────── */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, salt, digest] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 64, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    const expected = Buffer.from(digest, 'base64');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ── tokens ──────────────────────────────────────────────────── */

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function encode(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`;
}

function decode(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const sessionId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(sessionId);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return sessionId;
}

/* ── session lifecycle ───────────────────────────────────────── */

export async function createSession(userId: string, tenantId: string) {
  const h = await headers();
  const sid = id('ses');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run(
    `INSERT INTO sessions (id, user_id, tenant_id, user_agent, ip, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?)`,
    sid,
    userId,
    tenantId,
    h.get('user-agent') ?? null,
    h.get('x-forwarded-for') ?? '127.0.0.1',
    now(),
    expires.toISOString(),
  );
  // Mark the cookie Secure only when the edge connection is actually HTTPS.
  // Tying this to NODE_ENV instead breaks login over plain HTTP in production:
  // browsers refuse to store a Secure cookie sent over http://, so the session
  // silently never sticks. `x-forwarded-proto` reflects the real scheme behind a
  // reverse proxy (set `proxy_set_header X-Forwarded-Proto $scheme;`); absent it
  // (direct HTTP) the cookie is non-Secure and works.
  const proto = (h.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  const jar = await cookies();
  jar.set(COOKIE, encode(sid), {
    httpOnly: true,
    sameSite: 'lax',
    secure: proto === 'https',
    path: '/',
    expires,
  });
  run(`UPDATE users SET presence='online', last_seen_at=? WHERE id=?`, now(), userId);
  return sid;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const sid = decode(token);
    if (sid) {
      const s = get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id=?', sid);
      if (s) run(`UPDATE users SET presence='offline' WHERE id=?`, s.user_id);
      run('DELETE FROM sessions WHERE id=?', sid);
    }
  }
  jar.delete(COOKIE);
}

export interface Session {
  user: SafeUser;
  tenant: Tenant;
}

/** Resolve the caller, or null when unauthenticated. Never throws. */
export async function currentSession(): Promise<Session | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(COOKIE)?.value;
  } catch {
    return null;
  }
  if (!token) return null;
  const sid = decode(token);
  if (!sid) return null;

  const row = get<{ user_id: string; expires_at: string }>(
    'SELECT user_id, expires_at FROM sessions WHERE id=?',
    sid,
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run('DELETE FROM sessions WHERE id=?', sid);
    return null;
  }

  const user = get<SafeUser>(
    `SELECT id, tenant_id, email, name, role, avatar_hue, locale, status, presence,
            last_seen_at, created_at, updated_at
     FROM users WHERE id=? AND status != 'disabled'`,
    row.user_id,
  );
  if (!user) return null;

  const tenant = get<Tenant>('SELECT * FROM tenants WHERE id=?', user.tenant_id);
  if (!tenant) return null;

  return { user, tenant };
}

/** Resolve the caller or throw — for route handlers and server components. */
export async function requireSession(): Promise<Session> {
  const s = await currentSession();
  if (!s) throw new UnauthorizedError();
  return s;
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor() {
    super('Authentication required');
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = 'Insufficient permissions') {
    super(msg);
  }
}

const RANK: Record<Role, number> = { analyst: 1, operator: 2, admin: 3, owner: 4 };

export function requireRole(session: Session, min: Role) {
  if (RANK[session.user.role] < RANK[min]) throw new ForbiddenError();
}

export function can(role: Role, min: Role) {
  return RANK[role] >= RANK[min];
}

/* ── audit ───────────────────────────────────────────────────── */

export function audit(
  tenantId: string,
  actor: { id?: string; name?: string } | null,
  action: string,
  target?: string | null,
  meta: Record<string, unknown> = {},
) {
  run(
    `INSERT INTO audit_log (id, tenant_id, actor_id, actor_name, action, target, meta_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id('aud'),
    tenantId,
    actor?.id ?? null,
    actor?.name ?? 'system',
    action,
    target ?? null,
    JSON.stringify(meta),
    null,
    now(),
  );
}

export function recentAudit(tenantId: string, limit = 50) {
  return all(
    'SELECT * FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
    tenantId,
    limit,
  );
}

/* ── API keys ────────────────────────────────────────────────── */

export function generateApiKey() {
  const raw = `ovoz_sk_${crypto.randomBytes(24).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, 16), hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

export function verifyApiKey(raw: string) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return get<{ id: string; tenant_id: string; scopes: string }>(
    'SELECT id, tenant_id, scopes FROM api_keys WHERE hash=? AND revoked_at IS NULL',
    hash,
  );
}
