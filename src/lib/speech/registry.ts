/**
 * The engine registry — one list of every STT, TTS and LLM engine CallMind can
 * use, with what each one is and what it costs.
 *
 * Pure data: nothing here calls an engine or reads a key, so any module can
 * import it. Whether an engine is configured on this server is worked out by
 * the model lab (`@/lib/lab`), which knows each engine's setup.
 *
 * `pricePerMin` is USD per minute of audio (heard for STT, spoken for TTS).
 * `null` on an engine that runs on our own server (`runs: 'server'`) means it
 * has no per-minute price; elsewhere it means "not known yet" (a dash).
 *
 * Sources, read 2026-11-06:
 *   • GAPI: 35 so‘m a minute (gapi.uz) at the CBU rate of 11 973.48 so‘m/$.
 *   • gemini-3.5 (via Speko): Google's estimate, ~$0.005 a minute.
 *   • ElevenLabs Scribe (via Speko): Speko routes it as scribe_v2_realtime,
 *     ElevenLabs' list price $0.39 an hour → $0.0065 a minute (batch Scribe v2
 *     is $0.22 an hour; Speko's bill shows which one it charges).
 *   • Gemini direct (Flash-Lite, audio in): 25 audio tokens a second at
 *     $0.30/M in, ~175 text tokens a minute at $2.50/M out ≈ $0.0009 a minute.
 *   • ElevenLabs (via Speko): $50 / $40 per million characters
 *     (eleven_v3_conversational / eleven_v4_turbo), ~900 characters a minute
 *     → $0.045 / $0.036. Speko's router adds 5% on top.
 *   • Zipformer runs inside the app: $0.
 *   • BRB TTS is our own model behind the BRB speech proxy (VPN): no per-minute
 *     price, but the account has a request limit.
 */
import type { Locale } from '@/lib/types';

export type EngineKind = 'stt' | 'tts' | 'llm';

export interface EngineInfo {
  kind: EngineKind;
  /** The id the code uses (and what the usage log records). */
  id: string;
  name: string;
  vendor: string;
  /** `app` = inside CallMind, `server` = our own server, `cloud` = an outside API. */
  runs: 'app' | 'server' | 'cloud';
  /** Reached through a router, e.g. Speko. */
  via?: string;
  /** STT: words while the caller speaks. TTS/LLM: output streams as it is made. */
  live: boolean;
  languages: Locale[];
  pricePerMin: number | null;
  /** What has to be set for the engine to work. */
  setup: string;
}

export const ENGINES: readonly EngineInfo[] = [
  /* ── speech to text ── */
  { kind: 'stt', id: 'kotib', name: 'Own STT', vendor: 'CallMind', runs: 'server', live: false, languages: ['uz'], pricePerMin: null, setup: 'STT_TRANSCRIBE_URL' },
  { kind: 'stt', id: 'gapi', name: 'GAPI', vendor: 'GAPI (gapi.uz)', runs: 'cloud', live: false, languages: ['uz'], pricePerMin: 0.0029, setup: 'GAPIAPI' },
  { kind: 'stt', id: 'local', name: 'Zipformer', vendor: 'Open model (sherpa-onnx)', runs: 'app', live: true, languages: ['uz'], pricePerMin: 0, setup: 'models/uzbek-zipformer' },
  { kind: 'stt', id: 'speko', name: 'gemini-3.5', vendor: 'Google', via: 'Speko', runs: 'cloud', live: false, languages: ['uz', 'ru', 'en'], pricePerMin: 0.005, setup: 'SPEKO_API_KEY' },
  { kind: 'stt', id: 'scribe', name: 'ElevenLabs Scribe', vendor: 'ElevenLabs', via: 'Speko', runs: 'cloud', live: false, languages: ['uz', 'ru', 'en'], pricePerMin: 0.0065, setup: 'SPEKO_API_KEY' },
  { kind: 'stt', id: 'gemini', name: 'Gemini Flash-Lite', vendor: 'Google', runs: 'cloud', live: false, languages: ['uz', 'ru', 'en'], pricePerMin: 0.0009, setup: 'GEMINI_API_KEY' },
  { kind: 'stt', id: 'brb', name: 'BRB Whisper', vendor: 'BRB (own model)', runs: 'server', live: false, languages: ['uz', 'ru', 'en'], pricePerMin: null, setup: 'BRB_STT_URL' },

  /* ── text to speech ── */
  { kind: 'tts', id: 'default', name: 'Own TTS', vendor: 'CallMind', runs: 'server', live: true, languages: ['uz'], pricePerMin: null, setup: 'TTS_BASE_URL' },
  { kind: 'tts', id: 'brb', name: 'BRB TTS', vendor: 'BRB (own model)', runs: 'server', live: false, languages: ['uz'], pricePerMin: null, setup: 'BRB_SPEECH_LOGIN' },
  { kind: 'tts', id: 'eleven_v3_conversational', name: 'ElevenLabs v3', vendor: 'ElevenLabs', via: 'Speko', runs: 'cloud', live: true, languages: ['uz', 'ru', 'en'], pricePerMin: 0.045, setup: 'SPEKO_API_KEY' },
  { kind: 'tts', id: 'eleven_v4_turbo', name: 'ElevenLabs v4 Turbo', vendor: 'ElevenLabs', via: 'Speko', runs: 'cloud', live: true, languages: ['uz', 'ru', 'en'], pricePerMin: 0.036, setup: 'SPEKO_API_KEY' },
];

/* ── language models ─────────────────────────────────────────── */

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

/**
 * A language model an agent can answer with. `id` is `provider:model` — what
 * an agent's `llm_model` and the tenant's default store, and what the usage
 * log records. Prices are USD per million tokens from each provider's price
 * page (read 2026-11-05); `null` = not billed per token (our own server).
 */
export interface LlmModelInfo {
  id: string;
  provider: LlmProvider;
  model: string;
  name: string;
  vendor: string;
  runs: 'server' | 'cloud';
  /** Writes the answer as it goes, so the voice starts on the first words. */
  streams: boolean;
  priceIn: number | null;
  priceOut: number | null;
  setup: string;
}

const llm = (
  provider: LlmProvider,
  model: string,
  name: string,
  priceIn: number | null,
  priceOut: number | null,
): LlmModelInfo => ({
  id: `${provider}:${model}`,
  provider,
  model,
  name,
  vendor: { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google', ollama: 'Self-hosted' }[provider],
  runs: provider === 'ollama' ? 'server' : 'cloud',
  // Every hosted provider streams its answer to a caller that voices it as it comes.
  streams: true,
  priceIn,
  priceOut,
  setup: { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', ollama: 'OLLAMA_BASE_URL' }[provider],
});

export const LLM_MODELS: readonly LlmModelInfo[] = [
  llm('openai', 'gpt-5.5', 'GPT-5.5', 5, 30),
  llm('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', 2, 10),
  llm('openai', 'gpt-6.1-terra', 'GPT-6.1 Terra', 1, 5),
  llm('openai', 'gpt-6-luna', 'GPT-6 Luna', 0.1, 0.5),
  llm('openai', 'gpt-5.4-mini', 'GPT-5.4 mini', 0.75, 4.5),
  llm('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 0.4, 1.6),
  llm('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 4, 20),
  llm('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 10),
  llm('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.5),
  // Gemini 3.8 Flash doubles to $1.50 / $7.50 on 2027-01-01.
  llm('gemini', 'gemini-3.8-flash', 'Gemini 3.8 Flash', 0.75, 3.75),
  llm('gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 0.3, 2.5),
  llm('gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 0.25, 1.5),
  llm('ollama', 'gemma4:31b', 'Gemma 4 31B', null, null),
];

export function llmModelInfo(id: string | null | undefined): LlmModelInfo | undefined {
  return id ? LLM_MODELS.find((m) => m.id === id) : undefined;
}

/** USD for one answer, or null when the model's price is not known. */
export function llmCost(id: string | null | undefined, tokensIn?: number | null, tokensOut?: number | null): number | null {
  const m = llmModelInfo(id);
  if (!m || m.priceIn == null || m.priceOut == null || tokensIn == null || tokensOut == null) return null;
  return (m.priceIn * tokensIn + m.priceOut * tokensOut) / 1e6;
}

export function engineInfo(kind: EngineKind, id: string): EngineInfo | undefined {
  return ENGINES.find((e) => e.kind === kind && e.id === id);
}

/** Display name for an engine id, falling back to the id itself. */
export function engineDisplayName(kind: EngineKind, id: string): string {
  return engineInfo(kind, id)?.name ?? id;
}

/** USD for `audioMs` of audio on this engine, or null when its price is not known. */
export function audioCost(kind: EngineKind, id: string, audioMs: number | null | undefined): number | null {
  const price = engineInfo(kind, id)?.pricePerMin;
  if (price == null || audioMs == null) return null;
  return (price * audioMs) / 60000;
}
