'use client';

/**
 * Word-by-word transcript from the local streaming STT sidecar (`stt-stream/`).
 *
 * While `active`, the microphone is resampled to 16 kHz mono float32 by the
 * AudioContext and streamed over a WebSocket in ~100 ms frames; the sidecar
 * answers with the growing transcript (`partial`) and a sentence at each pause
 * (`final`). In the Playground's voice call this is the transcript itself:
 * when the phrase ends, `finish` flushes the last words and the turn is sent
 * as text, so the agent starts thinking without waiting for a separate STT pass.
 *
 * It opens its own microphone stream next to the voice session's; browsers
 * share one device between both, and echo cancellation keeps the agent's own
 * voice out of the live words.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms

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

export function useLiveTranscript({ url, active }: { url: string | null; active: boolean }) {
  const [text, setText] = useState('');
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const finalsRef = useRef('');
  /** The whole utterance so far — finished sentences plus the one in progress. */
  const textRef = useRef('');
  /** Set while `finish` waits for the sidecar to flush the last words. */
  const flushRef = useRef<(() => void) | null>(null);

  const show = (value: string) => {
    textRef.current = value;
    setText(value);
  };

  /** Start a new utterance: forget what was heard so far. */
  const reset = useCallback(() => {
    finalsRef.current = '';
    show('');
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reset' }));
  }, []);

  /**
   * The phrase just ended: have the sidecar decode its last few hundred
   * milliseconds and resolve with the whole utterance. Because the model has
   * been transcribing all along, this takes milliseconds — no upload, no
   * second pass. Resolves with what is known after `timeoutMs` regardless.
   */
  const finish = useCallback(
    (timeoutMs = 350): Promise<string> =>
      new Promise((resolve) => {
        const ws = socketRef.current;
        const done = () => {
          flushRef.current = null;
          resolve(textRef.current.trim());
        };
        if (ws?.readyState !== WebSocket.OPEN) return done();
        flushRef.current = done;
        ws.send(JSON.stringify({ type: 'flush' }));
        setTimeout(() => flushRef.current === done && done(), timeoutMs);
      }),
    [],
  );

  useEffect(() => {
    if (!active || !url) return;
    let cancelled = false;
    let media: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let moduleUrl = '';

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      let msg: { type?: string; text?: string };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!msg.text) return;
      if (msg.type === 'final') {
        finalsRef.current = `${finalsRef.current} ${msg.text}`.trim();
        show(finalsRef.current);
        flushRef.current?.();
      } else {
        show(`${finalsRef.current} ${msg.text}`.trim());
      }
    };

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
          if (ws.readyState === WebSocket.OPEN) ws.send(e.data.buffer);
        };
        source.connect(tap);
      } catch (err) {
        console.warn('[live-stt] microphone tap failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      ws.close();
      socketRef.current = null;
      media?.getTracks().forEach((track) => track.stop());
      void ctx?.close().catch(() => {});
      if (moduleUrl) URL.revokeObjectURL(moduleUrl);
      finalsRef.current = '';
      show('');
      setConnected(false);
    };
  }, [active, url]);

  return { text, connected, reset, finish };
}
