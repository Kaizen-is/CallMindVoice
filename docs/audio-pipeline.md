# Audio pipeline, turn gating and the Audio Processing Lab

What happens to a caller's voice between the microphone (or phone line) and the
speech recogniser, what was wrong with it, what changed on 25 Nov 2026, and
what is still open. Read with `docs/brb-speech-api.md` (the STT/TTS services).

## 1. The audio paths (as found in the code)

| Path | Capture | Format to the server | VAD / endpointing | Where STT runs |
|---|---|---|---|---|
| Playground call, bank demo, logistics demo (hands-free) | `use-voice-session.ts`: one `getUserMedia` stream with browser AEC + NS + AGC; a `MediaRecorder` per utterance | `src/lib/audio.ts`: WebM/Opus → decoded, **75 Hz high-pass + resample to 16 kHz mono** (OfflineAudioContext), peak gain up to 8×, silence trimmed (150 ms padding), WAV | Browser, energy: noise floor over 300 ms, speech ≥ 3× floor for 250 ms, end after 800 ms quiet, an early "speculative" upload after 350 ms, max 30 s | Server: `playground_voice.heard_in` / `demo.heard_in` → `stt.transcribe(clean=True)` (CleanVoice if `DENOISE_URL`, then the engine) |
| Playground with a streaming model (Zipformer, live Scribe/Gemini) | as above **plus a second mic stream** (`use-live-transcript.ts`) streamed to `/api/speech/live` | text when the stream has it, else the WAV | same browser VAD decides when the phrase ends | streaming sidecar; WAV fallback |
| Push-to-talk (STT page "Yozib olish", Playground text-mode mic) | `startRecording()` with AEC **off**, NS **off**, AGC on | same `audio.ts` 16 kHz WAV | none (button) | `/api/speech/stt` or `/api/models/stt` |
| STT page uploads | file → browser decode → 16 kHz WAV (no filter, no gain) | WAV | none | `/api/speech/stt` |
| Phone (Asterisk AudioSocket) | `telephony-bridge/bridge.py` (prod still runs `bridge.mjs`): 8 kHz 16-bit mono, 20 ms frames, inbound only (the media path already separates caller and agent audio) | 8 kHz WAV of the utterance | Bridge, energy: floor tracked when idle, speech ≥ 3.5× floor, end after 350 ms, 200 ms preroll, min 200 ms voiced, max 15 s; barge-in ≥ 5× floor for 240 ms | `/api/telephony/bridge/turn` → `stt.transcribe(clean=True)` |

Overlap: the browser has one turn in flight at a time (a new one aborts the
previous request, sequence-numbered); the server answers a second concurrent
turn of one call with 409. While a browser turn is in "processing" the hook's
VAD ignores the mic entirely. CleanVoice (`DENOISE_URL`, off locally) is
**noise** suppression only, with a 3 s timeout and an SNR threshold of 30 dB; it
does not remove other people's voices.

## 2. Root causes of the two problems

**Background speech becoming a turn while the agent is thinking (problem B).**

1. *Phone, the main cause.* The bridge treated any caller audio during a turn
   ("the agent is talking **or thinking**") as a possible barge-in. Loud
   background speech for 240 ms while the answer was still being generated
   **cancelled the caller's real turn** (its STT/LLM request was aborted) and
   became the next utterance itself.
2. *Phone, a race.* The turn object was created inside the spawned task, one
   event-loop step after the utterance ended; frames already in the TCP buffer
   in that gap could start a second utterance.
3. *Phone, stale audio.* Frames gathered during the turn stayed in the preroll
   and were glued to the start of the next utterance.
4. *Browser, end of phrase.* During the 800 ms end-of-phrase wait, anything
   above 0.7 × the start threshold counted as "the caller went on", so a
   quieter voice in the room was **appended to the caller's phrase**.
5. *Browser, while the agent speaks.* A barge-in needed only 320 ms of energy
   above the echo-adjusted threshold: a nearby person could interrupt the agent
   and become the next turn.
6. *Browser, streaming STT.* The live transcript collected room talk between
   turns and sent it with the next phrase (it was only reset when a turn
   started/ended).

**Competing speakers (problem A).** Nothing in any path separated voices: the
only "cleaning" is CleanVoice (noise) and the browser's NS (noise). A second
person close enough to pass the energy VAD is transcribed with the caller.

## 3. What changed

### Turn gating (priority 1, on by default)

- **Phone** (`telephony-bridge/bridge.py`): explicit states `LISTENING →
  CAPTURING → THINKING → SPEAKING → REARMING`, derived from what is actually
  happening (`Connection.state`). While THINKING (turn in flight, reply audio
  not started, filler included) caller audio is **dropped**: it can neither
  cancel nor extend the turn. Barge-in only while the reply is playing. The turn
  is created in the same step that finalizes the utterance (race closed); each
  turn has an id and only the current turn may release the line; after a reply
  the line rearms for `VAD_REARM_MS` (200 ms) with an empty preroll.
  `VAD_BARGE_WHILE_THINKING=1` restores the old behaviour.
  **Production still runs `bridge.mjs`, which does not have this.** It reaches
  calls when the server switches to `bridge.py` (handoff.md).
- **Browser** (`src/lib/voice/turn-gate.ts`, `use-voice-session.ts`; all three
  call pages share the hook):
  - *Dominant-speaker gate*: the caller's own speech level is learned from the
    turns they make. A new turn must reach −12 dB of it, going on after a pause
    −10.5 dB, and an interruption −6 dB. Until the first turn everything passes.
  - *Barge-in must look like a voice*: only frames with most energy in
    250–4000 Hz and a harmonic (non-flat) spectrum count toward the 320 ms.
    Clicks, thumps and hiss do not.
  - *One submission per finalized utterance*, by turn id (`TurnLedger`); stale
    speculative results are dropped; `resumeListening` from a superseded turn
    cannot cancel a capture in progress.
  - *Streaming transcript*: reset after 1.5 s of listening with nobody speaking
    to the agent, so room talk is not prefixed to the next phrase.
  - *Debug view*: `?voiceDebug=1` on the Playground shows the phase, turn id,
    mic level, learned caller level and every accept/reject with its reason
    (`thinking`, `below_primary_level`, `not_speech_like`, `too_short`,
    `stale_turn`…). No audio, no transcript. `?voiceDebug=0` turns it off.

### Preprocessing pipeline (backend `app/audio/`)

`decode → high-pass → gain → noise suppression → voice isolation → resample
16 kHz → VAD → trim`. Every stage returns a `StageResult` whose `status` is the
truth: `ran`, `bypassed` (ran, changed nothing), `disabled`, `unavailable`,
`failed`. Noise suppression (`cleanvoice`) and voice isolation are separate
stages. Interfaces (`app/audio/types.py`): `AudioFrame`,
`AudioStreamProcessor`, `NoiseSuppressionProcessor`, `VoiceIsolationProcessor`,
`VADProcessor`, `TurnStateController`, `AudioProcessingResult`.

- **Voice isolation**: provider `inworld` = Inworld voice-isolator (Apache-2.0,
  48 kHz, PyTorch, ~60M parameters) as a **sidecar**
  (`backend/tools/voice_isolator_sidecar.py`, `POST /isolate`), so the backend
  does not need torch. It runs at the input's own rate before resampling; a
  lower-rate input is flagged ("upsampled, missing band not restored", and for
  8 kHz "no telephony-specific model"). Its model card: it keeps the **louder**
  voice — dominant-speaker isolation, not caller identification.
- **VAD**: `energy` (always available) and `silero` (Silero VAD on onnxruntime,
  no torch; model loaded once per process, state per stream; tensors as in
  silero-vad's `OnnxWrapper`). Hysteresis 0.5 / 0.35, min speech, min silence
  and 250 ms pre-roll/post-roll padding.
- **Live turns**: `prepare_live()` runs before STT in the phone, Playground and
  demo routes. With the flags off (default) it returns the bytes untouched.
- **Fallback**: `VOICE_ISOLATION_FALLBACK=original` passes the original audio
  when isolation cannot run (the stage says `failed`/`unavailable`);
  `reject` turns that utterance into "nothing heard", so audio of uncertain
  origin never becomes trusted input in sensitive flows.

### Audio Processing Lab (For developers ▸ STT, "Nutqni matnga")

Below the unchanged upload/record/transcribe flow:
original vs processed panels with real waveforms (zoomable, click to seek),
optional spectrogram, VAD segments and the score line, play/pause, durations,
sample rates, download of the exact WAV that would go to STT, a status banner
when no cleaning ran, per-stage results with timings and level change, playback
of every intermediate stage (raw / after filter-gain / denoised / isolated /
final), metrics, and an explicit **before/after STT comparison** with the
selected engine (two requests to `/api/models/stt`, word diff, latencies,
WER/CER only when a human reference is typed). Settings (not audio) are kept in
`localStorage`. Clips live in server memory for 15 minutes, owner-only.

API: `GET /api/audio/capabilities`, `POST /api/audio/process` (multipart `file`
= 16-bit WAV at its own rate, `options` = JSON), `GET /api/audio/clip/{token}`.
`POST /api/speech/stt` is unchanged.

## 4. Configuration

All in `.env.example`: `AUDIO_LAB`, `VOICE_ISOLATION_{PROVIDER,URL,MODEL,DEVICE,
TIMEOUT_MS}`, `VOICE_ISOLATION_BROWSER`, `VOICE_ISOLATION_PHONE`,
`VOICE_ISOLATION_FALLBACK`, `SILERO_VAD_MODEL`, `SERVER_VAD`, and for the
bridge `VAD_BARGE_WHILE_THINKING`, `VAD_REARM_MS` (plus the existing `VAD_*`).

Needs installing / downloading (not done on the dev PC):
- Voice isolation: torch + the Inworld package + its weights (Hugging Face) on
  the sidecar host; start the sidecar, set `VOICE_ISOLATION_URL`.
- Silero: `pip install onnxruntime` in `backend/.venv` and the `silero_vad.onnx`
  file (silero-vad repo, `src/silero_vad/data/`); set `SILERO_VAD_MODEL`.

## 5. Running and testing

- Unit tests: `npm test` (tsc + `tests/web/*.test.mjs`: the gate, WER/CER,
  waveform maths) and in `backend/`: `pytest tests/test_bridge_turns.py
  tests/test_audio_pipeline.py` (plus the whole suite).
- Lab: start `api` and `site`, open For developers ▸ STT, upload a file or
  record, press "Qayta ishlash".
- Live debug: Playground with `?voiceDebug=1`.

**Measuring (still to do with real audio).** The automated tests use synthetic
signals and a scripted isolator: they prove the plumbing and the gating rules,
not separation quality. To measure: record (a) caller alone, (b) background
speaker alone, (c) both at once, (d) background louder, (e) quiet caller, in
Uzbek, Russian and mixed, in the office and on a phone line; run them through
the lab with isolation on/off and compare WER with a reference; for live calls
count false barge-ins and wrong-speaker turns in the debug view.

## 6. Limitations (be explicit)

- No component identifies **which** speaker is the caller. The browser gate and
  the Inworld model both prefer the **dominant** (loudest/closest) voice; a
  louder background speaker can still win. Browser AGC narrows level
  differences after long silences.
- Voice isolation is not in the browser's live loop (no in-browser model): live
  browser turns can only use it server-side after the browser VAD has decided
  the turn (`VOICE_ISOLATION_BROWSER`).
- The phone fix is in `bridge.py` only; production uses `bridge.mjs` until the
  switch. No 8 kHz isolation model is configured.
- The Inworld sidecar is written against its README and not yet run here.
  Isolation latency on CPU is unmeasured (64M parameters per clip, likely
  hundreds of ms; the 1.5 s timeout falls back).
- Voice isolation or speaker similarity is never authentication.
