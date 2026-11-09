/**
 * OpenAI answer generation, over the Chat Completions REST API (no SDK
 * dependency). Activated by OPENAI_API_KEY; OPENAI_MODEL picks the model
 * (default gpt-4.1-mini: no reasoning pass, so the first words come fast —
 * what a phone call needs) and OPENAI_BASE_URL an OpenAI-compatible endpoint.
 *
 * Answers stream: the structured JSON is decoded as it arrives and its
 * `answer` text handed on piece by piece, so the voice starts on the first
 * sentence while the model writes the rest (as with Ollama).
 *
 * Every function returns `null` on any failure so `provider.ts` can fall back
 * to the local engine and a call is never dropped because of us.
 */
import 'server-only';
import type { LlmCall } from './call';
import { answerExtractor } from './ollama';

export function hasOpenAI(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function openaiModel(): string {
  return process.env.OPENAI_MODEL || 'gpt-4.1-mini';
}

function baseUrl(): string {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function timeoutMs(): number {
  const n = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

/**
 * Reasoning models take no temperature and think unless told not to. The
 * lowest setting is named differently across generations: the first GPT-5
 * models call it "minimal", GPT-5.1 and later "none" (and refuse "minimal");
 * the o-series stops at "low". "chat-latest" models are not reasoning models.
 */
function samplingFor(model: string): Record<string, unknown> {
  if (/chat-latest/.test(model)) return {};
  // The larger GPT-6 tiers (Sol, Astra) start at "low"; "none" is a 400 there.
  if (/^gpt-\d+(\.\d+)?-(sol|astra)\b/.test(model)) return { reasoning_effort: 'low' };
  if (/^gpt-5(-|$)/.test(model)) return { reasoning_effort: 'minimal' };
  if (/^gpt-(5\.\d|[6-9])/.test(model)) return { reasoning_effort: 'none' };
  if (/^o\d/.test(model)) return { reasoning_effort: 'low' };
  return { temperature: 0.2 };
}

// Strict structured output: the reply always parses, and `answer` comes first.
const ANSWER_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'answer',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'What you say out loud.' },
        answered: { type: 'boolean' },
        usedExcerpts: { type: 'array', items: { type: 'integer' } },
      },
      required: ['answer', 'answered', 'usedExcerpts'],
      additionalProperties: false,
    },
  },
} as const;

function request(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()),
  });
}

/**
 * The structured answer, streamed: `onAnswer` receives the `answer` text as it
 * is generated. Resolves to the complete JSON string, or null on failure —
 * check what was already streamed before falling back, since it may have been spoken.
 */
export async function openaiJsonStream(
  system: string,
  user: string,
  onAnswer?: (delta: string) => void,
  call?: LlmCall,
): Promise<string | null> {
  if (!hasOpenAI()) return null;
  const model = call?.model || openaiModel();
  const extract = onAnswer ? answerExtractor(onAnswer) : null;
  let raw = '';
  try {
    const res = await request({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: true,
      // Token counts for the usage log arrive in one last chunk. Only asked of
      // OpenAI itself: a compatible server behind OPENAI_BASE_URL may not know it.
      ...(process.env.OPENAI_BASE_URL ? {} : { stream_options: { include_usage: true } }),
      max_completion_tokens: 500,
      response_format: ANSWER_FORMAT,
      ...samplingFor(model),
    });
    if (!res.ok || !res.body) {
      console.warn(`[openai] ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    // Server-sent events: `data: {chunk}` lines, ending with `data: [DONE]`.
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffered = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string; refusal?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        if (chunk.usage && call) {
          call.tokensIn = chunk.usage.prompt_tokens;
          call.tokensOut = chunk.usage.completion_tokens;
        }
        const piece = chunk.choices?.[0]?.delta?.content ?? '';
        if (piece) {
          raw += piece;
          extract?.(raw);
        }
      }
    }
  } catch (err) {
    console.warn('[openai] stream failed:', err instanceof Error ? err.message : err);
    return null;
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  console.warn(`[openai] no JSON in reply: ${raw.slice(0, 200)}`);
  return null;
}

/** Plain-text generation, used for the operator hand-off summary. */
export async function openaiText(
  system: string,
  user: string,
  maxOutputTokens = 300,
  call?: LlmCall,
): Promise<string | null> {
  if (!hasOpenAI()) return null;
  const model = call?.model || openaiModel();
  try {
    const res = await request({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_completion_tokens: maxOutputTokens,
      ...samplingFor(model),
    });
    if (!res.ok) {
      console.warn(`[openai] ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (call && data.usage) {
      call.tokensIn = data.usage.prompt_tokens;
      call.tokensOut = data.usage.completion_tokens;
    }
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn('[openai] request failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
