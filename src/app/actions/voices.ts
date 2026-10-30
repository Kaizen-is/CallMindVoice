'use server';

/**
 * Custom voices — tenant-saved TTS voices for the internal Uzbek TTS v2 API.
 * Two modes: `clone` (a reference audio sample + its exact transcript) and
 * `design` (an attribute string like "female, young adult, moderate pitch").
 */
import fs from 'node:fs';
import path from 'node:path';
import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth';
import { get, id, now, run, UPLOAD_DIR } from '@/lib/db';
import type { CustomVoiceRow } from '@/lib/voices';

const MAX_REF_BYTES = 20 * 1024 * 1024; // matches the TTS server's 413 limit

// The v2 API accepts only these voice_design words (anything else → 422).
const DESIGN_WORDS = new Set([
  'male', 'female',
  'child', 'teenager', 'young adult', 'middle-aged', 'elderly',
  'very low pitch', 'low pitch', 'moderate pitch', 'high pitch', 'very high pitch',
  'whisper',
  'american accent', 'british accent', 'australian accent', 'canadian accent',
  'indian accent', 'chinese accent', 'japanese accent', 'korean accent',
  'russian accent', 'portuguese accent',
]);

function revalidateVoicePages() {
  revalidatePath('/app/dev/voice-clone');
  revalidatePath('/app/dev/voice-design');
  revalidatePath('/app/dev/tts');
  revalidatePath('/app/agent');
}

export async function createDesignVoiceAction(input: {
  name: string;
  attributes: string[];
}): Promise<{ ok: true; voiceId: string } | { ok: false; message: string }> {
  const session = await requireSession();
  const name = input.name.trim().slice(0, 60);
  if (!name) return { ok: false, message: 'empty_name' };

  const attrs = input.attributes.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!attrs.length) return { ok: false, message: 'empty_design' };
  const bad = attrs.find((a) => !DESIGN_WORDS.has(a));
  if (bad) return { ok: false, message: `invalid_attribute:${bad}` };

  const voiceId = id('cv');
  run(
    `INSERT INTO custom_voices (id, tenant_id, name, mode, voice_design, created_at)
     VALUES (?,?,?,?,?,?)`,
    voiceId,
    session.tenant.id,
    name,
    'design',
    attrs.join(', '),
    now(),
  );
  revalidateVoicePages();
  return { ok: true, voiceId };
}

/** Transcribe the reference sample with the internal STT so the user never types it. */
async function transcribeSample(bytes: ArrayBuffer, fileName: string): Promise<string | null> {
  const url = process.env.STT_TRANSCRIBE_URL;
  if (!url) return null;
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), fileName || 'sample.wav');
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[voices] stt ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim() || null;
  } catch (err) {
    console.warn('[voices] stt failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function createCloneVoiceAction(
  form: FormData,
): Promise<{ ok: true; voiceId: string } | { ok: false; message: string }> {
  const session = await requireSession();
  const name = String(form.get('name') ?? '').trim().slice(0, 60);
  const file = form.get('refAudio');

  if (!name) return { ok: false, message: 'empty_name' };
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'empty_audio' };
  if (file.size > MAX_REF_BYTES) return { ok: false, message: 'audio_too_large' };

  const bytes = await file.arrayBuffer();
  const refText = await transcribeSample(bytes, file.name);
  if (!refText) return { ok: false, message: 'transcribe_failed' };

  const voiceId = id('cv');
  const ext = path.extname(file.name || '').toLowerCase() || '.wav';
  const fileName = `voice_${voiceId}${ext}`;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), new Uint8Array(bytes));

  run(
    `INSERT INTO custom_voices (id, tenant_id, name, mode, ref_audio_path, ref_text, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    voiceId,
    session.tenant.id,
    name,
    'clone',
    fileName,
    refText,
    now(),
  );
  revalidateVoicePages();
  return { ok: true, voiceId };
}

export async function deleteCustomVoiceAction(
  voiceId: string,
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const row = get<CustomVoiceRow>(
    'SELECT * FROM custom_voices WHERE id=? AND tenant_id=?',
    voiceId,
    session.tenant.id,
  );
  if (!row) return { ok: false };
  if (row.ref_audio_path) {
    fs.rmSync(path.join(UPLOAD_DIR, row.ref_audio_path), { force: true });
  }
  run('DELETE FROM custom_voices WHERE id=? AND tenant_id=?', voiceId, session.tenant.id);
  // Agents pointing at the deleted voice quietly fall back to the default speaker.
  revalidateVoicePages();
  return { ok: true };
}
