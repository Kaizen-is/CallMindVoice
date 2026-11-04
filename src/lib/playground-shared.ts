/**
 * What the console Playground's call and its side panels agree on. Kept free
 * of server-only imports so the browser half can use it too.
 */
import type { DemoEvent } from '@/lib/demo-shared';
import type { Locale } from '@/lib/types';

/**
 * What a Playground voice-call request streams, one JSON object per line: the
 * public demo's events (heard, reply, more, final, audio, filler, …) plus the
 * finished turn's numbers and sources for the side panels.
 */
export type CallEvent = DemoEvent | { t: 'detail'; detail: TurnDetail };

/** Read a streamed call response event by event, as the demo page does. */
export async function* readCallEvents(res: Response): AsyncGenerator<CallEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line) as CallEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** One voice turn's numbers and sources, for the "Last turn" / "Sources used" panels. */
export interface TurnDetail {
  language: Locale;
  intent: string;
  confidence: number;
  answered: boolean;
  escalate: string | null;
  summary?: string;
  timings: Record<string, number>;
  citations: Array<{ documentTitle: string; heading: string | null; snippet: string; score: number }>;
  retrieval: { strategy: string; totalChunks: number; hits: Array<Record<string, unknown>> };
  engine: string;
}

/** An agent as the Playground call needs it: who it is, and whom it calls (if anyone). */
export interface CallAgent {
  id: string;
  name: string;
  primaryLang: Locale;
  target: { fullName: string; birthYear: string } | null;
}
