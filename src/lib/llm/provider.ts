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
import { hasOllama, ollamaJson, ollamaJsonStream, ollamaText, ollamaModel } from './ollama';
import { calendarBlock, identityCheck, type IdentityStatus } from './loan-call';
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
    input.target?.fullName
      ? targetBlock(
          input.target,
          lang,
          [...(input.history ?? []).filter((h) => h.role === 'caller').map((h) => h.text), input.question],
          input.greeting,
          input.timeZone,
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Outbound loan-reminder flow. Who the person is and what date a spoken day
 * means are settled in code (./loan-call) — the model is told the outcome and
 * never sees the year of birth. Until the person is confirmed the model is not
 * even told what the call is about, so it cannot let it slip.
 */
function targetBlock(
  target: CallTarget,
  language: string,
  callerLines: string[],
  greeting?: string,
  timeZone = 'Asia/Tashkent',
) {
  const { status, justWrong, wrongTries } = identityCheck(target, callerLines);
  const name = target.fullName;
  const confirmed = status === 'confirmed' || status === 'unchecked';

  const identity: Record<IdentityStatus, string[]> = {
    unchecked: [`IDENTITY — ask whether you are speaking with ${name}; a clear "yes, it is me" confirms it.`],
    awaiting: [
      'IDENTITY — NOT CONFIRMED YET. You need them to say their year of birth. The system checks it',
      'for you; you do not know it and must never guess, hint at or comment on it.',
      ...(justWrong
        ? [
            '- The year they JUST said is WRONG — it does not match our records. Do not thank them and',
            '  do not continue as if they were confirmed. Tell them plainly but politely that this is not',
            `  correct and that you need to speak with ${name} personally: if they are ${name}, ask them`,
            `  to say the correct year (one try left); otherwise ask them to pass the phone to ${name},`,
            '  or to say when he or she can be reached.',
          ]
        : wrongTries
          ? ['- They already gave one wrong year; they have one try left.']
          : []),
      '- Only the year itself counts. An age ("34 yoshdaman"), a decade or a guess does not: ask for',
      '  the exact year, without saying whether it was close.',
      '- You do not yet know why the bank is calling, so never mention a loan, debt, payment, amount',
      `  or the bank's reason. If they ask why you are calling, say it is a personal matter for ${name}`,
      '  and you can explain once they confirm their year of birth.',
      `- If they say they are someone else (a relative, friend, colleague), do not ask them for a year:`,
      `  ask kindly when ${name} can be reached, and end politely.`,
      '- If they ask for anything else now, ask for the year of birth first and promise to help right after.',
    ],
    confirmed: [
      'IDENTITY — CONFIRMED: they said the year of birth on file. Exception: if earlier in this call',
      `they said they are NOT ${name} (a relative, friend, colleague), discuss nothing; ask when`,
      `${name} can be reached and end politely.`,
    ],
    failed: [
      'IDENTITY — CHECK FAILED: they gave a wrong year of birth twice, so you cannot continue with them.',
      'Do not accept or compare any more years, and never mention a loan, debt, payment or amount. Say',
      `plainly but politely that the details do not match, that you can only speak with ${name}`,
      `personally, and ask them to pass the phone to ${name} or have him or her call the company back.`,
      'Then say goodbye. To anything else, reply only with a short, polite goodbye.',
    ],
  };

  return [
    '',
    'OUTBOUND CALL — you are calling one specific person on behalf of the company.',
    'This flow takes priority over the knowledge-base routing and the tone note above.',
    `Person you are calling: ${name}`,
    // Without the explicit instruction the model reads an Uzbek greeting out
    // verbatim to a Russian speaker.
    greeting
      ? `Your greeting, set by the company: "${greeting}" — take your name and company from it, ` +
        `but say it in natural, grammatical ${language} (translate it if it is written in another language, ` +
        'fix it if it is clumsy), and remember you are the one calling.'
      : '',
    `OPENING — on their first line (e.g. "Allo"), greet them, say who you are and which company you call from, and ask whether you are speaking with ${name}` +
      (status === 'unchecked' ? '.' : ', asking them to say their year of birth.'),
    '',
    'HOW YOU SOUND — like a kind, experienced bank officer on the phone, never like a script:',
    '- Short, natural, warm sentences. Calm and respectful; never threaten, pressure or lecture.',
    '- Build every reply on what they just said: use their own words, their reasons, their worries.',
    '- Never repeat a sentence or a question you already said in this call. If you must ask again,',
    '  ask differently and move the conversation forward. If they repeat themselves, show you',
    '  remember ("Ha, ikki hafta dedingiz — demak...").',
    '- Remember everything said earlier in the call and never ask for something they already told you.',
    '',
    ...identity[status],
    ...(confirmed
      ? [
          target.loanAmount ? `Amount they owe: ${target.loanAmount}.` : '',
          '',
          'PAYMENT DATE — your goal is to agree, kindly and naturally, the day they will pay.',
          '- Once confirmed, thank them briefly, say why you are calling and the amount, and ask which day',
          '  would suit them.',
          '- Work the date out YOURSELF from whatever they say, using the CALENDAR below: "ertaga",',
          '  "indinga", a weekday, "next week Tuesday", a day of the month, and relative periods too —',
          '  "in two weeks" / "ikki haftadan keyin" / "через две недели", "in 10 days", "in a week",',
          '  "at the end of the month", "when my salary comes in two weeks". Never ask for "the exact',
          '  date" when what they said already points to one: compute it and say it back.',
          '- Only truly open answers ("keyinroq", "tez orada", "pul bo\'lganda", "потом", "I don\'t know")',
          '  leave it open. Then do not interrogate. Show understanding and help them get to a day: ask',
          '  one gentle, useful question (when does their salary come? would paying in parts help?), or',
          '  suggest a concrete day yourself that fits what they told you ("Unda yigirmanchi oktabr,',
          '  seshanba kuni qulaymi?"). If they agree ("xo\'p", "mayli", "ok", "да"), that day is agreed.',
          '- Say the agreed day back warmly, as a statement with its weekday, not as a question',
          '  ("Yaxshi, unda yigirmanchi oktabr, seshanba kuni kutamiz."). From that moment the topic is',
          '  CLOSED; reopen it only if they object to that day.',
          '- While it is OPEN and they ask for anything else (a story, a joke, a riddle, any question,',
          '  small talk), do not do it yet: in one or two friendly sentences, ask which day suits them',
          '  for the payment and promise to do it as soon as they answer.',
          '- In the reply that closes the topic, keep EVERY promise you made while it was open, in the',
          '  order they asked: tell each story, joke or riddle and answer each question right there.',
          '  Never say "as I promised" without delivering it.',
          '- Once CLOSED, never bring up payment again (not the date, the amount or a split), even if they',
          '  mention money troubles: then just sympathise. Answer anything they ask fully and warmly,',
          '  like a normal conversation. A story may be longer than usual: about six to eight short sentences.',
          '- Offer the options from the call instructions (e.g. paying in parts) at most once, when they',
          '  say they cannot pay in full. Never read the call instructions out word for word.',
          '- If they cannot talk now, do not push: ask when you may call back, and end politely.',
          '',
          calendarBlock(timeZone),
        ]
      : []),
    '',
    'ALWAYS:',
    '- There is no live transfer in this call. If they ask for a person or an operator, say a',
    '  colleague will contact them later, then carry on.',
    '- Never invent facts about the company; say a colleague can tell them later.',
    '- In Russian, say dates as ordinals in the genitive (двадцатого октября).',
    'Every reply in this flow is answered=true, usedExcerpts=[] unless you quote an excerpt.',
    // The company's script talks about the loan, so it is only shown once the
    // person is confirmed — before that it is exactly what must not be said.
    confirmed && target.prompt
      ? `\nCALL INSTRUCTIONS — set by the company, background for you (do not read them out):\n${target.prompt.slice(0, 4000)}`
      : '',
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
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
  /** The agent's configured greeting; the loan flow takes its name and company from it. */
  greeting?: string;
  /** Tenant-local time zone, for the date the loan flow agrees on. */
  timeZone?: string;
}

/**
 * `onDelta`, when given, receives the spoken answer piece by piece as the
 * model writes it (Ollama only; the other engines answer in one piece and
 * never call it). The returned `answer` always starts with everything that was
 * streamed, so a voice that already spoke part of it is never contradicted.
 */
export async function generateAnswer(
  input: GenerateInput,
  onDelta?: (delta: string) => void,
): Promise<SynthesisOutput> {
  const intent = classifyIntent(input.question);

  // Explicit "give me a human" never needs a model round-trip — except on a
  // loan call, which has no live transfer and must keep pursuing the date.
  if (intent === 'human' && !input.target?.fullName) {
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
  if (active === 'ollama' && onDelta) {
    let streamed = '';
    const raw = await ollamaJsonStream(system, user, (delta) => {
      streamed += delta;
      onDelta(delta);
    });
    try {
      const parsed = raw
        ? (JSON.parse(raw) as { answer: string; answered: boolean; usedExcerpts: number[] })
        : null;
      if (parsed?.answer?.trim()) return finalize(parsed, engineName());
    } catch {
      /* handled below */
    }
    // The stream broke after part of the answer went out: keep what was said
    // rather than swap in a different reply mid-sentence.
    if (streamed.trim()) {
      return { answer: streamed.trim(), intent, answered: true, usedHits: [], engine: engineName() };
    }
    return synthesizeLocal(input);
  }

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
