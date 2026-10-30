'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface LiveEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Subscribes to the tenant event stream and refreshes the current route when
 * something relevant happens. Refreshes are coalesced so a burst of twenty
 * simulated calls produces one re-render rather than twenty.
 */
export function useLive(
  interesting: string[],
  onEvent?: (e: LiveEvent) => void,
): { connected: boolean; last: LiveEvent | null } {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<LiveEvent | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const source = new EventSource('/api/stream');

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e) => {
      let data: LiveEvent;
      try {
        data = JSON.parse(e.data) as LiveEvent;
      } catch {
        return;
      }
      if (data.type === 'heartbeat') {
        setConnected(true);
        return;
      }
      setLast(data);
      handler.current?.(data);
      if (!interesting.length || interesting.includes(data.type)) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 350);
      }
    };

    return () => {
      if (timer.current) clearTimeout(timer.current);
      source.close();
    };
    // `interesting` is a literal array at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  return { connected, last };
}
