/**
 * Public demo — one spoken turn. The browser posts the utterance it recorded;
 * the response streams what the STT heard, the agent's reply, and the reply's
 * voice, all in one round trip (see `@/lib/demo`).
 */
import {
  admit,
  claimCall,
  closeDemoCall,
  demoAgent,
  demoLang,
  demoTarget,
  demoVoice,
  eventStream,
  fillerFor,
  liveDemoCall,
  releaseCall,
  speak,
} from '@/lib/demo';
import { runTurn } from '@/lib/engine/conversation';
import { transcribe } from '@/lib/speech/stt';

/** About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s. */
const MAX_AUDIO_BYTES = 1_400_000;

export async function POST(request: Request): Promise<Response> {
  if (!admit('turn', request)) return Response.json({ error: 'busy' }, { status: 429 });
  const agent = demoAgent();
  if (!agent) return Response.json({ error: 'unavailable' }, { status: 503 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  const audio = form.get('audio');
  const callId = String(form.get('callId') ?? '');
  const lang = demoLang(form.get('lang'));
  const voiceId = demoVoice(agent, form.get('voice'));
  if (!(audio instanceof File) || !audio.size || audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'bad_audio' }, { status: 400 });
  }
  if (!liveDemoCall(callId)) return Response.json({ error: 'ended' }, { status: 410 });

  const wav = await audio.arrayBuffer();
  if (!claimCall(callId)) return Response.json({ error: 'busy_call' }, { status: 409 });

  return eventStream(async (send, signal) => {
    // The lock guards the transcript, not the voice: it is released as soon as
    // the turn is written down, so a visitor who talks over the reply is not
    // refused while that reply is still being voiced.
    let sttMs = 0;
    let result: Awaited<ReturnType<typeof runTurn>> | null = null;
    try {
      const started = performance.now();
      const heard = await transcribe(wav, { language: lang, denoise: true });
      sttMs = Math.round(performance.now() - started);
      send({ t: 'heard', text: heard.text });
      if (heard.text) {
        const filler = fillerFor(agent, callId, heard.text, voiceId);
        if (filler) send({ t: 'filler', pcm: filler });
        result = await runTurn({
          tenantId: agent.tenant_id,
          callId,
          agent,
          utterance: heard.text,
          sttMs,
          target: demoTarget(agent),
        });
      }
    } finally {
      releaseCall(callId);
    }
    if (!result) {
      send({ t: 'done' });
      return;
    }

    // An escalation is a transfer to a human, who is not on this page: the
    // agent says its hand-off line and the call ends.
    const end = result.escalate ? 'transfer' : null;
    send({
      t: 'reply',
      text: result.reply,
      lang: result.language,
      end,
      ms: { stt: sttMs, retrieval: result.timings.retrievalMs, llm: result.timings.llmMs },
    });
    if (end) closeDemoCall(callId, 'resolved_by_operator');
    await speak(agent, result.reply, result.language, send, signal, voiceId);
    send({ t: 'done' });
  });
}
