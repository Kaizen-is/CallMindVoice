/**
 * Server Actions through the edge proxy — runs in the browser before the app
 * becomes interactive (Next.js `instrumentation-client`).
 *
 * Next.js sends a Server Action's arguments as a plain string body, which the
 * browser labels `Content-Type: text/plain;charset=UTF-8`. The proxy in front of
 * callmind.brb-tech.uz answers every `text/plain` POST with 403, so every
 * action called with arguments failed with "An unexpected response was received
 * from the server": saving an agent (its model, voice, prompt), typed Playground
 * messages, settings, team and knowledge-base edits.
 *
 * Next.js reads an action's body the same way under any content type except
 * multipart and urlencoded forms (`server-action-request-meta` in next/dist), so
 * the request is relabelled `application/json`, which the proxy lets through.
 * Form actions (multipart) are untouched. Remove this file once the proxy
 * allows `text/plain` POSTs that carry a `Next-Action` header.
 */

const ACTION_HEADER = 'next-action';

function isServerAction(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(ACTION_HEADER);
  if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === ACTION_HEADER);
  return Object.keys(headers).some((name) => name.toLowerCase() === ACTION_HEADER);
}

function hasContentType(headers: HeadersInit): boolean {
  return new Headers(headers).has('content-type');
}

try {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      init?.method === 'POST' &&
      typeof init.body === 'string' &&
      isServerAction(init.headers) &&
      !hasContentType(init.headers!)
    ) {
      const headers = new Headers(init.headers);
      headers.set('content-type', 'application/json');
      return original(input, { ...init, headers });
    }
    return original(input, init);
  };
} catch {
  // Leave fetch as it is; actions then behave as before.
}
