'use client';

/**
 * L8 pilot: a Playground call answered natively by Gemini Live (backend/app/engine/native_call.py).
 *
 * One socket carries the microphone up (16 kHz PCM, every 100 ms) and the agent's own voice down
 * (24 kHz PCM). Gemini decides when the caller has finished and notices when they talk over it — on
 * "interrupted" the agent's voice stops at once. The page only shows the words, the tools our code
 * answered, the promise and the text guardrail's flags.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceOut } from '@/app/demo/voice-out';
import { VOICE_MIC_CONSTRAINTS } from '@/lib/audio';

const MIC_RATE = 16000;
const FRAME = 1600; // 100 ms
const VOICE_RATE = 24000;
const WORKLET = `
class NativeTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('native-tap', NativeTap);
`;

export interface NativeLine {
  role: 'caller' | 'agent';
  text: string;
  flags?: string[];
  firstMs?: number | null;
}

export interface NativeTool {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export type NativeState = 'idle' | 'connecting' | 'live' | 'error';

function toPcm16(frame: Float32Array): ArrayBuffer {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const s = Math.max(-1, Math.min(1, frame[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export function useNativeCall({ agentId, lang }: { agentId: string; lang: string }) {
  const [state, setState] = useState<NativeState>('idle');
  const [lines, setLines] = useState<NativeLine[]>([]);
  const [live, setLive] = useState<{ caller: string; agent: string }>({ caller: '', agent: '' });
  const [tools, setTools] = useState<NativeTool[]>([]);
  const [promise, setPromise] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const outRef = useRef<VoiceOut | null>(null);
  const micRef = useRef<{ stream: MediaStream; ctx: AudioContext; url: string } | null>(null);

  const stopMic = () => {
    const mic = micRef.current;
    micRef.current = null;
    if (!mic) return;
    mic.stream.getTracks().forEach((t) => t.stop());
    void mic.ctx.close().catch(() => {});
    URL.revokeObjectURL(mic.url);
  };

  const hangUp = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'end' }));
    ws?.close();
    stopMic();
    outRef.current?.stop();
    setState('idle');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setLines([]);
    setTools([]);
    setPromise(null);
    setLive({ caller: '', agent: '' });
    setState('connecting');
    const out = outRef.current ?? new VoiceOut();
    outRef.current = out;
    void out.resume();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_MIC_CONSTRAINTS });
      const ctx = new AudioContext({ sampleRate: MIC_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      micRef.current = { stream, ctx, url };
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ agentId, lang, mode: 'audio' });
      const ws = new WebSocket(`${scheme}://${window.location.host}/api/core/playground/native?${q}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          out.enqueue(new Uint8Array(e.data), VOICE_RATE);
          return;
        }
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        switch (msg.t) {
          case 'ready': {
            setModel(String(msg.model ?? ''));
            setState('live');
            const tap = new AudioWorkletNode(ctx, 'native-tap');
            tap.port.onmessage = (m: MessageEvent<Float32Array>) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(toPcm16(m.data));
            };
            ctx.createMediaStreamSource(stream).connect(tap);
            break;
          }
          case 'caller':
            setLive((l) => ({ ...l, caller: String(msg.text ?? '') }));
            break;
          case 'agent':
            setLive((l) => ({ ...l, agent: String(msg.text ?? '') }));
            break;
          case 'interrupted':
            out.stop(); // they talked over the agent: its voice stops now
            break;
          case 'tool':
            setTools((t) => [...t, msg as unknown as NativeTool]);
            break;
          case 'promise':
            setPromise((msg.promise as Record<string, unknown>) ?? null);
            break;
          case 'turn': {
            const add: NativeLine[] = [];
            if (msg.caller) add.push({ role: 'caller', text: String(msg.caller) });
            if (msg.agent) {
              add.push({
                role: 'agent',
                // Cut off by the caller talking over it: the line stops mid-sentence.
                text: String(msg.agent) + (msg.cut ? ' —' : ''),
                flags: (msg.flags as string[]) ?? [],
                firstMs: (msg.firstMs as number | null) ?? null,
              });
            }
            setLines((l) => [...l, ...add]);
            setLive({ caller: '', agent: '' });
            break;
          }
          case 'error':
          case 'closed':
            setError(String(msg.detail ?? msg.reason ?? msg.code ?? 'closed'));
            setState('error');
            stopMic();
            break;
        }
      };
      ws.onclose = () => {
        stopMic();
        setState((s) => (s === 'error' ? s : 'idle'));
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'microphone');
      setState('error');
      stopMic();
    }
  }, [agentId, lang]);

  useEffect(() => () => hangUp(), [hangUp]);

  return { state, lines, live, tools, promise, error, model, start, hangUp };
}
