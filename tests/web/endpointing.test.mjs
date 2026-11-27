// Unit tests for src/lib/voice/endpointing.ts (Q4: how long a pause ends the caller's phrase).
// Run: node --test tests/web/ (Node 22.6+ needs --experimental-strip-types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSmallTalk, PAUSE_MS, pauseFor } from '../../src/lib/voice/endpointing.ts';

const reason = (heard, asked) => pauseFor(heard, asked).reason;

test('a clearly finished reply ends sooner', () => {
  assert.equal(reason('Ha, mayli.'), 'smallTalk');
  assert.equal(reason('rahmat'), 'smallTalk');
  assert.equal(reason('Xo‘p'), 'smallTalk');
  assert.equal(reason('Qancha qarzim qoldi?'), 'question');
  assert.equal(reason("Hozir pulim yo'q. Oylik olganimda to'layman."), 'complete');
  assert.equal(pauseFor('Ha, mayli.').ms, PAUSE_MS.smallTalk);
});

test('a phrase left hanging gets more time', () => {
  assert.equal(reason("To'lovni keyingi oyga"), 'unsure'); // no sign either way: the old wait
  assert.equal(reason('Hozir pulim yo‘q, lekin'), 'holding');
  assert.equal(reason('Hozir pulim yo‘q,'), 'holding');
  assert.equal(reason('Ertaga va'), 'holding');
  assert.equal(reason('Hmm'), 'holding');
  assert.equal(reason('Ну'), 'holding');
});

test('numbers being said get more time', () => {
  assert.equal(reason('Yigirma besh'), 'holding');
  assert.equal(reason("To'rt yuz ming"), 'holding');
  assert.equal(reason('Mening raqamim 90 123'), 'holding');
  assert.equal(reason('beshinchi'), 'holding');
  assert.equal(reason('двадцать пять'), 'holding');
});

test('an answer to "qancha / qachon / raqam" waits until it is clearly finished', () => {
  assert.equal(reason('ertaga', 'Qachon to‘lay olasiz?'), 'holding');
  assert.equal(reason('Ertaga.', 'Qachon to‘lay olasiz?'), 'complete');
  assert.equal(reason('ertaga', 'Yana savolingiz bormi?'), 'unsure');
});

test('ordinary words are not mistaken for numbers', () => {
  for (const w of ['ona', 'uchun', 'birga', 'yuzaga', 'oltin', 'семья', 'стоит']) {
    assert.notEqual(reason(`Bu ${w}`), 'holding', w);
  }
});

test('no live words: nothing changes', () => {
  assert.deepEqual(pauseFor(''), { reason: 'unsure', ms: PAUSE_MS.unsure });
  assert.deepEqual(pauseFor('   '), { reason: 'unsure', ms: 1100 });
});

test('small talk matches the backend list and rule', () => {
  for (const p of ['ha', 'Ha.', "xo'p", 'xop', 'ha mayli', 'Ha, rahmat!', 'katta rahmat', 'Assalomu alaykum', 'ha-ha', 'kerak emas']) {
    assert.ok(isSmallTalk(p), p);
  }
  for (const p of ['ha, qancha qarzim bor?', 'ha ha ha ha', '', "yo'q emas", 'salom alaykum']) {
    assert.ok(!isSmallTalk(p), p);
  }
});

test('number forms of the short stems still count', () => {
  for (const w of ['oltita', 'oltinchi', 'birinchi', 'uchinchi', 'olti', 'bir', "o'n"]) {
    assert.equal(reason(`Muddat ${w}`), 'holding', w);
  }
  assert.equal(reason('Bu biroq'), 'holding'); // "however" at the end: not finished
});

test('the same words match however they are written (the early answer, Q5)', async () => {
  const { sameWords } = await import('../../src/lib/voice/endpointing.ts');
  assert.equal(sameWords('Qancha qarzim qoldi?'), sameWords('qancha  qarzim qoldi'));
  assert.equal(sameWords('To‘lovni ko‘chirsam bo‘ladimi?'), sameWords("to'lovni ko'chirsam bo'ladimi"));
  assert.notEqual(sameWords('Qancha qarzim qoldi?'), sameWords('Qancha qarsim qoldi?'));
  assert.notEqual(sameWords('Qancha qarzim'), sameWords('Qancha qarzim qoldi?'));
  assert.equal(sameWords("Hozir pulim yo'q. Oylik olganimda to'layman."), "hozir pulim yo'q oylik olganimda to'layman");
});

test('a real interruption has words that are not just listening (Q7)', async () => {
  const { isRealInterruption } = await import('../../src/lib/voice/endpointing.ts');
  // Noise or nothing heard: the agent goes on.
  assert.equal(isRealInterruption(''), false);
  assert.equal(isRealInterruption('   '), false);
  // Listening sounds: the agent goes on.
  for (const t of ['ha', 'Ha.', 'mm', 'xo‘p', 'aha', 'ha mayli', 'tushunarli']) assert.equal(isRealInterruption(t), false, t);
  // Refusals and "stop" always cut in, however short.
  for (const t of ["yo'q", 'Yo‘q!', 'kerak emas', "to'xtang", 'bas', 'нет', 'стоп']) assert.equal(isRealInterruption(t), true, t);
  // Real words: cut in.
  for (const t of ['Qancha qarzim qoldi?', 'kechirasiz', 'ha, lekin men', 'boshqa savol']) assert.equal(isRealInterruption(t), true, t);
});
