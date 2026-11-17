/**
 * The Python backend (FastAPI, `backend/`), called from the site's server side:
 * page data loaders and server actions. Every request carries the visitor's
 * login cookie (and their address / user agent, for the audit log), so Python
 * sees exactly the same session. No business logic lives here — the pages ask
 * Python for their data (`GET /views/<page>`) and the server actions forward to
 * Python (`POST /actions/<name>`), keeping the same names and return shapes.
 */
import 'server-only';
import { cookies, headers } from 'next/headers';

const CORE_API = (process.env.CORE_API_URL ?? 'http://127.0.0.1:8100').replace(/\/+$/, '');

/** A non-2xx answer from Python; `message` is its `error` code when it sent one. */
export class CoreError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const code =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
    super(code || `core_${status}`);
    this.status = status;
    this.body = body;
  }
}

async function forwardedHeaders(): Promise<Record<string, string>> {
  const jar = await cookies();
  const incoming = await headers();
  const out: Record<string, string> = {
    accept: 'application/json',
    cookie: jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  };
  for (const name of ['x-forwarded-for', 'x-real-ip', 'user-agent', 'accept-language']) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  return out;
}

async function call<T>(method: 'GET' | 'POST', path: string, init: { json?: unknown; form?: FormData } = {}): Promise<T> {
  const requestHeaders = await forwardedHeaders();
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    requestHeaders['content-type'] = 'application/json';
  }
  const res = await fetch(`${CORE_API}${path}`, { method, headers: requestHeaders, body, cache: 'no-store' });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new CoreError(res.status, data);
  return data as T;
}

/** A page's data, or any other read. */
export function coreGet<T>(path: string): Promise<T> {
  return call<T>('GET', path);
}

/** A server action's work, with its arguments as JSON. */
export function corePost<T>(path: string, json: unknown = {}): Promise<T> {
  return call<T>('POST', path, { json });
}

/** A server action that sends files (uploads). */
export function corePostForm<T>(path: string, form: FormData): Promise<T> {
  return call<T>('POST', path, { form });
}
