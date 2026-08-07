/**
 * Speech-to-text proxy → internal Uzbek STT (`uzbek_stt_v1`).
 *
 * The browser records the mic, encodes 16 kHz mono WAV, and POSTs the raw bytes
 * here. We forward them as multipart to the internal transcribe endpoint (which
 * lives on a private network the browser cannot reach) and return `{ text }`.
 */
import { currentSession } from '@/lib/auth';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const url = process.env.STT_TRANSCRIBE_URL;
  if (!url) return Response.json({ error: 'stt_not_configured' }, { status: 503 });

  const audio = await request.arrayBuffer();
  if (!audio.byteLength) return Response.json({ error: 'empty_audio' }, { status: 400 });

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`[stt] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Response.json({ error: 'stt_failed' }, { status: 502 });
    }
    const data = (await res.json()) as { text?: string; language?: string };
    return Response.json({ text: (data.text ?? '').trim(), language: data.language ?? null });
  } catch (err) {
    console.warn('[stt] request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: 'stt_unreachable' }, { status: 502 });
  }
}
