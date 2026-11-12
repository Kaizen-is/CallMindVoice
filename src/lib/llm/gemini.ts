/**
 * Google Gemini answer generation, called directly over the REST API (no SDK
 * dependency). Activated by GEMINI_API_KEY; the model defaults to a low-latency
 * flash model because voice turns are latency-bound (README ▸ Latency budget).
 *
 * Every function returns `null` on any failure (missing key, HTTP error,
 * timeout, safety block) so `provider.ts` can fall back to the local engine and
 * a call is never dropped because of us.
 */
import 'server-only';
import type { LlmCall } from './call';
import { answerExtractor } from './json-stream';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 8000;

export function hasGemini(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function geminiModel(): string {
  // A flash-lite model gives the lowest time-to-first-word for voice and is
  // plenty for grounded, excerpt-based answers. Override with GEMINI_MODEL.
  return process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

async function call(
  system: string,
  user: string,
  generationConfig: Record<string, unknown>,
  meta?: LlmCall,
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = meta?.model || geminiModel();

  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // Surface the reason in server logs — usually a bad key, wrong model name,
      // or a region/quota issue the operator needs to see.
      console.warn(`[gemini] ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as GeminiResponse;
    if (meta && data.usageMetadata) {
      // Thinking tokens are billed as output.
      meta.tokensIn = data.usageMetadata.promptTokenCount;
      meta.tokensOut = (data.usageMetadata.candidatesTokenCount ?? 0) + (data.usageMetadata.thoughtsTokenCount ?? 0);
    }
    if (data.promptFeedback?.blockReason) {
      console.warn(`[gemini] blocked: ${data.promptFeedback.blockReason}`);
      return null;
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim() || null;
  } catch (err) {
    console.warn('[gemini] request failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Gemini uses an OpenAPI-subset schema (upper-case type names, no
// additionalProperties). `propertyOrdering` keeps the JSON stable.
const ANSWER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    answered: { type: 'BOOLEAN' },
    usedExcerpts: { type: 'ARRAY', items: { type: 'INTEGER' } },
  },
  required: ['answer', 'answered', 'usedExcerpts'],
  propertyOrdering: ['answer', 'answered', 'usedExcerpts'],
} as const;

const ANSWER_CONFIG = {
  responseMimeType: 'application/json',
  responseSchema: ANSWER_SCHEMA,
  temperature: 0.2,
  maxOutputTokens: 500,
} as const;

/** Structured answer generation — returns the raw JSON string, or null. */
export function geminiJson(system: string, user: string, meta?: LlmCall): Promise<string | null> {
  return call(system, user, ANSWER_CONFIG, meta);
}

/**
 * Streaming twin of {@link geminiJson} (`streamGenerateContent`, server-sent
 * events): the same structured answer, with the `answer` text handed to
 * `onAnswer` piece by piece as Gemini writes it, so the voice can start on the
 * first words. Resolves to the complete JSON string, or null on failure —
 * check what was already streamed before falling back, since it may have been
 * spoken.
 */
export async function geminiJsonStream(
  system: string,
  user: string,
  onAnswer?: (delta: string) => void,
  meta?: LlmCall,
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = meta?.model || geminiModel();
  const extract = onAnswer ? answerExtractor(onAnswer) : null;
  let raw = '';

  try {
    const res = await fetch(`${ENDPOINT}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: ANSWER_CONFIG,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      console.warn(`[gemini] stream ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }

    // One `data: {…}` line per event; each carries the next piece of text, and
    // the last also the token counts.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
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
        let data: GeminiResponse;
        try {
          data = JSON.parse(line.slice(5).trim()) as GeminiResponse;
        } catch {
          continue;
        }
        if (data.promptFeedback?.blockReason) {
          console.warn(`[gemini] blocked: ${data.promptFeedback.blockReason}`);
          return null;
        }
        if (meta && data.usageMetadata) {
          meta.tokensIn = data.usageMetadata.promptTokenCount;
          meta.tokensOut = (data.usageMetadata.candidatesTokenCount ?? 0) + (data.usageMetadata.thoughtsTokenCount ?? 0);
        }
        const piece = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        if (piece) {
          raw += piece;
          extract?.(raw);
        }
      }
    }
  } catch (err) {
    console.warn('[gemini] stream failed:', err instanceof Error ? err.message : err);
    return null;
  }

  return raw.trim() || null;
}

/** Plain-text generation, used for the operator hand-off summary. */
export function geminiText(system: string, user: string, maxOutputTokens = 300, meta?: LlmCall): Promise<string | null> {
  return call(system, user, { temperature: 0.3, maxOutputTokens }, meta);
}

/* ── speech-to-text ──────────────────────────────────────────── */

const STT_TIMEOUT_MS = 8000;
const NO_SPEECH = '<empty>';

/**
 * Transcribe one utterance (a 16 kHz mono WAV). Used for languages the internal
 * Uzbek model does not know, and as a second ear when that model is down.
 *
 * Returns the verbatim transcript, '' when there was no speech, or null on any
 * failure. A model asked to "say nothing" on silence tends to say something
 * anyway, so it is given an explicit marker to answer with instead.
 */
export async function geminiTranscribe(wav: ArrayBuffer, languageName: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_STT_MODEL || 'gemini-flash-lite-latest';

  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are the speech-to-text engine of a phone line. Transcribe the caller's words " +
                `verbatim in the language they actually speak (expected: ${languageName}), in that ` +
                "language's normal script. Write numbers as digits. Never translate, answer, " +
                `summarise or add anything. If there is no intelligible speech, output exactly: ${NO_SPEECH}`,
            },
          ],
        },
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } }] },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[gemini] stt ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
    return text.includes(NO_SPEECH) ? '' : text;
  } catch (err) {
    console.warn('[gemini] stt failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
