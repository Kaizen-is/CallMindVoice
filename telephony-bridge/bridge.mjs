/**
 * Ovoz telephony bridge — Asterisk AudioSocket ⇄ Ovoz Next.js.
 *
 *   Asterisk ──AudioSocket(TCP)──▶ this bridge ──HTTP(x-bridge-secret)──▶ Next.js
 *            ◀──── slin audio ─────           ◀──── streamed PCM ───────
 *
 * A standalone Node service (Node ≥ 22, ESM, ZERO npm dependencies — only the
 * built-ins `net` + global `fetch`/`FormData`/`Blob`/`Buffer`). It speaks the
 * Asterisk AudioSocket wire protocol on a TCP port, endpoints the caller's
 * audio into complete utterances, and hands each one to the Next.js bridge
 * endpoints, which own every secret (STT/TTS + the LLM engine).
 *
 * The bridge holds only: NEXT_BASE_URL, BRIDGE_SHARED_SECRET, and everything
 * below.
 *
 * ── AudioSocket wire protocol ────────────────────────────────────────────────
 *   Every message is:  [1-byte type][2-byte big-endian length][payload]
 *     0x00 TERMINATE  hang up (payload usually empty)
 *     0x01 UUID       16-byte call id (Asterisk channel), sent once on connect
 *     0x03 DTMF       one ASCII digit
 *     0x10 AUDIO      signed 16-bit LE PCM, 8 kHz mono, 20 ms (320-byte) frames
 *     0xff ERROR      error notification
 *   TCP is a stream, so messages split/merge across segments — we reassemble.
 *
 * ── What makes it sound live rather than like a walkie-talkie ────────────────
 *
 *   • **Streamed playback.** /turn returns raw 8 kHz PCM as a chunked stream,
 *     one sentence at a time. We start pacing frames onto the line the moment
 *     the first bytes land, instead of waiting for the whole reply to render.
 *
 *   • **Filler lines.** If the answer has not started arriving within
 *     FILLER_AFTER_MS, we play a pre-fetched holding line ("bir daqiqa") in the
 *     agent's own voice. The caller hears a human-shaped pause instead of dead
 *     air, and it costs nothing — the fillers were downloaded during the
 *     greeting.
 *
 *   • **Barge-in.** Inbound audio is analysed even while the agent is speaking.
 *     Sustained speech stops playback immediately, aborts the in-flight turn,
 *     and reports back what fraction of the reply the caller actually heard so
 *     the transcript matches reality.
 *
 *   • **Adaptive VAD.** The energy threshold tracks the line's own noise floor,
 *     measured continuously, instead of a fixed constant that is too sensitive
 *     on a clean SIP leg and stone deaf on a noisy GSM one.
 *
 * ── Remaining v1 limitations ─────────────────────────────────────────────────
 *   • No in-call SIP transfer on escalate — the bridge plays the handoff line
 *     then hangs up (the reason is logged; wire ARI/transfer in later).
 *   • to/from are a static env mapping (BRIDGE_TO_NUMBER / BRIDGE_FROM_NUMBER).
 *     TODO: an ARI companion keyed by the AudioSocket UUID to resolve the real
 *     dialed DID + caller id per call for multi-number deployments.
 */
import net from 'node:net';

/* ── config (env, with defaults) ─────────────────────────────── */

const CONFIG = {
  port: intEnv('AUDIOSOCKET_PORT', 8090),
  nextBaseUrl: (process.env.NEXT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  secret: process.env.BRIDGE_SHARED_SECRET || '',
  // Static v1 number mapping. TODO: resolve per-call via ARI (UUID → DID/caller).
  toNumber: process.env.BRIDGE_TO_NUMBER || '',
  fromNumber: process.env.BRIDGE_FROM_NUMBER || 'anonymous',
  vad: {
    // 350 ms, not the 700 ms this bridge shipped with: 700 ms is audible dead
    // air on every single turn. The adaptive threshold below is what makes the
    // shorter window safe — a fixed threshold at 350 ms cuts people off.
    silenceMs: intEnv('VAD_SILENCE_MS', 350),
    // Absolute floor for "voiced", used until the noise floor is measured and
    // as a lower bound afterwards.
    minRms: intEnv('VAD_MIN_RMS', 350),
    // Voiced = noiseFloor × this. Speech sits far above room noise, so a
    // multiplicative threshold survives lines this constant never could.
    rmsFactor: floatEnv('VAD_RMS_FACTOR', 3.5),
    // Barge-in needs a higher bar than normal speech: the agent's own audio
    // leaks back through imperfect echo cancellation on some trunks.
    bargeRmsFactor: floatEnv('VAD_BARGE_RMS_FACTOR', 5),
    maxUtteranceMs: intEnv('VAD_MAX_UTTERANCE_MS', 15000), // hard cap per utterance
    minVoicedMs: intEnv('VAD_MIN_VOICED_MS', 200), // shorter = discard as noise
    prerollMs: intEnv('VAD_PREROLL_MS', 200), // audio kept before onset (anti-clip)
    // Sustained speech over the barge threshold that stops the agent talking.
    bargeMs: intEnv('VAD_BARGE_MS', 240),
  },
  // How long a turn may be silent before a filler line covers the gap.
  fillerAfterMs: intEnv('FILLER_AFTER_MS', 300),
  fillersEnabled: !/^(0|false|no|off)$/i.test(process.env.FILLERS || ''),
  verbose: /^(1|true|yes|on)$/i.test(process.env.BRIDGE_LOG || ''),
};

/* ── audio + protocol constants ──────────────────────────────── */

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = ((SAMPLE_RATE * FRAME_MS) / 1000) * BYTES_PER_SAMPLE; // 320
const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000; // 16

const MSG = { TERMINATE: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };
const TURN_TIMEOUT_MS = 120000; // STT + LLM + TTS worst case
const END_TIMEOUT_MS = 15000;
const FILLER_COUNT = 3; // distinct holding lines prefetched per call

/** Rough speech rate, used only to estimate a reply's length before it renders. */
const BYTES_PER_CHAR = 60 * BYTES_PER_MS;

/* ── server bootstrap ────────────────────────────────────────── */

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 15000);

  /** @type {ConnState} */
  const state = {
    buffer: Buffer.alloc(0),
    uuid: null,
    callId: '', // Ovoz DB call id (from x-ovoz-callid)
    from: CONFIG.fromNumber,
    to: CONFIG.toNumber,
    // endpointing
    speaking: false,
    utter: [],
    voicedMs: 0,
    silenceMs: 0,
    utterMs: 0,
    preroll: [],
    prerollMs: 0,
    noiseFloor: CONFIG.vad.minRms,
    bargeVoicedMs: 0,
    // turn lifecycle
    turn: null, // in-flight turn (AbortController + Playback), or null
    fillers: [], // prefetched holding lines (Buffer[])
    fillerAt: 0, // rotation cursor
    pendingRatio: 0, // barge-in report for the NEXT /turn request
    ended: false,
    startedAt: Date.now(),
  };

  socket.on('data', (chunk) => {
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;
    drain(state, (type, payload) => handleMessage(socket, state, type, payload));
  });
  socket.on('error', (err) => {
    log('socket error:', err.message);
    void finish(socket, state);
  });
  socket.on('close', () => {
    state.turn?.playback.cancel();
    state.turn?.abort.abort();
    void finish(socket, state);
  });
});

server.on('error', (err) => {
  log('server error:', err.message);
  process.exit(1);
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  log(`AudioSocket bridge listening on 0.0.0.0:${CONFIG.port}`);
  log(`next=${CONFIG.nextBaseUrl}  secret=${CONFIG.secret ? 'set' : 'MISSING'}  ` +
      `to=${CONFIG.toNumber || '(unset)'}  from=${CONFIG.fromNumber}`);
  log(`vad: rms>=max(${CONFIG.vad.minRms}, floor×${CONFIG.vad.rmsFactor})  ` +
      `silence=${CONFIG.vad.silenceMs}ms  min=${CONFIG.vad.minVoicedMs}ms  ` +
      `max=${CONFIG.vad.maxUtteranceMs}ms  preroll=${CONFIG.vad.prerollMs}ms`);
  log(`barge-in: ${CONFIG.vad.bargeMs}ms over floor×${CONFIG.vad.bargeRmsFactor}  ` +
      `fillers=${CONFIG.fillersEnabled ? `after ${CONFIG.fillerAfterMs}ms` : 'off'}`);
  if (!CONFIG.secret) log('WARNING: BRIDGE_SHARED_SECRET empty — endpoints will 401 (or 503 if unset app-side).');
  if (!CONFIG.toNumber) log('WARNING: BRIDGE_TO_NUMBER unset — number→agent lookup will 404 until set (v1 static mapping).');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

/* ── framing: reassemble [type][len][payload] from the TCP stream ─ */

function drain(state, onMessage) {
  const buf = state.buffer;
  let offset = 0;
  while (buf.length - offset >= 3) {
    const type = buf.readUInt8(offset);
    const len = buf.readUInt16BE(offset + 1);
    if (buf.length - offset - 3 < len) break; // incomplete — wait for more bytes
    const payload = buf.subarray(offset + 3, offset + 3 + len);
    offset += 3 + len;
    onMessage(type, payload);
  }
  state.buffer = offset > 0 ? buf.subarray(offset) : buf;
}

/** Frame and send one AudioSocket message. */
function writeMessage(socket, type, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
  const header = Buffer.allocUnsafe(3);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(payload.length, 1);
  socket.write(Buffer.concat([header, payload]));
}

/* ── message dispatch ────────────────────────────────────────── */

function handleMessage(socket, state, type, payload) {
  switch (type) {
    case MSG.UUID:
      state.uuid = formatUuid(payload);
      log(`call up  uuid=${state.uuid}  to=${state.to || '(unset)'}  from=${state.from}`);
      void openAndGreet(socket, state);
      break;
    case MSG.AUDIO:
      onAudio(socket, state, payload);
      break;
    case MSG.DTMF:
      // TODO: map a digit (e.g. 0) to an operator-escalation request.
      log(`dtmf ${payload.toString('utf8')}`);
      break;
    case MSG.TERMINATE:
      log('terminate frame from Asterisk');
      state.turn?.playback.cancel();
      state.turn?.abort.abort();
      void finish(socket, state);
      socket.end();
      break;
    case MSG.ERROR:
      log(`error frame from Asterisk: 0x${payload.toString('hex')}`);
      break;
    default:
      // Unknown/ignored frame types (some Asterisk builds emit others).
      break;
  }
}

/* ── VAD / endpointing ───────────────────────────────────────── */

/**
 * One 20 ms frame of caller audio.
 *
 * Runs in three modes depending on what the agent is doing:
 *   • a turn is in flight  → barge-in detection only
 *   • the caller is mid-utterance → accumulate, watch for the endpoint
 *   • idle → track the noise floor and keep a rolling preroll
 */
function onAudio(socket, state, payload) {
  if (payload.length < BYTES_PER_SAMPLE) return;

  const rms = rmsOf(payload);
  const durMs = (payload.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

  // ── barge-in: the agent is talking (or thinking) and the caller starts. ──
  if (state.turn) {
    if (rms >= state.noiseFloor * CONFIG.vad.bargeRmsFactor) {
      state.bargeVoicedMs += durMs;
      // Hold the audio: if this turns out to be a real barge-in, it is the
      // start of the caller's next utterance and must not be lost.
      state.preroll.push(Buffer.from(payload));
      state.prerollMs += durMs;
      if (state.bargeVoicedMs >= CONFIG.vad.bargeMs) bargeIn(state);
    } else {
      // Isolated noise, not speech — forget it.
      state.bargeVoicedMs = 0;
      trimPreroll(state);
    }
    return;
  }

  const voiced = rms >= voicedThreshold(state);

  if (voiced) {
    if (!state.speaking) {
      // Speech onset — seed the utterance with the preroll so we don't clip it.
      state.speaking = true;
      state.utter = state.preroll.slice();
      state.utterMs = state.prerollMs;
      state.voicedMs = 0;
      state.silenceMs = 0;
      state.preroll = [];
      state.prerollMs = 0;
    }
    state.utter.push(Buffer.from(payload));
    state.utterMs += durMs;
    state.voicedMs += durMs;
    state.silenceMs = 0;
  } else if (state.speaking) {
    // Keep trailing silence inside the utterance; end the turn once it's long enough.
    state.utter.push(Buffer.from(payload));
    state.utterMs += durMs;
    state.silenceMs += durMs;
    if (state.silenceMs >= CONFIG.vad.silenceMs) {
      endpoint(socket, state);
      return;
    }
  } else {
    // Idle: this frame is (by definition) not speech, so it is a clean sample
    // of the line's noise floor. Track it slowly — a fast tracker would drift
    // upward during speech pauses and start ignoring quiet callers.
    state.noiseFloor = state.noiseFloor * 0.95 + rms * 0.05;
    state.preroll.push(Buffer.from(payload));
    state.prerollMs += durMs;
    trimPreroll(state);
  }

  // Hard cap so a caller who never pauses still gets processed.
  if (state.speaking && state.utterMs >= CONFIG.vad.maxUtteranceMs) {
    endpoint(socket, state);
  }
}

/** The energy a frame must exceed to count as speech, on this line, right now. */
function voicedThreshold(state) {
  return Math.max(CONFIG.vad.minRms, state.noiseFloor * CONFIG.vad.rmsFactor);
}

function trimPreroll(state) {
  while (state.prerollMs > CONFIG.vad.prerollMs && state.preroll.length > 1) {
    const dropped = state.preroll.shift();
    state.prerollMs -= (dropped.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
  }
}

/** Finalize the buffered utterance and, if it's real speech, process it. */
function endpoint(socket, state) {
  const chunks = state.utter;
  const voicedMs = state.voicedMs;
  state.speaking = false;
  state.utter = [];
  state.utterMs = 0;
  state.voicedMs = 0;
  state.silenceMs = 0;

  if (voicedMs < CONFIG.vad.minVoicedMs) return; // a click/cough, not a turn
  const pcm = Buffer.concat(chunks);
  processUtterance(socket, state, pcm).catch((err) => log('turn error:', err.message));
}

/**
 * The caller talked over the agent. Stop speaking immediately, drop the rest of
 * the reply, and remember how much of it was actually heard — the next /turn
 * carries that number so the stored transcript matches what went down the line.
 */
function bargeIn(state) {
  const turn = state.turn;
  if (!turn) return;
  state.pendingRatio = turn.playback.spokenRatio(turn.replyChars);
  log(`barge-in — stopping playback at ${(state.pendingRatio * 100).toFixed(0)}% of the reply`);
  turn.playback.cancel();
  turn.abort.abort();
  state.turn = null;
  state.bargeVoicedMs = 0;
  // The frames that triggered the barge-in are already in the preroll, so the
  // normal onset path picks the utterance up from the caller's first syllable.
}

/* ── turn processing ─────────────────────────────────────────── */

async function openAndGreet(socket, state) {
  const playback = new Playback(socket, state);
  const abort = new AbortController();
  state.turn = { playback, abort, replyChars: 0 };
  // Fetch the holding lines concurrently with the greeting, so they are already
  // in memory by the time the caller's first question needs one.
  void prefetchFillers(state);
  try {
    const res = await callTurn(state, abort, { first: true });
    if (!res) {
      log('greeting turn failed — leaving the call silent');
      return;
    }
    state.turn.replyChars = res.text.length;
    await pump(res, playback);
    await playback.drain();
  } finally {
    if (state.turn?.playback === playback) state.turn = null;
  }
}

async function processUtterance(socket, state, pcm) {
  const playback = new Playback(socket, state);
  const abort = new AbortController();
  state.turn = { playback, abort, replyChars: 0 };

  // Cover the STT + retrieval + generation gap with a holding line, but only if
  // the answer is actually slow — a fast turn should never hear a filler.
  const fillerTimer = setTimeout(() => {
    const filler = nextFiller(state);
    if (filler && !playback.started) playback.push(filler);
  }, CONFIG.fillerAfterMs);

  try {
    const res = await callTurn(state, abort, { audio: pcmToWav(pcm) });
    if (!res) return;
    state.turn.replyChars = res.text.length;
    await pump(res, playback, () => clearTimeout(fillerTimer));
    await playback.drain();

    if (res.escalate) {
      // No SIP transfer in v1 — the handoff line was just spoken; end the call.
      log(`escalation flagged: ${res.escalate} — no in-call transfer in v1, ending call`);
      await finish(socket, state);
      socket.end();
    }
  } finally {
    clearTimeout(fillerTimer);
    if (state.turn?.playback === playback) state.turn = null;
  }
}

/**
 * Read the reply body and feed playback as it arrives.
 *
 * `audio/L16` is raw PCM and can go straight onto the line chunk by chunk —
 * this is the streaming path and the reason a long answer starts playing after
 * one sentence instead of after all of them. Anything else (a WAV, from an
 * older app build) is buffered whole and converted, preserving compatibility at
 * the cost of the latency win.
 */
async function pump(res, playback, onFirstChunk) {
  if (!res.body) {
    playback.end();
    return;
  }
  try {
    await readInto(res, playback, onFirstChunk);
  } catch (err) {
    // A barge-in or a hangup aborts the body mid-flight. That is the normal way
    // an interrupted turn ends, not a fault — whatever already played, played.
    if (!playback.cancelled) log('reply stream ended early:', err.message);
  }
  playback.end();
}

async function readInto(res, playback, onFirstChunk) {
  if (res.raw) {
    for await (const chunk of res.body) {
      onFirstChunk?.();
      onFirstChunk = null;
      playback.markReplyStart();
      playback.push(Buffer.from(chunk));
    }
  } else {
    const parts = [];
    for await (const chunk of res.body) parts.push(Buffer.from(chunk));
    onFirstChunk?.();
    playback.markReplyStart();
    playback.push(wavToPcm8kMono16(Buffer.concat(parts)));
  }
}

/**
 * POST one turn to Next.js. Updates state.callId from the response and returns
 * the still-open body so the caller can stream it.
 */
async function callTurn(state, abort, { audio, first } = {}) {
  const form = new FormData();
  if (audio) form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
  form.append('callId', state.callId || '');
  form.append('from', state.from || '');
  form.append('to', state.to || '');
  if (first) form.append('first', 'true');
  // Barge-in report for the reply the caller cut off, if any.
  if (state.pendingRatio > 0) {
    form.append('spokenRatio', state.pendingRatio.toFixed(3));
    state.pendingRatio = 0;
  }

  const timeout = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${CONFIG.nextBaseUrl}/api/telephony/bridge/turn`, {
      method: 'POST',
      headers: { 'x-bridge-secret': CONFIG.secret },
      body: form,
      signal: abort.signal,
    });
  } catch (err) {
    if (!abort.signal.aborted) log('turn request failed:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log(`turn ${res.status}: ${detail.slice(0, 200)}`);
    return null;
  }

  const callId = res.headers.get('x-ovoz-callid') || state.callId;
  if (callId) state.callId = callId;
  const textB64 = res.headers.get('x-ovoz-text') || '';
  const text = textB64 ? Buffer.from(textB64, 'base64').toString('utf8') : '';
  if (CONFIG.verbose && text) {
    log(`agent (${res.headers.get('x-ovoz-engine') || '-'}): ${text}`);
  }
  return {
    callId,
    escalate: res.headers.get('x-ovoz-escalate') || '',
    text,
    body: res.body,
    raw: (res.headers.get('content-type') || '').toLowerCase().includes('l16'),
  };
}

/** Download the holding lines once per call, in the background. */
async function prefetchFillers(state) {
  if (!CONFIG.fillersEnabled || state.fillers.length || !state.to) return;
  const wanted = Array.from({ length: FILLER_COUNT }, (_, i) => i);
  const results = await Promise.all(
    wanted.map(async (i) => {
      try {
        const url = `${CONFIG.nextBaseUrl}/api/telephony/bridge/filler?to=${encodeURIComponent(state.to)}&i=${i}`;
        const res = await fetch(url, {
          headers: { 'x-bridge-secret': CONFIG.secret },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null; // fillers are a nicety; never let them break a call
      }
    }),
  );
  state.fillers = results.filter((b) => b && b.length);
  if (CONFIG.verbose) log(`fillers ready: ${state.fillers.length}`);
}

/** Rotate through the prefetched lines so a call never repeats one twice running. */
function nextFiller(state) {
  if (!state.fillers.length) return null;
  const filler = state.fillers[state.fillerAt % state.fillers.length];
  state.fillerAt++;
  return filler;
}

/** Close the Ovoz call row exactly once (0x00 or socket close, whichever first). */
async function finish(socket, state) {
  if (state.ended) return;
  state.ended = true;
  const durationSec = Math.round((Date.now() - state.startedAt) / 1000);
  if (!state.callId) {
    log(`call closed with no Ovoz callId (dur=${durationSec}s)`);
    return;
  }
  try {
    const res = await fetch(`${CONFIG.nextBaseUrl}/api/telephony/bridge/end`, {
      method: 'POST',
      headers: { 'x-bridge-secret': CONFIG.secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: state.callId, durationSec }),
      signal: AbortSignal.timeout(END_TIMEOUT_MS),
    });
    log(`end ${res.status}  callId=${state.callId}  dur=${durationSec}s`);
  } catch (err) {
    log('end request failed:', err.message);
  }
}

/* ── playback: a paced 20 ms frame writer over a growing buffer ── */

/**
 * Paces PCM onto the AudioSocket at exactly one 320-byte frame per 20 ms of
 * real time, while the buffer behind it is still being filled.
 *
 * The pacing loop and the producer are decoupled on purpose: the loop starts as
 * soon as the first bytes exist and simply waits if it catches up with the
 * producer, so a slow second sentence produces a natural pause rather than a
 * glitch. Cancelling stops mid-frame — that immediacy is what makes barge-in
 * feel like interrupting a person instead of a voicemail system.
 */
class Playback {
  constructor(socket, state) {
    this.socket = socket;
    this.state = state;
    this.queue = [];       // unsent PCM, in order
    this.queued = 0;       // total bytes ever pushed
    this.sent = 0;         // total bytes actually written to the line
    this.done = false;     // producer finished
    this.cancelled = false;
    this.started = false;
    this.loop = null;
    // Byte offsets at which the actual reply began. Anything before them is a
    // filler line, which must not count towards "how much of the reply was heard".
    this.replyFrom = null;
  }

  /** Called when the first byte of the real reply is queued. */
  markReplyStart() {
    this.replyFrom ??= { queued: this.queued, sent: this.sent };
  }

  push(pcm) {
    if (this.cancelled || !pcm?.length) return;
    this.queue.push(pcm);
    this.queued += pcm.length;
    this.started = true;
    this.loop ??= this.#run();
  }

  end() {
    this.done = true;
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
  }

  /** Wait for everything pushed so far to finish playing. */
  async drain() {
    this.end();
    await this.loop;
  }

  /**
   * How much of the reply the caller heard, as a fraction.
   *
   * Exact once the producer has finished. Before that, the total is unknown —
   * later sentences have not rendered yet — so it is estimated from the reply's
   * character count. Overestimating what the caller heard would leave words in
   * the transcript they never got, so the estimate deliberately assumes the
   * reply is at least as long as the text implies.
   */
  spokenRatio(replyChars = 0) {
    // Interrupted before the reply started (during a filler, or while still
    // waiting on the app) — the caller heard none of it.
    if (!this.replyFrom) return 0;
    const queued = this.queued - this.replyFrom.queued;
    const sent = Math.max(0, this.sent - this.replyFrom.sent);
    const total = this.done ? queued : Math.max(queued, replyChars * BYTES_PER_CHAR);
    if (!total) return 0;
    return Math.min(1, Math.max(0.02, sent / total));
  }

  async #run() {
    // Drift-corrected pacing: one frame every 20 ms of wall clock, not 20 ms
    // after the previous write finished (which would slowly run late).
    let nextAt = Date.now();
    let carry = Buffer.alloc(0);

    while (!this.cancelled && !this.socket.destroyed && !this.state.ended) {
      // Gather one frame's worth of bytes out of the queue.
      while (carry.length < FRAME_BYTES && this.queue.length) {
        carry = carry.length ? Buffer.concat([carry, this.queue.shift()]) : this.queue.shift();
      }

      if (carry.length < FRAME_BYTES) {
        if (this.done) {
          // Final partial frame: pad with silence so Asterisk gets a whole one.
          if (carry.length) {
            const padded = Buffer.alloc(FRAME_BYTES);
            carry.copy(padded);
            writeMessage(this.socket, MSG.AUDIO, padded);
            this.sent += carry.length;
          }
          return;
        }
        // Producer is behind — wait briefly and try again. The line stays quiet
        // for this moment, which is exactly what the filler line exists to avoid.
        await sleep(10);
        nextAt = Math.max(nextAt, Date.now());
        continue;
      }

      writeMessage(this.socket, MSG.AUDIO, carry.subarray(0, FRAME_BYTES));
      this.sent += FRAME_BYTES;
      carry = carry.subarray(FRAME_BYTES);

      nextAt += FRAME_MS;
      const delay = nextAt - Date.now();
      if (delay > 1) await sleep(delay);
    }
  }
}

/* ── audio helpers ───────────────────────────────────────────── */

/** RMS energy of a signed-16 LE PCM buffer (0..32767). */
function rmsOf(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Wrap raw 8 kHz mono 16-bit PCM in a canonical 44-byte WAV header. */
function pcmToWav(pcm, sampleRate = SAMPLE_RATE, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Decode a WAV to 8 kHz mono 16-bit PCM. Only used on the compatibility path —
 * the app now streams raw L16 — but kept so an older app build still plays.
 */
function wavToPcm8kMono16(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf; // not a WAV we recognise — assume it's already raw slin
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ' && body.length >= 16) {
      fmt = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
    if (fmt && data) break;
  }
  if (!data) return Buffer.alloc(0);
  if (!fmt) return data;

  let pcm = data;
  if (fmt.bits !== 16) {
    log(`playback: ${fmt.bits}-bit WAV unsupported — sending best-effort`);
    return pcm;
  }
  if (fmt.channels === 2) pcm = downmixStereo16(pcm);
  if (fmt.sampleRate !== SAMPLE_RATE) pcm = resample16(pcm, fmt.sampleRate, SAMPLE_RATE);
  return pcm;
}

function downmixStereo16(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE((l + r) >> 1, i * 2);
  }
  return out;
}

/** Linear-interpolation resample of 16-bit mono PCM. */
function resample16(pcm, srcRate, dstRate) {
  const srcSamples = Math.floor(pcm.length / 2);
  if (srcSamples < 2) return pcm;
  const dstSamples = Math.max(1, Math.floor((srcSamples * dstRate) / srcRate));
  const out = Buffer.allocUnsafe(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const pos = (i * srcRate) / dstRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, srcSamples - 1);
    const frac = pos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

/* ── misc utils ──────────────────────────────────────────────── */

function formatUuid(payload) {
  if (payload.length !== 16) return payload.toString('hex');
  const h = payload.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : dflt;
}

function floatEnv(name, dflt) {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : dflt;
}

function log(...args) {
  console.log(new Date().toISOString(), '[bridge]', ...args);
}

/**
 * @typedef {Object} ConnState
 * @property {Buffer} buffer
 * @property {string|null} uuid
 * @property {string} callId
 * @property {string} from
 * @property {string} to
 * @property {boolean} speaking
 * @property {Buffer[]} utter
 * @property {number} voicedMs
 * @property {number} silenceMs
 * @property {number} utterMs
 * @property {Buffer[]} preroll
 * @property {number} prerollMs
 * @property {number} noiseFloor
 * @property {number} bargeVoicedMs
 * @property {{playback: Playback, abort: AbortController, replyChars: number}|null} turn
 * @property {Buffer[]} fillers
 * @property {number} fillerAt
 * @property {number} pendingRatio
 * @property {boolean} ended
 * @property {number} startedAt
 */
