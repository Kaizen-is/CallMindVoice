'use client';

/**
 * Streamed speech playback, shared by the Playground and the TTS page so a voice sounds and
 * starts the same in both.
 *
 * /api/speech/tts streams raw mono PCM with no container (8 kHz, or 24 kHz for a Speko model —
 * the X-Audio-Rate header says which), because a container needs its length up front and the
 * whole point is that the length is not known yet — the server is still rendering later
 * sentences. `<audio>` cannot start on that, so chunks are scheduled through Web Audio instead,
 * which also joins sentences on the audio clock rather than by chaining elements, so the seams
 * are inaudible.
 */

/** What the server sends when it says nothing else (our own TTS, phone format). */
export const TTS_RATE = 8000;
/** What the console asks for: 8 kHz cuts everything above 4 kHz and sounds muffled. */
export const WEB_TTS_RATE = 24000;

/** One PCM chunk → an AudioBuffer ready to be scheduled. */
export function pcmToAudioBuffer(ctx: AudioContext, pcm: Uint8Array, rate: number = TTS_RATE): AudioBuffer | null {
  const frames = Math.floor(pcm.length / 2);
  if (!frames) return null;
  const buffer = ctx.createBuffer(1, frames, rate);
  const channel = buffer.getChannelData(0);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

export interface TtsStreamRequest {
  text: string;
  voice?: string;
  language: string;
  engine: string;
}

export interface TtsStreamOptions {
  signal?: AbortSignal;
  /** Polled between chunks: true stops reading (a barge-in, a newer playback). */
  stale?: () => boolean;
  onFirstAudio?: () => void;
  /** Every scheduled source, so the caller can stop them mid-word. */
  onSource?: (source: AudioBufferSourceNode) => void;
}

export interface TtsStreamResult {
  /** All the audio received, 16-bit mono PCM at `rate` (e.g. for a WAV to replay or download). */
  pcm: Uint8Array;
  rate: number;
  /** Audio-clock time at which the last scheduled chunk ends. */
  playhead: number;
}

/**
 * Speak `request` through the streaming TTS endpoint: each chunk plays as soon as it arrives,
 * queued exactly where the previous one ends. Resolves when the stream is fully read (playback
 * may still be running until `playhead`), or null when nothing usable came back.
 */
export async function playTtsStream(
  ctx: AudioContext,
  request: TtsStreamRequest,
  options: TtsStreamOptions = {},
): Promise<TtsStreamResult | null> {
  // Autoplay policy keeps the context suspended until a user gesture; a click started this.
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  let res: Response;
  try {
    res = await fetch('/api/speech/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true, rate: WEB_TTS_RATE }),
      signal: options.signal,
    });
  } catch {
    return null; // aborted or offline
  }
  if (!res.ok || !res.body) return null;
  const rate = Number(res.headers.get('x-audio-rate')) || TTS_RATE;

  const reader = res.body.getReader();
  const received: Uint8Array[] = [];
  // A chunk boundary can land mid-sample; carry the odd byte forward.
  let leftover = new Uint8Array(0);
  // Where the next buffer starts on the audio clock. The small cushion keeps the first buffer
  // just ahead of "now" so its opening is not clipped.
  let playhead = 0;
  let announced = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (options.stale?.()) break;
      received.push(value);
      let joined = value;
      if (leftover.length) {
        joined = new Uint8Array(leftover.length + value.length);
        joined.set(leftover);
        joined.set(value, leftover.length);
      }
      const usable = joined.length - (joined.length % 2);
      leftover = joined.subarray(usable);
      if (!usable) continue;
      const buffer = pcmToAudioBuffer(ctx, joined.subarray(0, usable), rate);
      if (!buffer) continue;
      if (!announced) {
        announced = true;
        options.onFirstAudio?.();
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      playhead = Math.max(playhead, ctx.currentTime + 0.06);
      source.start(playhead);
      playhead += buffer.duration;
      options.onSource?.(source);
    }
  } catch {
    /* aborted mid-stream — whatever was already scheduled still plays out */
  }
  if (!received.length) return null;
  const total = received.reduce((n, c) => n + c.length, 0);
  const pcm = new Uint8Array(total - (total % 2));
  let at = 0;
  for (const chunk of received) {
    const take = Math.min(chunk.length, pcm.length - at);
    pcm.set(chunk.subarray(0, take), at);
    at += take;
  }
  return { pcm, rate, playhead };
}

/** 16-bit mono PCM → a WAV file (for an `<audio>` player to replay or download). */
export function pcmToWav(pcm: Uint8Array, rate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  header.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, pcm.length, true);
  return new Blob([header.buffer, pcm.slice().buffer], { type: 'audio/wav' });
}
