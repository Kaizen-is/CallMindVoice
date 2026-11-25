/**
 * Turn gating for the browser voice session: the decisions that say whether
 * sound in the microphone may START, CONTINUE or INTERRUPT a caller turn.
 *
 * Detecting speech and being allowed to make a turn of it are separate steps.
 * The voice hook (`use-voice-session.ts`) measures the mic; this module decides.
 * It has no DOM or React dependencies, so it is unit-tested with `node --test`
 * (tests/web/turn-gate.test.mjs).
 *
 * What it can and cannot do: it compares sound with the caller's OWN measured
 * speech level and checks that it looks like a voice rather than a click or
 * hiss. A person farther from the mic is quieter than the caller, so most
 * background talk falls below the gate. A background speaker as loud as the
 * caller passes: this is a dominant-speaker heuristic, not speaker
 * identification.
 */

/** The turn states every component reports in (see docs/audio-pipeline.md). */
export type TurnPhase =
  | 'idle'
  | 'listening'
  | 'capturing'
  | 'finalizing'
  | 'thinking'
  | 'speaking'
  | 'rearming'
  | 'error';

/** Why sound was not allowed to become (or extend, or interrupt) a turn. */
export type RejectReason =
  | 'thinking' // a turn is being answered: nothing heard now may change it
  | 'speaking_echo' // below what the agent's own echo would explain
  | 'tail_guard' // right after the agent stopped: its last syllable / the room
  | 'below_primary_level' // much quieter than the caller's own voice: likely someone else
  | 'not_speech_like' // a click, thump or hiss: no voice-band structure
  | 'too_short' // a burst shorter than a turn may start with
  | 'stale_turn' // a result for a turn that is no longer current
  | 'muted';

export interface GateConfig {
  /** A new turn needs at least this fraction of the caller's learned speech level (0 = off). */
  startRatio: number;
  /** After a pause, speech must reach this fraction of it to count as the caller going on. */
  continueRatio: number;
  /** An interruption of the agent needs this fraction of it. */
  bargeInRatio: number;
  /** Utterances heard before the learned level is trusted. */
  minUtterancesToLearn: number;
  /** Learning rate of the level (per accepted utterance). */
  learnRate: number;
  /** Voice band (Hz) used for the speech-likeness check. */
  voiceBandHz: [number, number];
  /** Minimum share of energy inside the voice band. */
  minVoiceBandShare: number;
  /** Maximum spectral flatness inside the band (1 = white noise, voiced speech is far lower). */
  maxFlatness: number;
}

export const DEFAULT_GATE: GateConfig = {
  // -12 dB below the caller's typical level: a quieter caller still passes, a
  // voice across the room usually does not.
  startRatio: 0.25,
  continueRatio: 0.3,
  // -6 dB: interrupting the agent should be clearly the caller.
  bargeInRatio: 0.5,
  minUtterancesToLearn: 1,
  learnRate: 0.35,
  voiceBandHz: [250, 4000],
  minVoiceBandShare: 0.55,
  maxFlatness: 0.45,
};

/**
 * The caller's own speech level, learned from the turns they actually made.
 * Until it has heard a turn it allows everything (no reference yet).
 */
export class SpeakerLevel {
  private level = 0;
  private utterances = 0;
  private frames: number[] = [];

  private readonly config: GateConfig;

  constructor(config: GateConfig = DEFAULT_GATE) {
    this.config = config;
  }

  /** One frame of the caller's voice during an accepted utterance. */
  observeFrame(rms: number): void {
    if (rms > 0 && this.frames.length < 4000) this.frames.push(rms);
  }

  /** The utterance was accepted as a turn: fold its typical level in. */
  commitUtterance(): void {
    if (this.frames.length < 5) {
      this.frames = [];
      return;
    }
    const sorted = [...this.frames].sort((a, b) => a - b);
    // The upper-middle of the voiced frames: robust to the quiet ends of words.
    const typical = sorted[Math.floor(sorted.length * 0.6)];
    this.level = this.utterances === 0 ? typical : this.level + (typical - this.level) * this.config.learnRate;
    this.utterances += 1;
    this.frames = [];
  }

  /** Forget the frames of an utterance that did not become a turn. */
  discardUtterance(): void {
    this.frames = [];
  }

  /** The learned level, or 0 while there is none to trust. */
  reference(): number {
    return this.utterances >= this.config.minUtterancesToLearn ? this.level : 0;
  }

  private passes(rms: number, ratio: number): boolean {
    const ref = this.reference();
    return ratio <= 0 || ref <= 0 || rms >= ref * ratio;
  }

  allowsStart(rms: number): boolean {
    return this.passes(rms, this.config.startRatio);
  }

  allowsContinue(rms: number): boolean {
    return this.passes(rms, this.config.continueRatio);
  }

  allowsBargeIn(rms: number): boolean {
    return this.passes(rms, this.config.bargeInRatio);
  }

  reset(): void {
    this.level = 0;
    this.utterances = 0;
    this.frames = [];
  }
}

/**
 * Does one analyser frame look like a voice? `spectrumDb` is
 * `AnalyserNode.getFloatFrequencyData` (dB per bin from 0 to sampleRate/2).
 * Voiced speech keeps most of its energy in the voice band and is peaky
 * (harmonics); clicks, thumps and hiss are flat or sit outside the band.
 */
export function speechLikeness(
  spectrumDb: ArrayLike<number>,
  sampleRate: number,
  config: GateConfig = DEFAULT_GATE,
): { speechLike: boolean; bandShare: number; flatness: number } {
  const bins = spectrumDb.length;
  if (!bins || !sampleRate) return { speechLike: true, bandShare: 1, flatness: 0 };
  const hzPerBin = sampleRate / 2 / bins;
  const [lo, hi] = config.voiceBandHz;
  let total = 0;
  let band = 0;
  let logSum = 0;
  let bandBins = 0;
  for (let i = 1; i < bins; i++) {
    const db = spectrumDb[i];
    if (!Number.isFinite(db)) continue;
    const power = 10 ** (db / 10);
    const hz = i * hzPerBin;
    if (hz < 60) continue;
    total += power;
    if (hz >= lo && hz <= hi) {
      band += power;
      logSum += Math.log(power + 1e-20);
      bandBins += 1;
    }
  }
  if (total <= 0 || bandBins === 0) return { speechLike: false, bandShare: 0, flatness: 1 };
  const bandShare = band / total;
  const flatness = Math.exp(logSum / bandBins) / (band / bandBins);
  return {
    speechLike: bandShare >= config.minVoiceBandShare && flatness <= config.maxFlatness,
    bandShare,
    flatness,
  };
}

/**
 * One finalized utterance → exactly one submission. Turn ids only grow; a
 * result for an id that is no longer current is stale and must be dropped.
 */
export class TurnLedger {
  private current = 0;
  private submitted = new Set<number>();

  /** Open the next turn; returns its id. */
  open(): number {
    this.current += 1;
    return this.current;
  }

  get currentId(): number {
    return this.current;
  }

  isCurrent(turnId: number): boolean {
    return turnId === this.current;
  }

  /** True only the first time it is called for the current turn. */
  claimSubmission(turnId: number): boolean {
    if (!this.isCurrent(turnId) || this.submitted.has(turnId)) return false;
    this.submitted.add(turnId);
    if (this.submitted.size > 64) this.submitted = new Set([...this.submitted].slice(-32));
    return true;
  }
}

/** The hook's coarse state → the shared turn phases. */
export function phaseOf(
  state: 'idle' | 'listening' | 'user_speaking' | 'processing' | 'ai_speaking' | 'error',
  context: { inTailGuard?: boolean } = {},
): TurnPhase {
  switch (state) {
    case 'listening':
      return context.inTailGuard ? 'rearming' : 'listening';
    case 'user_speaking':
      return 'capturing';
    case 'processing':
      return 'thinking';
    case 'ai_speaking':
      return 'speaking';
    default:
      return state;
  }
}

/** What the live debug view shows (never audio, never transcript text). */
export interface VoiceDebugEvent {
  at: number;
  phase: TurnPhase;
  turnId: number;
  kind: 'phase' | 'accepted' | 'rejected' | 'barge_in' | 'finalized';
  reason?: RejectReason | 'silence' | 'maximum';
  level?: number;
  reference?: number;
}
