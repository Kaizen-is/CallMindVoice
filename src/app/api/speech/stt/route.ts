/**
 * Speech-to-text proxy → the internal Uzbek model (Kotib) and/or Whisper turbo.
 *
 * The browser records the mic, encodes 16 kHz mono WAV, and POSTs the bytes
 * here. Engine selection, the Kotib/Whisper race for code-switching callers and
 * hallucination filtering all live in `@/lib/speech/stt`, shared with the
 * telephony bridge so the console hears exactly what the phone line hears.
 */
import { currentSession } from '@/lib/auth';
import { transcribe, sttConfigured, SttError } from '@/lib/speech/stt';
import type { Locale } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!sttConfigured()) return Response.json({ error: 'stt_not_configured' }, { status: 503 });

  // Accept both raw audio bodies and multipart uploads. Multipart is what the
  // console sends — some reverse proxies/WAFs 403 raw binary POSTs.
  let audio: ArrayBuffer;
  let language: Locale | undefined;
  // Opt-in: the Playground asks for noise cleaning; the STT lab hears raw audio.
  let clean = false;
  if (request.headers.get('content-type')?.includes('multipart/form-data')) {
    const form = await request.formData();
    const upload = form.get('file');
    if (!(upload instanceof File) || upload.size === 0) {
      return Response.json({ error: 'empty_audio' }, { status: 400 });
    }
    audio = await upload.arrayBuffer();
    const lang = form.get('language');
    if (typeof lang === 'string' && ['uz', 'ru', 'en'].includes(lang)) language = lang as Locale;
    clean = form.get('denoise') === '1';
  } else {
    audio = await request.arrayBuffer();
  }
  if (!audio.byteLength) return Response.json({ error: 'empty_audio' }, { status: 400 });

  try {
    const heard = await transcribe(audio, { language, denoise: clean });
    return Response.json({ text: heard.text, language: heard.language, engine: heard.engine });
  } catch (err) {
    const status = err instanceof SttError ? err.status : 502;
    console.warn('[stt] request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: err instanceof SttError ? err.message : 'stt_unreachable' }, { status });
  }
}
