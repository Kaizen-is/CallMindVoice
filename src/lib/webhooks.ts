/**
 * Outbound webhook delivery.
 *
 * When something happens on a tenant (a call starts, completes or escalates, a
 * document finishes indexing) we notify every webhook that tenant has
 * subscribed to that event. Delivery is fire-and-forget: a slow or dead
 * customer endpoint must never delay — let alone break — the call path or an
 * API response, so every failure is swallowed and every request is time-boxed.
 *
 * Each POST carries `x-ovoz-signature: sha256=<hex>`, an HMAC-SHA256 of the
 * exact raw request body keyed with the webhook's own `whsec_` secret. The
 * receiver recomputes the same HMAC to prove the payload came from us and was
 * not tampered with in transit.
 */
import 'server-only';
import crypto from 'node:crypto';
import { all, id, now } from './db';

/** Events a webhook row can subscribe to (stored comma-separated in `events`). */
export type WebhookEvent =
  | 'call.started'
  | 'call.completed'
  | 'call.escalated'
  | 'escalation.resolved'
  | 'document.indexed';

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string;
}

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Notify every active webhook subscribed to `event` for this tenant.
 *
 * Fire-and-forget by contract — callers use `void dispatchWebhook(...)`. Never
 * throws; a missing DB, a bad URL or a timeout all resolve quietly.
 */
export async function dispatchWebhook(
  tenantId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  let rows: WebhookRow[];
  try {
    rows = all<WebhookRow>(
      `SELECT id, url, events, secret FROM webhooks WHERE tenant_id=? AND status='active'`,
      tenantId,
    );
  } catch {
    return;
  }

  const subscribed = rows.filter((r) =>
    r.events
      .split(',')
      .map((e) => e.trim())
      .includes(event),
  );
  if (!subscribed.length) return;

  // One canonical body for all subscribers of this event; each is signed with
  // its own secret. Signing the exact bytes we send is what makes the signature
  // verifiable on the other end.
  const body = JSON.stringify({
    id: id('evt'),
    event,
    createdAt: now(),
    data: payload,
  });

  await Promise.all(subscribed.map((hook) => deliver(hook, body)));
}

async function deliver(hook: WebhookRow, body: string): Promise<void> {
  try {
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ovoz-signature': `sha256=${signature}`,
        'user-agent': 'Ovoz-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch {
    // Fire-and-forget: retries/backoff are out of scope, and a failed delivery
    // must not surface to the caller that triggered the event.
  }
}
