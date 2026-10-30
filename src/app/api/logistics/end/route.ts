/**
 * Logistics demo — hang up. Also the target of the page's unload beacon,
 * which arrives as text/plain, so the body is parsed by hand.
 */
import { closeLogisticsCall } from '@/lib/logistics';

export async function POST(request: Request): Promise<Response> {
  let callId = '';
  try {
    const body = JSON.parse(await request.text()) as { callId?: unknown };
    callId = typeof body.callId === 'string' ? body.callId : '';
  } catch {
    /* an empty or garbled beacon — nothing to end */
  }
  // Only ever touches calls of the logistics demo agent; anything else is a no-op.
  if (callId) closeLogisticsCall(callId);
  return new Response(null, { status: 204 });
}
