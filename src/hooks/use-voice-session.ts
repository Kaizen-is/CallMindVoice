'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startRecording,
  VOICE_MIC_CONSTRAINTS,
  type Recording,
  type RecordingResult,
} from '@/lib/audio';

export const SILENCE_TIMEOUT_MS = 800;
export const MIN_SPEECH_MS = 250;
export const MAX_UTTERANCE_MS = 30_000;
export const BARGE_IN_SPEECH_MS = 320;

const CALIBRATION_MS = 300;
const BARGE_IN_CALIBRATION_MS = 250;
const MIN_VOICE_RMS = 0.012;
const MIN_BARGE_IN_RMS = 0.02;
const NOISE_MULTIPLIER = 3;
const BARGE_IN_NOISE_MULTIPLIER = 3.5;
const RELEASE_RATIO = 0.7;
const ERROR_RECOVERY_MS = 1_500;

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'processing'
  | 'ai_speaking'
  | 'error';

/** Why a session failed, for callers that show their own localised messages. */
export type VoiceErrorCode = 'mic_denied' | 'mic_unavailable' | 'recording';

interface UseVoiceSessionOptions {
  onUtterance: (recording: RecordingResult, turnId: number) => Promise<void> | void;
  onBargeIn?: () => void;
  onError?: (message: string, code: VoiceErrorCode) => void;
  /** Mic level 0–1 on every animation frame, for visuals that must not re-render React. */
  onLevel?: (level: number) => void;
}

const voiceLog = (event: string, detail?: Record<string, unknown>) => {
  if (process.env.NODE_ENV === 'production') return;
  if (detail) console.debug(`[VOICE] ${event}`, detail);
  else console.debug(`[VOICE] ${event}`);
};

export function useVoiceSession({ onUtterance, onBargeIn, onError, onLevel }: UseVoiceSessionOptions) {
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
  const onBargeInRef = useRef(onBargeIn);
  const onErrorRef = useRef(onError);
  const onLevelRef = useRef(onLevel);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
    onBargeInRef.current = onBargeIn;
    onErrorRef.current = onError;
    onLevelRef.current = onLevel;
  }, [onUtterance, onBargeIn, onError, onLevel]);

  const transition = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setVoiceState(next);
  }, []);

  const clearCandidate = useCallback(() => {
    candidateSinceRef.current = 0;
    candidateLastVoiceAtRef.current = 0;
    speechStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;
    const recording = recordingRef.current;
    recordingRef.current = null;
    recording?.cancel();
  }, []);

  const resumeListening = useCallback(() => {
    if (!activeRef.current) return;
    if (stateRef.current === 'ai_speaking') voiceLog('tts_finished');
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
      if (!recording) {
        failAndResume('Audio yozuvini yakunlab bo‘lmadi');
        return;
      }

      isFinalizingRef.current = true;
      recordingRef.current = null;
      candidateSinceRef.current = 0;
      speechStartedAtRef.current = 0;
      lastVoiceAtRef.current = 0;
      transition('processing');
      voiceLog('speech_ended', { reason });
      voiceLog('processing');

      const generation = generationRef.current;
      const turnId = turnIdRef.current;
      void recording
        .stop()
        .then(async (result) => {
          if (!activeRef.current || generation !== generationRef.current) return;
          voiceLog('utterance_finalized', {
            turnId,
            durationMs: Math.round(result.durationSec * 1000),
          });
          await onUtteranceRef.current(result, turnId);
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

    onLevelRef.current?.(Math.min(1, rms / 0.08));
    if (now - lastLevelPaintRef.current >= 80) {
      lastLevelPaintRef.current = now;
      setLevel(Math.min(1, rms / 0.08));
    }

    if (stateRef.current === 'listening') {
      if (now < calibratedAtRef.current) {
        noiseFloorRef.current = noiseFloorRef.current * 0.85 + Math.min(rms, 0.04) * 0.15;
      } else {
        const threshold = Math.max(MIN_VOICE_RMS, noiseFloorRef.current * NOISE_MULTIPLIER);
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
        } else {
          noiseFloorRef.current = noiseFloorRef.current * 0.98 + Math.min(rms, 0.04) * 0.02;
        }
      }
    } else if (stateRef.current === 'ai_speaking') {
      if (now < bargeInCalibratedAtRef.current) {
        const calibrationCap = Math.max(0.012, noiseFloorRef.current * 2);
        playbackNoiseFloorRef.current =
          playbackNoiseFloorRef.current * 0.85 + Math.min(rms, calibrationCap) * 0.15;
      } else {
        // Echo cancellation handles most speaker leakage. This second, higher
        // adaptive threshold requires a sustained signal clearly above the
        // measured playback residue before treating it as an interruption.
        const threshold = Math.max(
          MIN_BARGE_IN_RMS,
          playbackNoiseFloorRef.current * BARGE_IN_NOISE_MULTIPLIER,
          noiseFloorRef.current * NOISE_MULTIPLIER,
        );
        if (rms >= threshold) {
          if (!candidateSinceRef.current) beginCandidate(now, 'ai_speaking');
          else candidateLastVoiceAtRef.current = now;
          if (
            candidateSinceRef.current &&
            now - candidateSinceRef.current >= BARGE_IN_SPEECH_MS &&
            recordingRef.current
          ) {
            speechStartedAtRef.current = candidateSinceRef.current;
            lastVoiceAtRef.current = now;
            transition('user_speaking');
            voiceLog('barge_in', { turnId: turnIdRef.current });
            onBargeInRef.current?.();
          }
        } else if (candidateSinceRef.current && now - candidateLastVoiceAtRef.current > 120) {
          clearCandidate();
        } else if (!candidateSinceRef.current) {
          const trackingCap = Math.max(0.012, noiseFloorRef.current * 2);
          playbackNoiseFloorRef.current =
            playbackNoiseFloorRef.current * 0.98 + Math.min(rms, trackingCap) * 0.02;
        }
      }
    } else if (stateRef.current === 'user_speaking') {
      const threshold = Math.max(MIN_VOICE_RMS, noiseFloorRef.current * NOISE_MULTIPLIER);
      if (rms >= threshold * RELEASE_RATIO) lastVoiceAtRef.current = now;
      if (now - lastVoiceAtRef.current >= SILENCE_TIMEOUT_MS) finalizeUtterance('silence');
      else if (now - speechStartedAtRef.current >= MAX_UTTERANCE_MS) finalizeUtterance('maximum');
    }

    rafRef.current = requestAnimationFrame(analyse);
  }, [beginCandidate, clearCandidate, finalizeUtterance, transition]);

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

  const setAiSpeaking = useCallback(() => {
    if (!activeRef.current) return;
    clearCandidate();
    playbackNoiseFloorRef.current = Math.max(0.004, noiseFloorRef.current);
    bargeInCalibratedAtRef.current = performance.now() + BARGE_IN_CALIBRATION_MS;
    transition('ai_speaking');
    voiceLog('tts_started');
  }, [clearCandidate, transition]);

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
