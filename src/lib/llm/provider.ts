/**
 * Answer generation.
 *
 * Two engines behind one interface:
 *   • `local`  — the extractive synthesiser in ./local.ts. Zero cost, zero
 *                config, works offline. This is what runs out of the box.
 *   • `claude` — Anthropic's Messages API, used automatically when
 *                ANTHROPIC_API_KEY is present. Falls back to `local` on any
 *                provider error so a call is never dropped because of us.
 *
 * The voice pipeline is latency-critical (<1 s from end-of-speech to first
 * audio), so the Claude path is tuned for time-to-first-word: thinking off,
 * effort low, a hard output cap, and streaming.
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { RetrievalHit } from '@/lib/rag/retrieve';
import type { Locale } from '@/lib/types';
import {
  classifyIntent,
  summarizeLocal,
  synthesizeLocal,
  type Intent,
  type SynthesisInput,
  type SynthesisOutput,
} from './local';

export type { Intent, SynthesisOutput };
export { classifyIntent, sentimentOf, INTENT_LABEL } from './local';

const LANGUAGE_NAME: Record<Locale, string> = {
  uz: 'Uzbek',
  ru: 'Russian',
  en: 'English',
};

const PERSONA_NOTE: Record<string, string> = {
  professional: 'Composed and efficient. No small talk beyond a brief greeting.',
  friendly: 'Warm and personable, but still brief.',
  concise: 'Maximally terse. Answer and stop.',
  empathetic: 'Acknowledge the caller’s situation in a few words before answering.',
};

/* ── prompt construction ─────────────────────────────────────── */

function systemPrompt(input: SynthesisInput & { persona?: string; instructions?: string }) {
  const lang = LANGUAGE_NAME[input.language] ?? 'English';
  return [
    `You are ${input.agentName}, the voice assistant answering the phone for this company.`,
    `Reply in ${lang}. If the caller switches language mid-call, switch with them.`,
    '',
    'Your reply is read aloud by a speech synthesiser, so:',
    '- Two or three short sentences at most. Never use markdown, lists, or headings.',
    '- Write numbers, prices and times the way a person says them out loud.',
    '- Do not include internal or system XML tags in your response.',
    '',
    'Answer ONLY from the knowledge base excerpts supplied in the user turn.',
    'If the excerpts do not contain the answer, set answered=false and say — in the',
    'caller’s language — that you will pass them to a colleague. Never guess a price,',
    'a date, a phone number or a medical fact that is not in the excerpts.',
    input.persona ? `\nTone: ${PERSONA_NOTE[input.persona] ?? input.persona}` : '',
    input.instructions ? `\nCompany instructions:\n${input.instructions.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function contextBlock(hits: RetrievalHit[]) {
  if (!hits.length) return 'KNOWLEDGE BASE EXCERPTS: (none matched this question)';
  return [
    'KNOWLEDGE BASE EXCERPTS',
    ...hits.map(
      (h, i) =>
        `[${i + 1}] source: ${h.documentTitle}${h.heading ? ` › ${h.heading}` : ''}\n${h.text.slice(0, 1400)}`,
    ),
  ].join('\n\n');
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'What the assistant says out loud, in the caller’s language.',
    },
    answered: {
      type: 'boolean',
      description: 'True only if the excerpts fully support the answer.',
    },
    usedExcerpts: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Numbers of the excerpts the answer relies on.',
    },
  },
  required: ['answer', 'answered', 'usedExcerpts'],
  additionalProperties: false,
} as const;

/* ── client ──────────────────────────────────────────────────── */

let client: Anthropic | null | undefined;

function anthropic(): Anthropic | null {
  if (client !== undefined) return client;
  client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return client;
}

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5';

export function engineName(): string {
  return anthropic() ? `claude:${MODEL()}` : 'ovoz-local-synthesis';
}

export function engineIsHosted(): boolean {
  return anthropic() !== null;
}

/* ── generation ──────────────────────────────────────────────── */

export interface GenerateInput extends SynthesisInput {
  persona?: string;
  instructions?: string;
}

export async function generateAnswer(input: GenerateInput): Promise<SynthesisOutput> {
  const claude = anthropic();
  const intent = classifyIntent(input.question);

  // These never need a model round-trip, and skipping it saves ~600 ms.
  if (intent === 'human' || (!input.hits.length && input.confidence < input.threshold)) {
    return synthesizeLocal(input);
  }
  if (!claude) return synthesizeLocal(input);

  try {
    const message = await claude.messages.create({
      model: MODEL(),
      max_tokens: 400,
      // Voice turns are latency-bound; depth of reasoning is not what makes
      // this answer good — grounding is. See README ▸ Latency budget.
      thinking: { type: 'disabled' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: ANSWER_SCHEMA },
      },
      system: systemPrompt(input),
      messages: [
        {
          role: 'user',
          content: [
            contextBlock(input.hits),
            '',
            ...(input.history ?? [])
              .slice(-6)
              .map((t) => `${t.role === 'caller' ? 'CALLER' : 'YOU'}: ${t.text}`),
            `CALLER: ${input.question}`,
          ].join('\n'),
        },
      ],
    });

    if (message.stop_reason === 'refusal') return synthesizeLocal(input);

    const raw = message.content.find((b) => b.type === 'text');
    if (!raw || raw.type !== 'text') return synthesizeLocal(input);

    const parsed = JSON.parse(raw.text) as {
      answer: string;
      answered: boolean;
      usedExcerpts: number[];
    };
    if (!parsed.answer?.trim()) return synthesizeLocal(input);

    const used = new Set(parsed.usedExcerpts ?? []);
    return {
      answer: parsed.answer.trim(),
      intent,
      answered: Boolean(parsed.answered),
      usedHits: input.hits.filter((_, i) => used.has(i + 1)).slice(0, 3),
      engine: `claude:${message.model}`,
    };
  } catch {
    // Provider outage, rate limit, malformed JSON — the caller still gets an
    // answer from the local engine rather than dead air.
    return synthesizeLocal(input);
  }
}

/** Streaming variant used by the web playground for token-by-token display. */
export async function* streamAnswer(
  input: GenerateInput,
): AsyncGenerator<{ delta?: string; done?: SynthesisOutput }> {
  const claude = anthropic();
  if (!claude) {
    const result = synthesizeLocal(input);
    // Mirror the streaming shape so the client renders identically.
    for (const word of result.answer.split(/(\s+)/)) {
      yield { delta: word };
      await new Promise((r) => setTimeout(r, 14));
    }
    yield { done: result };
    return;
  }

  const result = await generateAnswer(input);
  for (const word of result.answer.split(/(\s+)/)) {
    yield { delta: word };
    await new Promise((r) => setTimeout(r, 10));
  }
  yield { done: result };
}

/* ── summarisation for operator hand-off ─────────────────────── */

export async function summarizeCall(
  turns: Array<{ role: string; text: string }>,
  language: Locale,
  reason: string,
): Promise<string> {
  const claude = anthropic();
  const fallback = summarizeLocal(turns, language, reason);
  if (!claude || turns.length < 2) return fallback;

  try {
    const message = await claude.messages.create({
      model: MODEL(),
      max_tokens: 300,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system:
        'You brief a human contact-centre operator who is about to pick up a live call ' +
        'mid-conversation. Write 2–3 sentences: what the caller wants, what has already ' +
        'been said, and what the operator must do next. No preamble, no markdown. ' +
        'Do not include internal or system XML tags in your response. ' +
        `Write in ${LANGUAGE_NAME[language] ?? 'English'}.`,
      messages: [
        {
          role: 'user',
          content: `Escalation reason: ${reason}\n\nTranscript:\n${turns
            .map((t) => `${t.role === 'caller' ? 'CALLER' : 'AI'}: ${t.text}`)
            .join('\n')}`,
        },
      ],
    });
    if (message.stop_reason === 'refusal') return fallback;
    const block = message.content.find((b) => b.type === 'text');
    return block && block.type === 'text' && block.text.trim() ? block.text.trim() : fallback;
  } catch {
    return fallback;
  }
}
