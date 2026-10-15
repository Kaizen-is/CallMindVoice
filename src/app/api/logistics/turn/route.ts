/**
 * Logistics demo — one spoken turn. The browser posts the utterance it
 * recorded; GAPI transcribes it (after our noise cleaner), the shipment the
 * caller named is looked up, and the reply streams back with its voice.
 */
import { admit, claimCall, eventStream, releaseCall, speakAsWritten, demoLang } from '@/lib/demo';
import { runTurn } from '@/lib/engine/conversation';
import {
  closeLogisticsCall,
  heardIn,
  liveLogisticsCall,
  logisticsFiller,
  logisticsAgent,
  logisticsVoice,
  prefetchHeard,
  turnContext,
} from '@/lib/logistics';
import { detectLanguage } from '@/lib/rag/text';
import type { Locale } from '@/lib/types';

/** About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s. */
const MAX_AUDIO_BYTES = 1_400_000;

export async function POST(request: Request): Promise<Response> {
  // `?prefetch=1`: the visitor has paused, probably at the end of the phrase —
  // transcribe now and keep it for the turn that follows (see `prefetchHeard`).
  const prefetch = new URL(request.url).searchParams.get('prefetch') === '1';
  if (!admit(prefetch ? 'prefetch' : 'turn', request)) return Response.json({ error: 'busy' }, { status: 429 });
  const agent = logisticsAgent();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const audio = form.get('audio');
  const callId = String(form.get('callId') ?? '');
  const lang = demoLang(form.get('lang'));
  const voiceId = logisticsVoice(form.get('voice'));
  if (!(audio instanceof File) || !audio.size || audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'bad_audio' }, { status: 400 });
  }
  if (!liveLogisticsCall(callId)) return Response.json({ error: 'ended' }, { status: 410 });

  const wav = await audio.arrayBuffer();
  if (prefetch) {
    prefetchHeard(callId, wav, lang);
    return new Response(null, { status: 202 });
  }
  if (!claimCall(callId)) return Response.json({ error: 'busy_call' }, { status: 409 });

  return eventStream(async (send, signal) => {
    // Per-turn timing in the server log, to see where a slow reply spent its time.
    const t0 = performance.now();
    let firstAudioMs = 0;
    let fillerSent = false;
    const timedSend: typeof send = (event) => {
      if (event.t === 'audio' && !firstAudioMs) firstAudioMs = Math.round(performance.now() - t0);
      send(event);
    };
    let sttMs = 0;
    let result: Awaited<ReturnType<typeof runTurn>> | null = null;
    let voice: ReturnType<typeof speakAsWritten> | null = null;
    try {
      const started = performance.now();
      const heard = await heardIn(callId, wav, lang).catch((err) => {
        console.warn('[logistics] stt failed:', err instanceof Error ? err.message : err);
        return { text: '', engine: 'none' as const, language: null };
      });
      sttMs = Math.round(performance.now() - started);
      send({ t: 'heard', text: heard.text });
      if (heard.text) {
        const filler = logisticsFiller(agent, callId, heard.text, voiceId);
        if (filler) send({ t: 'filler', pcm: filler });
        fillerSent = Boolean(filler);
        const speaker = speakAsWritten(agent, detectLanguage(heard.text) as Locale, timedSend, signal, voiceId);
        voice = speaker;
        result = await runTurn({
          tenantId: agent.tenant_id,
          callId,
          agent,
          utterance: heard.text,
          sttMs,
          context: turnContext(voiceId),
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

    // An explicit "give me a person" is a transfer to a human, who is not on
    // this page: the agent says its hand-off line and the call ends.
    const end = result.escalate ? 'transfer' : null;
    if (end) closeLogisticsCall(callId, 'resolved_by_operator');
    await voice.finish(result.reply);
    send({
      t: 'final',
      text: result.reply,
      end,
      ms: { stt: sttMs, retrieval: result.timings.retrievalMs, llm: result.timings.llmMs },
    });
    console.log(
      `[logistics] turn ${callId.slice(-6)}: stt ${sttMs} ms, llm ${result.timings.llmMs} ms, ` +
        `first audio ${firstAudioMs} ms, all voiced ${Math.round(performance.now() - t0)} ms` +
        `, filler ${fillerSent ? 'yes' : 'no'}, ${result.reply.split(/\s+/).length} words`,
    );
    send({ t: 'done' });
  });
}
