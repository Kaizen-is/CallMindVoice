/**
 * Playground voice call — picked up. Opens a call with the agent the team
 * chose and streams back its id, the agent's opening line and that line's
 * voice, as the public demo's `/api/demo/call` does. An agent with a "Who to
 * call" person (the banking agent) opens with its model-written call opening;
 * a receptionist with its greeting. See `@/lib/playground-voice`.
 */
import { currentSession } from '@/lib/auth';
import {
  callLang,
  openPlaygroundCall,
  playgroundAgent,
  playgroundOpening,
  seedOpening,
} from '@/lib/playground';
import { eventStream, speak, speakingAgent, voicePick, warmFillers } from '@/lib/playground-voice';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as {
    agentId?: unknown;
    lang?: unknown;
    voice?: unknown;
    ttsEngine?: unknown;
  };
  const saved = playgroundAgent(session.tenant.id, body.agentId);
  if (!saved) return Response.json({ error: 'no_agent' }, { status: 404 });

  const lang = callLang(body.lang, saved);
  const pick = voicePick(saved, body.ttsEngine, body.voice);
  // Introduces itself by the name of the voice the caller hears (see speakingAgent).
  const agent = speakingAgent(saved, pick);
  const callId = openPlaygroundCall(session.tenant.id, session.user.name, agent, lang);
  warmFillers(agent, lang, pick);

  return eventStream(async (send, signal) => {
    send({ t: 'call', callId });
    const text = await playgroundOpening(agent, lang);
    if (!text) {
      // No greeting saved: the line is simply open for the caller to speak first.
      send({ t: 'done' });
      return;
    }
    seedOpening(agent, callId, lang, text);
    send({ t: 'reply', text, lang, end: null });
    await speak(agent, text, lang, pick, send, signal);
    send({ t: 'done' });
  });
}
