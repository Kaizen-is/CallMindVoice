'use server';

import { revalidatePath } from 'next/cache';
import { audit, requireRole, requireSession } from '@/lib/auth';
import { setTenantDefaultLlm } from '@/lib/llm/choice';

/** Pick the account's default language model (Models ▸ Model lab ▸ LLM). Null clears it. */
export async function setDefaultLlmAction(choice: string | null) {
  const session = await requireSession();
  requireRole(session, 'admin');
  if (!setTenantDefaultLlm(session.tenant.id, choice || null)) {
    return { ok: false, message: 'Unknown model.' };
  }
  audit(session.tenant.id, session.user, 'llm.default', null, { model: choice || null });
  revalidatePath('/app', 'layout');
  return { ok: true };
}
