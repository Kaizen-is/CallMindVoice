/**
 * Console Playground — pick up. Opens a call with the chosen agent and streams
 * back its id, the agent's opening line and that line's voice, exactly like the
 * public demo (see `@/lib/demo`), but signed in and with the agent's real setup.
 */
import { after } from 'next/server';
import { currentSession } from '@/lib/auth';
import { eventStream, speak } from '@/lib/demo';
import {
  callLang,
  callVoice,
  openPlaygroundCall,
  playgroundAgent,
  playgroundOpening,
  seedOpening,
  warmFillers,
} from '@/lib/playground';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { agentId?: unknown; lang?: unknown; voice?: unknown };
  const agent = playgroundAgent(session.tenant.id, body.agentId);
  if (!agent) return Response.json({ error: 'no_agent' }, { status: 404 });
  const lang = callLang(body.lang, agent);
  const voiceId = callVoice(agent, body.voice);
  const callId = openPlaygroundCall(session.tenant.id, session.user.name, agent, lang);
  after(() => warmFillers(agent, voiceId, lang));

  return eventStream(async (send, signal) => {
    send({ t: 'call', callId });
    const text = await playgroundOpening(agent, lang);
    if (text) {
      seedOpening(agent, callId, lang, text);
      send({ t: 'reply', text, lang, end: null });
      await speak(agent, text, lang, send, signal, voiceId);
    }
    send({ t: 'done' });
  });
}
