'use client';

/**
 * Live transcript while the caller speaks (route `/api/speech/live`): from
 * Zipformer, the streaming Uzbek model inside the app (`engine` 'local'), or a
 * streaming model through Speko — 'scribe_live' (ElevenLabs Scribe v3 Live,
 * word by word) or 'gemini_live' (gemini-3.5-transcribe-live, a phrase at a time).
 *
 * While `active`, the microphone is resampled to 16 kHz mono by the
 * AudioContext and posted in ~quarter-second pieces; each answer is the whole
 * utterance heard so far. One request is in flight at a time: audio that piles
 * up meanwhile goes out together in the next one, so a slow network never
 * builds a backlog. In the Playground's voice call this is the transcript
 * itself: when the phrase ends, `finish` sends the last piece and the turn is
 * sent as text, so the agent starts thinking without a separate STT pass.
 *
 * It opens its own microphone stream next to the voice session's; browsers
 * share one device between both, and echo cancellation keeps the agent's own
 * voice out of the live words.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // the worklet posts every 100 ms
const SEND_EVERY_SAMPLES = 4000; // a request at most every 250 ms (the in-app Zipformer)
const SEND_EVERY_SAMPLES_SPEKO = 1600; // every 100 ms for a streaming Speko model: its words show sooner

/** Collects mic samples on the audio thread and posts them in fixed frames. */
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('live-stt-tap', Tap);
`;

function toPcm16(frames: Float32Array[]): Blob {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      out[at++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return new Blob([out.buffer], { type: 'application/octet-stream' });
}

export function useLiveTranscript({
  url,
  active,
  engine = 'local',
  language = 'uz',
}: {
  url: string | null;
  active: boolean;
  /** Which streaming model hears the caller: 'local' (Zipformer), 'scribe_live' or 'gemini_live'. */
  engine?: string;
  language?: string;
}) {
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  /** The whole utterance so far. */
  const textRef = useRef('');
  const sidRef = useRef('');
  const pendingRef = useRef<Float32Array[]>([]);
  const pendingSamplesRef = useRef(0);
  /** The request in flight, so control calls can wait for it. */
  const inflightRef = useRef<Promise<void> | null>(null);
  /** Bumped by reset/finish: answers to older requests are ignored. */
  const genRef = useRef(0);
  const urlRef = useRef(url);
  urlRef.current = url;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const languageRef = useRef(language);
  languageRef.current = language;

  const show = (value: string) => {
    textRef.current = value;
    setText(value);
  };

  const post = useCallback(async (op: string, audio?: Blob): Promise<string | null> => {
    const target = urlRef.current;
    if (!target || !sidRef.current) return null;
    const form = new FormData();
    form.append('sid', sidRef.current);
    form.append('op', op);
    form.append('engine', engineRef.current);
    form.append('language', languageRef.current);
    if (audio) form.append('audio', audio, 'piece.pcm');
    try {
      const res = await fetch(target, { method: 'POST', body: form });
      if (!res.ok) {
        if (res.status === 503 || res.status === 401) setConnected(false);
        return null;
      }
      setConnected(true);
      const data = (await res.json()) as { text?: string };
      return data.text ?? '';
    } catch {
      return null;
    }
  }, []);

  /** Take whatever audio has piled up. */
  const takePending = () => {
    const frames = pendingRef.current;
    pendingRef.current = [];
    pendingSamplesRef.current = 0;
    return frames;
  };

  /** Send the piled-up audio if nothing is in flight. */
  const pump = useCallback(() => {
    const every = engineRef.current === 'local' ? SEND_EVERY_SAMPLES : SEND_EVERY_SAMPLES_SPEKO;
    if (inflightRef.current || pendingSamplesRef.current < every) return;
    const gen = genRef.current;
    const audio = toPcm16(takePending());
    const job = post('feed', audio).then((heard) => {
      if (heard !== null && gen === genRef.current) show(heard);
    });
    inflightRef.current = job.finally(() => {
      inflightRef.current = null;
      pump();
    });
  }, [post]);

  /** Start a new utterance: forget what was heard so far. */
  const reset = useCallback(() => {
    genRef.current++;
    takePending();
    show('');
    const prior = inflightRef.current ?? Promise.resolve();
    void prior.then(() => post('reset'));
  }, [post]);

  /**
   * The phrase just ended: send the last piece and resolve with the whole
   * utterance. The model has been transcribing all along, so this is one short
   * request. Resolves with what is known after `timeoutMs` regardless.
   */
  const finish = useCallback(
    (timeoutMs = 900): Promise<string> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (value: string) => {
          if (settled) return;
          settled = true;
          resolve(value.trim());
        };
        setTimeout(() => done(textRef.current), timeoutMs);
        const prior = inflightRef.current ?? Promise.resolve();
        void prior.then(async () => {
          const gen = ++genRef.current;
          const frames = takePending();
          const heard = await post('finish', frames.length ? toPcm16(frames) : undefined);
          if (gen === genRef.current && heard !== null) show(heard);
          done(heard ?? textRef.current);
        });
      }),
    [post],
  );

  useEffect(() => {
    if (!active || !url) return;
    let cancelled = false;
    let media: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let moduleUrl = '';
    sidRef.current = crypto.randomUUID();
    const sid = sidRef.current;
    // Ask once whether the model is there, so the switch can say so.
    void post('reset');

    (async () => {
      try {
        media = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) return;
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(moduleUrl);
        if (cancelled) return;
        const source = ctx.createMediaStreamSource(media);
        const tap = new AudioWorkletNode(ctx, 'live-stt-tap');
        tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
          pendingRef.current.push(e.data);
          pendingSamplesRef.current += e.data.length;
          pump();
        };
        source.connect(tap);
      } catch (err) {
        console.warn('[live-stt] microphone tap failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      genRef.current++;
      media?.getTracks().forEach((track) => track.stop());
      void ctx?.close().catch(() => {});
      if (moduleUrl) URL.revokeObjectURL(moduleUrl);
      takePending();
      // Free the server-side stream; keepalive survives a closing tab.
      const form = new FormData();
      form.append('sid', sid);
      form.append('op', 'close');
      form.append('engine', engine);
      void fetch(url, { method: 'POST', body: form, keepalive: true }).catch(() => {});
      sidRef.current = '';
      show('');
      setConnected(false);
    };
  }, [active, url, engine, post, pump]);

  return { text, connected, reset, finish };
}
