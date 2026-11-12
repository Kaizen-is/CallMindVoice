/**
 * BRB speech proxy — our own TTS (and, later, STT) models behind the
 * "TTS/STT Proxy API" (`BRB_SPEECH_URL`, reachable through the BRB VPN).
 *
 *   POST /auth/login   {login, password}   → {access_token, refresh_token}
 *   POST /auth/refresh {refresh_token}     → a new pair
 *   POST /tts/speech   {input} + Bearer    → the whole WAV (no streaming)
 *
 * The account (`BRB_SPEECH_LOGIN` / `BRB_SPEECH_PASSWORD`) has a request
 * limit, and every input is stored by the proxy, so text is sent one sentence
 * at a time by `./tts` (which also caches renders on disk, so a fixed line
 * costs one request ever). Tokens are kept in memory: refreshed shortly before
 * they expire, renewed once on a 401, and the login repeated when the refresh
 * token is no longer accepted.
 */
import 'server-only';

const LOGIN_TIMEOUT_MS = 10_000;
const SPEECH_TIMEOUT_MS = 30_000;
/** Renew this long before the access token's `exp`. */
const EARLY_MS = 60_000;

export class BrbError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function base(): string {
  return (process.env.BRB_SPEECH_URL || '').trim().replace(/\/+$/, '');
}

export function brbConfigured(): boolean {
  return Boolean(base() && process.env.BRB_SPEECH_LOGIN?.trim() && process.env.BRB_SPEECH_PASSWORD);
}

/* ── tokens ──────────────────────────────────────────────────── */

interface Tokens {
  access: string;
  refresh: string;
  /** When the access token stops being used (ms epoch); Infinity when it carries no `exp`. */
  renewAt: number;
}

let tokens: Tokens | null = null;
let pending: Promise<Tokens> | null = null;

/** The `exp` claim of a JWT in ms, or null. The signature is the proxy's business. */
function expiresAt(jwt: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function toTokens(data: { access_token?: unknown; refresh_token?: unknown }): Tokens {
  if (typeof data.access_token !== 'string' || !data.access_token) throw new BrbError('brb_auth_failed');
  const exp = expiresAt(data.access_token);
  return {
    access: data.access_token,
    refresh: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    renewAt: exp === null ? Infinity : exp - EARLY_MS,
  };
}

async function post(path: string, body: unknown, timeoutMs: number, token?: string): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function login(): Promise<Tokens> {
  const res = await post(
    '/auth/login',
    { login: (process.env.BRB_SPEECH_LOGIN || '').trim(), password: process.env.BRB_SPEECH_PASSWORD || '' },
    LOGIN_TIMEOUT_MS,
  );
  if (!res.ok) {
    console.warn(`[brb] login ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    throw new BrbError('brb_auth_failed', res.status === 401 || res.status === 403 ? 503 : 502);
  }
  return toTokens((await res.json()) as Record<string, unknown>);
}

/** A new pair from the refresh token, or a fresh login when that is refused. */
async function renew(current: Tokens | null): Promise<Tokens> {
  if (current?.refresh) {
    const res = await post('/auth/refresh', { refresh_token: current.refresh }, LOGIN_TIMEOUT_MS).catch(() => null);
    if (res?.ok) return toTokens((await res.json()) as Record<string, unknown>);
  }
  return login();
}

/** A usable access token; `stale` is one the proxy just refused. One renewal at a time. */
async function accessToken(stale?: string): Promise<string> {
  if (tokens && tokens.access !== stale && Date.now() < tokens.renewAt) return tokens.access;
  if (!pending) {
    const current = tokens;
    pending = renew(current)
      .then((fresh) => (tokens = fresh))
      .finally(() => {
        pending = null;
      });
  }
  return (await pending).access;
}

/* ── speech ──────────────────────────────────────────────────── */

/**
 * Render one piece of text (already in spoken form). Resolves to the WAV the
 * proxy returns; throws BrbError — `brb_limit` when the account's limit is
 * reached (429), `brb_<status>` otherwise.
 */
export async function brbSpeech(text: string): Promise<Buffer> {
  if (!brbConfigured()) throw new BrbError('brb_not_configured', 503);
  let token = await accessToken();
  let res = await post('/tts/speech', { input: text }, SPEECH_TIMEOUT_MS, token);
  if (res.status === 401) {
    // Expired or revoked early: renew once and try again.
    token = await accessToken(token);
    res = await post('/tts/speech', { input: text }, SPEECH_TIMEOUT_MS, token);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    console.warn(`[brb] tts ${res.status}: ${detail}`);
    throw new BrbError(res.status === 429 ? 'brb_limit' : `brb_${res.status}`, res.status === 429 ? 429 : 502);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new BrbError('brb_empty_audio');
  return audio;
}
