/**
 * Text-to-speech proxy → internal Uzbek TTS (OmniVoice).
 *
 * The console and playground POST text here and get a WAV back. All of the
 * actual work — JWT mint and refresh, voice resolution, spoken-form
 * normalisation, the disk cache — lives in `@/lib/speech/tts`, shared with the
 * telephony bridge so both paths sound identical. Unconfigured ⇒ 503, and the
 * client falls back to the browser's own speech synthesiser.
 */
import { currentSession } from '@/lib/auth';
import { synthesizeWav, ttsConfigured, TtsError } from '@/lib/speech/tts';
import type { Locale } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!ttsConfigured()) return Response.json({ error: 'tts_not_configured' }, { status: 503 });

  const { text, voice, language } = (await request.json()) as {
    text?: string;
    voice?: string;
    language?: Locale;
  };
  if (!text?.trim()) return Response.json({ error: 'empty_text' }, { status: 400 });

  try {
    const wav = await synthesizeWav(text, {
      tenantId: session.tenant.id,
      voiceId: voice,
      language: language ?? 'uz',
      tag: `pg_${session.user.id.slice(0, 8)}`,
    });
    return new Response(new Uint8Array(wav), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const status = err instanceof TtsError ? err.status : 502;
    console.warn('[tts] request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: err instanceof TtsError ? err.message : 'tts_unreachable' }, { status });
  }
}
