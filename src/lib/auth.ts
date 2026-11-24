/**
 * Who is signed in, for the site's pages. The Python backend owns authentication
 * (backend/app/auth.py, backend/app/routers/account.py): it checks the signed
 * `ovoz_session` cookie, the session row and the user on `GET /session`, and the
 * sign-in / sign-up / sign-out actions (src/app/actions/auth.ts) run there too.
 */
import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { coreGet } from './core';
import type { SafeUser, Tenant } from './types';

const COOKIE = 'ovoz_session';

export interface Session {
  user: SafeUser;
  tenant: Tenant;
}

/**
 * Resolve the caller, or null when unauthenticated. Never throws: a visitor
 * without the cookie costs no backend call, and an unreachable backend reads as
 * signed out. Asked once per request (layout and page share the answer).
 */
export const currentSession = cache(async (): Promise<Session | null> => {
  try {
    if (!(await cookies()).get(COOKIE)?.value) return null;
    return await coreGet<Session | null>('/session');
  } catch {
    return null;
  }
});

/** Resolve the caller or throw — for server components. */
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
