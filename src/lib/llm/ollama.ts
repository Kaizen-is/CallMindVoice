/**
 * Ollama answer generation — self-hosted models such as Gemma, called over
 * Ollama's native REST API (no SDK dependency). Activated by OLLAMA_BASE_URL:
 *
 *   • Local / own GPU server:  OLLAMA_BASE_URL=http://127.0.0.1:11434
 *                              OLLAMA_MODEL=gemma4:31b
 *   • Ollama cloud (testing):  OLLAMA_BASE_URL=https://ollama.com
 *                              OLLAMA_MODEL=gemma4:31b
 *                              OLLAMA_API_KEY=…
 *
 * Every function returns `null` on any failure (unreachable server, HTTP
 * error, timeout, unparseable output) so `provider.ts` can fall back to the
 * local engine and a call is never dropped because of us.
 */
import 'server-only';

export function hasOllama(): boolean {
  return Boolean(process.env.OLLAMA_BASE_URL);
}

export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL || 'gemma4:31b';
}

function baseUrl(): string {
  return (process.env.OLLAMA_BASE_URL || '').replace(/\/+$/, '');
}

function timeoutMs(): number {
  const n = Number(process.env.OLLAMA_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

interface OllamaResponse {
  message?: { content?: string };
  error?: string;
}

async function call(
  system: string,
  user: string,
  options: { temperature: number; num_predict: number },
  format?: unknown,
): Promise<string | null> {
  if (!hasOllama()) return null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;

  try {
    const res = await fetch(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ollamaModel(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        // Voice turns are latency-bound: no reasoning trace before the answer.
        think: false,
        // Keep the weights resident between calls — reloading a 31B model
        // costs seconds the caller would spend listening to silence.
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        options,
        ...(format ? { format } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });

    if (!res.ok) {
      console.warn(`[ollama] ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as OllamaResponse;
    if (data.error) {
      console.warn(`[ollama] error: ${data.error}`);
      return null;
    }
    return data.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[ollama] request failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Ollama constrains decoding to a standard JSON schema passed as `format`.
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    answered: { type: 'boolean' },
    usedExcerpts: { type: 'array', items: { type: 'integer' } },
  },
  required: ['answer', 'answered', 'usedExcerpts'],
} as const;

// Not every Ollama host enforces `format` (Ollama cloud does not), so the shape
// is also spelled out in the prompt.
const JSON_INSTRUCTION =
  '\n\nRespond with ONLY a JSON object, no other text: ' +
  '{"answer": string (what you say out loud), "answered": boolean, "usedExcerpts": number[]}';

/** Structured answer generation — returns the raw JSON string, or null. */
export async function ollamaJson(system: string, user: string): Promise<string | null> {
  const raw = await call(system + JSON_INSTRUCTION, user, { temperature: 0.2, num_predict: 500 }, ANSWER_SCHEMA);
  if (!raw) return null;
  // Defensive: some models still wrap the object in a ```json fence.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  console.warn(`[ollama] no JSON in reply: ${raw.slice(0, 200)}`);
  return null;
}

/**
 * Streaming twin of {@link ollamaJson}: the same structured answer, but the
 * `answer` text is handed to `onAnswer` piece by piece as it is generated, so
 * the voice can start on the first sentence while the model writes the rest.
 * Resolves to the complete JSON string, or null on failure — check what was
 * already streamed before falling back, since that may have been spoken.
 */
export async function ollamaJsonStream(
  system: string,
  user: string,
  onAnswer: (delta: string) => void,
): Promise<string | null> {
  if (!hasOllama()) return null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;

  const extract = answerExtractor(onAnswer);
  let raw = '';
  try {
    const res = await fetch(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ollamaModel(),
        messages: [
          { role: 'system', content: system + JSON_INSTRUCTION },
          { role: 'user', content: user },
        ],
        stream: true,
        think: false,
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        options: { temperature: 0.2, num_predict: 500 },
        format: ANSWER_SCHEMA,
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok || !res.body) {
      console.warn(`[ollama] ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    // Newline-delimited JSON, one object per generated piece.
    const decoder = new TextDecoder();
    let buffered = '';
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const data = JSON.parse(line) as OllamaResponse;
        if (data.error) {
          console.warn(`[ollama] error: ${data.error}`);
          return null;
        }
        const piece = data.message?.content ?? '';
        if (piece) {
          raw += piece;
          extract(raw);
        }
      }
    }
  } catch (err) {
    console.warn('[ollama] stream failed:', err instanceof Error ? err.message : err);
    return null;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  console.warn(`[ollama] no JSON in reply: ${raw.slice(0, 200)}`);
  return null;
}

/**
 * Follows a growing JSON text and reports the `answer` string's value as it
 * appears, decoded. Escapes split across pieces wait for their next piece.
 */
function answerExtractor(onAnswer: (delta: string) => void): (raw: string) => void {
  let at = -1; // index of the first character of the value, once found
  let closed = false;
  return (raw) => {
    if (closed) return;
    if (at < 0) {
      const m = /"answer"\s*:\s*"/.exec(raw);
      if (!m) return;
      at = m.index + m[0].length;
    }
    let out = '';
    let i = at;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        closed = true;
        break;
      }
      if (c !== '\\') {
        out += c;
        i += 1;
        continue;
      }
      if (i + 1 >= raw.length) break;
      const e = raw[i + 1];
      if (e === 'u') {
        if (i + 6 > raw.length) break;
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 32);
        i += 6;
      } else {
        out += e === 'n' ? '\n' : e === 't' ? ' ' : e === 'r' ? '' : e;
        i += 2;
      }
    }
    at = i;
    if (out) onAnswer(out);
  };
}

/** Plain-text generation, used for the operator hand-off summary. */
export function ollamaText(system: string, user: string, maxOutputTokens = 300): Promise<string | null> {
  return call(system, user, { temperature: 0.3, num_predict: maxOutputTokens });
}
