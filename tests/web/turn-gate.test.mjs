// Unit tests for src/lib/voice/turn-gate.ts. Run: node --test tests/web/
// (Node 24 runs the TypeScript module directly by stripping its types.)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_GATE,
  phaseOf,
  SpeakerLevel,
  speechLikeness,
  TurnLedger,
} from '../../src/lib/voice/turn-gate.ts';

const learn = (level, rms, frames = 30) => {
  for (let i = 0; i < frames; i++) level.observeFrame(rms);
  level.commitUtterance();
};

test('allows everything until the caller has made a turn', () => {
  const level = new SpeakerLevel();
  assert.equal(level.reference(), 0);
  assert.ok(level.allowsStart(0.001));
  assert.ok(level.allowsBargeIn(0.001));
});

test('a voice much quieter than the caller cannot start, continue or interrupt', () => {
  const level = new SpeakerLevel();
  learn(level, 0.1); // the caller, close to the mic
  const across = 0.015; // someone across the room: about -16 dB
  assert.equal(level.allowsStart(across), false);
  assert.equal(level.allowsContinue(across), false);
  assert.equal(level.allowsBargeIn(across), false);
});

test('the caller speaking a little quieter still passes (quiet user)', () => {
  const level = new SpeakerLevel();
  learn(level, 0.1);
  assert.ok(level.allowsStart(0.04)); // -8 dB
  assert.ok(level.allowsContinue(0.04));
  assert.equal(level.allowsBargeIn(0.04), false); // interrupting needs to be clearly them
  assert.ok(level.allowsBargeIn(0.07));
});

test('the level follows the caller slowly and ignores aborted utterances', () => {
  const level = new SpeakerLevel();
  learn(level, 0.1);
  for (let i = 0; i < 30; i++) level.observeFrame(0.5);
  level.discardUtterance();
  assert.equal(level.reference(), 0.1);
  learn(level, 0.05);
  const ref = level.reference();
  assert.ok(ref < 0.1 && ref > 0.05, `ref ${ref}`);
});

test('a ratio of 0 turns a gate off', () => {
  const level = new SpeakerLevel({ ...DEFAULT_GATE, startRatio: 0 });
  learn(level, 0.1);
  assert.ok(level.allowsStart(0.0001));
});

/** A dB spectrum (1024 bins over 0..24 kHz) from a power function of frequency. */
const spectrum = (powerAt, bins = 1024, rate = 48000) =>
  Float32Array.from({ length: bins }, (_, i) => 10 * Math.log10(powerAt((i * rate) / 2 / bins) + 1e-12));

test('harmonic voice-band sound is speech-like', () => {
  const voiced = spectrum((hz) => {
    if (hz < 80 || hz > 4000) return 1e-6;
    const k = hz / 150; // harmonics of a 150 Hz voice
    return Math.abs(k - Math.round(k)) < 0.05 ? 1 / Math.round(k) : 1e-5;
  });
  const result = speechLikeness(voiced, 48000);
  assert.ok(result.speechLike, JSON.stringify(result));
});

test('white noise and a high click are not speech-like', () => {
  const white = speechLikeness(spectrum(() => 1), 48000);
  assert.equal(white.speechLike, false);
  const click = speechLikeness(spectrum((hz) => (hz > 5000 ? 1 : 0.01)), 48000);
  assert.equal(click.speechLike, false);
});

test('one finalized utterance can be submitted exactly once', () => {
  const ledger = new TurnLedger();
  const first = ledger.open();
  assert.ok(ledger.claimSubmission(first));
  assert.equal(ledger.claimSubmission(first), false); // a duplicate endpoint callback
  const second = ledger.open();
  assert.equal(ledger.claimSubmission(first), false); // stale: an older turn
  assert.ok(ledger.isCurrent(second));
  assert.ok(ledger.claimSubmission(second));
});

test('hook states map onto the shared turn phases', () => {
  assert.equal(phaseOf('processing'), 'thinking');
  assert.equal(phaseOf('ai_speaking'), 'speaking');
  assert.equal(phaseOf('user_speaking'), 'capturing');
  assert.equal(phaseOf('listening', { inTailGuard: true }), 'rearming');
  assert.equal(phaseOf('listening'), 'listening');
});
