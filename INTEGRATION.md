# Ovoz — Integration Guide

How to connect your systems to Ovoz. There are two integration surfaces, and you
can use either or both:

1. **REST API + webhooks** (`/v1`) — ask an agent, pull call data, push documents,
   and receive real-time events.
2. **Telephony (SIP)** — bring your own phone numbers (Asterisk / FreePBX) onto
   Ovoz's voice pipeline, so live calls are answered by the agent in Uzbek/Russian/
   English using Ovoz's self-hosted speech models.

---

## Authentication (REST)

Every `/v1` request is authenticated with a **bearer API key**. Create one in the
console under **Developers → API keys**. Keys look like `ovoz_sk_…`, are shown only
once, and carry a scope:

| Scope | Grants |
|-------|--------|
| `read` | `GET /v1/calls`, `POST /v1/answer` |
| `read,write` | the above + `POST /v1/documents` |
| `read,write,admin` | the above + future admin endpoints |

```http
Authorization: Bearer ovoz_sk_xxxxxxxxxxxxxxxx
```

- Missing / invalid / revoked key → **401**
- Valid key without the required scope → **403**

**Base URL** — your Ovoz deployment. On a self-hosted install the API is served at
`https://<your-ovoz-host>/api/v1/…`. (The console's code samples show the hosted
form `https://api.ovoz.ai/v1/…`; substitute your host.)

All errors share one envelope:

```json
{ "error": { "type": "unauthorized", "message": "…" } }
```

`400` bad request · `401` auth · `403` scope · `422` processing failure · `405` method.

---

## REST API

### `POST /v1/answer` — ask the agent  ·  scope `read`

Grounded answer with citations. Stateless — no call is recorded.

```json
// request
{ "question": "Kardiolog qabuli qancha turadi?", "language": "uz", "callId": null }
```
```json
// response
{
  "answer": "Kardiolog qabuli 180 000 so'm…",
  "confidence": 0.91,
  "answered": true,
  "escalate": null,
  "citations": [
    { "documentTitle": "Narxlar 2026.pdf", "heading": "Qabul narxlari", "score": 0.94 }
  ],
  "timings": { "retrievalMs": 12, "llmMs": 240, "totalMs": 268 }
}
```

`escalate` is `null`, `"explicit_request"` (caller asked for a human), or
`"low_confidence"` (below the agent's threshold). `language` is optional — omit it
and Ovoz auto-detects.

```bash
curl -X POST https://<host>/api/v1/answer \
  -H "Authorization: Bearer ovoz_sk_…" -H "Content-Type: application/json" \
  -d '{"question":"Ish vaqtingiz qanday?","language":"uz"}'
```

### `GET /v1/calls` — list calls  ·  scope `read`

```
GET /v1/calls?limit=50&outcome=escalated&from=2026-08-01
```
```json
{
  "data": [
    { "id": "call_…", "from": "+99890…", "outcome": "resolved_by_ai",
      "language": "uz", "turns": 4, "durationMs": 61200, "avgLatencyMs": 540, "csat": 5 }
  ],
  "hasMore": false
}
```

`limit` defaults to 50, capped at 200. `outcome` is an exact match
(`resolved_by_ai` · `resolved_by_operator` · `abandoned` · `voicemail`). `from` is an
ISO date filtering on `started_at >=`.

### `POST /v1/documents` — add knowledge  ·  scope `write`

Pushes a document into the knowledge base and indexes it synchronously.

```json
// request
{ "title": "August price list", "text": "Terapevt qabuli — 120 000 so'm…", "sourceType": "txt" }
```
```json
// response
{ "id": "doc_…", "chunks": 14, "status": "ready" }
```

Emits the `document.indexed` webhook.

---

## Webhooks

Register endpoints under **Developers → Webhooks** with a signing secret
(`whsec_…`). Ovoz `POST`s a signed JSON envelope for each subscribed event.

**Events:** `call.started` · `call.completed` · `call.escalated` · `document.indexed`

```json
// body
{ "id": "evt_…", "event": "call.completed", "createdAt": "2026-08-11T18:20:00Z",
  "data": { "callId": "call_…", "outcome": "resolved_by_ai",
            "durationMs": 61200, "avgLatencyMs": 540, "csat": 5 } }
```

**Verify every delivery.** Header `x-ovoz-signature: sha256=<hex>` is
`HMAC-SHA256(your whsec secret, raw request body)`:

```js
import crypto from 'node:crypto';
function verify(rawBody, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
```

Sign against the **raw** bytes (don't re-serialize the parsed JSON). Deliveries are
fire-and-forget with a ~5s timeout; respond `2xx` quickly and process async.

---

## Telephony (SIP) — bring your own numbers

Route real phone calls through Ovoz's self-hosted Uzbek STT/TTS + agent, from your
own Asterisk/FreePBX. Ovoz runs a lightweight **AudioSocket bridge**; your PBX
streams the call's audio to it and plays back the agent's reply.

1. In the console **Numbers**, add your DID as a `sip` number and link it to a live
   agent.
2. On your Asterisk/FreePBX, point that DID's **Inbound Route → Custom Destination**
   at an AudioSocket dialplan context that streams to the Ovoz bridge (`host:8090`).
3. The bridge handles endpointing (VAD) → STT → the agent turn → TTS, and streams
   the reply back down the same connection.

Requirements: **Asterisk 18+ / FreePBX 15+** with `app_audiosocket`; audio is
**8 kHz, 16-bit, mono PCM**. The full setup — dialplan snippet, module checks, the
ARI/`externalMedia` alternative, every env var, and current limitations — is in
[`telephony-bridge/README.md`](telephony-bridge/README.md).

```
Your PBX ──AudioSocket(TCP 8090)──▶ Ovoz bridge ──HTTPS──▶ Ovoz app
                                    (VAD)          STT → runTurn → TTS
```

---

## Notes

- **REST + webhooks are always on.** The telephony bridge activates when
  `BRIDGE_SHARED_SECRET` is set on the Ovoz app and the bridge process is running.
- **Data residency.** STT and TTS run on-premise. If a tenant requires all data to
  stay in-country, run the app with `LLM_PROVIDER=local` — the hosted LLMs (Gemini /
  Claude) are the only cross-border hop.
- **Idempotency & retries.** Treat `POST /v1/documents` as create-if-new by title on
  your side; webhook deliveries may retry, so make consumers idempotent on `event.id`.
