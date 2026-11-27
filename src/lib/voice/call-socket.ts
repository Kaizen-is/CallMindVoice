/**
 * The Playground call over one WebSocket (L2; backend/app/routers/playground_ws.py).
 *
 * One open connection carries the live-words audio (binary, every 100 ms), the turn and its events, the
 * agent's voice (raw bytes, not base64 text), the early start, the cut-in and the timings — instead of a
 * new request for each. `CallSocket.open` resolves null when the socket cannot open (a proxy that does
 * not pass WebSockets, an old server): the page then uses the requests, as before.
 */
import type { CallEvent } from '@/lib/playground-shared';

type Waiter<T> = (value: T) => void;
const HEADER_BYTES = 13; // kind (1) · seq · rate · afterMs (uint32 LE each)

/** A turn's events, as they arrive; ends when the server closes the turn (or the socket drops). */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: Waiter<IteratorResult<T>> | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

export interface LiveConfig {
  sid: string;
  engine: string;
  language: string;
  agentId?: string;
}

export class CallSocket {
  private readonly ws: WebSocket;
  private seq = 0;
  private liveId = 0;
  private liveConfig = '';
  private readonly feedWaiters: Waiter<string | null>[] = [];
  private readonly liveWaiters = new Map<number, Waiter<string | null>>();
  private readonly turns = new Map<number, Channel<CallEvent>>();
  private readonly replies: Record<'cut' | 'timings', Waiter<Record<string, unknown> | null>[]> = { cut: [], timings: [] };
  private lastEnd: { prob: number; ms: number } | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.dropAll();
  }

  /** The socket, or null if it does not open within `timeoutMs` (the page then uses requests). */
  static open(url: string, timeoutMs = 1500): Promise<CallSocket | null> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        resolve(null);
        return;
      }
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        ws.close();
        resolve(null);
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CallSocket(ws));
      };
      ws.onerror = ws.onclose = () => {
        clearTimeout(timer);
        resolve(null);
      };
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws.close();
    this.dropAll();
  }

  // ── live words ──────────────────────────────────────────────────

  /** Where the live-words audio goes (sent again only when it changes). */
  configureLive(config: LiveConfig): void {
    const key = JSON.stringify(config);
    if (key === this.liveConfig || !this.open) return;
    this.liveConfig = key;
    this.ws.send(JSON.stringify({ op: 'live-config', ...config }));
  }

  /** One audio piece; resolves with the words heard so far (null if the socket is gone). */
  async feed(audio: Blob | ArrayBuffer): Promise<string | null> {
    if (!this.open) return null;
    const data = audio instanceof Blob ? await audio.arrayBuffer() : audio;
    return new Promise((resolve) => {
      this.feedWaiters.push(resolve);
      this.ws.send(data);
    });
  }

  /** flush | finish | begin | reset | close; resolves with the text the server returns. */
  live(op: string): Promise<string | null> {
    if (!this.open) return Promise.resolve(null);
    const id = ++this.liveId;
    return new Promise((resolve) => {
      this.liveWaiters.set(id, resolve);
      this.ws.send(JSON.stringify({ op: 'live', id, live: op }));
    });
  }

  /** The end-of-turn model's score from the last `endpoint` (L3), once. */
  takeEnd(): { prob: number; ms: number } | null {
    const end = this.lastEnd;
    this.lastEnd = null;
    return end;
  }

  // ── turns ───────────────────────────────────────────────────────

  /** Send a turn; its events (the NDJSON stream's, the voice as `bytes`) arrive on the iterable. */
  turn(fields: Record<string, string>, audio?: string): { seq: number; events: AsyncIterable<CallEvent> } {
    const seq = ++this.seq;
    const channel = new Channel<CallEvent>();
    this.turns.set(seq, channel);
    if (this.open) this.ws.send(JSON.stringify({ op: 'turn', seq, fields, ...(audio ? { audio } : {}) }));
    else {
      channel.push({ t: 'error', code: 'socket' } as CallEvent);
      channel.end();
    }
    return { seq, events: channel };
  }

  /** The phrase at an early pause (no answer expected back). */
  prefetch(fields: Record<string, string>, audio?: string): void {
    if (this.open) this.ws.send(JSON.stringify({ op: 'prefetch', seq: ++this.seq, fields, ...(audio ? { audio } : {}) }));
  }

  /** The caller talked over turn `seq`: its voice stops. */
  abort(seq: number): void {
    if (this.open) this.ws.send(JSON.stringify({ op: 'abort', seq }));
  }

  cut(callId: string, heard: number): Promise<Record<string, unknown> | null> {
    return this.ask('cut', { op: 'cut', callId, heard });
  }

  timings(callId: string, turnId: string, laps: Record<string, number>): Promise<Record<string, unknown> | null> {
    return this.ask('timings', { op: 'timings', callId, turnId, laps });
  }

  private ask(kind: 'cut' | 'timings', message: object): Promise<Record<string, unknown> | null> {
    if (!this.open) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.replies[kind].push(resolve);
      this.ws.send(JSON.stringify(message));
    });
  }

  // ── from the server ─────────────────────────────────────────────

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (data.byteLength < HEADER_BYTES) return;
      const view = new DataView(data);
      const kind = view.getUint8(0);
      const seq = view.getUint32(1, true);
      const rate = view.getUint32(5, true) || undefined;
      const afterMs = view.getUint32(9, true) || undefined;
      const bytes = new Uint8Array(data, HEADER_BYTES);
      this.turns.get(seq)?.push({ t: kind === 2 ? 'filler' : 'audio', pcm: '', bytes, rate, afterMs } as CallEvent);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg.seq === 'number') {
      const channel = this.turns.get(msg.seq);
      if (!channel) return;
      if (msg.t === 'closed') {
        channel.end();
        this.turns.delete(msg.seq);
      } else channel.push(msg as unknown as CallEvent);
      return;
    }
    if (msg.t === 'live') {
      const text = typeof msg.text === 'string' ? msg.text : null;
      if (typeof msg.id === 'number') {
        if (typeof msg.endProb === 'number') {
          this.lastEnd = { prob: msg.endProb, ms: typeof msg.endMs === 'number' ? msg.endMs : 0 };
        }
        this.liveWaiters.get(msg.id)?.(text);
        this.liveWaiters.delete(msg.id);
      } else this.feedWaiters.shift()?.(text);
      return;
    }
    if (msg.t === 'cut' || msg.t === 'timings') this.replies[msg.t].shift()?.(msg);
  }

  /** The socket closed: everything waiting gets nothing, every open turn ends as a dropped line. */
  private dropAll(): void {
    this.feedWaiters.splice(0).forEach((w) => w(null));
    this.liveWaiters.forEach((w) => w(null));
    this.liveWaiters.clear();
    for (const kind of ['cut', 'timings'] as const) this.replies[kind].splice(0).forEach((w) => w(null));
    this.turns.forEach((channel) => {
      channel.push({ t: 'error', code: 'socket' } as CallEvent);
      channel.end();
    });
    this.turns.clear();
  }
}

/** The socket's address on this site (through the rewrite of /api/core to the backend). */
export function callSocketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/core/playground/ws`;
}

/** A FormData of the turn's fields as the socket sends them: text fields, and the WAV as base64. */
export async function socketFields(form: FormData): Promise<{ fields: Record<string, string>; audio?: string }> {
  const fields: Record<string, string> = {};
  let audio: string | undefined;
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
    else if (key === 'audio') {
      const bytes = new Uint8Array(await value.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      audio = btoa(binary);
    }
  }
  return { fields, audio };
}
