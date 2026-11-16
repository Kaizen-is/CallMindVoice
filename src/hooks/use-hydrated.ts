'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False in the server-rendered HTML and while it hydrates, true once React runs
 * the page in the browser.
 *
 * The login and signup forms keep their submit button disabled until then: a
 * form sent before the scripts run carries React's `$ACTION_n:m` fields, and the
 * edge proxy refuses any field name with a colon (see `instrumentation-client.ts`).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
