# BRB speech API (TTS and STT)

Our own speech models — text-to-speech and speech-to-text — sit behind one BRB service,
the **"TTS/STT Proxy API"**. One account, one login, two endpoints. This page is what to
call, what comes back, and what we know (and do not know) about its limits.
Checked against the live service on 23 Nov 2026.

| | |
|---|---|
| Base URL | `https://tts-stt-proxy-test.brb.uz` (a test URL; no production URL announced yet) |
| Network | internal IP `172.22.202.1`, reachable only through the BRB GlobalProtect VPN |
| Swagger | `https://tts-stt-proxy-test.brb.uz/docs` (OpenAPI JSON: `/openapi.json`) |
| Auth | Bearer token from `POST /auth/login` |
| Account | `BRB_SPEECH_LOGIN` / `BRB_SPEECH_PASSWORD` in `.env` (role `user`), shared by TTS and STT |

## 1. Log in

```http
POST /auth/login
Content-Type: application/json

{"login": "<BRB_SPEECH_LOGIN>", "password": "<BRB_SPEECH_PASSWORD>"}
```

→ `200 {"access_token": "…", "refresh_token": "…", "token_type": "bearer"}`

- Both tokens are JWTs. **Access token: 60 minutes. Refresh token: 7 days.**
- Send the access token on every call: `Authorization: Bearer <access_token>`.
- Before it runs out (we renew 60 s early, from its `exp`), or after a `401`:

```http
POST /auth/refresh
Content-Type: application/json

{"refresh_token": "<refresh_token>"}
```

→ a new pair, same shape. If the refresh is refused, log in again.
- A wrong login or password is refused with `401`/`403`; a missing field with `422`.

## 2. Text to speech

```http
POST /tts/speech
Authorization: Bearer <access_token>
Content-Type: application/json

{"input": "Assalomu alaykum, sizga qanday yordam bera olaman?"}
```

→ `200`, `Content-Type: audio/wav`: the whole recording at once.

- Audio: **WAV, 24 kHz, mono, 16-bit PCM.** One voice; no voice, speed or language
  options. Uzbek (Latin) is what it is built for.
- No streaming: the answer arrives when the whole sentence is rendered (about 0.5 s
  for a short sentence). So send **one sentence per request** and play them in order.
- `input` must not be empty (`422`). The maximum length is not documented.
- The proxy **saves every input text** with the account that sent it (admins see them
  at `GET /tts/inputs`). Do not send anything that should not be stored.

## 3. Speech to text

```http
POST /stt/transcribe
Authorization: Bearer <access_token>
Content-Type: multipart/form-data; boundary=…

file = <the audio file>   (e.g. speech.wav, audio/wav)
```

→ `200 {"text": "Assalomu alaykum, kartamning balansini bilmoqchiman."}`

- One utterance per request, as a file. Tested with WAV at **8 kHz** (phone) and
  **16 kHz**, mono, 16-bit: identical results. Other formats are not documented.
- **No language field**: the model decides. Numbers come back as digits
  ("soat o'nda" → "soat 10:00da").
- Speed seen: about 0.2–0.4 s for a 2–5 second phrase.
- Empty text (`""`) means it heard nothing.
- The proxy **saves every request** (file name, type and the transcript) with the
  account (admins: `GET /stt/transcripts`).

## 4. Errors

| Status | Meaning | What to do |
|---|---|---|
| `401` | access token expired or revoked | refresh (or log in), then retry the call **once** |
| `422` | bad request (empty `input`, no `file`) | fix the request; do not retry |
| `429` | more than 20 requests to that endpoint in 60 s (section 6); `Retry-After` says how many seconds until it opens again | fall back to another engine; do not call again before `Retry-After` |
| `5xx` | the proxy or the model behind it failed | fall back to another engine |

`GET /health/` (alive) and `GET /health/ready` (`{"status":"ok","checks":{"database":"ok"}}`)
need no login.

## 5. Other endpoints (admin only — not for our account)

`POST /users` and `GET /users` (accounts, with each one's request count),
`GET /tts/inputs`, `GET /stt/transcripts`. Our account has the `user` role and can only
reach `/auth/*`, `/tts/speech` and `/stt/transcribe`.

## 6. Rate limits — measured, not published

The Swagger documents no limit, and accepted answers carry no rate-limit headers. So
we measured them on 23 Nov 2026 with a small test from one PC and our one account:

| | Limit | Window | Refused with |
|---|---|---|---|
| `POST /tts/speech` | **20 requests** | 60 s | `429 {"detail":"Too Many Requests"}` + `Retry-After: <seconds>` |
| `POST /stt/transcribe` | **20 requests** | 60 s | the same |

- **Separate counters**: while STT was refusing, TTS was still accepted.
- **The window starts at the first request**: 20 requests in 3.4 s were followed by
  `Retry-After: 56`, and after waiting that long requests went through again. Waiting
  less is refused again (10 s later: `Retry-After: 46`).
- Sent one at a time, request 21 is refused every time. Sent several at once (5–10 in
  parallel), about 50 STT requests got through before a refusal: the counter seems to
  miss requests that arrive together. Do not rely on that: plan for **20 per minute**.
- The admin user list counts requests per account, so the limit is most likely per
  account (it could also be per client address; we have only one of each to test).
  Everything that uses our account — every PC, the server, every call — shares it.
- No sign of an hourly or daily limit during the test (about 120 requests in 15 minutes).

**What that means for CallMind**

- One phone or Playground call with BRB TTS speaks a reply as 1–4 sentences, each a
  request unless cached. 20 per minute is enough for **about one live call at a time**;
  two busy calls will run into it.
- STT: one request per caller phrase, so again roughly one or two calls at once.
- Fixed lines (greeting, re-prompt, fillers) are cached on disk and cost one request
  ever; only new reply text counts.
- On a 429 our client raises `brb_limit` and the call falls back to another engine
  (Playground: the browser voice). It does not yet read `Retry-After`; skipping BRB for
  that many seconds would save pointless refused requests.

**Still to ask BRB:** whether 20 per minute is meant per account or per address,
whether a larger limit is possible for live calls, the largest `input` text and audio
file accepted, and whether there will be a production URL with other limits.

## 7. In CallMind

- Code: `backend/app/speech/brb.py` (`brb_speech` for TTS, `brb_transcribe` for STT,
  shared login and token renewal), used by `tts.py` (engine `brb`, "BRB TTS") and
  `stt.py` (engine `brb`, "BRB Whisper"). Tests: `backend/tests/test_brb_stt.py`.
- `.env`: `BRB_SPEECH_URL`, `BRB_SPEECH_LOGIN`, `BRB_SPEECH_PASSWORD`.
- Production: the server (`10.10.50.4`) cannot reach the proxy yet; it needs a firewall
  route to `172.22.202.1:443` (see `handoff.md`, section 6).

### Example (Python, httpx)

```python
import httpx

BASE = "https://tts-stt-proxy-test.brb.uz"

with httpx.Client(base_url=BASE, timeout=30) as http:
    tokens = http.post("/auth/login", json={"login": LOGIN, "password": PASSWORD}).json()
    auth = {"Authorization": f"Bearer {tokens['access_token']}"}

    wav = http.post("/tts/speech", headers=auth, json={"input": "Rahmat."}).content
    text = http.post("/stt/transcribe", headers=auth, files={"file": ("speech.wav", wav, "audio/wav")}).json()["text"]
```
