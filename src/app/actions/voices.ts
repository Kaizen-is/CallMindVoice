'use server';

/**
 * Custom voices — tenant-saved TTS voices for the internal Uzbek TTS v2 API.
 * Two modes: `clone` (a reference audio sample + its exact transcript) and
 * `design` (an attribute string like "female, young adult, moderate pitch").
 * The work is done by the Python backend (`backend/app/custom_voices.py`).
 */
import { revalidatePath } from 'next/cache';
import { corePost, corePostForm } from '@/lib/core';

function revalidateVoicePages() {
  revalidatePath('/app/dev/voice-clone');
  revalidatePath('/app/dev/voice-design');
  revalidatePath('/app/dev/tts');
  revalidatePath('/app/agent');
}

type Saved = { ok: true; voiceId: string } | { ok: false; message: string };

export async function createDesignVoiceAction(input: { name: string; attributes: string[] }): Promise<Saved> {
  const r = await corePost<Saved>('/actions/createDesignVoiceAction', { input });
  if (r.ok) revalidateVoicePages();
  return r;
}

/** The sample (`refAudio`) is transcribed by the internal STT, so the user never types it. */
export async function createCloneVoiceAction(form: FormData): Promise<Saved> {
  const r = await corePostForm<Saved>('/actions/createCloneVoiceAction', form);
  if (r.ok) revalidateVoicePages();
  return r;
}

export async function deleteCustomVoiceAction(voiceId: string): Promise<{ ok: boolean }> {
  const r = await corePost<{ ok: boolean }>('/actions/deleteCustomVoiceAction', { voiceId });
  // Agents pointing at the deleted voice quietly fall back to the default speaker.
  if (r.ok) revalidateVoicePages();
  return r;
}
