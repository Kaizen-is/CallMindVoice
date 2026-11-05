#!/usr/bin/env node
/**
 * Check that the Speko/ElevenLabs TTS models speak Uzbek.
 *
 * Renders one Uzbek sentence with each model through the same Router call the
 * app makes (`src/lib/speech/speko.ts`), saves data/speko-<model>.wav to
 * listen to, and prints status, latency to first audio, and length.
 *
 *   npm run test:speko
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.SPEKO_API_KEY || '').trim();
const base = (process.env.SPEKO_BASE_URL || 'https://router.speko.dev/v1').replace(/\/+$/, '');
const voice = process.env.SPEKO_TTS_VOICE?.trim();
const MODELS = ['eleven_v3_conversational', 'eleven_v4_turbo'];
const TEXT =
  'Assalomu alaykum! MedLine klinikasiga qo‘ng‘iroq qilganingiz uchun rahmat. ' +
  'Shifokor qabuli ertaga soat o‘nda bo‘ladi. Sizga yana qanday yordam bera olaman?';
const RATE = 8000;

if (!key) {
  console.error('SPEKO_API_KEY is empty — paste the key into .env first.');
  process.exit(1);
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

for (const model of MODELS) {
  const t0 = performance.now();
  const res = await fetch(`${base}/tts/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      routing: { mode: 'explicit', provider: 'elevenlabs', model },
      input: TEXT,
      language: 'uz',
      ...(voice ? { voice } : {}),
      audio: { encoding: 'pcm_s16le', sample_rate_hz: RATE, channels: 1 },
    }),
  });
  if (!res.ok || !res.body) {
    console.log(`✗ ${model}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    continue;
  }
  const parts = [];
  let firstMs = 0;
  for await (const chunk of res.body) {
    if (!firstMs) firstMs = performance.now() - t0;
    parts.push(Buffer.from(chunk));
  }
  const pcm = Buffer.concat(parts);
  const out = path.join(root, 'data', `speko-${model}.wav`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, wav(pcm.subarray(0, pcm.length - (pcm.length % 2))));
  console.log(
    `✓ ${model}: served by ${res.headers.get('speko-provider')}/${res.headers.get('speko-model')}, ` +
      `first audio ${Math.round(firstMs)} ms, ${(pcm.length / 2 / RATE).toFixed(1)} s audio → ${path.relative(root, out)}`,
  );
}
