/**
 * POST /v1/answer  (scope: read)
 *
 * Stateless grounded question-answering: retrieve against the tenant's
 * knowledge base and synthesise an answer, without persisting a call. Reuses
 * the exact retrieval + generation path the live voice engine runs on
 * (`retrieve` ⊕ `generateAnswer`), so an API answer is identical to what a
 * caller would hear.
 */
import { requireApiKey } from '@/lib/api-auth';
import { liveAgent } from '@/lib/engine/calls';
import { generateAnswer } from '@/lib/llm/provider';
import { retrieve } from '@/lib/rag/retrieve';
import { detectLanguage } from '@/lib/rag/text';
import type { Locale } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LANGUAGES: Locale[] = ['uz', 'ru', 'en'];

function invalid(message: string): Response {
  return Response.json({ error: { type: 'invalid_request', message } }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = requireApiKey(req, 'read');
  if (auth instanceof Response) return auth;

  let body: { question?: unknown; language?: unknown; callId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return invalid('Request body must be valid JSON.');
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return invalid('`question` is required.');

  const language: Locale =
    typeof body.language === 'string' && LANGUAGES.includes(body.language as Locale)
      ? (body.language as Locale)
      : detectLanguage(question);

  // The tenant's live agent supplies name/persona/instructions/threshold. When
  // none exists yet we fall back to neutral defaults rather than 500.
  const agent = liveAgent(auth.tenantId);
  const threshold = agent?.confidence_threshold ?? 0.45;

  const t0 = performance.now();

  const tRetrieve = performance.now();
  const retrieval = await retrieve(auth.tenantId, question, { topK: 5 });
  const retrievalMs = Math.round(performance.now() - tRetrieve);

  const tGen = performance.now();
  const generated = await generateAnswer({
    question,
    hits: retrieval.hits,
    confidence: retrieval.confidence,
    language,
    agentName: agent?.name ?? 'Ovoz',
    threshold,
    history: [],
    persona: agent?.persona,
    instructions: agent?.instructions,
  });
  const llmMs = Math.round(performance.now() - tGen);
  const totalMs = Math.round(performance.now() - t0);

  // Stateless escalation signal: an explicit "human please" or an ungrounded
  // answer. Mirrors the live engine's two hardest triggers without call state.
  const escalate: 'explicit_request' | 'low_confidence' | null =
    generated.intent === 'human'
      ? 'explicit_request'
      : !generated.answered
        ? 'low_confidence'
        : null;

  const sourceHits = generated.usedHits.length ? generated.usedHits : retrieval.hits.slice(0, 2);
  const citations = sourceHits.map((h) => ({
    documentTitle: h.documentTitle,
    heading: h.heading,
    score: Number(h.score.toFixed(3)),
  }));

  return Response.json({
    answer: generated.answer,
    confidence: Number(retrieval.confidence.toFixed(2)),
    answered: generated.answered,
    escalate,
    citations,
    timings: { retrievalMs, llmMs, totalMs },
  });
}
