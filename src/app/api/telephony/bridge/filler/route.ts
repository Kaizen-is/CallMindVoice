/**
 * Asterisk/FreePBX ↔ Ovoz voice bridge — FILLER endpoint.
 *
 * Returns a short pre-rendered holding line ("bir daqiqa", "сейчас посмотрю")
 * in the agent's voice and language, as raw 8 kHz PCM.
 *
 * The bridge fetches a handful of these once, while the greeting is still
 * playing, and caches them in memory for the life of the call. When the caller
 * finishes speaking it plays one immediately — covering the retrieval and
 * generation latency with something a human would actually say, instead of
 * dead air. Nothing here is on the critical path of a turn: by the time a
 * filler is needed it is already sitting in the bridge's memory.
 *
 * Server-side these lines are fixed text, so they come out of the TTS disk
 * cache and cost a file read rather than a synthesis.
 */
import { fillerLines, fillerPcm } from '@/lib/speech/fillers';
import { authorizeBridge, resolveTarget, isResponse } from '@/lib/telephony/bridge';
import { TtsError } from '@/lib/speech/tts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeBridge(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? '';
  const index = Number(url.searchParams.get('i') ?? '0');

  const target = resolveTarget(to);
  if (isResponse(target)) return target;
  const { number, agent, language } = target;

  try {
    const pcm = await fillerPcm({
      tenantId: number.tenant_id,
      voiceId: agent.voice_id,
      language,
      index: Number.isFinite(index) ? index : 0,
    });
    return new Response(new Uint8Array(pcm), {
      headers: {
        'Content-Type': 'audio/L16; rate=8000; channels=1',
        'Cache-Control': 'no-store',
        'x-ovoz-count': String(fillerLines(language).length),
      },
    });
  } catch (err) {
    const status = err instanceof TtsError ? err.status : 502;
    console.warn('[bridge/filler]', err instanceof Error ? err.message : err);
    return Response.json({ error: 'filler_failed' }, { status });
  }
}
