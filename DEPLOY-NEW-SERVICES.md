# New services and keys — for deployment

This release adds optional speech and AI engines to the Playground. **Every key below is optional**: with none of them set, the app behaves exactly as before (your own STT/TTS models and current AI engine). Each one only switches on the feature it belongs to.

## 1. Keys only (add to the Kubernetes secret, restart the app)

| Variable | Turns on | Notes |
|---|---|---|
| `GAPIAPI` | **GAPI** speech-to-text (console.gapi.uz) | Optional: `GAPI_BASE_URL` (default `https://console.gapi.uz`) |
| `SPEKO_API_KEY` | **ElevenLabs** voices (Nadya, Miron) and **gemini-3.5** STT via Speko | Optional: `SPEKO_BASE_URL` (default `https://router.speko.dev/v1`), `SPEKO_TTS_VOICE` |
| `OPENAI_API_KEY` | **OpenAI** as an answer engine | See the warnings below |
| `OPENAI_MODEL` | Which OpenAI model answers | Recommended `gpt-5.5` (best Uzbek); `gpt-4.1` is faster |

The app pod needs **outbound HTTPS** to `console.gapi.uz`, `router.speko.dev`, `api.speko.dev` and `api.openai.com`.

**OpenAI warnings**

- OpenAI is the **last** choice in automatic engine selection: if Gemini, Claude or Ollama is already configured, that one keeps answering. To make OpenAI answer, also set `LLM_PROVIDER=openai`.
- `OPENAI_API_KEY` **also switches knowledge-base search to OpenAI embeddings**. Documents indexed before the switch keep keyword search but lose meaning-based search until they are re-uploaded (re-indexed). Re-upload the knowledge base after enabling it, or plan the switch for a quiet moment.

## 2. Zipformer streaming STT — nothing to deploy

Zipformer is an Uzbek speech model that now runs **inside the app itself**. There is no extra service, port, WebSocket, nginx rule or variable.

- The model files ship in the repo: `models/uzbek-zipformer/` (~71 MB, from <https://huggingface.co/Bahrom1996/uzbek-streaming-stt-punct>, licence Apache-2.0). The image must include this folder; a normal `COPY . .` does.
- The library is `sherpa-onnx-node` (a normal npm dependency, installed by `npm ci`). Its prebuilt binary needs a **Debian/Ubuntu-based Node image** (e.g. `node:22-bookworm-slim`), **not Alpine**. On Alpine the Zipformer button stays disabled; nothing else breaks.
- It uses the CPU: ~2 threads while someone is talking, ~300 MB more RAM once loaded (on first use). Optional: `ZIPFORMER_THREADS` (default 2), `ZIPFORMER_MODEL_DIR` (default `models/uzbek-zipformer`).
- If the app runs from a Next.js `standalone` build, copy `models/` next to it as well.

**Check it**: in the Playground, the STT switch shows **Zipformer** enabled; while talking, words appear as you speak.

## 2b. gemini-3.5 STT

Google Gemini Transcribe through Speko. It uses the same `SPEKO_API_KEY` as the ElevenLabs voices; no new key. Accurate on Uzbek, but ~5 s per phrase.

## 3. Not for production

`NODE_EXTRA_CA_CERTS` and `--experimental-sqlite` are only for the local Windows setup (company firewall certificate, Node 22.11). Do not copy them to the cluster.
