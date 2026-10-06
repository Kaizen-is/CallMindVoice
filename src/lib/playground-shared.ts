/**
 * What the console Playground's call and its side panels agree on. Kept free
 * of server-only imports so the browser half can use it too.
 */
import type { Locale } from '@/lib/types';

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
