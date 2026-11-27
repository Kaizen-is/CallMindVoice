'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  VOICE_MIC_CONSTRAINTS,
  joinRecordings,
  preRollPiece,
  startRecording,
  type RawAudio,
  type Recording,
  type RecordingResult,
} from '@/lib/audio';
import {
  DEFAULT_GATE,
  phaseOf,
  SpeakerLevel,
  speechLikeness,
  TurnLedger,
  type GateConfig,
  type RejectReason,
  type TurnPhase,
  type VoiceDebugEvent,
} from '@/lib/voice/turn-gate';
import { PreRoll } from '@/lib/voice/preroll';

/**
 * This much quiet ends the caller's turn. It was 800 ms, which cut callers off when they paused
 * mid-sentence on a phone ("…valyutasini ber…", 25 Nov 2026); the speculative STT below still starts
 * at EARLY_SILENCE_MS, so the longer wait costs about 0.3 s per turn.
 */
export const SILENCE_TIMEOUT_MS = 1100;
/**
 * A pause this long is usually the end of the phrase, so the utterance is
 * handed to `onSpeculate` while the rest of SILENCE_TIMEOUT_MS runs out: the
 * STT works during the wait instead of after it. Speech that resumes in time
 * is recorded on and joined, so nothing is cut off.
 */
export const EARLY_SILENCE_MS = 350;
/** How much sound before a phrase was detected goes in front of its recording (Q10). */
const PRE_ROLL_MS = 400;
/** Posts the mic's samples from the audio thread in ~21 ms frames (at 48 kHz) for the pre-roll. */
const PRE_ROLL_WORKLET = `
class PreRollTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('pre-roll-tap', PreRollTap);
`;
export const MIN_SPEECH_MS = 250;
export const MAX_UTTERANCE_MS = 30_000;
export const BARGE_IN_SPEECH_MS = 320;

const CALIBRATION_MS = 300;
const BARGE_IN_CALIBRATION_MS = 400;
const MIN_VOICE_RMS = 0.012;
const MIN_BARGE_IN_RMS = 0.02;
const NOISE_MULTIPLIER = 3;
const BARGE_IN_NOISE_MULTIPLIER = 3.5;
const RELEASE_RATIO = 0.7;
const ERROR_RECOVERY_MS = 1_500;
/**
 * Echo guard. The agent's own voice leaks back into the mic past the browser's
 * echo cancellation (more with loudspeakers, loud volume, or before the canceller
 * has adapted). With the agent's output level (`getPlaybackLevel`), the hook
 * learns how much of it reaches the mic and only treats the mic as the caller
 * when it is clearly louder than that predicted echo.
 */
const ECHO_MARGIN = 1.6;
/** The playback level remembered for echo that arrives late (output latency, room): half-life. */
const ECHO_PEAK_HALF_LIFE_MS = 150;
const ECHO_LEARN_MIN_PLAYBACK = 0.004;
const MAX_ECHO_RATIO = 4;
/** After the agent stops, its last syllable and the room's reverb must not open a new turn. */
const TAIL_GUARD_MS = 450;
/** Listening this long with nothing that could be the caller: `onListeningQuiet` (live STT drops room words). */
const QUIET_NOTICE_MS = 1_500;
/** The same rejection is reported to the debug view at most this often. */
const DEBUG_REJECT_EVERY_MS = 500;

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'processing'
  | 'ai_speaking'
  | 'error';

/** Why a session failed, for callers that show their own localised messages. */
export type VoiceErrorCode = 'mic_denied' | 'mic_unavailable' | 'recording';

/** Timing of a finished utterance, on the page's `performance.now()` clock. */
export interface UtteranceTiming {
  /** The last moment the caller's voice was heard — the real end of speech, before the silence wait. */
  speechEndedAt: number;
  /** When the utterance was handed over (end of speech + the silence that confirmed it). */
  finalizedAt: number;
}

interface UseVoiceSessionOptions {
  onUtterance: (recording: RecordingResult, turnId: number, timing: UtteranceTiming) => Promise<void> | void;
  /**
   * The utterance as it stands after EARLY_SILENCE_MS of quiet. If the pause
   * holds, `onUtterance` receives this very object (same `wav` Blob), so work
   * started on it can be reused; if speech resumes, it receives a longer one.
   */
  onSpeculate?: (recording: RecordingResult, turnId: number) => void;
  onBargeIn?: () => void;
  onError?: (message: string, code: VoiceErrorCode) => void;
  /**
   * The RMS (0–1) of what the agent is playing right now (VoiceOut.rms()). With it, the agent's
   * own voice leaking into the mic is told apart from the caller talking over it.
   */
  getPlaybackLevel?: () => number;
  /** Mic level 0–1 on every animation frame, for visuals that must not re-render React. */
  onLevel?: (level: number) => void;
  /**
   * Listening, and nothing that could be the caller for QUIET_NOTICE_MS. A streaming transcript
   * resets here, so room talk heard between turns is not sent with the caller's next phrase.
   */
  onListeningQuiet?: () => void;
  /** Turn-gate decisions (state, accepted/rejected and why) for the live debug view. */
  onDebug?: (event: VoiceDebugEvent) => void;
  /** Overrides of the gate (see turn-gate.ts); a ratio of 0 switches that check off. */
  gate?: Partial<GateConfig>;
  /**
   * The microphone as the browser actually set it up (Q10): echo cancellation, noise suppression and
   * gain control are requests a browser or device may not grant.
   */
  onMicReady?: (settings: MediaTrackSettings) => void;
  /**
   * How much quiet ends the phrase right now (ms), asked on every quiet frame: the Playground reads it
   * from the live words (src/lib/voice/endpointing.ts). Without it, SILENCE_TIMEOUT_MS.
   */
  silenceTimeoutMs?: () => number;
}

const voiceLog = (event: string, detail?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'production') return;
  if (detail) console.debug(`[VOICE] ${event}`, detail);
  else console.debug(`[VOICE] ${event}`);
};

export function useVoiceSession({
  onUtterance,
  onSpeculate,
  onBargeIn,
  onError,
  onLevel,
  getPlaybackLevel,
  onListeningQuiet,
  onDebug,
  gate,
  silenceTimeoutMs,
  onMicReady,
}: UseVoiceSessionOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);

  const stateRef = useRef<VoiceState>('idle');
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const recordingRef = useRef<Recording | null>(null);
  /** Finished pieces of the current utterance, split off at early pauses. */
  const partsRef = useRef<Promise<RawAudio>[]>([]);
  /** The utterance offered at the current pause; null once speech resumes. */
  const speculationRef = useRef<Promise<RecordingResult> | null>(null);
  /** Bumped whenever the utterance is finalized or dropped, to orphan a recorder still starting. */
  const segmentRef = useRef(0);
  /** The utterance most recently finalized. */
  const finalizedRef = useRef<Promise<RecordingResult> | null>(null);
  const candidateSinceRef = useRef(0);
  const candidateLastVoiceAtRef = useRef(0);
  const speechStartedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const noiseFloorRef = useRef(0.004);
  const playbackNoiseFloorRef = useRef(0.004);
  const calibratedAtRef = useRef(0);
  const bargeInCalibratedAtRef = useRef(0);
  /** Turn ids (one per candidate) and the one-submission-per-utterance rule. */
  const ledgerRef = useRef(new TurnLedger());
  /** The caller's own speech level, learned from their turns: the dominant-speaker gate. */
  const speakerRef = useRef<SpeakerLevel | null>(null);
  const gateRef = useRef<GateConfig>({ ...DEFAULT_GATE, ...gate });
  const quietSinceRef = useRef(0);
  const lastRejectRef = useRef<Partial<Record<RejectReason, number>>>({});
  const onListeningQuietRef = useRef(onListeningQuiet);
  const onDebugRef = useRef(onDebug);
  const silenceTimeoutRef = useRef(silenceTimeoutMs);
  const onMicReadyRef = useRef(onMicReady);
  onMicReadyRef.current = onMicReady;
  /** The last moments of mic sound (Q10), and the audio-thread tap that fills it. */
  const preRollRef = useRef<PreRoll | null>(null);
  const preRollTapRef = useRef<{ node: AudioWorkletNode; url: string } | null>(null);
  const isFinalizingRef = useRef(false);
  const lastLevelPaintRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownsContextRef = useRef(true);
  const mutedRef = useRef(false);
  const onUtteranceRef = useRef(onUtterance);
  const onSpeculateRef = useRef(onSpeculate);
  const onBargeInRef = useRef(onBargeIn);
  const onErrorRef = useRef(onError);
  const onLevelRef = useRef(onLevel);
  const getPlaybackLevelRef = useRef(getPlaybackLevel);
  /** Recent peak of the agent's output level (decays; echo arrives a little after the sound). */
  const playbackPeakRef = useRef(0);
  /** Learned mic level per unit of playback level: how much of the agent's voice comes back. */
  const echoRatioRef = useRef(0);
  /** Time the current barge-in candidate was actually loud (not just since it began). */
  const voicedMsRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  /** False while the browser's own speech engine talks: its sound bypasses echo cancellation. */
  const bargeInAllowedRef = useRef(true);
  const tailGuardUntilRef = useRef(0);
  const lastAiThresholdRef = useRef(0);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
    onSpeculateRef.current = onSpeculate;
    onBargeInRef.current = onBargeIn;
    onErrorRef.current = onError;
    onLevelRef.current = onLevel;
    getPlaybackLevelRef.current = getPlaybackLevel;
    onListeningQuietRef.current = onListeningQuiet;
    onDebugRef.current = onDebug;
    silenceTimeoutRef.current = silenceTimeoutMs;
  }, [onUtterance, onSpeculate, onBargeIn, onError, onLevel, getPlaybackLevel, onListeningQuiet, onDebug, silenceTimeoutMs]);

  if (!speakerRef.current) speakerRef.current = new SpeakerLevel(gateRef.current);
  const speaker = speakerRef.current;

  const currentPhase = useCallback(
    (): TurnPhase => phaseOf(stateRef.current, { inTailGuard: performance.now() < tailGuardUntilRef.current }),
    [],
  );

  const debug = useCallback(
    (kind: VoiceDebugEvent['kind'], extra?: Partial<VoiceDebugEvent>) => {
      const sink = onDebugRef.current;
      if (!sink) return;
      const now = performance.now();
      if (kind === 'rejected' && extra?.reason) {
        const reason = extra.reason as RejectReason;
        if (now - (lastRejectRef.current[reason] ?? 0) < DEBUG_REJECT_EVERY_MS) return;
        lastRejectRef.current[reason] = now;
      }
      sink({
        at: now,
        phase: currentPhase(),
        turnId: ledgerRef.current.currentId,
        kind,
        reference: speakerRef.current?.reference(),
        ...extra,
      });
    },
    [currentPhase],
  );

  const transition = useCallback(
    (next: VoiceState) => {
      const changed = stateRef.current !== next;
      stateRef.current = next;
      setVoiceState(next);
      if (changed) debug('phase');
    },
    [debug],
  );

  const clearCandidate = useCallback(() => {
    candidateSinceRef.current = 0;
    candidateLastVoiceAtRef.current = 0;
    voicedMsRef.current = 0;
    speechStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;
    partsRef.current = [];
    speculationRef.current = null;
    segmentRef.current += 1;
    speakerRef.current?.discardUtterance();
    const recording = recordingRef.current;
    recordingRef.current = null;
    recording?.cancel();
  }, []);

  const resumeListening = useCallback(() => {
    if (!activeRef.current) return;
    // The caller is mid-phrase (e.g. they interrupted the agent): a late "done" from the turn
    // they cut off must not throw their new utterance away.
    if (stateRef.current === 'user_speaking') {
      voiceLog('resume_ignored_while_capturing', { turnId: ledgerRef.current.currentId });
      debug('rejected', { reason: 'stale_turn' });
      return;
    }
    quietSinceRef.current = performance.now();
    if (stateRef.current === 'ai_speaking') {
      voiceLog('tts_finished');
      tailGuardUntilRef.current = performance.now() + TAIL_GUARD_MS;
    }
    clearCandidate();
    setError(null);
    transition('listening');
    const context = contextRef.current;
    if (context?.state === 'suspended') void context.resume().catch(() => {});
    voiceLog('listening_resumed');
  }, [clearCandidate, debug, transition]);

  const failAndResume = useCallback(
    (message: string, notify = true) => {
      clearCandidate();
      setError(message);
      transition('error');
      if (notify) onErrorRef.current?.(message, 'recording');
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      if (activeRef.current) {
        recoveryTimerRef.current = setTimeout(() => {
          recoveryTimerRef.current = null;
          resumeListening();
        }, ERROR_RECOVERY_MS);
      }
    },
    [clearCandidate, resumeListening, transition],
  );

  const finalizeUtterance = useCallback(
    (reason: 'silence' | 'maximum' | 'model') => {
      if (isFinalizingRef.current || stateRef.current !== 'user_speaking') return;
      const recording = recordingRef.current;
      const speculation = speculationRef.current;
      // The pause held: the utterance offered at its start is the final one,
      // and the recorder kept running since holds only silence.
      const pending: Promise<RecordingResult> | null =
        (reason === 'silence' || reason === 'model') && speculation
          ? speculation
          : recording
            ? Promise.all([...partsRef.current, recording.stopRaw()]).then(joinRecordings)
            : partsRef.current.length
              ? Promise.all(partsRef.current).then(joinRecordings)
              : null;
      if (!pending) {
        failAndResume('Audio yozuvini yakunlab bo‘lmadi');
        return;
      }
      if (pending === speculation) recording?.cancel();
      finalizedRef.current = pending;
      const timing: UtteranceTiming = {
        speechEndedAt: lastVoiceAtRef.current || performance.now(),
        finalizedAt: performance.now(),
      };

      isFinalizingRef.current = true;
      recordingRef.current = null;
      partsRef.current = [];
      speculationRef.current = null;
      segmentRef.current += 1;
      candidateSinceRef.current = 0;
      speechStartedAtRef.current = 0;
      lastVoiceAtRef.current = 0;
      // FINALIZING -> THINKING: from here nothing the mic hears joins or replaces this turn.
      const turnId = ledgerRef.current.currentId;
      speakerRef.current?.commitUtterance();
      transition('processing');
      debug('finalized', { reason, turnId });
      voiceLog('speech_ended', { reason, early: pending === speculation });
      voiceLog('processing');

      const generation = generationRef.current;
      void pending
        .then(async (result) => {
          if (!activeRef.current || generation !== generationRef.current) return;
          // Exactly one submission per finalized utterance, and only while it is the current turn.
          if (!ledgerRef.current.claimSubmission(turnId)) {
            voiceLog('stale_utterance_dropped', { turnId });
            return;
          }
          voiceLog('utterance_finalized', {
            turnId,
            durationMs: Math.round(result.durationSec * 1000),
          });
          await onUtteranceRef.current(result, turnId, timing);
        })
        .catch((cause) => {
          if (!activeRef.current || generation !== generationRef.current) return;
          failAndResume(cause instanceof Error ? cause.message : 'Audio yozuvini yakunlab bo‘lmadi');
        })
        .finally(() => {
          isFinalizingRef.current = false;
        });
    },
    [debug, failAndResume, transition],
  );

  /**
   * At an early pause: close the current piece and offer the utterance so far,
   * while a fresh recorder — started first, so not a syllable falls between
   * the two — keeps listening in case the speaker goes on.
   */
  const speculate = useCallback(() => {
    const recording = recordingRef.current;
    const stream = streamRef.current;
    if (!recording || !stream || speculationRef.current) return;
    const segment = segmentRef.current;
    const turnId = ledgerRef.current.currentId;
    recordingRef.current = null;
    void startRecording(stream)
      .then((next) => {
        if (segment !== segmentRef.current || !activeRef.current) next.cancel();
        else recordingRef.current = next;
      })
      .catch(() => {
        /* the pause will finalize on the speculation alone */
      });
    partsRef.current = [...partsRef.current, recording.stopRaw()];
    const speculation = Promise.all(partsRef.current).then(joinRecordings);
    speculationRef.current = speculation;
    voiceLog('speech_paused', { turnId });
    void speculation
      .then((result) => {
        // Offered while the pause lasts, and also once it has finalized on
        // this very utterance: that is when the work it starts gets used.
        const current = speculationRef.current === speculation || finalizedRef.current === speculation;
        if (current && activeRef.current && ledgerRef.current.isCurrent(turnId)) {
          onSpeculateRef.current?.(result, turnId);
        }
      })
      .catch(() => {
        /* finalize reports a failed recording */
      });
  }, []);

  const beginCandidate = useCallback(
    (now: number, expectedState: 'listening' | 'ai_speaking') => {
      if (candidateSinceRef.current || !streamRef.current) return;
      candidateSinceRef.current = now;
      candidateLastVoiceAtRef.current = now;
      const candidateTurn = ledgerRef.current.open();
      void startRecording(streamRef.current)
        .then((recording) => {
          if (
            !activeRef.current ||
            stateRef.current !== expectedState ||
            !ledgerRef.current.isCurrent(candidateTurn) ||
            !candidateSinceRef.current
          ) {
            recording.cancel();
            return;
          }
          recordingRef.current = recording;
          // The sound just before the recorder started goes in front: the first syllable is kept.
          const kept = preRollRef.current?.snapshot();
          const rate = contextRef.current?.sampleRate;
          if (kept?.length && rate) partsRef.current.unshift(preRollPiece(kept, rate));
        })
        .catch((cause) =>
          failAndResume(cause instanceof Error ? cause.message : 'Audio yozuvini boshlab bo‘lmadi'),
        );
    },
    [failAndResume],
  );

  const analyse = useCallback(() => {
    const analyser = analyserRef.current;
    if (!activeRef.current || !analyser) return;

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const now = performance.now();
    const frameMs = lastFrameAtRef.current ? Math.min(100, Math.max(0, now - lastFrameAtRef.current)) : 16;
    lastFrameAtRef.current = now;
    /** Voice-like (harmonic, in the voice band)? Measured only when a decision needs it. */
    const speechLike = () => {
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(spectrum);
      return speechLikeness(spectrum, analyser.context.sampleRate, gateRef.current).speechLike;
    };

    // What the agent is playing, held for a moment: its echo reaches the mic a little later.
    const playback = getPlaybackLevelRef.current?.() ?? 0;
    playbackPeakRef.current = Math.max(playback, playbackPeakRef.current * 0.5 ** (frameMs / ECHO_PEAK_HALF_LIFE_MS));
    const predictedEcho = echoRatioRef.current * playbackPeakRef.current;
    /** Learn how much of the agent's voice comes back: quickly at the start of its turn, slowly after. */
    const learnEcho = (fast: boolean) => {
      if (playbackPeakRef.current < ECHO_LEARN_MIN_PLAYBACK) return;
      const seen = Math.min(MAX_ECHO_RATIO, rms / playbackPeakRef.current);
      const rate = seen > echoRatioRef.current ? (fast ? 0.2 : 0.02) : fast ? 0.02 : 0.005;
      echoRatioRef.current += (seen - echoRatioRef.current) * rate;
    };

    onLevelRef.current?.(Math.min(1, rms / 0.08));
    if (now - lastLevelPaintRef.current >= 80) {
      lastLevelPaintRef.current = now;
      setLevel(Math.min(1, rms / 0.08));
    }

    if (stateRef.current === 'listening') {
      const inTail = now < tailGuardUntilRef.current;
      if (now < calibratedAtRef.current) {
        noiseFloorRef.current = noiseFloorRef.current * 0.85 + Math.min(rms, 0.04) * 0.15;
      } else {
        // Right after the agent stops, the end of its voice (and the room) still rings: the
        // interruption threshold holds for a moment, and any remaining echo is discounted.
        const threshold = Math.max(
          MIN_VOICE_RMS,
          noiseFloorRef.current * NOISE_MULTIPLIER,
          predictedEcho * ECHO_MARGIN,
          inTail ? lastAiThresholdRef.current : 0,
        );
        const loudEnough = rms >= threshold;
        // Loud enough to be speech, but far quieter than the caller's own voice: someone else.
        const primary = loudEnough && speaker.allowsStart(rms);
        // And shaped like a voice: a car, wind or a fan is loud but has no voice-band structure, and
        // must not start a phrase (Q7, 26 Nov 2026: background noise kept opening "listening").
        const voiceLike = primary && speechLike();
        if (loudEnough && !primary) debug('rejected', { reason: 'below_primary_level', level: rms });
        else if (primary && !voiceLike) debug('rejected', { reason: 'not_speech_like', level: rms });
        if (voiceLike) {
          quietSinceRef.current = now;
          if (!candidateSinceRef.current) {
            beginCandidate(now, 'listening');
          } else {
            candidateLastVoiceAtRef.current = now;
          }
          if (
            candidateSinceRef.current &&
            now - candidateSinceRef.current >= MIN_SPEECH_MS &&
            recordingRef.current
          ) {
            speechStartedAtRef.current = candidateSinceRef.current;
            lastVoiceAtRef.current = now;
            transition('user_speaking');
            debug('accepted', { level: rms });
            voiceLog('speech_started', { turnId: ledgerRef.current.currentId });
          }
        } else if (candidateSinceRef.current && now - candidateLastVoiceAtRef.current > 120) {
          clearCandidate();
          debug('rejected', { reason: 'too_short', level: rms });
        } else {
          // The room's level, kept up to date: quiet moments, and loud sound that is not a voice
          // (a car going by, wind), so a steady noise raises the bar instead of opening a phrase.
          if (!inTail && (!loudEnough || !voiceLike)) {
            noiseFloorRef.current = noiseFloorRef.current * 0.98 + Math.min(rms, 0.04) * 0.02;
          }
          if (!candidateSinceRef.current && now - quietSinceRef.current >= QUIET_NOTICE_MS) {
            quietSinceRef.current = now;
            onListeningQuietRef.current?.();
          }
        }
      }
    } else if (stateRef.current === 'ai_speaking') {
      if (now < bargeInCalibratedAtRef.current) {
        // The floor stays the room's noise (capped near silence); the agent's own leakage is
        // learned separately, relative to what it plays (echo guard) — counting it in both would
        // make a real interruption hard to hear.
        const calibrationCap = Math.max(0.012, noiseFloorRef.current * 2);
        playbackNoiseFloorRef.current =
          playbackNoiseFloorRef.current * 0.85 + Math.min(rms, calibrationCap) * 0.15;
        learnEcho(true);
      } else {
        // Echo cancellation handles most speaker leakage. This second, higher
        // adaptive threshold requires a sustained signal clearly above the
        // measured playback residue — and above the echo predicted from what the
        // agent is saying right now — before treating it as an interruption.
        const threshold = Math.max(
          MIN_BARGE_IN_RMS,
          playbackNoiseFloorRef.current * BARGE_IN_NOISE_MULTIPLIER,
          noiseFloorRef.current * NOISE_MULTIPLIER,
          predictedEcho * ECHO_MARGIN,
        );
        lastAiThresholdRef.current = threshold;
        // An interruption must be loud enough, clearly the caller (not a quieter voice in the
        // room) and shaped like a voice (not a click or thump): amplitude alone is not proof.
        const loudEnough = bargeInAllowedRef.current && rms >= threshold;
        const primary = loudEnough && speaker.allowsBargeIn(rms);
        const voiceLike = primary && speechLike();
        if (loudEnough && !primary) debug('rejected', { reason: 'below_primary_level', level: rms });
        else if (primary && !voiceLike) debug('rejected', { reason: 'not_speech_like', level: rms });
        if (!bargeInAllowedRef.current) {
          // The browser's own voice: no echo reference and no cancellation, so no interruptions.
        } else if (voiceLike) {
          if (!candidateSinceRef.current) beginCandidate(now, 'ai_speaking');
          else candidateLastVoiceAtRef.current = now;
          // Only time the caller is actually heard counts (not gaps between loud frames).
          voicedMsRef.current += frameMs;
          if (candidateSinceRef.current && voicedMsRef.current >= BARGE_IN_SPEECH_MS && recordingRef.current) {
            speechStartedAtRef.current = candidateSinceRef.current;
            lastVoiceAtRef.current = now;
            transition('user_speaking');
            debug('barge_in', { level: rms });
            voiceLog('barge_in', {
              turnId: ledgerRef.current.currentId,
              rms: Number(rms.toFixed(4)),
              threshold: Number(threshold.toFixed(4)),
              echo: Number(predictedEcho.toFixed(4)),
            });
            onBargeInRef.current?.();
          }
        } else if (candidateSinceRef.current && now - candidateLastVoiceAtRef.current > 120) {
          clearCandidate();
        } else if (!candidateSinceRef.current) {
          const trackingCap = Math.max(0.012, noiseFloorRef.current * 2);
          playbackNoiseFloorRef.current =
            playbackNoiseFloorRef.current * 0.98 + Math.min(rms, trackingCap) * 0.02;
          learnEcho(false);
        }
      }
    } else if (stateRef.current === 'user_speaking') {
      const threshold = Math.max(MIN_VOICE_RMS, noiseFloorRef.current * NOISE_MULTIPLIER);
      if (rms >= threshold) speaker.observeFrame(rms);
      // Going on after a pause must sound like the caller, not a quieter voice in the room:
      // otherwise background talk in the end-of-phrase silence is glued onto their phrase.
      // Going on means voice again, not the wind or a car carrying on after the caller stopped.
      if (rms >= threshold * RELEASE_RATIO && speaker.allowsContinue(rms) && speechLike()) {
        lastVoiceAtRef.current = now;
        if (speculationRef.current) {
          // They went on: the offered utterance is stale; the fresh recorder
          // carries on and the pieces are joined at the real end.
          speculationRef.current = null;
          voiceLog('speech_resumed', { turnId: ledgerRef.current.currentId });
        }
      } else if (rms >= threshold * RELEASE_RATIO) {
        debug('rejected', { reason: 'below_primary_level', level: rms });
      }
      const quiet = now - lastVoiceAtRef.current;
      // Never shorter than the early pause plus a little: the speculative STT must get its chance.
      const endAfter = Math.max(EARLY_SILENCE_MS + 100, silenceTimeoutRef.current?.() ?? SILENCE_TIMEOUT_MS);
      if (quiet >= endAfter) finalizeUtterance('silence');
      else if (now - speechStartedAtRef.current >= MAX_UTTERANCE_MS) finalizeUtterance('maximum');
      else if (quiet >= EARLY_SILENCE_MS && onSpeculateRef.current && !speculationRef.current) speculate();
    }

    rafRef.current = requestAnimationFrame(analyse);
  }, [beginCandidate, clearCandidate, debug, finalizeUtterance, speculate, speaker, transition]);

  const cleanup = useCallback(
    (updateReactState: boolean) => {
      generationRef.current += 1;
      startingRef.current = false;
      activeRef.current = false;
      isFinalizingRef.current = false;
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      clearCandidate();
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      const tap = preRollTapRef.current;
      preRollTapRef.current = null;
      preRollRef.current = null;
      if (tap) {
        tap.node.port.onmessage = null;
        tap.node.disconnect();
        URL.revokeObjectURL(tap.url);
      }
      analyserRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const context = contextRef.current;
      contextRef.current = null;
      // A context the caller lent us (see startSession) is theirs to close.
      if (context && ownsContextRef.current && context.state !== 'closed') void context.close().catch(() => {});
      if (updateReactState) {
        stateRef.current = 'idle';
        setVoiceState('idle');
        setIsSessionActive(false);
        setLevel(0);
        setError(null);
      }
    },
    [clearCandidate],
  );

  const stopSession = useCallback(() => {
    const hadSession = activeRef.current || startingRef.current;
    cleanup(true);
    if (hadSession) voiceLog('session_stopped');
  }, [cleanup]);

  /**
   * Open the mic and start listening. Resolves true once listening.
   *
   * `context` lets the caller supply an AudioContext it created inside the
   * user's tap. iOS Safari only starts a context during a gesture, and one
   * created here — after awaiting the mic permission — can stay suspended,
   * leaving the analyser silent and the VAD deaf.
   */
  const startSession = useCallback(async (options?: { context?: AudioContext }): Promise<boolean> => {
    if (activeRef.current || startingRef.current) return activeRef.current;
    cleanup(true);
    startingRef.current = true;
    const generation = generationRef.current;
    voiceLog('session_started');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_MIC_CONSTRAINTS });
      if (!startingRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      // Store resources as soon as they exist so any later setup failure is
      // handled by the same cleanup path (including stopped mic tracks).
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !mutedRef.current;
      });
      const settings = stream.getAudioTracks()[0]?.getSettings?.();
      if (settings) {
        voiceLog('microphone_settings', {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
        });
        onMicReadyRef.current?.(settings);
      }

      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ownsContextRef.current = !options?.context;
      const context = options?.context ?? new AudioContextCtor();
      contextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      // Q10: an audio-thread tap keeps the last PRE_ROLL_MS of sound (best effort: without
      // AudioWorklet, recordings simply start when speech is detected, as before).
      void (async () => {
        try {
          const url = URL.createObjectURL(new Blob([PRE_ROLL_WORKLET], { type: 'application/javascript' }));
          await context.audioWorklet.addModule(url);
          if (generation !== generationRef.current) {
            URL.revokeObjectURL(url);
            return;
          }
          const node = new AudioWorkletNode(context, 'pre-roll-tap');
          const ring = new PreRoll((PRE_ROLL_MS / 1000) * context.sampleRate);
          node.port.onmessage = (e: MessageEvent<Float32Array>) => ring.push(e.data);
          source.connect(node);
          preRollRef.current = ring;
          preRollTapRef.current = { node, url };
        } catch (err) {
          voiceLog('pre_roll_unavailable', { error: String(err) });
        }
      })();

      startingRef.current = false;
      activeRef.current = true;
      sourceRef.current = source;
      analyserRef.current = analyser;
      noiseFloorRef.current = 0.004;
      calibratedAtRef.current = performance.now() + CALIBRATION_MS;
      echoRatioRef.current = 0;
      playbackPeakRef.current = 0;
      tailGuardUntilRef.current = 0;
      bargeInAllowedRef.current = true;
      setIsSessionActive(true);
      setError(null);
      transition('listening');
      voiceLog('microphone_ready');
      voiceLog('listening');
      rafRef.current = requestAnimationFrame(analyse);
      return true;
    } catch (cause) {
      startingRef.current = false;
      cleanup(false);
      const denied =
        cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError');
      const message = denied
        ? 'Mikrofonga ruxsat berilmadi'
        : cause instanceof Error
          ? cause.message
          : 'Mikrofon bilan xatolik yuz berdi';
      setError(message);
      transition('error');
      onErrorRef.current?.(message, denied ? 'mic_denied' : 'mic_unavailable');
      return false;
    }
  }, [analyse, cleanup, transition]);

  /**
   * Mute without closing the mic: a disabled track delivers silence, so the VAD
   * hears nothing and nothing is recorded, and unmuting is instant.
   */
  const setMuted = useCallback(
    (muted: boolean) => {
      mutedRef.current = muted;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      // A phrase cut off by muting was not meant to be sent.
      if (muted && stateRef.current === 'user_speaking') {
        clearCandidate();
        transition('listening');
      }
    },
    [clearCandidate, transition],
  );

  /**
   * The agent starts talking. `bargeIn: false` when it speaks through the browser's own speech
   * engine: that sound bypasses echo cancellation and has no level to compare, so it would
   * otherwise interrupt itself.
   */
  const setAiSpeaking = useCallback(
    (options?: { bargeIn?: boolean }) => {
      if (!activeRef.current) return;
      clearCandidate();
      bargeInAllowedRef.current = options?.bargeIn !== false;
      playbackNoiseFloorRef.current = Math.max(0.004, noiseFloorRef.current);
      // Re-learned at the start of every turn (volume, device and echo cancellation change).
      echoRatioRef.current *= 0.7;
      bargeInCalibratedAtRef.current = performance.now() + BARGE_IN_CALIBRATION_MS;
      transition('ai_speaking');
      voiceLog('tts_started');
    },
    [clearCandidate, transition],
  );

  const sessionIsActive = useCallback(() => activeRef.current, []);
  /** The shared turn phase right now (for the debug view; not React state). */
  const getPhase = currentPhase;
  const getTurnId = useCallback(() => ledgerRef.current.currentId, []);
  /** The caller's learned speech level (0 until their first turn). */
  const getSpeakerReference = useCallback(() => speakerRef.current?.reference() ?? 0, []);

  useEffect(() => () => cleanup(false), [cleanup]);

  /**
   * L3: the end-of-turn model is sure the caller has finished. The phrase ends now instead of after the
   * rest of the silence wait — only while they are still quiet since the early pause (that pause's
   * utterance is still the one on offer). True when it ended.
   */
  const endPhraseNow = useCallback((): boolean => {
    if (stateRef.current !== 'user_speaking' || !speculationRef.current || isFinalizingRef.current) return false;
    finalizeUtterance('model');
    return true;
  }, [finalizeUtterance]);

  return {
    endPhraseNow,
    voiceState,
    level,
    error,
    isSessionActive,
    startSession,
    stopSession,
    setAiSpeaking,
    resumeListening,
    failAndResume,
    sessionIsActive,
    setMuted,
    getPhase,
    getTurnId,
    getSpeakerReference,
  };
}
