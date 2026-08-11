/**
 * Ovoz telephony bridge — Asterisk AudioSocket ⇄ Ovoz Next.js.
 *
 *   Asterisk ──AudioSocket(TCP)──▶ this bridge ──HTTP(x-bridge-secret)──▶ Next.js
 *            ◀──── slin audio ─────           ◀──── reply WAV ────────────
 *
 * A standalone Node service (Node ≥ 22, ESM, ZERO npm dependencies — only the
 * built-ins `net` + global `fetch`/`FormData`/`Blob`/`Buffer`). It speaks the
 * Asterisk AudioSocket wire protocol on a TCP port, runs energy-based VAD to cut
 * the caller's audio into complete utterances, and hands each utterance to the
 * Next.js bridge endpoints, which own every secret (STT/TTS + the LLM engine).
 *
 * The bridge holds only: NEXT_BASE_URL, BRIDGE_SHARED_SECRET, and the AudioSocket
 * handling below.
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
 * ── Turn flow ────────────────────────────────────────────────────────────────
 *   on 0x01 UUID          → POST /turn (first=true, no audio) → play greeting WAV
 *   on endpointed speech  → POST /turn (audio=utterance WAV)  → play reply WAV
 *   on 0x00 / socket close → POST /end { callId, durationSec }
 *
 * ── v1 limitations ───────────────────────────────────────────────────────────
 *   • No in-call SIP transfer on escalate — the bridge plays the handoff line
 *     then hangs up (the reason is logged; wire ARI/transfer in later).
 *   • VAD is energy (RMS) based, no barge-in (inbound audio is ignored while the
 *     agent is speaking).
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
    silenceMs: intEnv('VAD_SILENCE_MS', 700), // trailing silence that ends a turn
    rmsThreshold: intEnv('VAD_RMS_THRESHOLD', 800), // 16-bit RMS above = "voiced"
    maxUtteranceMs: intEnv('VAD_MAX_UTTERANCE_MS', 15000), // hard cap per utterance
    minVoicedMs: intEnv('VAD_MIN_VOICED_MS', 200), // shorter = discard as noise
    prerollMs: intEnv('VAD_PREROLL_MS', 160), // audio kept before onset (anti-clip)
  },
  verbose: /^(1|true|yes|on)$/i.test(process.env.BRIDGE_LOG || ''),
};

/* ── audio + protocol constants ──────────────────────────────── */

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // signed 16-bit
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000 * BYTES_PER_SAMPLE; // 320

const MSG = { TERMINATE: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };
const TURN_TIMEOUT_MS = 120000; // STT + LLM + TTS worst case
const END_TIMEOUT_MS = 15000;

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
    speaking: false,
    utter: /** @type {Buffer[]} */ ([]),
    voicedMs: 0,
    silenceMs: 0,
    utterMs: 0,
    preroll: /** @type {Buffer[]} */ ([]),
    prerollMs: 0,
    busy: false, // a turn (STT→LLM→TTS→playback) is in flight
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
  socket.on('close', () => void finish(socket, state));
});

server.on('error', (err) => {
  log('server error:', err.message);
  process.exit(1);
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  log(`AudioSocket bridge listening on 0.0.0.0:${CONFIG.port}`);
  log(`next=${CONFIG.nextBaseUrl}  secret=${CONFIG.secret ? 'set' : 'MISSING'}  ` +
      `to=${CONFIG.toNumber || '(unset)'}  from=${CONFIG.fromNumber}`);
  log(`vad: rms>=${CONFIG.vad.rmsThreshold}  silence=${CONFIG.vad.silenceMs}ms  ` +
      `min=${CONFIG.vad.minVoicedMs}ms  max=${CONFIG.vad.maxUtteranceMs}ms  preroll=${CONFIG.vad.prerollMs}ms`);
  if (!CONFIG.secret) log('WARNING: BRIDGE_SHARED_SECRET empty — /turn and /end will 401 (or 503 if unset app-side).');
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

/**
 * @param {ConnState} state
 * @param {(type:number, payload:Buffer)=>void} onMessage
 */
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

function onAudio(socket, state, payload) {
  if (state.busy) return; // no barge-in in v1 — ignore audio while the agent talks
  if (payload.length < BYTES_PER_SAMPLE) return;

  const rms = rmsOf(payload);
  const durMs = (payload.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
  const voiced = rms >= CONFIG.vad.rmsThreshold;

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
    // Idle: keep a short rolling preroll of recent silence for onset padding.
    state.preroll.push(Buffer.from(payload));
    state.prerollMs += durMs;
    while (state.prerollMs > CONFIG.vad.prerollMs && state.preroll.length > 1) {
      const dropped = state.preroll.shift();
      state.prerollMs -= (dropped.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
    }
  }

  // Hard cap so a caller who never pauses still gets processed.
  if (state.speaking && state.utterMs >= CONFIG.vad.maxUtteranceMs) {
    endpoint(socket, state);
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

/* ── turn processing ─────────────────────────────────────────── */

async function openAndGreet(socket, state) {
  state.busy = true;
  try {
    const res = await callTurn(state, { first: true });
    if (res) await playWav(socket, state, res.wav);
    else log('greeting turn failed — leaving the call silent');
  } finally {
    state.busy = false;
  }
}

async function processUtterance(socket, state, pcm) {
  state.busy = true;
  try {
    const wav = pcmToWav(pcm);
    const res = await callTurn(state, { audio: wav });
    if (!res) return;
    await playWav(socket, state, res.wav);
    if (res.escalate) {
      // No SIP transfer in v1 — the handoff line was just spoken; end the call.
      log(`escalation flagged: ${res.escalate} — no in-call transfer in v1, ending call`);
      await finish(socket, state);
      socket.end();
    }
  } finally {
    state.busy = false;
  }
}

/**
 * POST one turn to Next.js. Updates state.callId from the response.
 * @returns {Promise<{callId:string, escalate:string, text:string, wav:Buffer}|null>}
 */
async function callTurn(state, { audio, first } = {}) {
  const form = new FormData();
  if (audio) form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'utterance.wav');
  form.append('callId', state.callId || '');
  form.append('from', state.from || '');
  form.append('to', state.to || '');
  if (first) form.append('first', 'true');

  let res;
  try {
    res = await fetch(`${CONFIG.nextBaseUrl}/api/telephony/bridge/turn`, {
      method: 'POST',
      headers: { 'x-bridge-secret': CONFIG.secret },
      body: form,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch (err) {
    log('turn request failed:', err.message);
    return null;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log(`turn ${res.status}: ${detail.slice(0, 200)}`);
    return null;
  }

  const callId = res.headers.get('x-ovoz-callid') || state.callId;
  if (callId) state.callId = callId;
  const escalate = res.headers.get('x-ovoz-escalate') || '';
  const textB64 = res.headers.get('x-ovoz-text') || '';
  const text = textB64 ? Buffer.from(textB64, 'base64').toString('utf8') : '';
  const wav = Buffer.from(await res.arrayBuffer());
  if (CONFIG.verbose && text) log(`agent: ${text}`);
  return { callId, escalate, text, wav };
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

/* ── playback: WAV → paced 20 ms slin frames ─────────────────── */

async function playWav(socket, state, wavBuf) {
  const pcm = wavToPcm8kMono16(wavBuf);
  if (!pcm || !pcm.length) return;

  // Drift-corrected pacing: one 320-byte frame every 20 ms of real time.
  let nextAt = Date.now();
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
    if (socket.destroyed || state.ended) break;
    let frame = pcm.subarray(i, i + FRAME_BYTES);
    if (frame.length < FRAME_BYTES) {
      const padded = Buffer.alloc(FRAME_BYTES); // pad the tail with silence
      frame.copy(padded);
      frame = padded;
    }
    writeMessage(socket, MSG.AUDIO, frame);
    nextAt += FRAME_MS;
    const delay = nextAt - Date.now();
    if (delay > 1) await sleep(delay);
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
 * Decode a WAV to 8 kHz mono 16-bit PCM for AudioSocket. The internal TTS
 * returns 8 kHz WAV already, but we parse fmt defensively and down-mix /
 * resample if it ever differs so playback never sounds wrong on the wire.
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
 * @property {boolean} busy
 * @property {boolean} ended
 * @property {number} startedAt
 */
