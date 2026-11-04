#!/usr/bin/env node
/**
 * Uzbek TTS benchmark for real-time calls: which Speko voices can actually
 * speak Uzbek, and how fast?
 *
 * Each voice reads the same Uzbek call-centre sentences through the Speko
 * Router (the call the app makes). The audio is then transcribed by GAPI — a
 * strong Uzbek recogniser (WER ~8–10%) — and compared word by word with what
 * was meant. A voice that mangles Uzbek comes back with a high WER; one that
 * reads it as English or refuses shows up as an error or near-100%.
 *
 * Also measured: time to first audio byte (what a caller waits for) and total
 * render time. Results + samples: data/uz-bench/index.html.
 *
 *   npm run bench:uz-tts
 *   npm run bench:uz-tts -- --only nadya,miron   # filter by name/provider (comma list)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filterArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
// A filtered run gets its own folder, so it never overwrites the full report.
const outDir = path.join(root, 'data', filterArg ? `uz-bench-${filterArg.replace(/[^\w]+/g, '-')}` : 'uz-bench');
const SPEKO = (process.env.SPEKO_BASE_URL || 'https://router.speko.dev/v1').replace(/\/+$/, '');
const GAPI = (process.env.GAPI_BASE_URL || 'https://console.gapi.uz').replace(/\/+$/, '');
const spekoKey = (process.env.SPEKO_API_KEY || '').trim();
const gapiKey = (process.env.GAPI_API_KEY || process.env.GAPIAPI || '').trim();
const RATE = 16000;
const RATE_FOR = { openai: 24000, speechify: 24000, gemini: 24000 };

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1]?.toLowerCase() : null;

if (!spekoKey || !gapiKey) {
  console.error('Both SPEKO_API_KEY and GAPIAPI must be set in .env.');
  process.exit(1);
}

/* The 20 voices on platform.speko.ai → Voices, plus the ElevenLabs models. */
const VOICES = [
  ['Claudia', 'cartesia', 'sonic-3.5', 'f80e7298-93f5-46d0-86f2-b8f29cfc88bd'],
  ['Clementine', 'cartesia', 'sonic-3.5', '4111bc29-d7ff-4a15-90db-819f7b4f7706'],
  ['Carol', 'cartesia', 'sonic-3.5', 'bf991597-6c13-47e4-8411-91ec2de5c466'],
  ['Carson', 'cartesia', 'sonic-3.5', '4df027cb-2920-4a1f-8c34-f21529d5c3fe'],
  ['Kyle', 'cartesia', 'sonic-3.5', 'c961b81c-a935-4c17-bfb3-ba2239de8c2f'],
  ['Edric', 'cartesia', 'sonic-3.5', '921034a2-aace-4ef7-87b1-b9bc455c9a15'],
  ['Sofia', 'openai', 'gpt-4o-mini-tts', 'nova'],
  ['Vivienne', 'openai', 'gpt-4o-mini-tts', 'sage'],
  ['Diego', 'openai', 'gpt-4o-mini-tts', 'echo'],
  ['Atlas (OpenAI)', 'openai', 'gpt-4o-mini-tts', 'onyx'],
  ['Freya', 'speechify', 'simba-3.2', 'belinda'],
  ['Oliver', 'speechify', 'simba-3.2', 'alec'],
  ['Isla', 'smallest', 'lightning_v3.1', 'chloe'],
  ['Aria', 'gemini', 'gemini-3.8-flash-tts', 'Aoede'],
  ['Silas', 'gemini', 'gemini-3.8-flash-tts', 'Charon'],
  ['Carina', 'xai', 'grok-tts', 'carina'],
  ['Luna', 'xai', 'grok-tts', 'luna'],
  ['Orion', 'xai', 'grok-tts', 'orion'],
  ['Atlas (xAI)', 'xai', 'grok-tts', 'atlas'],
  ['Cosmo', 'xai', 'grok-tts', 'cosmo'],
  // Every ElevenLabs model the Router offers, on its default voice.
  ...['eleven_v3_conversational', 'eleven_v3', 'eleven_v4_turbo', 'eleven_v4', 'eleven_flash_v2_5', 'eleven_multilingual_v2'].map(
    (m) => [`ElevenLabs ${m}`, 'elevenlabs', m, null],
  ),
  // The two ElevenLabs voices the Playground offers, on the two models it offers.
  ...['eleven_v4_turbo', 'eleven_v3_conversational'].flatMap((m) => [
    [`Nadya · ${m}`, 'elevenlabs', m, 'lZSeoYcz4phdvms888pn'],
    [`Miron · ${m}`, 'elevenlabs', m, 'VlXLedwkU4YDM3HBGpiI'],
  ]),
].filter(
  ([name, provider]) =>
    !only || only.split(',').some((o) => name.toLowerCase().includes(o) || provider.includes(o)),
);

/* Short, realistic call-centre lines with the letters that trip models up (oʻ, gʻ, q, x, sh, ch). */
const SENTENCES = [
  'Assalomu alaykum, MedLine klinikasiga qo‘ng‘iroq qilganingiz uchun rahmat.',
  'Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.',
  'Kechirasiz, bu savolga javob bera olmayman, sizni mutaxassisga ulayman.',
];

/* ── WER ─────────────────────────────────────────────────────── */

const words = (s) =>
  s
    .toLowerCase()
    .replace(/[ʻʼ‘’`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function wer(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

/* ── calls ───────────────────────────────────────────────────── */

function wav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synth(provider, model, voice, text) {
  const t0 = performance.now();
  const res = await fetch(`${SPEKO}/tts/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${spekoKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      routing: { mode: 'explicit', provider, model },
      input: text,
      language: 'uz',
      ...(voice ? { voice } : {}),
      audio: { encoding: 'pcm_s16le', sample_rate_hz: RATE_FOR[provider] ?? RATE, channels: 1 },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const parts = [];
  let first = 0;
  for await (const chunk of res.body) {
    if (!first) first = performance.now() - t0;
    parts.push(Buffer.from(chunk));
  }
  const pcm = Buffer.concat(parts);
  return { pcm: pcm.subarray(0, pcm.length - (pcm.length % 2)), firstMs: first, totalMs: performance.now() - t0 };
}

async function transcribe(wavBuf) {
  const form = new FormData();
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'speech.wav');
  form.append(
    'settings',
    JSON.stringify({
      diarization: false, itn: false, formatting: true, pii: false, gender: false,
      call_outcome: false, speaker_identification: false, enroll: 'off', language_detection: true,
    }),
  );
  const res = await fetch(`${GAPI}/v1/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gapiKey}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GAPI ${res.status}`);
  const data = await res.json();
  return (data.text ?? data.segments?.map((s) => s.text ?? '').join(' ') ?? '').trim();
}

/* ── run ─────────────────────────────────────────────────────── */

fs.mkdirSync(outDir, { recursive: true });
const results = [];
for (const [name, provider, model, voice] of VOICES) {
  const row = { name, provider, model, voice, samples: [], error: null };
  for (const [i, text] of SENTENCES.entries()) {
    try {
      const rate = RATE_FOR[provider] ?? RATE;
      const { pcm, firstMs, totalMs } = await synth(provider, model, voice, text).catch(async (err) => {
        if (!/HTTP 5\d\d/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 3000));
        return synth(provider, model, voice, text);
      });
      if (pcm.length < rate) throw new Error('no audio');
      const file = `${provider}-${voice ?? model}-${i + 1}.wav`.replace(/[^\w.-]/g, '_');
      const buf = wav(pcm, rate);
      fs.writeFileSync(path.join(outDir, file), buf);
      const heard = await transcribe(buf);
      row.samples.push({ text, heard, wer: wer(text, heard), firstMs, totalMs, file });
    } catch (err) {
      row.error = err.message;
      break;
    }
  }
  const n = row.samples.length;
  row.wer = n ? row.samples.reduce((a, s) => a + s.wer, 0) / n : null;
  row.firstMs = n ? row.samples.reduce((a, s) => a + s.firstMs, 0) / n : null;
  results.push(row);
  console.log(
    row.error
      ? `✗ ${name.padEnd(36)} ${provider}:${model} — ${row.error}`
      : `${row.wer <= 0.15 ? '✓' : row.wer <= 0.35 ? '~' : '✗'} ${name.padEnd(36)} WER ${(row.wer * 100).toFixed(0).padStart(3)}%  first audio ${Math.round(row.firstMs)} ms  (${provider}:${model})`,
  );
}

/* ── report ──────────────────────────────────────────────────── */

results.sort((a, b) => (a.wer ?? 9) - (b.wer ?? 9));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const verdict = (r) => (r.error ? 'fails' : r.wer <= 0.15 ? 'good' : r.wer <= 0.35 ? 'weak' : 'not Uzbek');
fs.writeFileSync(
  path.join(outDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Uzbek TTS benchmark</title>
<style>body{font:14px system-ui;margin:24px;max-width:1100px}td,th{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top;text-align:left}
.good{color:#0a7a3d;font-weight:600}.weak{color:#a66300;font-weight:600}.fails,.not{color:#b00020;font-weight:600}small{color:#666}code{user-select:all}</style>
<h1>Uzbek TTS benchmark — Speko voices</h1>
<p>Each voice read ${SENTENCES.length} Uzbek sentences; GAPI transcribed the audio. WER = share of words GAPI heard wrong (lower is better; GAPI's own error is ~8–10%, so ≤15% means clear Uzbek). First audio = how long a caller waits before hearing anything.</p>
<table><tr><th>Voice</th><th>Provider / model</th><th>Verdict</th><th>WER</th><th>First audio</th><th>Samples (what GAPI heard)</th></tr>
${results
  .map(
    (r) => `<tr><td><b>${esc(r.name)}</b><br><small><code>${esc(r.voice ?? '(default)')}</code></small></td>
<td>${esc(r.provider)}<br><small>${esc(r.model)}</small></td>
<td class="${verdict(r).split(' ')[0]}">${verdict(r)}</td>
<td>${r.wer == null ? '—' : (r.wer * 100).toFixed(0) + '%'}</td>
<td>${r.firstMs == null ? '—' : Math.round(r.firstMs) + ' ms'}</td>
<td>${r.error ? `<small>${esc(r.error)}</small>` : r.samples.map((s) => `<audio controls preload="none" src="${esc(s.file)}"></audio><br><small>${esc(s.heard)} — ${(s.wer * 100).toFixed(0)}%</small>`).join('<br>')}</td></tr>`,
  )
  .join('\n')}
</table>`,
);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\nReport: ${path.relative(root, path.join(outDir, 'index.html'))}`);
