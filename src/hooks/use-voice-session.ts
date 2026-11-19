'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  joinRecordings,
  startRecording,
  VOICE_MIC_CONSTRAINTS,
  type RawAudio,
  type Recording,
  type RecordingResult,
} from '@/lib/audio';

export const SILENCE_TIMEOUT_MS = 800;
/**
 * A pause this long is usually the end of the phrase, so the utterance is
 * handed to `onSpeculate` while the rest of SILENCE_TIMEOUT_MS runs out: the
 * STT works during the wait instead of after it. Speech that resumes in time
 * is recorded on and joined, so nothing is cut off.
 */
export const EARLY_SILENCE_MS = 350;
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
  const turnIdRef = useRef(0);
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
  }, [onUtterance, onSpeculate, onBargeIn, onError, onLevel, getPlaybackLevel]);

  const transition = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setVoiceState(next);
  }, []);

  const clearCandidate = useCallback(() => {
    candidateSinceRef.current = 0;
    candidateLastVoiceAtRef.current = 0;
    voicedMsRef.current = 0;
    speechStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;
    partsRef.current = [];
    speculationRef.current = null;
    segmentRef.current += 1;
    const recording = recordingRef.current;
    recordingRef.current = null;
    recording?.cancel();
  }, []);

  const resumeListening = useCallback(() => {
    if (!activeRef.current) return;
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
  }, [clearCandidate, transition]);

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
    (reason: 'silence' | 'maximum') => {
      if (isFinalizingRef.current || stateRef.current !== 'user_speaking') return;
      const recording = recordingRef.current;
      const speculation = speculationRef.current;
      // The pause held: the utterance offered at its start is the final one,
      // and the recorder kept running since holds only silence.
      const pending: Promise<RecordingResult> | null =
        reason === 'silence' && speculation
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
      transition('processing');
      voiceLog('speech_ended', { reason, early: pending === speculation });
      voiceLog('processing');

      const generation = generationRef.current;
      const turnId = turnIdRef.current;
      void pending
        .then(async (result) => {
          if (!activeRef.current || generation !== generationRef.current) return;
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
    [failAndResume, transition],
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
    const turnId = turnIdRef.current;
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
        if (current && activeRef.current) onSpeculateRef.current?.(result, turnId);
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
      turnIdRef.current += 1;
      const candidateTurn = turnIdRef.current;
      void startRecording(streamRef.current)
        .then((recording) => {
          if (
            !activeRef.current ||
            stateRef.current !== expectedState ||
            turnIdRef.current !== candidateTurn ||
            !candidateSinceRef.current
          ) {
            recording.cancel();
            return;
          }
          recordingRef.current = recording;
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
        if (rms >= threshold) {
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
            voiceLog('speech_started', { turnId: turnIdRef.current });
          }
        } else if (candidateSinceRef.current && now - candidateLastVoiceAtRef.current > 120) {
          clearCandidate();
        } else if (!inTail) {
          noiseFloorRef.current = noiseFloorRef.current * 0.98 + Math.min(rms, 0.04) * 0.02;
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
        if (!bargeInAllowedRef.current) {
          // The browser's own voice: no echo reference and no cancellation, so no interruptions.
        } else if (rms >= threshold) {
          if (!candidateSinceRef.current) beginCandidate(now, 'ai_speaking');
          else candidateLastVoiceAtRef.current = now;
          // Only time the caller is actually heard counts (not gaps between loud frames).
          voicedMsRef.current += frameMs;
          if (candidateSinceRef.current && voicedMsRef.current >= BARGE_IN_SPEECH_MS && recordingRef.current) {
            speechStartedAtRef.current = candidateSinceRef.current;
            lastVoiceAtRef.current = now;
            transition('user_speaking');
            voiceLog('barge_in', {
              turnId: turnIdRef.current,
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
      if (rms >= threshold * RELEASE_RATIO) {
        lastVoiceAtRef.current = now;
        if (speculationRef.current) {
          // They went on: the offered utterance is stale; the fresh recorder
          // carries on and the pieces are joined at the real end.
          speculationRef.current = null;
          voiceLog('speech_resumed', { turnId: turnIdRef.current });
        }
      }
      const quiet = now - lastVoiceAtRef.current;
      if (quiet >= SILENCE_TIMEOUT_MS) finalizeUtterance('silence');
      else if (now - speechStartedAtRef.current >= MAX_UTTERANCE_MS) finalizeUtterance('maximum');
      else if (quiet >= EARLY_SILENCE_MS && onSpeculateRef.current && !speculationRef.current) speculate();
    }

    rafRef.current = requestAnimationFrame(analyse);
  }, [beginCandidate, clearCandidate, finalizeUtterance, speculate, transition]);

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

  useEffect(() => () => cleanup(false), [cleanup]);

  return {
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
  };
}
