// Unit tests for src/lib/voice/preroll.ts (Q10: the start of a phrase is no longer cut off).
// Run: node --test tests/web/ (Node 22.6+ needs --experimental-strip-types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PreRoll } from '../../src/lib/voice/preroll.ts';

const frame = (start, n) => Float32Array.from({ length: n }, (_, i) => start + i);

test('keeps the newest samples, oldest first', () => {
  const ring = new PreRoll(10);
  ring.push(frame(0, 4));
  ring.push(frame(4, 4));
  ring.push(frame(8, 4));
  ring.push(frame(12, 4)); // 16 samples pushed, 10 kept: 6…15
  assert.deepEqual([...ring.snapshot()], [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('right after the microphone opened: what there is', () => {
  const ring = new PreRoll(10);
  assert.equal(ring.snapshot().length, 0);
  ring.push(frame(0, 3));
  assert.deepEqual([...ring.snapshot()], [0, 1, 2]);
});

test('memory stays bounded however long it runs', () => {
  const ring = new PreRoll(4800);
  for (let i = 0; i < 5000; i++) ring.push(frame(i * 128, 128));
  const snap = ring.snapshot();
  assert.equal(snap.length, 4800);
  assert.equal(snap[snap.length - 1], 5000 * 128 - 1); // the very newest sample is last
});

test('clear and zero size', () => {
  const ring = new PreRoll(8);
  ring.push(frame(0, 8));
  ring.clear();
  assert.equal(ring.snapshot().length, 0);
  const none = new PreRoll(0);
  none.push(frame(0, 8));
  assert.equal(none.snapshot().length, 0);
});
