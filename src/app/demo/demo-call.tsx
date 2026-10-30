'use client';

/**
 * The public bank demo: an incoming call from the bank's AI agent.
 *
 * The visitor answers, the agent speaks first (it is an outbound loan
 * reminder), and from then on the call is hands-free — the VAD hears the end
 * of each phrase, the server transcribes, thinks and streams the reply's voice
 * back in one response, and the visitor may talk over the agent at any time.
 *
 * Phases: ringing → connecting → live → ended (→ connecting on redial).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useVoiceSession, type VoiceErrorCode } from '@/hooks/use-voice-session';
import { micSupported, type RecordingResult } from '@/lib/audio';
import type { DemoEvent, DemoLang } from '@/lib/demo-shared';
import type { Locale } from '@/lib/types';
import { COPY, type Copy } from './copy';
import { IconAlert, IconHandset, IconHangUp, IconHeadset, IconLock, IconMic, IconMicOff, IconPerson } from './icons';
import { decodePcm, speakWithBrowser, VoiceOut } from './voice-out';
import s from './demo.module.css';

type Phase = 'ringing' | 'connecting' | 'live' | 'ended';
type Notice = 'micDenied' | 'micMissing' | 'unsupported' | 'unavailable' | 'busy' | 'network';
type EndReason = 'user' | 'transfer' | 'server';

/**
 * Voice timing for one agent line. The audio pipeline writes it as chunks are
 * scheduled; the line's reveal animation reads it every frame. Kept out of
 * React state on purpose — it changes far faster than anything should render.
 */
interface Speech {
  /** Audio-clock time the voice began; 0 = not yet, -1 = no voice (show it all). */
  start: number;
  /** Where the queued voice currently ends. */
  end: number;
  /** Every chunk has arrived. */
  done: boolean;
  /** …and played out. */
  finished: boolean;
  /** Cut off by the visitor talking over it, or by a hang-up. */
  stopped: boolean;
  /** How much had been said when it was cut off, 0–1. */
  frozen: number;
  chars: number;
}

type Row =
  | { id: string; kind: 'agent'; text: string; speech: Speech }
  | { id: string; kind: 'user'; text: string; status: 'recording' | 'transcribing' | 'final' }
  | { id: string; kind: 'persona' }
  | { id: string; kind: 'transfer' };

interface Props {
  fontClass: string;
  initialLang: DemoLang;
  available: boolean;
  identity: { agent: Record<DemoLang, string>; org: Record<DemoLang, string> };
  persona: { name: Record<DemoLang, string>; birthYear: string };
  /** Voices the visitor may pick for the agent; '' = the agent's own. */
  voices: Array<{ id: string; name: string; group: 'builtin' | 'clone' | 'design' }>;
  initialVoice: string;
}

/** Speaking rate of the agent's voice, used until a line's true length is known. */
const SECONDS_PER_CHAR = 0.063;

let rowSeq = 0;
const rowId = () => `r${++rowSeq}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function progress(speech: Speech, now: number): number {
  if (speech.start < 0 || speech.finished) return 1;
  if (speech.stopped) return speech.frozen;
  if (!speech.start) return 0;
  const length = speech.done
    ? speech.end - speech.start
    : Math.max(speech.end - speech.start, speech.chars * SECONDS_PER_CHAR);
  return Math.min(1, Math.max(0, (now - speech.start) / Math.max(0.05, length)));
}

/**
 * Transcript typesetting. The STT writes lowercase ("menman. men 1992-yilda…")
 * and the model types Uzbek with a typewriter apostrophe ("so'm"); on screen
 * sentences start with a capital and Uzbek gets its real letters, oʻ and gʻ,
 * and the ʼ of tutuq belgisi. Display only: what was sent and stored is untouched.
 */
function typeset(text: string, lang: string): string {
  let out = text.trim().replace(/(^|[.!?…]\s+)(\p{Ll})/gu, (_, lead: string, letter: string) => lead + letter.toUpperCase());
  if (lang === 'uz') {
    out = out.replace(/([oOgG])['‘’`ʼ]/g, '$1ʻ').replace(/(\p{L})['’`](?=\p{L})/gu, '$1ʼ');
  }
  return out;
}

function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The server's newline-delimited JSON events, as they arrive. */
async function* readEvents(res: Response): AsyncGenerator<DemoEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield JSON.parse(line) as DemoEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a layout change as a View Transition where the browser has them.
 *
 * The browser applies the change a frame later, from its own callback — by
 * which time the call may have moved on (a fast pickup goes live within that
 * frame). So this returns `settle`, which applies the change at once if the
 * browser has not yet: anything that continues after an await calls it first,
 * and a late callback then finds nothing left to do.
 */
let pendingMorph: (() => void) | null = null;

function morph(update: () => void): () => void {
  // Changes land in the order they were asked for.
  pendingMorph?.();
  let applied = false;
  const settle = () => {
    if (applied) return;
    applied = true;
    if (pendingMorph === settle) pendingMorph = null;
    flushSync(update);
  };
  pendingMorph = settle;
  type Transition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => Transition };
  if (!doc.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settle();
    return settle;
  }
  // A transition overtaken by the next one is skipped, which rejects these;
  // its change has been applied regardless (see `settle`).
  const transition = doc.startViewTransition(settle);
  for (const done of [transition.ready, transition.finished, transition.updateCallbackDone]) {
    done?.catch(() => {});
  }
  return settle;
}

const vibrate = (ms = 12) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no haptics here */
  }
};

/* ── transcript rows ─────────────────────────────────────────── */

/**
 * An agent line arrives whole but faint, and each word lights up as the voice
 * reaches it. A line the visitor talked over keeps its unsaid words struck
 * through, so the transcript shows exactly what was heard.
 */
const AgentLine = memo(function AgentLine({
  text,
  speech,
  clock,
}: {
  text: string;
  speech: Speech;
  clock: () => number;
}) {
  const said = useRef<HTMLSpanElement>(null);
  const unsaid = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);

  useEffect(() => {
    let frame = 0;
    let shown = -1;
    const paint = () => {
      const p = progress(speech, clock());
      let n = p >= 1 ? text.length : Math.round(text.length * p);
      // Light whole words: the one being spoken appears as it starts.
      if (n > 0 && n < text.length) {
        const space = text.indexOf(' ', n);
        n = space < 0 ? text.length : space;
      }
      if (n !== shown && said.current && unsaid.current) {
        shown = n;
        said.current.textContent = text.slice(0, n);
        unsaid.current.textContent = text.slice(n);
      }
      if (speech.stopped) {
        setCut(n < text.length);
        return;
      }
      if (!speech.finished && speech.start >= 0) frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [text, speech, clock]);

  return (
    <li className={s.agent} data-cut={cut || undefined}>
      <span className={s.srOnly}>{text}</span>
      <span aria-hidden>
        <span ref={said} />
        <span ref={unsaid} className={s.unsaid}>
          {text}
        </span>
      </span>
    </li>
  );
});

function UserLine({ text, status }: { text: string; status: 'recording' | 'transcribing' | 'final' }) {
  return (
    <li className={s.user} data-status={status}>
      {status === 'recording' ? (
        <span className={s.bars} aria-hidden>
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : status === 'transcribing' ? (
        <span className={s.dots} aria-hidden>
          <i />
          <i />
          <i />
        </span>
      ) : (
        text
      )}
    </li>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return <span className={s.timer}>{clockText(now - since)}</span>;
}

function LangSwitch({ lang, label, onChange }: { lang: DemoLang; label: string; onChange: (l: DemoLang) => void }) {
  return (
    <div className={s.lang} role="group" aria-label={label} data-lang={lang}>
      <span className={s.thumb} aria-hidden />
      {(['uz', 'ru'] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          title={l === 'uz' ? 'Oʻzbekcha' : 'Русский'}
          aria-pressed={lang === l}
          onClick={() => onChange(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function VoicePicker({
  voice,
  voices,
  copy,
  onChange,
}: {
  voice: string;
  voices: Props['voices'];
  copy: Copy;
  onChange: (id: string) => void;
}) {
  const groups = (['builtin', 'clone', 'design'] as const)
    .map((group) => ({ group, items: voices.filter((v) => v.group === group) }))
    .filter((g) => g.items.length);
  return (
    <select className={s.voice} aria-label={copy.voice} title={copy.voice} value={voice} onChange={(e) => onChange(e.target.value)}>
      <option value="">{copy.agentVoice}</option>
      {groups.map(({ group, items }) => (
        <optgroup key={group} label={copy.voiceGroups[group]}>
          {items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function NoticeCard({ notice, copy }: { notice: Notice; copy: Copy }) {
  return (
    <div className={s.notice} role="alert">
      {notice === 'micDenied' ? <IconLock /> : <IconAlert />}
      <p>
        <strong>{copy[notice]}</strong>
        {notice === 'micDenied' && <span>{copy.micDeniedHint}</span>}
      </p>
    </div>
  );
}

/* ── the call ────────────────────────────────────────────────── */

export function DemoCall({ fontClass, initialLang, available, identity, persona, voices, initialVoice }: Props) {
  const [lang, setLang] = useState<DemoLang>(initialLang);
  // Read by every request as it is sent, so a new pick takes effect from the next reply.
  const [voicePick, setVoicePick] = useState(initialVoice);
  const voiceRef = useRef(initialVoice);
  const [phase, setPhase] = useState<Phase>('ringing');
  const [rows, setRows] = useState<Row[]>([]);
  const [muted, setMuted] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(available ? null : 'unavailable');
  const [flash, setFlash] = useState<'heardNothing' | 'network' | null>(null);
  /** The agent owes a reply: from the end of the visitor's phrase to its first word. */
  const [waiting, setWaiting] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [endReason, setEndReason] = useState<EndReason>('user');
  const [duration, setDuration] = useState(0);

  const copy = COPY[lang];

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const outRef = useRef<VoiceOut | null>(null);
  const phaseRef = useRef<Phase>('ringing');
  const langRef = useRef<DemoLang>(initialLang);
  const mutedRef = useRef(false);
  const callIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  /** Bumped whenever the turn in flight stops mattering (barge-in, hang-up). */
  const seqRef = useRef(0);
  const inflightRef = useRef<AbortController | null>(null);
  const speakingRef = useRef<Speech | null>(null);
  const recordingRowRef = useRef<string | null>(null);
  const micLevelRef = useRef(0);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinnedRef = useRef(true);

  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const addRow = (row: Row) => setRows((list) => [...list, row]);
  const dropRow = (id: string) => setRows((list) => list.filter((row) => row.id !== id));
  const patchUser = (id: string, patch: { text?: string; status?: 'recording' | 'transcribing' | 'final' }) =>
    setRows((list) => list.map((row) => (row.id === id && row.kind === 'user' ? { ...row, ...patch } : row)));
  const showFlash = (key: 'heardNothing' | 'network') => {
    setFlash(key);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 2600);
  };
  const clock = useCallback(() => outRef.current?.now ?? 0, []);

  const holdScreen = async () => {
    try {
      wakeRef.current = (await navigator.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not allowed here — the screen may dim, the call still works */
    }
  };
  const releaseScreen = () => {
    void wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
  };

  /** Stop the agent mid-word and forget the turn that was speaking. */
  const silenceAgent = () => {
    seqRef.current += 1;
    inflightRef.current?.abort();
    inflightRef.current = null;
    const speech = speakingRef.current;
    if (speech && !speech.finished) {
      speech.frozen = progress(speech, clock());
      speech.stopped = true;
    }
    speakingRef.current = null;
    outRef.current?.stop();
    window.speechSynthesis?.cancel();
    setWaiting(false);
  };

  const voice = useVoiceSession({
    onUtterance: (recording) => handleUtterance(recording),
    onSpeculate: (recording) => prefetchUtterance(recording),
    onBargeIn: () => silenceAgent(),
    onError: (_message, code: VoiceErrorCode) => {
      if (code === 'mic_denied') setNotice('micDenied');
      else if (code === 'mic_unavailable') setNotice('micMissing');
      // 'recording' errors recover by themselves within a second.
    },
    onLevel: (level) => {
      micLevelRef.current = level;
    },
  });

  /**
   * Play one streamed response: register the call, show what was heard, add
   * the reply and voice it chunk by chunk, then hand the line back to the
   * visitor — unless the agent transferred the call.
   */
  const exchange = async (res: Response, seq: number, userRow?: string) => {
    const out = outRef.current!;
    let speech: Speech | null = null;
    let reply: { text: string; lang: Locale; end: 'transfer' | null } | null = null;
    let agentRow = '';
    let browserVoice = false;
    let dropped = false;

    try {
      for await (const event of readEvents(res)) {
        if (seq !== seqRef.current) return;
        if (event.t === 'call') {
          callIdRef.current = event.callId;
        } else if (event.t === 'heard' && userRow) {
          if (event.text.trim()) {
            patchUser(userRow, { text: typeset(event.text, langRef.current), status: 'final' });
          } else {
            dropRow(userRow);
            showFlash('heardNothing');
          }
        } else if (event.t === 'reply') {
          reply = { text: event.text, lang: event.lang, end: event.end };
          speech = { start: 0, end: 0, done: false, finished: false, stopped: false, frozen: 0, chars: event.text.length };
          speakingRef.current = speech;
          agentRow = rowId();
          addRow({ id: agentRow, kind: 'agent', text: typeset(event.text, event.lang), speech });
        } else if ((event.t === 'more' || event.t === 'final') && reply && speech) {
          // The reply grows a sentence at a time as the model writes it.
          reply.text = event.text;
          if (event.t === 'final') reply.end = event.end;
          speech.chars = event.text.length;
          const row = agentRow;
          const shown = typeset(event.text, reply.lang);
          setRows((list) => list.map((r) => (r.id === row && r.kind === 'agent' ? { ...r, text: shown } : r)));
        } else if (event.t === 'filler') {
          // "Bir daqiqa." — heard while the reply is still being worked out.
          out.enqueue(decodePcm(event.pcm));
        } else if (event.t === 'audio' && speech) {
          const span = out.enqueue(decodePcm(event.pcm));
          if (!span) continue;
          if (!speech.start) {
            speech.start = span.start;
            setWaiting(false);
            voice.setAiSpeaking();
          }
          speech.end = span.end;
        } else if (event.t === 'voice') {
          browserVoice = true;
        } else if (event.t === 'error') {
          throw new Error(event.code);
        }
      }
    } catch {
      if (seq !== seqRef.current) return; // aborted on purpose
      // The line dropped mid-reply: whatever already arrived still plays out.
      dropped = true;
    }
    if (seq !== seqRef.current) return;
    inflightRef.current = null;

    if (!reply || !speech) {
      // Nothing was heard (or nothing came back): the line is the visitor's again.
      setWaiting(false);
      if (dropped) showFlash('network');
      if (phaseRef.current === 'live') voice.resumeListening();
      return;
    }

    speech.done = true;
    if (!speech.start) {
      // No voice arrived: the browser reads the line instead.
      speech.start = -1;
      setWaiting(false);
      if (browserVoice || dropped) {
        voice.setAiSpeaking();
        await speakWithBrowser(reply.text, reply.lang, () => seq !== seqRef.current);
      }
    } else {
      while (out.remaining > 0.02 && seq === seqRef.current) await sleep(40);
    }
    if (seq !== seqRef.current) return;
    speech.finished = true;
    speakingRef.current = null;

    if (reply.end === 'transfer') {
      addRow({ id: rowId(), kind: 'transfer' });
      hangUp('transfer');
      return;
    }
    voice.resumeListening();
  };

  /**
   * The visitor paused: send what they said ahead, so the server is already
   * transcribing it while the pause runs out. The turn reuses it when the
   * pause holds; when they go on, it is simply never asked for.
   */
  const prefetchUtterance = ({ wav, durationSec, rms }: RecordingResult) => {
    const callId = callIdRef.current;
    if (phaseRef.current !== 'live' || !callId || durationSec < 0.3 || rms < 0.0015 || wav.size <= 44) return;
    const form = new FormData();
    form.append('audio', wav, 'speech.wav');
    form.append('callId', callId);
    form.append('lang', langRef.current);
    form.append('voice', voiceRef.current);
    void fetch('/api/demo/turn?prefetch=1', { method: 'POST', body: form }).catch(() => {});
  };

  const handleUtterance = async ({ wav, durationSec, rms }: RecordingResult) => {
    const callId = callIdRef.current;
    const pending = recordingRowRef.current;
    recordingRowRef.current = null;
    // A cough, a click, or a phrase while the line is still connecting.
    if (phaseRef.current !== 'live' || !callId || durationSec < 0.3 || rms < 0.0015 || wav.size <= 44) {
      if (pending) dropRow(pending);
      if (phaseRef.current === 'live') voice.resumeListening();
      return;
    }

    const seq = ++seqRef.current;
    const row = pending ?? rowId();
    if (pending) patchUser(row, { status: 'transcribing' });
    else addRow({ id: row, kind: 'user', text: '', status: 'transcribing' });
    setWaiting(true);

    const controller = new AbortController();
    inflightRef.current = controller;
    let res: Response | null = null;
    // A 409 means the previous turn is still being written down — a moment's wait.
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = new FormData();
      form.append('audio', wav, 'speech.wav');
      form.append('callId', callId);
      form.append('lang', langRef.current);
      form.append('voice', voiceRef.current);
      try {
        res = await fetch('/api/demo/turn', { method: 'POST', body: form, signal: controller.signal });
      } catch {
        res = null;
        break;
      }
      if (res.status !== 409) break;
      await sleep(350);
    }
    if (seq !== seqRef.current) return;

    if (res?.status === 410 || res?.status === 429) {
      dropRow(row);
      if (res.status === 429) setNotice('busy');
      hangUp('server');
      return;
    }
    if (!res || !res.ok || !res.body) {
      dropRow(row);
      setWaiting(false);
      showFlash('network');
      voice.resumeListening();
      return;
    }
    await exchange(res, seq, row);
  };

  const answer = async () => {
    if (phaseRef.current === 'connecting' || phaseRef.current === 'live') return;
    if (!available) return setNotice('unavailable');
    if (!micSupported()) return setNotice('unsupported');

    // Created inside the tap: the only moment every browser lets audio start.
    const out = (outRef.current ??= new VoiceOut());
    void out.resume();
    vibrate();

    const seq = ++seqRef.current;
    callIdRef.current = null;
    setNotice(null);
    setMuted(false);
    mutedRef.current = false;
    setWaiting(true);
    const settle = morph(() => {
      go('connecting');
      setRows([{ id: rowId(), kind: 'persona' }]);
    });

    const controller = new AbortController();
    inflightRef.current = controller;
    const call = fetch('/api/demo/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: langRef.current, voice: voiceRef.current }),
      signal: controller.signal,
    }).catch(() => null);
    const [micReady, res] = await Promise.all([voice.startSession({ context: out.ctx }), call]);
    settle();
    if (seq !== seqRef.current) return; // hung up while connecting

    if (!micReady || !res?.ok || !res.body) {
      controller.abort();
      inflightRef.current = null;
      voice.stopSession();
      setWaiting(false);
      // A mic failure has already said why, through onError.
      if (micReady) setNotice(!res ? 'network' : res.status === 429 ? 'busy' : 'unavailable');
      morph(() => {
        go('ringing');
        setRows([]);
      });
      return;
    }

    out.tone('connect');
    startedAtRef.current = Date.now();
    setStartedAt(startedAtRef.current);
    go('live');
    void holdScreen();
    await exchange(res, seq);
  };

  const hangUp = (reason: EndReason) => {
    if (phaseRef.current !== 'live' && phaseRef.current !== 'connecting') return;
    silenceAgent();
    voice.stopSession();
    voice.setMuted(false);
    const callId = callIdRef.current;
    callIdRef.current = null;
    if (callId) {
      void fetch('/api/demo/end', { method: 'POST', body: JSON.stringify({ callId }), keepalive: true }).catch(() => {});
    }
    outRef.current?.tone('hangup');
    vibrate(20);
    releaseScreen();

    const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    recordingRowRef.current = null;
    morph(() => {
      go('ended');
      setEndReason(reason);
      setDuration(durationMs);
      setMuted(false);
      mutedRef.current = false;
      setRows((list) => list.filter((row) => row.kind !== 'user' || row.status === 'final'));
    });
  };

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    voice.setMuted(next);
  };

  const switchLang = (next: DemoLang) => {
    if (next === langRef.current) return;
    langRef.current = next;
    setLang(next);
    document.documentElement.lang = next;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('lang', next);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* the address bar is cosmetic */
    }
  };

  const switchVoice = (next: string) => {
    voiceRef.current = next;
    setVoicePick(next);
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set('voice', next);
      else url.searchParams.delete('voice');
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* the address bar is cosmetic */
    }
  };

  /* ── derived state ─────────────────────────────────────────── */

  const { voiceState } = voice;
  const orb =
    phase === 'ringing'
      ? 'ringing'
      : phase === 'connecting'
        ? 'connecting'
        : phase === 'ended'
          ? 'idle'
          : muted
            ? 'muted'
            : voiceState === 'ai_speaking'
              ? 'speaking'
              : voiceState === 'user_speaking'
                ? 'hearing'
                : voiceState === 'processing' || waiting
                  ? 'thinking'
                  : 'listening';

  const status = flash
    ? copy[flash]
    : phase === 'connecting'
      ? copy.connecting
      : phase === 'ended'
        ? `${endReason === 'transfer' ? copy.transferred : copy.ended} · ${clockText(duration)}`
        : {
            muted: copy.muted,
            speaking: copy.speaking,
            hearing: copy.hearing,
            thinking: copy.thinking,
            listening: copy.listening,
          }[orb as 'muted' | 'speaking' | 'hearing' | 'thinking' | 'listening'] ?? copy.listening;

  const orbAction = phase === 'ringing' || phase === 'ended' ? 'answer' : orb === 'speaking' ? 'interrupt' : null;
  const blocked = notice === 'unavailable' || notice === 'unsupported';
  const last = rows[rows.length - 1];
  const typing = phase === 'live' && waiting && last?.kind === 'user' && last.status === 'final';

  const onOrb = () => {
    if (orbAction === 'answer' && !blocked) void answer();
    else if (orbAction === 'interrupt') {
      silenceAgent();
      voice.resumeListening();
    }
  };

  /* ── effects ───────────────────────────────────────────────── */

  // The visitor's own bubble: live bars while they speak, dots while transcribing.
  useEffect(() => {
    if (phase !== 'live') return;
    if (voiceState === 'user_speaking' && !recordingRowRef.current) {
      const id = rowId();
      recordingRowRef.current = id;
      addRow({ id, kind: 'user', text: '', status: 'recording' });
    } else if ((voiceState === 'listening' || voiceState === 'error') && recordingRowRef.current) {
      dropRow(recordingRowRef.current);
      recordingRowRef.current = null;
    }
  }, [voiceState, phase]);

  // One loudness value drives the orb and the bars: the agent's voice while it
  // speaks, the visitor's mic otherwise. Written straight to a CSS variable.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (phase !== 'live' && phase !== 'connecting') {
      root.style.setProperty('--lvl', '0');
      return;
    }
    let frame = 0;
    let shown = 0;
    const tick = () => {
      const out = outRef.current;
      const target =
        out && out.remaining > 0 ? out.level() : mutedRef.current ? 0 : micLevelRef.current;
      shown += (target - shown) * (target > shown ? 0.45 : 0.12);
      root.style.setProperty('--lvl', shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  // Keep the newest line in view unless the visitor scrolled back to read.
  useEffect(() => {
    const scroller = scrollRef.current;
    const log = logRef.current;
    if (!scroller || !log) return;
    const onScroll = () => {
      pinnedRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    };
    const follow = new ResizeObserver(() => {
      if (pinnedRef.current) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    });
    scroller.addEventListener('scroll', onScroll, { passive: true });
    follow.observe(log);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      follow.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!micSupported()) setNotice((current) => current ?? 'unsupported');
  }, []);

  // Space answers or redials; M mutes. Buttons keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.target instanceof HTMLElement && e.target.closest('button, a, input, textarea'))) return;
      if (e.code === 'Space' && (phaseRef.current === 'ringing' || phaseRef.current === 'ended')) {
        e.preventDefault();
        if (!blocked) void answer();
      } else if (e.key.toLowerCase() === 'm' && phaseRef.current === 'live') {
        toggleMute();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Closing the tab hangs up; returning to it re-takes the screen wake lock.
  useEffect(() => {
    const bye = () => {
      const callId = callIdRef.current;
      if (callId) navigator.sendBeacon?.('/api/demo/end', JSON.stringify({ callId }));
    };
    const back = () => {
      if (document.visibilityState === 'visible' && phaseRef.current === 'live') void holdScreen();
    };
    window.addEventListener('pagehide', bye);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('pagehide', bye);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  useEffect(
    () => () => {
      outRef.current?.close();
      outRef.current = null;
    },
    [],
  );

  /* ── render ────────────────────────────────────────────────── */

  const inCall = phase === 'live' || phase === 'connecting';
  const personaLine = copy.persona(persona.name[lang], persona.birthYear);

  return (
    <div ref={rootRef} className={`${s.root} ${fontClass}`} data-phase={phase} data-orb={orb} lang={lang}>
      <header className={s.bar}>
        <div className={s.brand}>
          <span className={s.mark} aria-hidden />
          CallMind
          <span className={s.tag}>demo</span>
        </div>
        {phase === 'live' && (
          <div className={s.callChip}>
            <span className={s.rec} aria-hidden />
            {identity.agent[lang]}
            <Elapsed since={startedAt} />
          </div>
        )}
        <div className={s.barEnd}>
          {voices.length > 0 && <VoicePicker voice={voicePick} voices={voices} copy={copy} onChange={switchVoice} />}
          <LangSwitch lang={lang} label={copy.language} onChange={switchLang} />
        </div>
      </header>

      <main className={s.main}>
        <section className={s.stage} aria-label={identity.agent[lang]}>
          {phase === 'ringing' && (
            <p className={s.kicker}>
              <span className={s.beacon} aria-hidden />
              {copy.incoming}
            </p>
          )}

          <button
            type="button"
            className={s.orb}
            onClick={onOrb}
            data-action={orbAction ?? undefined}
            tabIndex={orbAction ? 0 : -1}
            aria-label={orbAction === 'interrupt' ? copy.interrupt : orbAction ? copy.answer : identity.agent[lang]}
          >
            <span className={s.ripple} />
            <span className={`${s.ripple} ${s.r2}`} />
            <span className={`${s.ripple} ${s.r3}`} />
            <span className={s.halo} />
            <span className={s.sphere}>
              <span className={`${s.blob} ${s.b1}`} />
              <span className={`${s.blob} ${s.b2}`} />
              <span className={`${s.blob} ${s.b3}`} />
              <span className={`${s.blob} ${s.b4}`} />
              <span className={s.gloss} />
            </span>
            <span className={s.spinner} />
          </button>

          <div className={s.identity}>
            <h1 className={s.name}>{identity.agent[lang]}</h1>
            <p className={s.org}>{identity.org[lang]}</p>
          </div>

          {phase !== 'ringing' && (
            <p className={s.status} aria-live="polite">
              {phase === 'live' && (
                <span className={s.clock}>
                  <span className={s.rec} aria-hidden />
                  <Elapsed since={startedAt} />
                </span>
              )}
              <span className={s.state}>{status}</span>
            </p>
          )}

          <div className={s.controls}>
            {phase === 'ringing' && (
              <button type="button" className={s.answer} onClick={() => void answer()} disabled={blocked}>
                <IconHandset />
                {copy.answer}
              </button>
            )}
            {inCall && (
              <>
                <button
                  type="button"
                  className={`${s.round} ${s.mute}`}
                  aria-pressed={muted}
                  aria-label={muted ? copy.unmute : copy.mute}
                  title={muted ? copy.unmute : copy.mute}
                  onClick={toggleMute}
                >
                  {muted ? <IconMicOff /> : <IconMic />}
                </button>
                <button
                  type="button"
                  className={`${s.round} ${s.end}`}
                  aria-label={copy.hangUp}
                  title={copy.hangUp}
                  onClick={() => hangUp('user')}
                >
                  <IconHangUp />
                </button>
              </>
            )}
            {phase === 'ended' && (
              <button type="button" className={s.redial} onClick={() => void answer()} disabled={blocked}>
                <IconHandset />
                {copy.redial}
              </button>
            )}
          </div>

          {phase === 'ringing' && (
            <p className={s.persona}>
              <IconPerson />
              {personaLine}
            </p>
          )}
          {notice && <NoticeCard notice={notice} copy={copy} />}
        </section>

        <section className={s.transcript} aria-label={copy.transcript}>
          <div className={s.scroller} ref={scrollRef}>
            <ol className={s.log} ref={logRef} role="log">
              {rows.map((row) => {
                if (row.kind === 'agent') {
                  return <AgentLine key={row.id} text={row.text} speech={row.speech} clock={clock} />;
                }
                if (row.kind === 'user') return <UserLine key={row.id} text={row.text} status={row.status} />;
                if (row.kind === 'persona') {
                  return (
                    <li key={row.id} className={s.note}>
                      <IconPerson />
                      {personaLine}
                    </li>
                  );
                }
                return (
                  <li key={row.id} className={s.note}>
                    <IconHeadset />
                    {copy.transferred}
                  </li>
                );
              })}
              {typing && (
                <li className={s.typing} aria-hidden>
                  <i />
                  <i />
                  <i />
                </li>
              )}
            </ol>
          </div>
        </section>
      </main>
    </div>
  );
}
