# New services and keys — for deployment

This release adds optional speech and AI engines to the Playground. **Every key below is optional**: with none of them set, the app behaves exactly as before (your own STT/TTS models and current AI engine). Each one only switches on the feature it belongs to.

## 1. Keys only (add to the Kubernetes secret, restart the app)

| Variable | Turns on | Notes |
|---|---|---|
| `GAPIAPI` | **GAPI** speech-to-text (console.gapi.uz) | Optional: `GAPI_BASE_URL` (default `https://console.gapi.uz`) |
| `SPEKO_API_KEY` | **ElevenLabs** voices (Nadya, Miron) via Speko | Optional: `SPEKO_BASE_URL` (default `https://router.speko.dev/v1`), `SPEKO_TTS_VOICE` |
| `OPENAI_API_KEY` | **OpenAI** as an answer engine | See the warnings below |
| `OPENAI_MODEL` | Which OpenAI model answers | Recommended `gpt-5.5` (best Uzbek); `gpt-4.1` is faster |

The app pod needs **outbound HTTPS** to `console.gapi.uz`, `router.speko.dev`, `api.speko.dev` and `api.openai.com`.

**OpenAI warnings**

- OpenAI is the **last** choice in automatic engine selection: if Gemini, Claude or Ollama is already configured, that one keeps answering. To make OpenAI answer, also set `LLM_PROVIDER=openai`.
- `OPENAI_API_KEY` **also switches knowledge-base search to OpenAI embeddings**. Documents indexed before the switch keep keyword search but lose meaning-based search until they are re-uploaded (re-indexed). Re-upload the knowledge base after enabling it, or plan the switch for a quiet moment.

## 2. Zipformer streaming STT — a separate small service

Zipformer is **not** a key: it is a model that runs in its own process, `stt-stream/` in this repo (Node 22 + sherpa-onnx, CPU only). The browser streams the microphone to it over a WebSocket while the caller speaks, so the words are ready the moment they stop.

```
Browser (Playground) ──wss──▶ stt-stream :8095  /stream      live words while speaking
Next.js app ─────────http──▶ stt-stream :8095  /transcribe  one-shot fallback
```

**What is needed**

1. **Model files** (~70 MB, not in git — they are a gated download from
   <https://huggingface.co/Bahrom1996/uzbek-streaming-stt-punct>, licence Apache-2.0):
   `encoder-…int8.onnx`, `decoder-…int8.onnx`, `joiner-…int8.onnx`, `tokens.txt`.
   Put them in the image or on a volume.
2. **A container** for `stt-stream/`: `npm ci` in that folder, start with `node server.mjs`.
   About 1–2 CPU cores and ~300 MB RAM; the model loads in ~5 s.
3. **Its environment**

   | Variable | Value |
   |---|---|
   | `STT_STREAM_MODEL_DIR` | folder with the model files |
   | `STT_STREAM_HOST` | `0.0.0.0` (inside Kubernetes) |
   | `STT_STREAM_PORT` | `8095` |
   | `STT_STREAM_ORIGINS` | `https://callmind.brb-tech.uz` (who may open the WebSocket) |
   | `STT_STREAM_THREADS` | `2` |

4. **A Kubernetes Service** in front of it (e.g. `stt-stream:8095`).
5. **A public WebSocket path** for the browser, through the existing ingress/nginx — for example `wss://callmind.brb-tech.uz/stt-stream/stream` → `stt-stream:8095/stream`, with WebSocket upgrade enabled:

   ```nginx
   location /stt-stream/ {
     proxy_pass http://stt-stream:8095/;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_read_timeout 3600s;
   }
   ```

6. **Two variables on the app**

   | Variable | Value |
   |---|---|
   | `STT_STREAM_URL` | internal: `http://stt-stream:8095` |
   | `STT_STREAM_PUBLIC_URL` | public: `https://callmind.brb-tech.uz/stt-stream` (the app turns it into `wss://…/stream`) |

**Check it**: `curl http://stt-stream:8095/health` → `{"ok":true,"model":"…"}`. In the Playground, the STT switch shows **Zipformer** enabled; while talking, words appear as you speak.

If the service is down, the Playground falls back to sending the audio for a one-shot transcription; nothing else in the app depends on it.

## 3. Not for production

`NODE_EXTRA_CA_CERTS` and `--experimental-sqlite` are only for the local Windows setup (company firewall certificate, Node 22.11). Do not copy them to the cluster.
