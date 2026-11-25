'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/primitives';
import type { TurnPhase, VoiceDebugEvent } from '@/lib/voice/turn-gate';

/**
 * Live voice debugging for the Playground (developer view, off by default):
 * the turn phase, mic level, the caller's learned level, and every recent
 * accept/reject decision with its reason. Holds no audio and no transcript.
 *
 * Turned on with `?voiceDebug=1` in the URL (remembered in this browser) and
 * off with `?voiceDebug=0`.
 */

const KEY = 'callmind.voiceDebug';
const MAX_EVENTS = 14;

export function useVoiceDebugEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      const flag = new URLSearchParams(window.location.search).get('voiceDebug');
      if (flag === '1') localStorage.setItem(KEY, '1');
      if (flag === '0') localStorage.removeItem(KEY);
      setOn(localStorage.getItem(KEY) === '1');
    } catch {
      setOn(false);
    }
  }, []);
  return on;
}

/** Collects the hook's debug events (pass `push` as `onDebug`). */
export function useVoiceDebugLog(enabled: boolean) {
  const [events, setEvents] = useState<VoiceDebugEvent[]>([]);
  const pending = useRef<VoiceDebugEvent[]>([]);
  const push = useRef((event: VoiceDebugEvent) => {
    pending.current.push(event);
  });
  useEffect(() => {
    if (!enabled) return;
    // Batch into React a few times a second: decisions arrive per animation frame.
    const id = setInterval(() => {
      if (!pending.current.length) return;
      const fresh = pending.current;
      pending.current = [];
      setEvents((list) => [...fresh.reverse(), ...list].slice(0, MAX_EVENTS));
    }, 250);
    return () => clearInterval(id);
  }, [enabled]);
  return { events, onDebug: enabled ? push.current : undefined };
}

const PHASE_TONE: Record<TurnPhase, string> = {
  idle: 'bg-surface-2 text-ink-3',
  listening: 'bg-success-soft text-success',
  capturing: 'bg-brand-soft text-brand',
  finalizing: 'bg-brand-soft text-brand',
  thinking: 'bg-warning-soft text-warning',
  speaking: 'bg-info-soft text-info',
  rearming: 'bg-surface-2 text-ink-2',
  error: 'bg-danger-soft text-danger',
};

export function VoiceDebugPanel({
  events,
  getPhase,
  getTurnId,
  getSpeakerReference,
  level,
}: {
  events: VoiceDebugEvent[];
  getPhase: () => TurnPhase;
  getTurnId: () => number;
  getSpeakerReference: () => number;
  level: number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, []);
  const phase = getPhase();
  const reference = getSpeakerReference();
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-ink">Voice debug</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${PHASE_TONE[phase]}`}>{phase}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-ink-3">Turn</dt>
        <dd className="text-right font-mono text-ink">{getTurnId()}</dd>
        <dt className="text-ink-3">Mic level</dt>
        <dd className="text-right font-mono text-ink">{level.toFixed(2)}</dd>
        <dt className="text-ink-3">Caller level (learned)</dt>
        <dd className="text-right font-mono text-ink">{reference ? reference.toFixed(3) : '—'}</dd>
        <dt className="text-ink-3">Gating</dt>
        <dd className="text-right text-ink">strict (thinking ignores the mic)</dd>
        <dt className="text-ink-3">Voice isolation</dt>
        <dd className="text-right text-ink">browser: none (see Nutqni matnga lab)</dd>
      </dl>
      <ul className="mt-3 max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex justify-between gap-2">
            <span className={e.kind === 'rejected' ? 'text-danger' : e.kind === 'accepted' ? 'text-success' : 'text-ink-2'}>
              {e.kind}
              {e.reason ? `: ${e.reason}` : ''}
            </span>
            <span className="text-ink-3">
              #{e.turnId} {e.phase}
              {e.level !== undefined ? ` ${e.level.toFixed(3)}` : ''}
            </span>
          </li>
        ))}
        {!events.length && <li className="text-ink-3">No decisions yet.</li>}
      </ul>
    </Card>
  );
}
