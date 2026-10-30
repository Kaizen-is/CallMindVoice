/**
 * Logistics demo — the visitor rings the company. Opens a call and streams
 * back its id, the agent's greeting and that greeting's voice (see `@/lib/logistics`).
 */
import { admit, demoLang, eventStream, speak } from '@/lib/demo';
import {
  greetingFor,
  logisticsAgent,
  logisticsVoice,
  openLogisticsCall,
  seedGreeting,
} from '@/lib/logistics';

export async function POST(request: Request): Promise<Response> {
  if (!admit('call', request)) return Response.json({ error: 'busy' }, { status: 429 });
  const agent = logisticsAgent();

  const body = (await request.json().catch(() => ({}))) as { lang?: unknown; voice?: unknown };
  const lang = demoLang(body.lang);
  const voiceId = logisticsVoice(body.voice);
  const callId = openLogisticsCall(agent, lang);

  return eventStream(async (send, signal) => {
    send({ t: 'call', callId });
    const text = greetingFor(lang, voiceId);
    seedGreeting(agent, callId, lang, text);
    send({ t: 'reply', text, lang, end: null });
    await speak(agent, text, lang, send, signal, voiceId);
    send({ t: 'done' });
  });
}
