/**
 * Server Actions through the edge proxy — runs in the browser before the app
 * becomes interactive (Next.js `instrumentation-client`).
 *
 * The proxy in front of callmind.brb-tech.uz refuses two kinds of POST with 403,
 * and the app then shows "An unexpected response was received from the server"
 * ("This page couldn't load"):
 *
 * 1. `Content-Type: text/plain`. Next.js sends a Server Action's arguments as a
 *    plain string body, which the browser labels `text/plain;charset=UTF-8`:
 *    saving an agent (its model, voice, prompt), typed Playground messages,
 *    settings, team and knowledge-base edits. Next.js reads an action's body the
 *    same way under any content type except multipart and urlencoded forms
 *    (`server-action-request-meta` in next/dist), so the request is relabelled
 *    `application/json`, which the proxy lets through.
 *
 * 2. A multipart field whose name contains a colon. React writes hidden fields
 *    such as `$ACTION_5:0` into server-rendered forms whose action is bound or
 *    comes from `useActionState` (login, signup), so the form also works before
 *    the page's JavaScript runs. When the form is sent by this code instead, the
 *    request carries the `Next-Action` header and Next.js reads the arguments
 *    from the rest of the body (`decodeReply`); the `$ACTION_…` fields are unused,
 *    so they are dropped. A form sent before the scripts run cannot be helped
 *    here; those forms keep their submit button disabled until the page is ready
 *    (`useHydrated`).
 *
 * Remove this file once the proxy allows both for callmind.brb-tech.uz.
 */

const ACTION_HEADER = 'next-action';
/** Fields React adds for forms sent without JavaScript; unused when this code sends the form. */
const NO_JS_FIELD = '$ACTION_';

function isServerAction(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(ACTION_HEADER);
  if (Array.isArray(headers)) return headers.some(([name]) => name.toLowerCase() === ACTION_HEADER);
  return Object.keys(headers).some((name) => name.toLowerCase() === ACTION_HEADER);
}

function hasContentType(headers: HeadersInit): boolean {
  return new Headers(headers).has('content-type');
}

/** The same form data without the no-JavaScript fields (the original when it has none). */
function withoutNoJsFields(body: FormData): FormData {
  const keys = [...body.keys()];
  if (!keys.some((key) => key.includes(NO_JS_FIELD))) return body;
  const copy = new FormData();
  for (const [key, value] of body.entries()) {
    if (!key.includes(NO_JS_FIELD)) copy.append(key, value);
  }
  return copy;
}

try {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && isServerAction(init.headers)) {
      if (typeof init.body === 'string' && !hasContentType(init.headers!)) {
        const headers = new Headers(init.headers);
        headers.set('content-type', 'application/json');
        return original(input, { ...init, headers });
      }
      if (init.body instanceof FormData) {
        return original(input, { ...init, body: withoutNoJsFields(init.body) });
      }
    }
    return original(input, init);
  };
} catch {
  // Leave fetch as it is; actions then behave as before.
}
