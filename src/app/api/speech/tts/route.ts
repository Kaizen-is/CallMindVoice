/**
 * Text-to-speech proxy → internal Uzbek TTS (OmniVoice).
 *
 * The TTS service is JWT-protected and returns 8 kHz WAV. With TTS_CLIENT_SECRET
 * the server mints its own token and caches it, auto-refreshing ~2 min before
 * the 24h expiry (a fixed TTS_JWT_TOKEN also works as a fallback). It calls
 * `generate`, then streams the produced WAV back. Unconfigured → 503, and the
 * client falls back to the browser's own speech synthesiser.
 */
import { currentSession } from '@/lib/auth';
import { VOICES } from '@/lib/catalog';

let cache: { token: string; exp: number } | null = null;

async function ttsToken(base: string): Promise<string | null> {
  const secret = process.env.TTS_CLIENT_SECRET;
  // Without a client secret, use a directly-supplied token (it expires in ~24h;
  // supply TTS_CLIENT_SECRET instead to have the server refresh it itself).
  if (!secret) return process.env.TTS_JWT_TOKEN?.trim() || null;

  if (cache && Date.now() < cache.exp) return cache.token;
  const clientId = process.env.TTS_CLIENT_ID || 'frontend';

  const res = await fetch(`${base}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: secret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[tts] auth ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const d = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh two minutes early so a token never expires mid-request.
  cache = { token: d.access_token, exp: Date.now() + (d.expires_in - 120) * 1000 };
  return cache.token;
}

/** Map a catalog voice id (nilufar/timur) to the internal server's profile. */
function resolveVoiceProfile(voiceId?: string): string {
  const male = VOICES.find((v) => v.id === voiceId)?.gender === 'male';
  return male
    ? process.env.TTS_VOICE_MALE || 'uz_male_news'
    : process.env.TTS_VOICE_FEMALE || 'uz_female_calm';
}

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const base = process.env.TTS_BASE_URL;
  if (!base || (!process.env.TTS_CLIENT_SECRET && !process.env.TTS_JWT_TOKEN)) {
    return Response.json({ error: 'tts_not_configured' }, { status: 503 });
  }

  const { text, voice } = (await request.json()) as { text?: string; voice?: string };
  if (!text?.trim()) return Response.json({ error: 'empty_text' }, { status: 400 });

  const token = await ttsToken(base);
  if (!token) return Response.json({ error: 'tts_auth_failed' }, { status: 502 });

  const userId = `pg_${session.user.id.slice(0, 8)}_${Date.now()}`;
  const voiceProfile = resolveVoiceProfile(voice);
  const auth = { Authorization: `Bearer ${token}` };

  try {
    const gen = await fetch(`${base}/api/v1/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        user_id: userId,
        phone: '+000000000',
        text: text.slice(0, 2000),
        voice_profile: voiceProfile,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!gen.ok) {
      console.warn(`[tts] generate ${gen.status}: ${(await gen.text()).slice(0, 200)}`);
      return Response.json({ error: 'tts_failed' }, { status: 502 });
    }

    const audioRes = await fetch(`${base}/api/v1/tts/audio/${encodeURIComponent(userId)}?inline=true`, {
      headers: auth,
      signal: AbortSignal.timeout(30000),
    });
    if (!audioRes.ok) {
      console.warn(`[tts] audio ${audioRes.status}`);
      return Response.json({ error: 'tts_audio_failed' }, { status: 502 });
    }
    return new Response(await audioRes.arrayBuffer(), {
      headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.warn('[tts] request failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: 'tts_unreachable' }, { status: 502 });
  }
}
