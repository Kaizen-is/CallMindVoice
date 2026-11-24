'use server';

import { revalidatePath } from 'next/cache';
import { corePost } from '@/lib/core';

/** Pick the account's default language model (Models ▸ Model lab ▸ LLM). Null clears it. Done in Python. */
export async function setDefaultLlmAction(choice: string | null) {
  const r = await corePost<{ ok: boolean; message?: string }>('/actions/setDefaultLlmAction', { choice });
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}
