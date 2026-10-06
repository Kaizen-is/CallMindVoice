/**
 * What the public demo's server and browser halves agree on. Kept free of
 * server-only imports so the page can use it too.
 */
import type { Locale } from '@/lib/types';

export type DemoLang = 'uz' | 'ru';

export function demoLang(value: unknown): DemoLang {
  return value === 'ru' ? 'ru' : 'uz';
}

/**
 * Each demo request answers with newline-delimited JSON events, so one round
 * trip carries everything a turn produces as soon as it exists: what the STT
 * heard, the reply text, then the reply's voice one sentence at a time.
 */
export type DemoEvent =
  | { t: 'call'; callId: string }
  | { t: 'heard'; text: string }
  | { t: 'reply'; text: string; lang: Locale; end: 'transfer' | null; ms?: Record<string, number> }
  /** 8 kHz mono 16-bit PCM, base64. */
  | { t: 'audio'; pcm: string }
  /** A pre-rendered "one moment" to fill the silence while the agent thinks. Same format. */
  | { t: 'filler'; pcm: string }
  /** No voice could be rendered: the browser should speak the line itself. */
  | { t: 'voice'; ok: false }
  | { t: 'error'; code: string }
  | { t: 'done' };
