/**
 * Console Playground — hang up. Also the target of the page's unload beacon,
 * which arrives as text/plain, so the body is parsed by hand.
 */
import { revalidatePath } from 'next/cache';
import { currentSession } from '@/lib/auth';
import { closePlaygroundCall } from '@/lib/playground';

export async function POST(request: Request): Promise<Response> {
  let callId = '';
  try {
    const body = JSON.parse(await request.text()) as { callId?: unknown };
    callId = typeof body.callId === 'string' ? body.callId : '';
  } catch {
    /* an empty or garbled beacon — nothing to end */
  }
  const session = await currentSession();
  // Only ever touches this tenant's Playground chats; anything else is a no-op.
  if (session && callId && closePlaygroundCall(session.tenant.id, callId, 5)) revalidatePath('/app');
  return new Response(null, { status: 204 });
}
