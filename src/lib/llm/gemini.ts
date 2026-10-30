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
}

async function call(
  system: string,
  user: string,
  generationConfig: Record<string, unknown>,
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = geminiModel();

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

/** Structured answer generation — returns the raw JSON string, or null. */
export function geminiJson(system: string, user: string): Promise<string | null> {
  return call(system, user, {
    responseMimeType: 'application/json',
    responseSchema: ANSWER_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 500,
  });
}

/** Plain-text generation, used for the operator hand-off summary. */
export function geminiText(system: string, user: string, maxOutputTokens = 300): Promise<string | null> {
  return call(system, user, { temperature: 0.3, maxOutputTokens });
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
