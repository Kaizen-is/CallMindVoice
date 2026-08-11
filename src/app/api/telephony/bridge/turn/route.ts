/**
 * Asterisk/FreePBX ↔ Ovoz voice bridge — TURN endpoint.
 *
 * The standalone AudioSocket bridge (`telephony-bridge/bridge.mjs`) POSTs one
 * complete caller utterance here and gets back the agent's spoken reply as a
 * WAV, with the call metadata carried in response headers. Every secret — the
 * internal Uzbek STT/TTS URLs and credentials, and the LLM engine — stays in
 * this Next.js app; the bridge only holds `NEXT_BASE_URL` + the shared secret.
 *
 * ── Endpointing contract (IMPORTANT) ─────────────────────────────────────────
 * The internal STT service expects a COMPLETE WAV utterance (one whole turn of
 * speech), not a live stream. The bridge is responsible for voice-activity
 * detection / endpointing — buffering the caller's PCM and cutting it into
 * utterances on trailing silence — BEFORE calling this route. This handler just
 * runs STT → runTurn → TTS on whatever finished WAV it is handed.
 *
 * ── Pipeline ─────────────────────────────────────────────────────────────────
 *   first leg  (first=true | no callId): startCall → TTS(greeting)     → WAV
 *   later legs (callId + audio):          STT → runTurn → TTS(reply)    → WAV
 *
 * ── Response ─────────────────────────────────────────────────────────────────
 *   body                = the reply WAV (Content-Type: audio/wav)
 *   x-ovoz-callid       = the Ovoz DB call id (minted on the first leg, reused)
 *   x-ovoz-escalate     = the escalation reason, or '' — on escalate we STILL
 *                         return the spoken handoff line as audio; in-call SIP
 *                         transfer is out of scope for v1, so the bridge plays
 *                         the line and hangs up (see README limitations).
 *   x-ovoz-text         = base64(utf-8) of the reply text (HTTP headers cannot
 *                         safely carry raw multi-byte UTF-8).
 *
 * Auth: header `x-bridge-secret` must equal `BRIDGE_SHARED_SECRET`. Env unset →
 * 503 (feature not provisioned); header mismatch → 401. Gating style mirrors
 * `src/app/api/telephony/twilio/voice/route.ts`.
 *
 * CREATE-ONLY module: imports the shared engine/db/catalog read-only.
 */
import { timingSafeEqual } from 'node:crypto';
import { get } from '@/lib/db';
import { liveAgent, startCall } from '@/lib/engine/calls';
import { runTurn } from '@/lib/engine/conversation';
import { VOICES } from '@/lib/catalog';
import type { Agent, Locale, PhoneNumber } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Never hand empty text to the TTS service — fall back per spoken language. */
const GREETING_FALLBACK: Record<Locale, string> = {
  uz: 'Assalomu alaykum! Sizni tinglayapman.',
  ru: 'Здравствуйте! Чем могу помочь?',
  en: 'Hello! How can I help you?',
};

/** Said when STT returns nothing intelligible — re-prompt without burning a turn. */
const REPROMPT: Record<Locale, string> = {
  uz: 'Uzr, eshitolmadim. Iltimos, takrorlang.',
  ru: 'Извините, я не расслышал. Повторите, пожалуйста.',
  en: "Sorry, I didn't catch that — could you say it again?",
};

/** Carries an HTTP status so upstream failures surface as a real code, not 500. */
class BridgeError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function POST(request: Request): Promise<Response> {
  // ── Auth gate (before touching the body, so unprovisioned deploys are safe) ──
  const secret = process.env.BRIDGE_SHARED_SECRET;
  if (!secret) return Response.json({ error: 'bridge_not_configured' }, { status: 503 });
  if (!secretMatches(request.headers.get('x-bridge-secret'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'expected_multipart_form' }, { status: 400 });
  }

  const to = field(form.get('to'));
  const from = field(form.get('from'));
  const first = field(form.get('first')) === 'true';
  const callIdIn = field(form.get('callId'));
  const audioField = form.get('audio');
  const audio = audioField && typeof audioField !== 'string' ? (audioField as Blob) : null;

  // ── Resolve number → agent → tenant (mirrors the Twilio voice route). ──
  const number = get<PhoneNumber>(
    `SELECT * FROM phone_numbers WHERE e164=? AND status='active' LIMIT 1`,
    to,
  );
  if (!number) return Response.json({ error: 'number_not_configured', to }, { status: 404 });

  const agent =
    get<Agent>('SELECT * FROM agents WHERE id=? AND tenant_id=?', number.agent_id, number.tenant_id) ??
    liveAgent(number.tenant_id);
  if (!agent || agent.status !== 'live') {
    return Response.json({ error: 'agent_unavailable' }, { status: 409 });
  }

  const lang = (agent.primary_lang ?? 'uz') as Locale;

  try {
    // ── First leg: open the call and greet. No STT on the opening leg. ──
    if (first || !callIdIn) {
      const callId = startCall({
        tenantId: number.tenant_id,
        agentId: agent.id,
        numberId: number.id,
        from,
        to,
        language: lang,
        channel: 'voice',
      });
      const greeting = agent.greeting?.trim() || GREETING_FALLBACK[lang] || GREETING_FALLBACK.uz;
      const wav = await synthesize(greeting, agent.voice_id, callId);
      return audioResponse(wav, { callId, escalate: '', text: greeting });
    }

    // ── Later legs need the caller's finished utterance audio. ──
    if (!audio) return Response.json({ error: 'missing_audio' }, { status: 400 });

    const t0 = performance.now();
    const transcript = await transcribe(audio);
    const sttMs = performance.now() - t0;

    // Nothing recognised — re-prompt without advancing the transcript.
    if (!transcript) {
      const line = REPROMPT[lang] || REPROMPT.uz;
      const wav = await synthesize(line, agent.voice_id, callIdIn);
      return audioResponse(wav, { callId: callIdIn, escalate: '', text: line });
    }

    // ── The turn engine: retrieval + generation + escalation + persistence. ──
    const result = await runTurn({
      tenantId: number.tenant_id,
      callId: callIdIn,
      agent,
      utterance: transcript,
      sttMs,
    });

    // On escalate, result.reply is already the spoken handoff line — synthesize
    // it and flag the reason; the bridge plays it and ends the call (no transfer).
    const wav = await synthesize(result.reply, agent.voice_id, callIdIn);
    return audioResponse(wav, {
      callId: callIdIn,
      escalate: result.escalate ?? '',
      text: result.reply,
    });
  } catch (err) {
    const status = err instanceof BridgeError ? err.status : 502;
    const message = err instanceof Error ? err.message : 'bridge_error';
    console.warn('[bridge/turn]', message);
    return Response.json({ error: message }, { status });
  }
}

/* ── auth ─────────────────────────────────────────────────────── */

function secretMatches(provided: string | null, expected: string): boolean {
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on unequal-length buffers.
  return a.length === b.length && timingSafeEqual(a, b);
}

function field(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}

/* ── STT: replicate the multipart request shape of /api/speech/stt ─ */

async function transcribe(wav: Blob): Promise<string> {
  const url = process.env.STT_TRANSCRIBE_URL;
  if (!url) throw new BridgeError('stt_not_configured', 503);

  const buf = await wav.arrayBuffer();
  if (!buf.byteLength) throw new BridgeError('empty_audio', 400);

  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');

  const res = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`[bridge/turn] stt ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    throw new BridgeError('stt_failed', 502);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

/* ── TTS: replicate the JWT-mint + generate flow of /api/speech/tts ─ */

let ttsCache: { token: string; exp: number } | null = null;

async function ttsToken(base: string): Promise<string | null> {
  const secret = process.env.TTS_CLIENT_SECRET;
  // Without a client secret, use a directly-supplied token (expires ~24h).
  if (!secret) return process.env.TTS_JWT_TOKEN?.trim() || null;

  if (ttsCache && Date.now() < ttsCache.exp) return ttsCache.token;
  const clientId = process.env.TTS_CLIENT_ID || 'frontend';

  const res = await fetch(`${base}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: secret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[bridge/turn] tts auth ${res.status}`);
    return null;
  }
  const d = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh two minutes early so a token never expires mid-request.
  ttsCache = { token: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return ttsCache.token;
}

/** Map a catalog voice id (nilufar/timur) to the internal server's profile. */
function voiceProfile(voiceId?: string): string {
  const male = VOICES.find((v) => v.id === voiceId)?.gender === 'male';
  return male
    ? process.env.TTS_VOICE_MALE || 'uz_male_news'
    : process.env.TTS_VOICE_FEMALE || 'uz_female_calm';
}

/** Synthesize `text` and return the raw WAV bytes (8 kHz from the TTS service). */
async function synthesize(text: string, voiceId: string, tag: string): Promise<ArrayBuffer> {
  const base = process.env.TTS_BASE_URL;
  if (!base || (!process.env.TTS_CLIENT_SECRET && !process.env.TTS_JWT_TOKEN)) {
    throw new BridgeError('tts_not_configured', 503);
  }
  const token = await ttsToken(base);
  if (!token) throw new BridgeError('tts_auth_failed', 502);

  // The internal server keys generated audio by user_id; make it unique per turn.
  const userId = `bridge_${tag.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20)}_${Date.now()}`;
  const auth = { Authorization: `Bearer ${token}` };

  const gen = await fetch(`${base}/api/v1/tts/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      user_id: userId,
      phone: '+000000000',
      text: text.slice(0, 2000),
      voice_profile: voiceProfile(voiceId),
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!gen.ok) {
    console.warn(`[bridge/turn] tts generate ${gen.status}: ${(await gen.text().catch(() => '')).slice(0, 160)}`);
    throw new BridgeError('tts_failed', 502);
  }

  const audioRes = await fetch(`${base}/api/v1/tts/audio/${encodeURIComponent(userId)}?inline=true`, {
    headers: auth,
    signal: AbortSignal.timeout(30000),
  });
  if (!audioRes.ok) throw new BridgeError('tts_audio_failed', 502);
  return audioRes.arrayBuffer();
}

/* ── response ─────────────────────────────────────────────────── */

function audioResponse(
  wav: ArrayBuffer,
  meta: { callId: string; escalate: string; text: string },
): Response {
  return new Response(wav, {
    status: 200,
    headers: {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'x-ovoz-callid': meta.callId,
      'x-ovoz-escalate': meta.escalate,
      'x-ovoz-text': Buffer.from(meta.text, 'utf8').toString('base64'),
    },
  });
}
