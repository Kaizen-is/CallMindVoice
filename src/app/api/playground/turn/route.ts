/**
 * Console Playground — one spoken turn. The browser posts the utterance it
 * recorded; the response streams what the STT heard, the agent's reply with
 * its numbers and sources, and the reply's voice, all in one round trip.
 */
import { currentSession } from '@/lib/auth';
import { claimCall, eventStream, fillerFor, releaseCall, speak } from '@/lib/demo';
import { runTurn } from '@/lib/engine/conversation';
import {
  callLang,
  callVoice,
  closePlaygroundCall,
  ownedPlaygroundCall,
  playgroundAgent,
  turnDetail,
} from '@/lib/playground';
import { transcribe } from '@/lib/speech/stt';

/** About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s. */
const MAX_AUDIO_BYTES = 1_400_000;

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const agent = playgroundAgent(session.tenant.id, form.get('agentId'));
  if (!agent) return Response.json({ error: 'no_agent' }, { status: 404 });
  const audio = form.get('audio');
  if (!(audio instanceof File) || !audio.size || audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'bad_audio' }, { status: 400 });
  }
  const call = ownedPlaygroundCall(session.tenant.id, form.get('callId'), agent.id);
  if (!call) return Response.json({ error: 'no_call' }, { status: 410 });
  const lang = callLang(form.get('lang'), agent);
  const voiceId = callVoice(agent, form.get('voice'));

  const wav = await audio.arrayBuffer();
  if (!claimCall(call.id)) return Response.json({ error: 'busy_call' }, { status: 409 });

  return eventStream(async (send, signal) => {
    let sttMs = 0;
    let result: Awaited<ReturnType<typeof runTurn>> | null = null;
    try {
      const started = performance.now();
      const heard = await transcribe(wav, { language: lang });
      sttMs = Math.round(performance.now() - started);
      send({ t: 'heard', text: heard.text });
      if (heard.text) {
        const filler = fillerFor(agent, call.id, heard.text, voiceId);
        if (filler) send({ t: 'filler', pcm: filler });
        // No target override: the agent's own saved "Who to call" person applies.
        result = await runTurn({ tenantId: session.tenant.id, callId: call.id, agent, utterance: heard.text, sttMs });
      }
    } finally {
      releaseCall(call.id);
    }
    if (!result) {
      send({ t: 'done' });
      return;
    }

    const end = result.escalate ? 'transfer' : null;
    send({
      t: 'reply',
      text: result.reply,
      lang: result.language,
      end,
      ms: { stt: sttMs, retrieval: result.timings.retrievalMs, llm: result.timings.llmMs },
      // Console-only: the numbers and sources for the side panels.
      ...{ detail: turnDetail(result) },
    });
    if (end) closePlaygroundCall(session.tenant.id, call.id);
    await speak(agent, result.reply, result.language, send, signal, voiceId);
    send({ t: 'done' });
  });
}
