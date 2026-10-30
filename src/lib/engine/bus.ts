/**
 * In-process pub/sub for live console updates, surfaced to browsers over SSE.
 *
 * A single-node broker is the right size for this: it keeps the live wallboard
 * and the operator inbox instant with no extra infrastructure. Swapping in
 * Redis pub/sub for multi-node deployment means reimplementing `publish` and
 * `subscribe` only — nothing else in the codebase touches the transport.
 */
import type { Locale } from '@/lib/types';

export type BusEvent =
  | { type: 'call_started'; callId: string; from: string; to: string; language: Locale }
  | { type: 'call_ringing'; callId: string; from: string }
  | { type: 'turn'; callId: string; utterance: string; reply: string; confidence: number; escalated: boolean; latencyMs: number }
  | { type: 'escalation'; callId: string; escalationId: string; reason: string; priority: string }
  | { type: 'escalation_assigned'; escalationId: string; callId: string; operatorId: string }
  | { type: 'escalation_resolved'; escalationId: string; callId: string }
  | { type: 'call_ended'; callId: string; outcome: string; durationMs: number; csat: number | null }
  | { type: 'document_indexed'; documentId: string; title: string; chunks: number }
  | { type: 'heartbeat'; at: string };

type Listener = (event: BusEvent) => void;

// Module state survives hot reloads via globalThis, otherwise every edit in dev
// silently orphans the open SSE connections.
const listeners: Map<string, Set<Listener>> = (globalThis as Record<string, unknown>).__ovozBus
  ? ((globalThis as Record<string, unknown>).__ovozBus as Map<string, Set<Listener>>)
  : new Map();
(globalThis as Record<string, unknown>).__ovozBus = listeners;

export function publish(tenantId: string, event: BusEvent) {
  const set = listeners.get(tenantId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* a broken listener must not take down the publisher */
    }
  }
}

export function subscribe(tenantId: string, fn: Listener): () => void {
  let set = listeners.get(tenantId);
  if (!set) {
    set = new Set();
    listeners.set(tenantId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(tenantId);
  };
}

export function subscriberCount(tenantId: string) {
  return listeners.get(tenantId)?.size ?? 0;
}
