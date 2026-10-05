/**
 * Answer generation.
 *
 * Two engines behind one interface:
 *   • `local`  — the extractive synthesiser in ./local.ts. Zero cost, zero
 *                config, works offline. This is what runs out of the box.
 *   • `claude` — Anthropic's Messages API, used automatically when
 *                ANTHROPIC_API_KEY is present. Falls back to `local` on any
 *                provider error so a call is never dropped because of us.
 *   • `ollama` — a self-hosted model (Gemma) via ./ollama.ts, used when
 *                OLLAMA_BASE_URL is set. Same fallback guarantee.
 *
 * The voice pipeline is latency-critical (<1 s from end-of-speech to first
 * audio), so the Claude path is tuned for time-to-first-word: thinking off,
 * effort low, a hard output cap, and streaming.
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { hasGemini, geminiJson, geminiText, geminiModel } from './gemini';
import { hasOllama, ollamaJson, ollamaText, ollamaModel } from './ollama';
import type { RetrievalHit } from '@/lib/rag/retrieve';
import type { CallTarget, Locale } from '@/lib/types';
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

function systemPrompt(input: GenerateInput) {
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
    'ROUTING — decide what the question is about:',
    '- Company questions (this company’s prices, hours, services, policies, staff,',
    '  addresses): answer ONLY from the knowledge base excerpts supplied in the user',
    '  turn. Never guess a company price, date, phone number or medical fact that is',
    '  not in the excerpts. If the excerpts lack the answer, set answered=false and',
    '  say — in the caller’s language — that you will pass them to a colleague.',
    '- General-knowledge questions (facts about the world, definitions, simple',
    '  calculations, anything not specific to this company): answer directly from',
    '  your own knowledge, set answered=true and usedExcerpts=[]. Do not mention',
    '  the knowledge base or transfer the caller for these.',
    '',
    'MEMORY — this is one continuous conversation. Remember everything the caller',
    'has told you earlier in it (their name, what they asked, details they gave) and',
    'use it. Questions about the conversation itself ("what is my name?", "what did',
    'I ask before?") are answered from the conversation: answered=true, usedExcerpts=[].',
    input.persona ? `\nTone: ${PERSONA_NOTE[input.persona] ?? input.persona}` : '',
    input.instructions
      ? '\nAGENT INSTRUCTIONS — set by the company for this agent. Follow them; they take ' +
        'priority over the tone and style guidance above, but never over the rule against ' +
        `inventing company facts:\n${input.instructions.slice(0, 4000)}`
      : '',
    input.target?.fullName ? targetBlock(input.target) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Outbound loan-reminder flow. The identity check lives in the conversation
 * itself: the memory rule above is what lets the model know, turns later,
 * whether the year of birth was already confirmed.
 */
function targetBlock(target: CallTarget) {
  return [
    '',
    'OUTBOUND CALL — you are calling one specific person about repaying their loan.',
    'This flow takes priority over the knowledge-base routing above.',
    `Person you are calling: ${target.fullName}`,
    target.birthYear ? `Their year of birth on file (SECRET): ${target.birthYear}` : '',
    target.loanAmount ? `Amount they owe: ${target.loanAmount}` : '',
    'Steps:',
    `1. Open by greeting them, saying you are calling for ${target.fullName}, and` +
      (target.birthYear ? ' asking them to confirm their year of birth.' : ' asking them to confirm it is them.'),
    '2. Never say, hint at or confirm the year of birth yourself before they say it.',
    '   Compare the year they say with the one on file.',
    '3. If it does not match, or they refuse: apologise, allow one more try, and never',
    '   mention the loan or any amount to an unconfirmed person. Then end politely.',
    '4. Only after the year matches: tell them the amount they owe and ask when they',
    '   can pay. Get a concrete date, then repeat it back to confirm.',
    '5. Stay polite and calm. Never threaten or pressure.',
    'Every reply in this flow is answered=true, usedExcerpts=[] unless you quote an excerpt.',
    target.prompt ? `\nCALL INSTRUCTIONS — set by the company for this call:\n${target.prompt.slice(0, 4000)}` : '',
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

/* ── client & provider selection ─────────────────────────────── */

let client: Anthropic | null | undefined;

function anthropic(): Anthropic | null {
  if (client !== undefined) return client;
  client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return client;
}

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5';

type Provider = 'ollama' | 'gemini' | 'anthropic' | 'local';

/**
 * Which answer engine is active. Set LLM_PROVIDER to force one explicitly;
 * otherwise the first configured provider wins (Ollama, then Gemini, then
 * Claude), and the local synthesiser is the floor when none is configured.
 */
function provider(): Provider {
  const pref = process.env.LLM_PROVIDER?.toLowerCase();
  if (pref === 'ollama') return hasOllama() ? 'ollama' : 'local';
  if (pref === 'gemini') return hasGemini() ? 'gemini' : 'local';
  if (pref === 'anthropic' || pref === 'claude') return anthropic() ? 'anthropic' : 'local';
  if (pref === 'local') return 'local';
  if (hasOllama()) return 'ollama';
  if (hasGemini()) return 'gemini';
  if (anthropic()) return 'anthropic';
  return 'local';
}

export function engineName(): string {
  const p = provider();
  if (p === 'ollama') return `ollama:${ollamaModel()}`;
  if (p === 'gemini') return `gemini:${geminiModel()}`;
  if (p === 'anthropic') return `claude:${MODEL()}`;
  return 'ovoz-local-synthesis';
}

export function engineIsHosted(): boolean {
  return provider() !== 'local';
}

/** Human-friendly label for the active engine, for the Overview/Settings cards. */
export function engineLabel(): string {
  const name = engineName();
  if (name.startsWith('ollama:')) return name.replace('ollama:', 'Ollama ');
  if (name.startsWith('gemini:')) return name.replace('gemini:', 'Gemini ');
  if (name.startsWith('claude:')) return name.replace('claude:', 'Claude ');
  return 'Local synthesiser';
}

/* ── generation ──────────────────────────────────────────────── */

export interface GenerateInput extends SynthesisInput {
  persona?: string;
  instructions?: string;
  target?: CallTarget;
}

export async function generateAnswer(input: GenerateInput): Promise<SynthesisOutput> {
  const intent = classifyIntent(input.question);

  // Explicit "give me a human" never needs a model round-trip.
  if (intent === 'human') {
    return synthesizeLocal(input);
  }

  const active = provider();
  if (active === 'local') return synthesizeLocal(input);

  // Prompt construction is provider-agnostic: a system prompt plus a single
  // user turn carrying the excerpts, recent history and the question.
  const system = systemPrompt(input);
  const user = [
    contextBlock(input.hits),
    '',
    ...(input.history ?? [])
      // Twenty caller/agent exchanges: enough for the agent to remember the
      // whole of a realistic chat, small next to the model's context window.
      .slice(-40)
      .map((h) => `${h.role === 'caller' ? 'CALLER' : 'YOU'}: ${h.text}`),
    `CALLER: ${input.question}`,
  ].join('\n');

  const finalize = (
    parsed: { answer: string; answered: boolean; usedExcerpts: number[] },
    engine: string,
  ): SynthesisOutput => {
    const used = new Set(parsed.usedExcerpts ?? []);
    return {
      answer: parsed.answer.trim(),
      intent,
      answered: Boolean(parsed.answered),
      usedHits: input.hits.filter((_, i) => used.has(i + 1)).slice(0, 3),
      engine,
    };
  };

  // Any failure below falls through to the local engine rather than dead air.
  if (active === 'gemini' || active === 'ollama') {
    try {
      const raw = active === 'ollama' ? await ollamaJson(system, user) : await geminiJson(system, user);
      if (!raw) return synthesizeLocal(input);
      const parsed = JSON.parse(raw) as { answer: string; answered: boolean; usedExcerpts: number[] };
      if (!parsed.answer?.trim()) return synthesizeLocal(input);
      return finalize(parsed, engineName());
    } catch {
      return synthesizeLocal(input);
    }
  }

  const claude = anthropic();
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
      system,
      messages: [{ role: 'user', content: user }],
    });

    if (message.stop_reason === 'refusal') return synthesizeLocal(input);
    const raw = message.content.find((b) => b.type === 'text');
    if (!raw || raw.type !== 'text') return synthesizeLocal(input);
    const parsed = JSON.parse(raw.text) as { answer: string; answered: boolean; usedExcerpts: number[] };
    if (!parsed.answer?.trim()) return synthesizeLocal(input);
    return finalize(parsed, `claude:${message.model}`);
  } catch {
    return synthesizeLocal(input);
  }
}

/** Streaming variant used by the web playground for token-by-token display. */
export async function* streamAnswer(
  input: GenerateInput,
): AsyncGenerator<{ delta?: string; done?: SynthesisOutput }> {
  if (provider() === 'local') {
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
  const fallback = summarizeLocal(turns, language, reason);
  if (turns.length < 2) return fallback;

  const active = provider();
  if (active === 'local') return fallback;

  const system =
    'You brief a human contact-centre operator who is about to pick up a live call ' +
    'mid-conversation. Write 2–3 sentences: what the caller wants, what has already ' +
    'been said, and what the operator must do next. No preamble, no markdown. ' +
    'Do not include internal or system XML tags in your response. ' +
    `Write in ${LANGUAGE_NAME[language] ?? 'English'}.`;
  const user = `Escalation reason: ${reason}\n\nTranscript:\n${turns
    .map((t) => `${t.role === 'caller' ? 'CALLER' : 'AI'}: ${t.text}`)
    .join('\n')}`;

  if (active === 'gemini' || active === 'ollama') {
    const text = active === 'ollama' ? await ollamaText(system, user, 300) : await geminiText(system, user, 300);
    return text?.trim() ? text.trim() : fallback;
  }

  const claude = anthropic();
  if (!claude) return fallback;
  try {
    const message = await claude.messages.create({
      model: MODEL(),
      max_tokens: 300,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (message.stop_reason === 'refusal') return fallback;
    const block = message.content.find((b) => b.type === 'text');
    return block && block.type === 'text' && block.text.trim() ? block.text.trim() : fallback;
  } catch {
    return fallback;
  }
}
