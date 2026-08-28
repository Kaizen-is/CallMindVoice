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
  /** Live mic stream — callers attach analysers for VAD / level metering. */
  stream: MediaStream;
}

export function micSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

export const VOICE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Start one encoded utterance. A caller may pass a long-lived session stream;
 * in that case stopping the recorder leaves the microphone tracks alive for
 * the next turn. Without a stream this keeps the original one-shot behaviour.
 */
export async function startRecording(sessionStream?: MediaStream): Promise<Recording> {
  // Raw capture: browser echo-cancellation and noise-suppression audibly
  // distort speech for this STT model (recorder-app files transcribe far
  // better). Push-to-talk means the agent is silent while recording, so echo
  // processing is unnecessary. AGC stays on for quiet mics; we peak-normalise
  // and high-pass afterwards ourselves.
  const ownsStream = !sessionStream;
  const stream =
    sessionStream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    }));
  const mr = new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  mr.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  mr.start();

  const cleanup = () => {
    if (ownsStream) stream.getTracks().forEach((t) => t.stop());
  };
  let settled = false;

  return {
    stream,
    cancel: () => {
      if (settled) return;
      settled = true;
      mr.ondataavailable = null;
      mr.onstop = null;
      try { mr.stop(); } catch { /* already stopped */ }
      cleanup();
    },
    stop: () =>
      new Promise<RecordingResult>((resolve, reject) => {
        if (settled) {
          reject(new Error('recording already finalized'));
          return;
        }
        settled = true;
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

  const pcm = await resampleProper(decoded, TARGET_RATE);

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

  // Trim leading/trailing silence (with 150 ms padding) — hands-free recordings
  // end with several seconds of quiet that only slow the STT down.
  const thr = Math.max(0.008, peak * 0.05);
  let s0 = 0;
  while (s0 < pcm.length && Math.abs(pcm[s0]) < thr) s0++;
  let s1 = pcm.length - 1;
  while (s1 > s0 && Math.abs(pcm[s1]) < thr) s1--;
  const pad = Math.floor(0.15 * TARGET_RATE);
  const trimmed =
    s1 > s0 ? pcm.subarray(Math.max(0, s0 - pad), Math.min(pcm.length, s1 + pad + 1)) : pcm;

  return { wav: encodeWav(trimmed, TARGET_RATE, gain), durationSec: decoded.duration, rms };
}

/**
 * Resample through OfflineAudioContext so the browser applies a proper
 * anti-aliasing filter — naive linear interpolation folds high frequencies
 * back into the speech band and audibly degrades STT accuracy.
 */
async function resampleProper(decoded: AudioBuffer, to: number): Promise<Float32Array> {
  if (decoded.sampleRate === to && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }
  const frames = Math.ceil((decoded.duration || decoded.length / decoded.sampleRate) * to);
  const off = new OfflineAudioContext(1, Math.max(1, frames), to);
  const src = off.createBufferSource();
  src.buffer = decoded;
  // Classical clean-up (no AI): a high-pass filter strips mains hum, desk
  // thumps and low rumble that speech models mistake for voicing.
  const hp = off.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 75;
  src.connect(hp);
  hp.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
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
