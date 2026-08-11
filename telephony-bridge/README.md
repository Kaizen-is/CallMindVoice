# Ovoz telephony bridge (Asterisk AudioSocket ⇄ Ovoz)

Bridges **live SIP phone calls** to Ovoz's self-hosted Uzbek STT/TTS and the
`runTurn` engine, replacing Twilio's built-in speech. A standalone Node service
speaks the Asterisk **AudioSocket** protocol, does the voice-activity detection
(VAD) that cuts caller audio into utterances, and calls two secret-authed
Next.js endpoints that own every credential.

```
 PSTN/SIP trunk
      │
      ▼
 ┌──────────────┐   AudioSocket (TCP, slin 8k)   ┌───────────────────┐
 │  Asterisk /  │ ────────────────────────────▶  │  bridge.mjs       │
 │  FreePBX     │ ◀────────────────────────────  │  (this service)   │
 └──────────────┘        reply audio             └───────┬───────────┘
                                                         │ HTTPS + x-bridge-secret
                                                         ▼
                                         ┌────────────────────────────────┐
                                         │  Next.js (Ovoz app)            │
                                         │  POST /api/telephony/bridge/turn│──▶ STT (10.10.50.4)
                                         │  POST /api/telephony/bridge/end │──▶ runTurn (LLM+RAG)
                                         │                                │──▶ TTS (10.10.50.4)
                                         └────────────────────────────────┘
```

The bridge holds **only** `NEXT_BASE_URL` + `BRIDGE_SHARED_SECRET` (+ VAD tuning
and the v1 number mapping). All STT/TTS URLs, JWT secrets, and the LLM engine
stay inside the Next.js app.

---

## 1. Requirements

| Component | Version | Notes |
|-----------|---------|-------|
| Asterisk  | **18+** | `app_audiosocket` + `res_audiosocket` (the `AudioSocket()` dialplan app). AudioSocket landed in Asterisk 16 but 18+ is the tested baseline. |
| FreePBX   | **15+** | For the GUI Inbound Route → Custom Destination wiring below. |
| Node.js   | **22+** | The bridge is ESM with **zero npm dependencies** — only Node built-ins (`net`, global `fetch`/`FormData`/`Blob`/`Buffer`). No build step, no `node_modules`. |

Check the AudioSocket modules are loaded on the Asterisk box:

```
asterisk -rx "module show like audiosocket"
# res_audiosocket.so    Asterisk AudioSocket support    Running
# app_audiosocket.so    AudioSocket Application          Running
```

If missing, load them (`module load res_audiosocket.so` / `app_audiosocket.so`)
or add to `/etc/asterisk/modules.conf`. For the **ARI/Stasis** alternative
(section 4) you also need `res_ari_applications` and `res_stasis`.

## 2. Audio format

AudioSocket audio frames are **signed linear PCM, 8 kHz, mono, 16-bit LE, 20 ms
(320-byte) frames** (Asterisk `slin` / `slin8`). The bridge produces and consumes
exactly this. The internal TTS returns 8 kHz WAV, which matches; the bridge still
parses the WAV `fmt ` chunk defensively and will down-mix/resample if a source
ever differs.

## 3. Dialplan: hand a call to AudioSocket (`extensions_custom.conf`)

Add a context that answers the call, mints a per-call UUID, and streams the
channel to the bridge. Put the bridge host/IP + port where the bridge runs
(default `8090`). Edit `/etc/asterisk/extensions_custom.conf`:

```asterisk
[ovoz-audiosocket]
; One leg per inbound call → the Ovoz bridge.
exten => _.,1,NoOp(Ovoz AudioSocket bridge for ${CALLERID(num)} → ${EXTEN})
 same => n,Answer()
 same => n,Set(AUDIOSOCKET_UUID=${SHELL(uuidgen | tr -d '\n')})
 ; slin is 8 kHz signed-linear; AudioSocket streams this natively.
 same => n,Set(CHANNEL(audioreadformat)=slin)
 same => n,Set(CHANNEL(audiowriteformat)=slin)
 ; AudioSocket(<uuid>,<bridge_host>:<port>)
 same => n,AudioSocket(${AUDIOSOCKET_UUID},BRIDGE_HOST:8090)
 same => n,Hangup()
```

Replace `BRIDGE_HOST` with the bridge's IP/hostname. Reload the dialplan:

```
asterisk -rx "dialplan reload"
```

> The UUID here is the Asterisk **channel** id (the `0x01` frame the bridge
> reads). It is **not** the Ovoz DB call id — the bridge gets that back from
> `/turn` in the `x-ovoz-callid` header and reuses it for the rest of the call.

## 4. (Alternative) ARI / Stasis external media

Instead of the dialplan app you can drive AudioSocket from an ARI app with
`externalMedia`, which is also where a production **UUID → DID/caller mapping**
belongs (see limitations):

```jsonc
// POST /ari/channels/externalMedia
{
  "app": "ovoz",
  "external_host": "BRIDGE_HOST:8090",
  "encapsulation": "audiosocket",
  "transport": "tcp",
  "format": "slin",
  "data": "<your-uuid>"      // correlate this UUID with the call's DID + caller id
}
```

Your ARI companion then knows, per `data`/UUID, the real dialed number and caller
id and can pass them to the bridge (future work — v1 uses the static env mapping).

## 5. Point an inbound DID at the context (FreePBX GUI)

1. **Admin → Custom Destinations → Add**
   - Target: `ovoz-audiosocket,s,1` (or `ovoz-audiosocket,${EXTEN},1` to keep the
     dialed number — the `_. ` pattern above matches either).
   - Description: `Ovoz AudioSocket`. Enable **Return: No**.
2. **Connectivity → Inbound Routes → (your DID)**
   - **Set Destination →** Custom Destinations → **Ovoz AudioSocket**.
   - Submit + **Apply Config**.

Now inbound calls on that DID are answered and streamed to the bridge.

## 6. Run the bridge

No install step — it has no dependencies:

```bash
cd telephony-bridge

BRIDGE_SHARED_SECRET='<same secret as the Next.js app>' \
NEXT_BASE_URL='https://ovoz.internal:3000' \
BRIDGE_TO_NUMBER='+998711234567' \
AUDIOSOCKET_PORT=8090 \
node bridge.mjs
# or: npm start
```

Syntax-check only (no Asterisk needed): `node --check bridge.mjs` (or `npm run check`).

Run it as a service (systemd, pm2, `screen`, …) next to Asterisk or on the same
private network as the Next.js app. Keep the bridge↔Next hop on a trusted network
(localhost/VPN); the shared secret is the only auth.

## 7. Environment variables

### Bridge process (this service)

The five the app owner adds to `.env.example` are the core set:

| Var | Default | Purpose |
|-----|---------|---------|
| `BRIDGE_SHARED_SECRET` | — (required) | Must equal the app's `BRIDGE_SHARED_SECRET`. Sent as `x-bridge-secret`. Empty ⇒ endpoints reject. |
| `AUDIOSOCKET_PORT` | `8090` | TCP port Asterisk connects to. |
| `NEXT_BASE_URL` | `http://localhost:3000` | Base URL of the Ovoz Next.js app. |
| `VAD_SILENCE_MS` | `700` | Trailing silence (ms) that ends an utterance. |
| `VAD_RMS_THRESHOLD` | `800` | 16-bit RMS energy above which a frame is "voiced". |

Additional bridge-only knobs (sensible defaults; override as needed):

| Var | Default | Purpose |
|-----|---------|---------|
| `BRIDGE_TO_NUMBER` | — | **v1 static mapping**: the dialed Ovoz DID (E.164) used to resolve number→agent→tenant. Must match an `active` row in `phone_numbers`. |
| `BRIDGE_FROM_NUMBER` | `anonymous` | Caller id passed as `from`. |
| `VAD_MAX_UTTERANCE_MS` | `15000` | Hard cap: force-endpoint a caller who never pauses. |
| `VAD_MIN_VOICED_MS` | `200` | Utterances with less voiced audio are discarded as noise. |
| `VAD_PREROLL_MS` | `160` | Audio kept before speech onset so word starts aren't clipped. |
| `BRIDGE_LOG` | off | `1`/`true` to log recognised text + agent replies. |

### Next.js app (already used by the speech routes — set on the app, not here)

- `BRIDGE_SHARED_SECRET` — same value as the bridge (this is the new one).
- `STT_TRANSCRIBE_URL` — internal Uzbek STT transcribe endpoint.
- `TTS_BASE_URL` + (`TTS_CLIENT_SECRET` **or** `TTS_JWT_TOKEN`) — internal TTS;
  optional `TTS_CLIENT_ID`, `TTS_VOICE_MALE`, `TTS_VOICE_FEMALE`.

## 8. How a call flows

1. Asterisk connects, sends `0x01` UUID. → bridge POSTs `/turn` with `first=true`
   (no audio); the app `startCall`s and returns the greeting WAV → bridge plays it.
2. Caller speaks. The bridge runs RMS VAD; on `VAD_SILENCE_MS` of trailing
   silence it assembles an 8 kHz mono WAV and POSTs `/turn` (`audio=…`).
   The app runs **STT → runTurn → TTS** and returns the reply WAV +
   `x-ovoz-callid` / `x-ovoz-escalate` / `x-ovoz-text`. → bridge plays it.
3. Repeat step 2 until hangup.
4. `0x00` terminate or socket close → bridge POSTs `/end { callId, durationSec }`
   → the app `endCall`s (closes the row, rolls up usage).

## 9. Known v1 limitations

- **No in-call SIP transfer on escalate.** When the engine escalates, the app
  returns the spoken handoff line and sets `x-ovoz-escalate`; the bridge plays it
  and hangs up. Actually bridging the caller to a human operator (ARI redirect /
  `Transfer`) is future work — the escalation is created in the DB regardless.
- **Energy-based VAD, no barge-in.** Endpointing is RMS + trailing-silence, tuned
  by `VAD_RMS_THRESHOLD` / `VAD_SILENCE_MS`. Noisy lines may need a higher
  threshold; clipped starts a longer preroll. Inbound audio is ignored while the
  agent is speaking (the caller can't interrupt the reply).
- **Static `to`/`from` ↔ UUID mapping.** v1 uses `BRIDGE_TO_NUMBER` /
  `BRIDGE_FROM_NUMBER` for the whole process, so it serves **one DID**. Multi-
  number setups need the ARI companion (section 4) to resolve the real DID +
  caller id per AudioSocket UUID and pass them per call.
- **One turn at a time per call.** STT+LLM+TTS+playback run sequentially; the
  bridge does not pipeline the next utterance until the current reply finishes.
```
