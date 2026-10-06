/**
 * Public demo — the visitor has picked up. Opens a call and streams back its
 * id, the agent's opening line and that line's voice (see `@/lib/demo`).
 */
import {
  admit,
  demoAgent,
  demoLang,
  demoVoice,
  eventStream,
  openDemoCall,
  openingLine,
  seedOpening,
  speak,
} from '@/lib/demo';

export async function POST(request: Request): Promise<Response> {
  if (!admit('call', request)) return Response.json({ error: 'busy' }, { status: 429 });
  const agent = demoAgent();
  if (!agent) return Response.json({ error: 'unavailable' }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { lang?: unknown; voice?: unknown };
  const lang = demoLang(body.lang);
  const voiceId = demoVoice(agent, body.voice);
  const callId = openDemoCall(agent, lang);

  return eventStream(async (send, signal) => {
    send({ t: 'call', callId });
    const text = await openingLine(agent, lang);
    seedOpening(agent, callId, lang, text);
    send({ t: 'reply', text, lang, end: null });
    await speak(agent, text, lang, send, signal, voiceId);
    send({ t: 'done' });
  });
}
