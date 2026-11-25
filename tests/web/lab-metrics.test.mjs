// Unit tests for the STT lab's maths: src/lib/voice/text-metrics.ts and waveform.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cer, normalizeText, wer, wordDiff } from '../../src/lib/voice/text-metrics.ts';
import { fft, peaks, spectrogram, wavSampleRate } from '../../src/lib/voice/waveform.ts';

test('no reference, no error rate', () => {
  assert.equal(wer('', 'anything'), null);
  assert.equal(cer('  ', 'anything'), null);
});

test('WER counts word edits against the reference', () => {
  assert.equal(wer('kartamning balansini bilmoqchiman', 'kartamning balansini bilmoqchiman'), 0);
  assert.equal(wer('kartamning balansini bilmoqchiman', 'kartam balansini bilmoqchiman'), 1 / 3);
  assert.equal(wer('bir ikki', 'bir ikki uch tort'), 1); // two insertions over two words
});

test('apostrophes and punctuation do not count as errors', () => {
  assert.equal(normalizeText('O‘zbekiston, salom!'), "o'zbekiston salom");
  assert.equal(wer("O'zbekiston salom", 'Oʻzbekiston, salom.'), 0);
  assert.equal(cer('abc', 'abd'), 1 / 3);
});

test('word diff shows what processing removed and added', () => {
  const diff = wordDiff('salom men kecha bordim', 'salom men bordim ha');
  assert.deepEqual(diff, [
    { kind: 'same', text: 'salom men' },
    { kind: 'removed', text: 'kecha' },
    { kind: 'same', text: 'bordim' },
    { kind: 'added', text: 'ha' },
  ]);
});

test('peaks are the real min and max of each slice', () => {
  const s = Float32Array.from([0, 0.5, -0.25, 0, 1, -1, 0.1, 0.2]);
  assert.deepEqual([...peaks(s, 2)], [-0.25, 0.5, -1, 1]);
});

test('the FFT finds a pure tone in its bin', () => {
  const n = 256;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 16 * i) / n));
  const im = new Float64Array(n);
  fft(re, im);
  const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
  assert.equal(mags.indexOf(Math.max(...mags)), 16);
});

test('spectrogram has the asked shape and peaks at the tone', () => {
  const rate = 16000;
  const s = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / rate));
  const { db, bins } = spectrogram(s, rate, 10, 512, 8000);
  assert.equal(bins, 256);
  assert.equal(db.length, 10 * 256);
  const frame = Array.from(db.subarray(5 * bins, 6 * bins));
  assert.equal(frame.indexOf(Math.max(...frame)), 32); // 1000 Hz / (16000/512)
});

test('reads the sample rate of a WAV header only', () => {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  [...'RIFF'].forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  [...'WAVE'].forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0)));
  v.setUint32(24, 44100, true);
  assert.equal(wavSampleRate(buf), 44100);
  assert.equal(wavSampleRate(new ArrayBuffer(44)), null);
});
