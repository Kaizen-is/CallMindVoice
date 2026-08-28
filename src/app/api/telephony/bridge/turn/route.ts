/**
 * Asterisk/FreePBX ↔ Ovoz voice bridge — TURN endpoint.
 *
 * The standalone AudioSocket bridge (`telephony-bridge/bridge.mjs`) POSTs one
 * complete caller utterance here and gets the agent's spoken reply back, with
 * the call metadata carried in response headers. Every secret — the internal
 * STT/TTS credentials and the LLM engine — stays in this Next.js app; the
 * bridge only holds `NEXT_BASE_URL` + the shared secret.
 *
 * ── The reply is STREAMED ────────────────────────────────────────────────────
 * The body is raw 8 kHz mono signed-16 PCM (`audio/L16`), not a WAV, and it is
 * produced incrementally: the reply is split into sentences, those are rendered
 * concurrently, and each is written to the response the moment it is ready.
 * The caller therefore starts hearing sentence one while sentence three is
 * still being synthesised. Sending a WAV instead would mean sending nothing at
 * all until the last sentence finished rendering — the old behaviour, and the
 * single largest source of dead air on the line.
 *
 * Because the headers are flushed before the first audio byte, everything the
 * bridge needs to make decisions (call id, escalation, transcript) arrives
 * ahead of the audio rather than after it.
 *
 * ── Endpointing contract ─────────────────────────────────────────────────────
 * The STT service expects a COMPLETE WAV utterance, not a live stream. The
 * bridge owns voice-activity detection and endpointing; this handler runs
 * STT → runTurn → TTS on whatever finished utterance it is handed.
 *
 * ── Pipeline ─────────────────────────────────────────────────────────────────
 *   first leg  (first=true | no callId): startCall → TTS(greeting, cached)
 *   later legs (callId + audio):          STT → runTurn → TTS(reply, streamed)
 *
 * ── Response headers ─────────────────────────────────────────────────────────
 *   x-ovoz-callid    the Ovoz DB call id (minted on the first leg, reused)
 *   x-ovoz-escalate  the escalation reason, or ''. On escalate we STILL return
 *                    the spoken handoff line; in-call SIP transfer is out of
 *                    scope for v1, so the bridge plays it and hangs up.
 *   x-ovoz-text      base64(utf-8) of the reply text (HTTP headers cannot
 *                    safely carry raw multi-byte UTF-8).
 *   x-ovoz-engine    which STT engine actually produced the transcript.
 */
import { get, run } from '@/lib/db';
import { startCall } from '@/lib/engine/calls';
import { runTurn } from '@/lib/engine/conversation';
import { authorizeBridge, resolveTarget, isResponse } from '@/lib/telephony/bridge';
import { transcribe, SttError } from '@/lib/speech/stt';
import { synthesizePcm, synthesizeStream, TtsError } from '@/lib/speech/tts';
import type { Locale } from '@/lib/types';

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

export async function POST(request: Request): Promise<Response> {
  const denied = authorizeBridge(request);
  if (denied) return denied;

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
  const spokenRatio = Number(field(form.get('spokenRatio')));
  const audioField = form.get('audio');
  const audio = audioField && typeof audioField !== 'string' ? (audioField as Blob) : null;

  const target = resolveTarget(to);
  if (isResponse(target)) return target;
  const { number, agent, language: lang } = target;

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
      // The greeting is identical on every call, so it is served from the TTS
      // disk cache — no synthesis round-trip in the first second of the call.
      const pcm = await synthesizePcm(greeting, {
        tenantId: number.tenant_id,
        voiceId: agent.voice_id,
        language: lang,
        tag: 'greeting',
        cache: true,
      });
      return pcmResponse(pcm, { callId, escalate: '', text: greeting, engine: 'none' });
    }

    // ── Barge-in bookkeeping, before anything else touches the transcript. ──
    // The bridge reports how much of its previous reply the caller actually
    // heard before interrupting. Leaving the full text in place would have the
    // model believe it said things that never reached the line.
    if (spokenRatio > 0 && spokenRatio < 1) {
      truncateLastAgentTurn(number.tenant_id, callIdIn, spokenRatio);
    }

    // ── Later legs need the caller's finished utterance audio. ──
    if (!audio) return Response.json({ error: 'missing_audio' }, { status: 400 });

    const t0 = performance.now();
    const heard = await transcribe(await audio.arrayBuffer(), { language: lang });
    const sttMs = performance.now() - t0;

    // Nothing recognised — re-prompt without advancing the transcript. Fixed
    // text, so this is another cache hit rather than a synthesis.
    if (!heard.text) {
      const line = REPROMPT[lang] || REPROMPT.uz;
      const pcm = await synthesizePcm(line, {
        tenantId: number.tenant_id,
        voiceId: agent.voice_id,
        language: lang,
        tag: 'reprompt',
        cache: true,
      });
      return pcmResponse(pcm, { callId: callIdIn, escalate: '', text: line, engine: heard.engine });
    }

    // ── The turn engine: retrieval + generation + escalation + persistence. ──
    const result = await runTurn({
      tenantId: number.tenant_id,
      callId: callIdIn,
      agent,
      utterance: heard.text,
      sttMs,
    });

    // On escalate, result.reply is already the spoken handoff line — the bridge
    // plays it and ends the call (no in-call transfer in v1).
    const stream = synthesizeStream(result.reply, {
      tenantId: number.tenant_id,
      voiceId: agent.voice_id,
      language: result.language,
      tag: 'reply',
    });
    return streamResponse(stream, {
      callId: callIdIn,
      escalate: result.escalate ?? '',
      text: result.reply,
      engine: heard.engine,
    });
  } catch (err) {
    const status = err instanceof TtsError || err instanceof SttError ? err.status : 502;
    const message = err instanceof Error ? err.message : 'bridge_error';
    console.warn('[bridge/turn]', message);
    return Response.json({ error: message }, { status });
  }
}

/* ── barge-in ─────────────────────────────────────────────────── */

/**
 * Cut the last agent turn down to the fraction the caller actually heard.
 *
 * Word-proportional truncation is an approximation — the bridge knows how many
 * audio frames it sent, not which word was mid-flight — but it is far closer to
 * the truth than keeping the whole reply, and the ellipsis tells the model (and
 * any human reading the transcript) that it was cut off.
 */
function truncateLastAgentTurn(tenantId: string, callId: string, ratio: number): void {
  const row = lastAgentTurn(tenantId, callId);
  if (!row) return;
  const words = row.text.split(/\s+/).filter(Boolean);
  const keep = Math.max(1, Math.floor(words.length * ratio));
  if (keep >= words.length) return;
  run(
    'UPDATE turns SET text=? WHERE id=?',
    `${words.slice(0, keep).join(' ')}…`,
    row.id,
  );
}

function lastAgentTurn(tenantId: string, callId: string) {
  return get<{ id: string; text: string }>(
    `SELECT id, text FROM turns WHERE tenant_id=? AND call_id=? AND role='agent'
     ORDER BY ordinal DESC LIMIT 1`,
    tenantId,
    callId,
  );
}

/* ── responses ────────────────────────────────────────────────── */

interface Meta {
  callId: string;
  escalate: string;
  text: string;
  engine: string;
}

function headers(meta: Meta): HeadersInit {
  return {
    // Raw telephony PCM: no container, so the bridge can forward frames the
    // instant they arrive instead of waiting for a length-prefixed header.
    'Content-Type': 'audio/L16; rate=8000; channels=1',
    'Cache-Control': 'no-store',
    'x-ovoz-callid': meta.callId,
    'x-ovoz-escalate': meta.escalate,
    'x-ovoz-text': Buffer.from(meta.text, 'utf8').toString('base64'),
    'x-ovoz-engine': meta.engine,
  };
}

function pcmResponse(pcm: Buffer, meta: Meta): Response {
  return new Response(new Uint8Array(pcm), { status: 200, headers: headers(meta) });
}

function streamResponse(chunks: AsyncGenerator<Buffer>, meta: Meta): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      } catch (err) {
        console.warn('[bridge/turn] stream aborted:', err instanceof Error ? err.message : err);
        // Close rather than error: the caller keeps whatever was already spoken
        // instead of the line dropping mid-sentence.
        controller.close();
      }
    },
    cancel() {
      // The bridge hung up or the caller barged in — stop rendering the rest.
      void chunks.return(undefined);
    },
  });
  return new Response(body, { status: 200, headers: headers(meta) });
}

function field(v: FormDataEntryValue | null): string {
  return typeof v === 'string' ? v : '';
}
