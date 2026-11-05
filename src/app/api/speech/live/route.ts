/**
 * Live Zipformer transcription for the Playground — word by word, in-process.
 *
 * While the caller speaks the browser posts its microphone here in quarter-
 * second pieces (16 kHz mono 16-bit PCM) and gets back the whole utterance
 * heard so far. Multipart, like `/api/speech/stt`, because some proxies reject
 * raw binary POSTs.
 *
 *   sid    the browser's session id (one per open call)
 *   op     feed | finish | reset | close
 *   audio  the PCM piece (feed, optionally finish)
 */
import { currentSession } from '@/lib/auth';
import { closeLive, feedLive, finishLive, pcm16ToFloat, resetLive, zipformerAvailable } from '@/lib/speech/zipformer';

const MAX_PIECE_BYTES = 512 * 1024; // ~16 s of audio; real pieces are 8 KB

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!zipformerAvailable()) return Response.json({ error: 'zipformer_not_available' }, { status: 503 });

  const form = await request.formData().catch(() => null);
  const sid = form?.get('sid');
  const op = form?.get('op');
  if (typeof sid !== 'string' || !/^[\w-]{8,64}$/.test(sid)) {
    return Response.json({ error: 'bad_session' }, { status: 400 });
  }
  const owner = session.user.id;

  let samples: Float32Array | undefined;
  const audio = form?.get('audio');
  if (audio instanceof File && audio.size) {
    if (audio.size > MAX_PIECE_BYTES) return Response.json({ error: 'piece_too_large' }, { status: 413 });
    samples = pcm16ToFloat(Buffer.from(await audio.arrayBuffer()));
  }

  try {
    switch (op) {
      case 'feed':
        return Response.json({ text: feedLive(owner, sid, samples ?? new Float32Array(0)) });
      case 'finish':
        return Response.json({ text: finishLive(owner, sid, samples) });
      case 'reset':
        resetLive(owner, sid);
        return Response.json({ text: '' });
      case 'close':
        closeLive(owner, sid);
        return Response.json({ ok: true });
      default:
        return Response.json({ error: 'bad_op' }, { status: 400 });
    }
  } catch (err) {
    console.warn('[zipformer] live request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: 'zipformer_failed' }, { status: 502 });
  }
}
