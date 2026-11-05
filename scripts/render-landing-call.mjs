#!/usr/bin/env node
/**
 * Render the landing page's demo call — one short clinic booking in Uzbek,
 * Russian and English — with ElevenLabs through Speko, into static files.
 *
 * The live site never calls Speko: the audio ships as files in
 * public/landing/call/, and src/components/marketing/landing-call-data.json
 * holds the transcript with each turn's duration so the page can reveal the
 * words in step with the voice. Re-run only when the script below changes.
 *
 *   npm run render:landing-call      (needs SPEKO_API_KEY in .env)
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.SPEKO_API_KEY || '').trim();
const base = (process.env.SPEKO_BASE_URL || 'https://router.speko.dev/v1').replace(/\/+$/, '');
const MODEL = 'eleven_v4_turbo';
const RATE = 16000;
const VOICE = { agent: 'lZSeoYcz4phdvms888pn' /* Nadya */, caller: 'VlXLedwkU4YDM3HBGpiI' /* Miron */ };

if (!key) {
  console.error('SPEKO_API_KEY is empty — set it in .env first.');
  process.exit(1);
}

/** Each turn: who speaks, what they say, and (for the agent) the document it came from. */
const CALL = {
  uz: [
    ['caller', 'Assalomu alaykum. Kardiolog qabuli qancha turadi?'],
    ['agent', 'Va alaykum assalom! Kardiolog qabuli 180 ming so‘m. Ertaga soat o‘nda bo‘sh vaqt bor, yozib qo‘yaymi?', 'Narxlar 2026.pdf'],
    ['caller', 'Ha, yozib qo‘ying. Ismim Sardor.'],
    ['agent', 'Yozib qo‘ydim, Sardor. Ertaga soat o‘nda kutamiz. Pasportingizni olib keling.', 'Qabul tartibi.docx'],
  ],
  ru: [
    ['caller', 'Здравствуйте. Сколько стоит приём кардиолога?'],
    ['agent', 'Здравствуйте! Приём кардиолога стоит 180 тысяч сумов. Завтра в десять есть свободное время — записать вас?', 'Narxlar 2026.pdf'],
    ['caller', 'Да, запишите. Меня зовут Сардор.'],
    ['agent', 'Записала, Сардор. Ждём вас завтра в десять. Возьмите с собой паспорт.', 'Qabul tartibi.docx'],
  ],
  en: [
    ['caller', 'Hello. How much is a cardiologist appointment?'],
    ['agent', 'Hello! A cardiologist appointment is 180,000 som. There is a free slot tomorrow at ten — shall I book it?', 'Narxlar 2026.pdf'],
    ['caller', 'Yes, please. My name is Sardor.'],
    ['agent', 'Booked, Sardor. We will see you tomorrow at ten. Please bring your passport.', 'Qabul tartibi.docx'],
  ],
};

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

async function render(text, voice, language) {
  const res = await fetch(`${base}/tts/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      routing: { mode: 'explicit', provider: 'elevenlabs', model: MODEL },
      input: text,
      language,
      voice,
      audio: { encoding: 'pcm_s16le', sample_rate_hz: RATE, channels: 1 },
    }),
  });
  if (!res.ok) throw new Error(`${language} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  return pcm.subarray(0, pcm.length - (pcm.length % 2));
}

const outDir = path.join(root, 'public', 'landing', 'call');
fs.mkdirSync(outDir, { recursive: true });
const data = {};
for (const [lang, turns] of Object.entries(CALL)) {
  data[lang] = [];
  for (const [i, [who, text, source]] of turns.entries()) {
    const pcm = await render(text, VOICE[who], lang);
    const file = `${lang}-${i + 1}.wav`;
    fs.writeFileSync(path.join(outDir, file), wav(pcm));
    const ms = Math.round((pcm.length / 2 / RATE) * 1000);
    data[lang].push({ who, text, ...(source ? { source } : {}), audio: `/landing/call/${file}`, ms });
    console.log(`✓ ${file}  ${who.padEnd(6)} ${(ms / 1000).toFixed(1)} s`);
  }
}
fs.writeFileSync(
  path.join(root, 'src', 'components', 'marketing', 'landing-call-data.json'),
  JSON.stringify(data, null, 2) + '\n',
);
console.log('\nWrote src/components/marketing/landing-call-data.json');
