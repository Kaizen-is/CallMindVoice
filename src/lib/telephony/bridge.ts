/**
 * Shared gate for the AudioSocket bridge endpoints.
 *
 * Every `/api/telephony/bridge/*` route needs the same two things before it can
 * do anything: prove the caller is our own bridge process, and turn the dialled
 * DID into a tenant + live agent. Both were copy-pasted per route; they live
 * here now so the auth semantics cannot drift between endpoints.
 *
 * Gating style mirrors `api/telephony/twilio/voice`: env unset ⇒ 503 (the
 * feature is not provisioned), header mismatch ⇒ 401.
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { get } from '@/lib/db';
import { liveAgent } from '@/lib/engine/calls';
import type { Agent, Locale, PhoneNumber } from '@/lib/types';

/** `null` means authorised; otherwise the Response to return immediately. */
export function authorizeBridge(request: Request): Response | null {
  const secret = process.env.BRIDGE_SHARED_SECRET;
  if (!secret) return Response.json({ error: 'bridge_not_configured' }, { status: 503 });

  const provided = Buffer.from(request.headers.get('x-bridge-secret') ?? '');
  const expected = Buffer.from(secret);
  // Length check first: timingSafeEqual throws on unequal-length buffers.
  const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
  return ok ? null : Response.json({ error: 'unauthorized' }, { status: 401 });
}

export interface BridgeTarget {
  number: PhoneNumber;
  agent: Agent;
  language: Locale;
}

/** Resolve the dialled DID to its tenant's live agent, or an error Response. */
export function resolveTarget(to: string): BridgeTarget | Response {
  const number = get<PhoneNumber>(
    `SELECT * FROM phone_numbers WHERE e164=? AND status='active' LIMIT 1`,
    to,
  );
  if (!number) return Response.json({ error: 'number_not_configured', to }, { status: 404 });

  const agent =
    get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', number.agent_id, number.tenant_id) ??
    liveAgent(number.tenant_id);
  if (!agent || agent.status !== 'live') {
    return Response.json({ error: 'agent_unavailable' }, { status: 409 });
  }

  return { number, agent, language: (agent.primary_lang ?? 'uz') as Locale };
}

export const isResponse = (v: unknown): v is Response => v instanceof Response;
