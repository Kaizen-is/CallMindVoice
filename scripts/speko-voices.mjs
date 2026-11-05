#!/usr/bin/env node
/**
 * List the ElevenLabs voices Speko can route, and render one Uzbek sentence in
 * each so you can pick SPEKO_TTS_VOICE by ear.
 *
 *   npm run voices:speko                 # list only
 *   npm run voices:speko -- --render     # also render samples (default model eleven_v3_conversational)
 *   npm run voices:speko -- --render --model eleven_v4_turbo --limit 15
 *
 * Samples land in data/voices/ with an index.html that plays them side by side;
 * open it in the browser. Each render is billed by Speko (one short sentence).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.SPEKO_API_KEY || '').trim();
const apiBase = (process.env.SPEKO_API_URL || 'https://api.speko.dev/v1').replace(/\/+$/, '');
const routerBase = (process.env.SPEKO_BASE_URL || 'https://router.speko.dev/v1').replace(/\/+$/, '');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const render = flag('render');
const model = option('model', 'eleven_v3_conversational');
const limit = Number(option('limit', 20));
const TEXT =
  'Assalomu alaykum! MedLine klinikasiga qo‘ng‘iroq qilganingiz uchun rahmat. Sizga qanday yordam bera olaman?';
const RATE = 16000;

if (!key) {
  console.error('SPEKO_API_KEY is empty — paste the key into .env first.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}` };

async function listVoices() {
  const voices = [];
  let cursor = '';
  do {
    const url = new URL(`${apiBase}/tts/voices`);
    url.searchParams.set('vendor', 'elevenlabs');
    url.searchParams.set('include_unmeasured', 'true');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`voices ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    voices.push(...(page.data ?? []));
    cursor = page.next_cursor ?? page.cursor ?? '';
  } while (cursor && voices.length < 500);
  return voices;
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

async function renderSample(voiceId) {
  const res = await fetch(`${routerBase}/tts/speech`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      routing: { mode: 'explicit', provider: 'elevenlabs', model },
      input: TEXT,
      language: 'uz',
      voice: voiceId,
      audio: { encoding: 'pcm_s16le', sample_rate_hz: RATE, channels: 1 },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  return wav(pcm.subarray(0, pcm.length - (pcm.length % 2)));
}

const voices = await listVoices();
// No ElevenLabs voice is native Uzbek, so try the likeliest first: the
// multilingual voices (many language tags), then Russian ones — the accent
// callers in Uzbekistan hear most often — then the rest.
const rank = (v) => {
  const langs = Array.isArray(v.languages) ? v.languages.map(String) : [];
  if (langs.some((l) => l.startsWith('uz'))) return 0;
  if (langs.length >= 10) return 1;
  if (langs.some((l) => l.startsWith('ru'))) return 2;
  return 3;
};
voices.sort((a, b) => rank(a) - rank(b));

console.log(`${voices.length} ElevenLabs voices (multilingual and Russian first):\n`);
for (const v of voices) {
  const langs = Array.isArray(v.languages) ? v.languages.slice(0, 6).join(',') : '';
  const uz = Array.isArray(v.languages) && v.languages.some((l) => String(l).startsWith('uz')) ? ' [uz]' : '';
  console.log(`${(v.voice_id ?? v.id).padEnd(24)} ${String(v.name).padEnd(34)} ${String(v.gender ?? '').padEnd(7)} ${String(v.accent ?? '').padEnd(12)} ${langs}${uz}`);
}

if (render) {
  const dir = path.join(root, 'data', 'voices');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const v of voices.slice(0, limit)) {
    const id = v.voice_id ?? String(v.id).split(':').pop();
    const file = `${model}-${id}.wav`;
    try {
      fs.writeFileSync(path.join(dir, file), await renderSample(id));
      rows.push({ id, name: v.name, gender: v.gender ?? '', accent: v.accent ?? '', file });
      console.log(`✓ rendered ${v.name}`);
    } catch (err) {
      console.log(`✗ ${v.name}: ${err.message}`);
    }
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Speko voices — ${esc(model)}</title>
<style>body{font:14px system-ui;margin:24px;max-width:900px}td{padding:6px 10px;border-bottom:1px solid #ddd}code{user-select:all}</style>
<h1>ElevenLabs via Speko — ${esc(model)}</h1><p>${esc(TEXT)}</p><table>
${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.gender)} ${esc(r.accent)}</td><td><audio controls preload="none" src="${esc(r.file)}"></audio></td><td><code>${esc(r.id)}</code></td></tr>`).join('\n')}
</table><p>Copy the id into <code>SPEKO_TTS_VOICE=</code> in .env.</p>`,
  );
  console.log(`\nOpen ${path.relative(root, path.join(dir, 'index.html'))} in the browser to listen.`);
}
