import { get } from '@/lib/db';
import { liveAgent, startCall } from '@/lib/engine/calls';
import { runTurn } from '@/lib/engine/conversation';
import * as twilio from '@/lib/telephony/twilio';
import type { Agent, PhoneNumber } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SPEECH_LOCALE: Record<string, string> = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-GB' };

/**
 * Twilio inbound-voice webhook.
 *
 * Live only when TWILIO_AUTH_TOKEN is configured — every request is signature
 * verified first, so this endpoint is safe to expose before credentials exist.
 * Uses the <Gather input="speech"> loop, which works on any Twilio account
 * without a websocket tier; swap in `mediaStreamTwiml` for the streaming path.
 */
export async function POST(request: Request) {
  if (!twilio.isConfigured()) {
    return new Response('Twilio is not configured on this deployment.', { status: 503 });
  }

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const signature = request.headers.get('x-twilio-signature') ?? '';
  const base = process.env.TWILIO_WEBHOOK_BASE_URL ?? new URL(request.url).origin;
  const url = `${base}/api/telephony/twilio/voice`;

  if (!twilio.verifySignature(url, params, signature)) {
    return new Response('Invalid signature', { status: 403 });
  }

  const to = params.To ?? '';
  const from = params.From ?? '';
  const speech = params.SpeechResult ?? '';

  const number = get<PhoneNumber>(
    `SELECT * FROM phone_numbers WHERE e164=? AND status='active' LIMIT 1`,
    to,
  );
  if (!number) {
    return xml(twilio.hangupTwiml('This number is not configured. Goodbye.', 'en-GB'));
  }

  const agent =
    get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', number.agent_id, number.tenant_id) ??
    liveAgent(number.tenant_id);
  if (!agent || agent.status !== 'live') {
    return xml(twilio.hangupTwiml('The assistant is not available right now. Goodbye.', 'en-GB'));
  }

  const locale = SPEECH_LOCALE[agent.primary_lang] ?? 'ru-RU';
  const existingCallId = params.callId ?? new URL(request.url).searchParams.get('callId');

  // First leg: greet and open the speech gather.
  if (!speech) {
    const callId = startCall({
      tenantId: number.tenant_id,
      agentId: agent.id,
      numberId: number.id,
      from,
      to,
      language: agent.primary_lang,
      channel: 'voice',
    });
    return xml(twilio.gatherTwiml(agent.greeting, `${url}?callId=${callId}`, locale));
  }

  if (!existingCallId) {
    return xml(twilio.gatherTwiml(agent.greeting, url, locale));
  }

  const result = await runTurn({
    tenantId: number.tenant_id,
    callId: existingCallId,
    agent,
    utterance: speech,
    sttMs: 0,
  });

  if (result.escalate) {
    const policy = JSON.parse(agent.escalation_json || '{}') as { fallbackNumber?: string };
    if (policy.fallbackNumber) {
      return xml(twilio.transferTwiml(policy.fallbackNumber, result.reply));
    }
    return xml(twilio.hangupTwiml(result.reply, locale));
  }

  return xml(
    twilio.gatherTwiml(result.reply, `${url}?callId=${existingCallId}`, SPEECH_LOCALE[result.language] ?? locale),
  );
}

function xml(body: string) {
  return new Response(body, {
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}
