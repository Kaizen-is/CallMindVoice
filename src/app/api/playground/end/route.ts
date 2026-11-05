/**
 * Playground voice call — hang up. Ends and bills the call once (see
 * `closePlaygroundCall`). Also the target of the page's unload beacon, which
 * arrives as text/plain, so the body is parsed by hand.
 */
import { currentSession } from '@/lib/auth';
import { closePlaygroundCall } from '@/lib/playground';

export async function POST(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let callId = '';
  try {
    const body = JSON.parse(await request.text()) as { callId?: unknown };
    callId = typeof body.callId === 'string' ? body.callId : '';
  } catch {
    /* an empty or garbled beacon — nothing to end */
  }
  if (callId) closePlaygroundCall(session.tenant.id, callId);
  return new Response(null, { status: 204 });
}
