/**
 * Browser mic capture → 16 kHz mono 16-bit WAV, for the internal STT.
 *
 * MediaRecorder gives us WebM/Opus; we decode it with the Web Audio API,
 * resample to 16 kHz mono, peak-normalise a quiet mic, and PCM-encode a WAV the
 * STT server accepts. `stop()` also returns the clip's duration and RMS energy
 * so the caller can reject a stray tap or silence. Runs only in the browser
 * (Chrome/Edge), same requirement as the Web Speech path.
 */

export interface RecordingResult {
  wav: Blob;
  durationSec: number;
  rms: number;
}

export interface Recording {
  stop: () => Promise<RecordingResult>;
  cancel: () => void;
}

export function micSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  mr.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  mr.start();

  const cleanup = () => stream.getTracks().forEach((t) => t.stop());

  return {
    cancel: () => {
      try { mr.stop(); } catch { /* already stopped */ }
      cleanup();
    },
    stop: () =>
      new Promise<RecordingResult>((resolve, reject) => {
        mr.onstop = async () => {
          cleanup();
          try {
            resolve(await webmToWav16k(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })));
          } catch (e) {
            reject(e instanceof Error ? e : new Error('encode failed'));
          }
        };
        try { mr.stop(); } catch (e) { reject(e instanceof Error ? e : new Error('stop failed')); }
      }),
  };
}

const TARGET_RATE = 16000;

async function webmToWav16k(blob: Blob): Promise<RecordingResult> {
  const buf = await blob.arrayBuffer();
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    void ctx.close();
  }

  const pcm = resample(decoded.getChannelData(0), decoded.sampleRate, TARGET_RATE);

  // Measure raw energy (before gain) so the caller can reject true silence,
  // and peak-normalise a quiet mic toward full scale to help the STT.
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
    sumSq += pcm[i] * pcm[i];
  }
  const rms = pcm.length ? Math.sqrt(sumSq / pcm.length) : 0;
  const gain = peak > 0 ? Math.min(8, 0.97 / peak) : 1;

  return { wav: encodeWav(pcm, TARGET_RATE, gain), durationSec: decoded.duration, rms };
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (idx - i0);
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number, gain = 1): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
