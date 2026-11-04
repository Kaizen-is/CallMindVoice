/**
 * Playground voice call — one spoken turn, in one round trip, as the public
 * demo's `/api/demo/turn`: the browser posts the phrase it recorded, and the
 * response streams what the STT heard, the reply as it is written, the reply's
 * voice, and finally the turn's numbers and sources for the side panels.
 *
 * `?prefetch=1`: the caller has paused, probably at the end of the phrase —
 * transcribe now and keep it for the turn that follows.
 */
import { currentSession } from '@/lib/auth';
import { runTurn } from '@/lib/engine/conversation';
import { callLang, ownedPlaygroundCall, playgroundAgent, turnDetail } from '@/lib/playground';
import {
  claimCall,
  eventStream,
  fillerFor,
  heardIn,
  prefetchHeard,
  releaseCall,
  speakAsWritten,
  speakingAgent,
  sttPick,
  voicePick,
} from '@/lib/playground-voice';
import { detectLanguage } from '@/lib/rag/text';
import { uzbekNumbersToDigits } from '@/lib/speech/numbers';
import type { Locale } from '@/lib/types';

/** About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s. */
const MAX_AUDIO_BYTES = 1_400_000;

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const prefetch = new URL(request.url).searchParams.get('prefetch') === '1';

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const audio = form.get('audio');
  const callId = String(form.get('callId') ?? '');
  // Streaming STT (Zipformer) transcribes in the browser's call while the
  // caller speaks; the phrase then arrives as text and needs no STT pass here.
  const streamed = String(form.get('text') ?? '').trim().slice(0, 2000);
  const hasAudio = audio instanceof File && audio.size > 0 && audio.size <= MAX_AUDIO_BYTES;
  if (!streamed && !hasAudio) return Response.json({ error: 'bad_audio' }, { status: 400 });
  const call = ownedPlaygroundCall(session.tenant.id, callId);
  if (!call || call.ended_at) return Response.json({ error: 'ended' }, { status: 410 });
  const saved = playgroundAgent(session.tenant.id, call.agent_id);
  if (!saved) return Response.json({ error: 'no_agent' }, { status: 404 });

  const lang = callLang(form.get('lang'), saved);
  const stt = sttPick(form.get('sttEngine'));
  const wav = hasAudio ? await (audio as File).arrayBuffer() : new ArrayBuffer(0);
  if (prefetch) {
    if (!hasAudio) return Response.json({ error: 'bad_audio' }, { status: 400 });
    prefetchHeard(callId, wav, lang, stt);
    return new Response(null, { status: 202 });
  }
  const pick = voicePick(saved, form.get('ttsEngine'), form.get('voice'));
  const agent = speakingAgent(saved, pick);
  if (!claimCall(callId)) return Response.json({ error: 'busy_call' }, { status: 409 });

  return eventStream(async (send, signal) => {
    // The lock guards the transcript, not the voice: released once the turn is
    // written down, so talking over the reply is never refused.
    let sttMs = 0;
    let result: Awaited<ReturnType<typeof runTurn>> | null = null;
    let voice: ReturnType<typeof speakAsWritten> | null = null;
    try {
      const started = performance.now();
      let heard;
      try {
        heard = streamed
          ? { text: uzbekNumbersToDigits(streamed), engine: 'local' as const, language: lang }
          : await heardIn(callId, wav, lang, stt);
      } catch (err) {
        // The recogniser failed (down, unreachable, bad key): say so plainly,
        // so the page can tell the caller which part broke.
        console.warn('[playground] stt failed:', err instanceof Error ? err.message : err);
        send({ t: 'error', code: 'stt' });
        return;
      }
      sttMs = Math.round(performance.now() - started);
      send({ t: 'heard', text: heard.text });
      if (heard.text) {
        const filler = fillerFor(agent, callId, heard.text, pick);
        if (filler) send({ t: 'filler', pcm: filler });
        const speaker = speakAsWritten(agent, detectLanguage(heard.text) as Locale, pick, send, signal);
        voice = speaker;
        result = await runTurn({
          tenantId: session.tenant.id,
          callId,
          agent,
          utterance: heard.text,
          sttMs,
          onDelta: (delta) => speaker.push(delta),
        });
      }
    } finally {
      releaseCall(callId);
    }
    if (!result || !voice) {
      await voice?.finish('');
      send({ t: 'done' });
      return;
    }

    await voice.finish(result.reply);
    send({
      t: 'final',
      text: result.reply,
      end: null,
      ms: { stt: sttMs, retrieval: result.timings.retrievalMs, llm: result.timings.llmMs },
    });
    send({ t: 'detail', detail: turnDetail(result) });
    send({ t: 'done' });
  });
}
