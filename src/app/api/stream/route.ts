import { currentSession } from '@/lib/auth';
import { subscribe, type BusEvent } from '@/lib/engine/bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events feed for the live wallboard and operator inbox.
 * One connection per browser tab, scoped to the caller's tenant.
 */
export async function GET(request: Request) {
  const session = await currentSession();
  if (!session) return new Response('Unauthorized', { status: 401 });

  const tenantId = session.tenant.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: BusEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: 'heartbeat', at: new Date().toISOString() });
      const unsubscribe = subscribe(tenantId, send);

      // Proxies drop idle connections; a comment frame every 25 s keeps it open.
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          closed = true;
        }
      }, 25_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
