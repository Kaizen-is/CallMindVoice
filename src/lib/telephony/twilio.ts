/**
 * Twilio Elastic SIP Trunking adapter — the production voice path.
 *
 * Wired end-to-end but inert until TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are
 * set: `isConfigured()` gates every call site, and the simulator stands in
 * otherwise. The webhook route validates Twilio's signature before doing
 * anything with a request, so exposing it publicly is safe from day one.
 *
 * Media handling: Twilio <Connect><Stream> opens a bidirectional WebSocket
 * carrying 8 kHz µ-law frames. `mediaStreamTwiml()` emits that TwiML; the
 * socket handler belongs in a long-lived Node process rather than a serverless
 * route, which is why it is deliberately not started from Next.js here.
 */
import 'server-only';
import crypto from 'node:crypto';

export function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

export function accountSid() {
  return process.env.TWILIO_ACCOUNT_SID ?? '';
}

function authHeader() {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
  const token = process.env.TWILIO_AUTH_TOKEN ?? '';
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

/**
 * Twilio signs each webhook with HMAC-SHA1 over the full URL plus the
 * alphabetically-sorted POST body. Reject anything that does not match.
 */
export function verifySignature(url: string, params: Record<string, string>, signature: string) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const payload =
    url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Open a bidirectional media stream into our voice engine. */
export function mediaStreamTwiml(wsUrl: string, callId: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="callId" value="${escapeXml(callId)}"/>
    </Stream>
  </Connect>
</Response>`;
}

/** Fallback for deployments without a websocket tier: classic gather loop. */
export function gatherTwiml(prompt: string, actionUrl: string, language = 'ru-RU') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" language="${escapeXml(language)}">
    <Say language="${escapeXml(language)}">${escapeXml(prompt)}</Say>
  </Gather>
  <Redirect method="POST">${escapeXml(actionUrl)}</Redirect>
</Response>`;
}

/** Warm transfer to an operator, with the AI summary passed as a SIP header. */
export function transferTwiml(operatorNumber: string, whisper: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(whisper)}</Say>
  <Dial answerOnBridge="true" timeout="30">
    <Number>${escapeXml(operatorNumber)}</Number>
  </Dial>
</Response>`;
}

export function hangupTwiml(farewell: string, language = 'ru-RU') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${escapeXml(language)}">${escapeXml(farewell)}</Say>
  <Hangup/>
</Response>`;
}

/* ── REST helpers (used by number provisioning and outbound dialling) ── */

async function api(path: string, init?: RequestInit) {
  if (!isConfigured()) throw new Error('Twilio is not configured');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid()}${path}`, {
    ...init,
    headers: {
      authorization: authHeader(),
      'content-type': 'application/x-www-form-urlencoded',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function listIncomingNumbers() {
  const json = (await api('/IncomingPhoneNumbers.json?PageSize=50')) as {
    incoming_phone_numbers: Array<{ sid: string; phone_number: string; friendly_name: string }>;
  };
  return json.incoming_phone_numbers.map((n) => ({
    sid: n.sid,
    e164: n.phone_number,
    label: n.friendly_name,
  }));
}

export async function placeOutboundCall(params: { to: string; from: string; webhookUrl: string }) {
  const body = new URLSearchParams({ To: params.to, From: params.from, Url: params.webhookUrl });
  return api('/Calls.json', { method: 'POST', body });
}

export function status() {
  return {
    configured: isConfigured(),
    accountSid: isConfigured() ? `${accountSid().slice(0, 10)}…` : null,
    webhookBase: process.env.TWILIO_WEBHOOK_BASE_URL ?? null,
    mode: isConfigured() ? ('twilio' as const) : ('simulator' as const),
  };
}
