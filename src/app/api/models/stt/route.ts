/**
 * Try one speech-to-text model on one recording — For developers ▸ STT.
 *
 * POST multipart: `file` (16 kHz mono 16-bit WAV), `engine` (an STT id from
 * the model list: kotib, gapi, local, speko, gemini, scribe), `language` (uz | ru | en).
 * → { text, engine, ms }
 *
 * Exactly that engine: no race, no fallback, no noise cleaning, so what comes
 * back is what the chosen model heard.
 */
import { currentSession } from '@/lib/auth';
import { sttEngineIds, transcribeOne, type SttEngineId } from '@/lib/speech/stt';
import type { Locale } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 10 * 1024 * 1024;
const LANGUAGES: readonly Locale[] = ['uz', 'ru', 'en'];

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: 'expected_multipart_form' }, { status: 400 });
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return Response.json({ error: 'empty_audio' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: 'audio_too_large' }, { status: 413 });

  const ready = sttEngineIds() as Record<string, boolean>;
  const engine = String(form.get('engine') ?? '');
  if (!ready[engine]) return Response.json({ error: 'engine_not_ready' }, { status: 400 });
  const lang = String(form.get('language') ?? '');
  const language: Locale = (LANGUAGES as readonly string[]).includes(lang) ? (lang as Locale) : 'uz';

  const started = performance.now();
  try {
    const heard = await transcribeOne(engine as SttEngineId, await file.arrayBuffer(), language);
    return Response.json({ text: heard.text, engine, ms: Math.round(performance.now() - started) });
  } catch (err) {
    console.warn('[models/stt] failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: err instanceof Error ? err.message : 'stt_failed' }, { status: 502 });
  }
}
