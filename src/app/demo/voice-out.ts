/**
 * The agent's voice in the browser.
 *
 * The demo streams raw 8 kHz PCM, one sentence per chunk, as each renders.
 * Chunks are scheduled back to back on a single Web Audio clock, so sentences
 * join without a seam and the first one plays while later ones still render.
 * An analyser on the output drives the orb, and `stop()` cuts the voice off
 * mid-word the moment the visitor talks over it.
 *
 * The same AudioContext is lent to the mic's VAD (see useVoiceSession). It is
 * created inside the visitor's tap, which is the only moment iOS lets one start.
 */

const VOICE_RATE = 8000;

export interface Span {
  /** Audio-clock seconds at which this chunk starts and ends. */
  start: number;
  end: number;
}

export class VoiceOut {
  readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly frame: Float32Array<ArrayBuffer>;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private playhead = 0;

  constructor() {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.5;
    this.frame = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.out.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  resume(): Promise<void> {
    return this.ctx.state === 'suspended' ? this.ctx.resume().catch(() => {}) : Promise.resolve();
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Seconds of voice still queued to play. */
  get remaining(): number {
    return Math.max(0, this.playhead - this.ctx.currentTime);
  }

  /** Queue one chunk of 16-bit mono PCM straight after whatever is queued. */
  enqueue(pcm: Uint8Array): Span | null {
    const frames = Math.floor(pcm.byteLength / 2);
    if (!frames) return null;
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2);
    const samples = new Float32Array(new ArrayBuffer(frames * 4));
    for (let i = 0; i < frames; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer(samples);
    source.connect(this.out);
    // A small cushion keeps the very first chunk from being clipped.
    const start = Math.max(this.playhead, this.ctx.currentTime + 0.04);
    source.start(start);
    this.playhead = start + source.buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    return { start, end: this.playhead };
  }

  private buffer(samples: Float32Array<ArrayBuffer>): AudioBuffer {
    try {
      const buffer = this.ctx.createBuffer(1, samples.length, VOICE_RATE);
      buffer.copyToChannel(samples, 0);
      return buffer;
    } catch {
      // An engine that refuses an 8 kHz buffer gets it upsampled to its own rate.
      const ratio = this.ctx.sampleRate / VOICE_RATE;
      const up = new Float32Array(new ArrayBuffer(Math.floor(samples.length * ratio) * 4));
      for (let i = 0; i < up.length; i++) {
        const at = i / ratio;
        const i0 = Math.floor(at);
        const i1 = Math.min(i0 + 1, samples.length - 1);
        up[i] = samples[i0] + (samples[i1] - samples[i0]) * (at - i0);
      }
      const buffer = this.ctx.createBuffer(1, up.length, this.ctx.sampleRate);
      buffer.copyToChannel(up, 0);
      return buffer;
    }
  }

  /** Silence the voice now, dropping everything still queued. */
  stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already finished */
      }
    }
    this.sources.clear();
    this.playhead = 0;
  }

  /** Output loudness, 0–1. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.frame);
    let sum = 0;
    for (let i = 0; i < this.frame.length; i++) sum += this.frame[i] * this.frame[i];
    return Math.min(1, Math.sqrt(sum / this.frame.length) / 0.11);
  }

  /** The two-note chime of a line connecting, or falling for a hang-up. */
  tone(kind: 'connect' | 'hangup') {
    const notes = kind === 'connect' ? [659.3, 987.8] : [587.3, 392];
    const t0 = this.ctx.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const at = t0 + i * 0.13;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.07, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain);
      // Straight to the speakers: the orb reacts to the agent's voice, not to chimes.
      gain.connect(this.ctx.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    });
    // The agent's first words wait for the chime to finish.
    this.playhead = Math.max(this.playhead, t0 + notes.length * 0.13 + 0.12);
  }

  close() {
    this.stop();
    void this.ctx.close().catch(() => {});
  }
}

/** Decode one base64 audio event. */
export function decodePcm(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const BROWSER_LANG = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-US' } as const;

/**
 * Last resort when the voice service is down: the browser's own synthesiser,
 * if it has a voice for the language. Resolves when it finishes, fails, or
 * `stale()` reports the visitor talked over it.
 */
export function speakWithBrowser(text: string, lang: keyof typeof BROWSER_LANG, stale: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    const tag = BROWSER_LANG[lang] ?? 'ru-RU';
    const voice = synth?.getVoices().find((v) => v.lang.toLowerCase().startsWith(tag.slice(0, 2)));
    if (!synth || !voice) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = tag;
    const timer = setInterval(() => {
      if (stale()) {
        synth.cancel();
        finish();
      }
    }, 100);
    const finish = () => {
      clearInterval(timer);
      resolve();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    synth.cancel();
    synth.speak(utterance);
  });
}
