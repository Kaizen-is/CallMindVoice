/**
 * Text-to-speech proxy → internal Uzbek TTS (OmniVoice).
 *
 * Two response shapes, chosen by the caller:
 *
 *   • `stream: true` → raw mono PCM (`audio/L16`), chunked, one sentence
 *     at a time as each renders. 8 kHz, unless the caller asks an ElevenLabs
 *     model for `rate: 24000`; `X-Audio-Rate` says which. This is the same wire format the telephony
 *     bridge consumes, and it exists for the same reason: the listener hears
 *     sentence one while sentence three is still on the GPU. The Playground
 *     plays it through Web Audio (`<audio>` cannot start on a headerless
 *     stream), and reassembles a WAV afterwards for the replay button.
 *
 *   • otherwise → a complete WAV, for callers that just want a file.
 *
 * All the real work — JWT mint and refresh, voice resolution, spoken-form
 * normalisation, the disk cache — lives in `@/lib/speech/tts`, shared with the
 * bridge so both paths sound identical. Unconfigured ⇒ 503, and the client
 * falls back to the browser's own speech synthesiser.
 */
import { currentSession } from '@/lib/auth';
import { isTtsEngine, outputRate, synthesizeStream, synthesizeWav, ttsConfigured, TtsError } from '@/lib/speech/tts';
import type { Locale } from '@/lib/types';

/**
 * Short text is almost always a fixed line — a filler, a greeting, a stock
 * question being re-tested — so it is worth caching on disk. Long text is a
 * one-off answer and caching it would only fill the directory.
 */
const CACHEABLE_CHARS = 120;

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { text, voice, language, stream, engine: asked, rate } = (await request.json()) as {
    text?: string;
    voice?: string;
    language?: Locale;
    stream?: boolean;
    /** The Playground's model picker; omitted ⇒ the internal TTS server. */
    engine?: string;
    /** Sample rate for an ElevenLabs model (8000 | 16000 | 24000); omitted ⇒ 8 kHz, as before. */
    rate?: number;
  };
  const engine = isTtsEngine(asked) ? asked : 'default';
  if (!ttsConfigured(engine)) return Response.json({ error: 'tts_not_configured' }, { status: 503 });
  if (!text?.trim()) return Response.json({ error: 'empty_text' }, { status: 400 });

  const opts = {
    tenantId: session.tenant.id,
    voiceId: voice,
    language: language ?? ('uz' as Locale),
    tag: `pg_${session.user.id.slice(0, 8)}`,
    cache: text.trim().length <= CACHEABLE_CHARS,
    engine,
    sampleRate: typeof rate === 'number' ? rate : undefined,
  };
  const sentRate = outputRate(opts);

  try {
    if (stream) return streamResponse(synthesizeStream(text, opts), sentRate);
    const wav = await synthesizeWav(text, opts);
    return new Response(new Uint8Array(wav), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Audio-Rate': String(sentRate) },
    });
  } catch (err) {
    const status = err instanceof TtsError ? err.status : 502;
    console.warn('[tts] request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: err instanceof TtsError ? err.message : 'tts_unreachable' }, { status });
  }
}

function streamResponse(chunks: AsyncGenerator<Buffer>, rate: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value));
      } catch (err) {
        console.warn('[tts] stream aborted:', err instanceof Error ? err.message : err);
        // Close rather than error, so the listener keeps what already played.
        controller.close();
      }
    },
    cancel() {
      // The listener navigated away or barged in — stop rendering the rest.
      void chunks.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': `audio/L16; rate=${rate}; channels=1`,
      'Cache-Control': 'no-store',
      'X-Audio-Rate': String(rate),
    },
  });
}
