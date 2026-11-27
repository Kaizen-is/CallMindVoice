// Unit tests for src/lib/voice/filler-gate.ts (Q6: the filler plays only if the caller is still waiting).
// Run: node --test tests/web/ (Node 22.6+ needs --experimental-strip-types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FillerGate } from '../../src/lib/voice/filler-gate.ts';

/** A fake clock: schedule() records timers, tick(ms) runs those that are due. */
function clock() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    schedule: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel: (id) => timers.delete(id),
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

test('a quick answer: the filler never plays', () => {
  const c = clock();
  let played = 0;
  const gate = new FillerGate(() => played++, c.schedule, c.cancel);
  gate.offer(1200);
  c.tick(800);
  gate.answer(); // the voice started at 0.8 s
  c.tick(1000);
  assert.equal(played, 0);
  assert.equal(gate.played, false);
  assert.equal(c.pending(), 0);
});

test('a late answer: the filler plays once at 1.2 s', () => {
  const c = clock();
  let played = 0;
  const gate = new FillerGate(() => played++, c.schedule, c.cancel);
  gate.offer(1200);
  c.tick(1199);
  assert.equal(played, 0);
  c.tick(1);
  assert.equal(played, 1);
  gate.answer();
  gate.offer(1200); // a second offer in the same turn does nothing
  c.tick(5000);
  assert.equal(played, 1);
});

test('the answer arrived before the filler did: nothing to play', () => {
  const c = clock();
  let played = 0;
  const gate = new FillerGate(() => played++, c.schedule, c.cancel);
  gate.answer();
  gate.offer(1200);
  c.tick(2000);
  assert.equal(played, 0);
});

test('already past the hold time when the filler arrives: it plays at once', () => {
  const c = clock();
  let played = 0;
  const gate = new FillerGate(() => played++, c.schedule, c.cancel);
  gate.offer(-300); // the turn left 1.5 s ago
  c.tick(0);
  assert.equal(played, 1);
});
