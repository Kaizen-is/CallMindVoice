import type { NextConfig } from 'next';

/**
 * Hosts allowed to request the dev server's internal `/_next/*` resources.
 *
 * In development Next.js blocks cross-origin requests to those dev-only assets:
 * only `localhost` is allowed by default. When `next dev` is opened via the
 * server's IP or a domain instead of localhost, the client JavaScript and HMR
 * are blocked — so the page renders (SSR) but nothing hydrates and every button
 * is dead. Listing the host here fixes that.
 *
 * Set ALLOWED_DEV_ORIGINS (comma-separated hosts, wildcards allowed, e.g.
 * "app.example.com,*.example.com") to match how you actually reach the server.
 *
 * NOTE: this only affects `next dev`. For a real deployment run
 * `next build && next start` — the cross-origin block does not apply in
 * production, and dev mode should not be used to serve remote traffic.
 */
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? '10.10.50.23')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Domains that may invoke Server Actions in production behind a reverse proxy.
 *
 * Next.js rejects a Server Action POST whose `Origin` header does not match the
 * request `Host`, as CSRF protection. Behind nginx/Caddy the browser's Origin is
 * your public domain while the app's Host may be the upstream — a mismatch that
 * silently breaks every form (login, signup, the language switcher). A correctly
 * configured proxy (`proxy_set_header Host $host;`) avoids this, but listing the
 * public domain(s) here makes it work regardless. Set SERVER_ACTIONS_ALLOWED_ORIGINS
 * to a comma-separated host list, e.g. "app.example.uz,example.uz".
 */
const serverActionOrigins = (process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The Python backend (FastAPI, `backend/`), which runs all of CallMind's server
 * code. It listens privately on 127.0.0.1:8100; the browser reaches it only
 * through this app, as `/api/core/*` — so the edge proxy needs no change and
 * the login cookie travels with every request. Read at build time; set
 * CORE_API_URL to point elsewhere.
 */
const coreApiUrl = (process.env.CORE_API_URL ?? 'http://127.0.0.1:8100').replace(/\/+$/, '');

/**
 * Routes the Python backend serves at their original paths (this app has no
 * API routes of its own): the pages, the phone bridge and API clients keep
 * calling the same URLs. Each entry forwards `/api/<path>` to `/<path>`.
 */
const pythonRoutes = [
  // Phase 1 — the Playground voice call and the console's speech routes.
  '/api/playground/:path*',
  '/api/speech/live',
  '/api/speech/tts',
  '/api/speech/stt',
  '/api/models/stt',
  // The STT page's Audio Processing Lab (processing pipeline, temporary clips).
  '/api/audio/:path*',
  // Phase 2 — the phone line: the AudioSocket bridge's turn, filler and end calls.
  '/api/telephony/:path*',
  // Phase 3 — the public bank demo and logistics demo (no login, per-address limits).
  '/api/demo/:path*',
  '/api/logistics/:path*',
  // Phase 4 — the live wallboard feed and the public API (API-key auth): calls, answer, documents.
  '/api/stream',
  '/api/v1/:path*',
];

const nextConfig: NextConfig = {
  // sherpa-onnx-node (the native Zipformer addon) stays installed for the CI image check
  // (scripts/ci-isolated-smoke.sh); speech recognition itself runs in the Python backend.
  serverExternalPackages: ['sherpa-onnx-node'],
  allowedDevOrigins,
  async rewrites() {
    return {
      // Before the app's own routes, so /api/core/* is always the Python backend.
      beforeFiles: [
        { source: '/api/core/:path*', destination: `${coreApiUrl}/:path*` },
        ...pythonRoutes.map((source) => ({ source, destination: `${coreApiUrl}${source.slice('/api'.length)}` })),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  experimental: {
    // Server Actions handle multi-megabyte knowledge-base uploads.
    serverActions: {
      bodySizeLimit: '25mb',
      ...(serverActionOrigins.length ? { allowedOrigins: serverActionOrigins } : {}),
    },
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
