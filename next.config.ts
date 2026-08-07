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

const nextConfig: NextConfig = {
  serverExternalPackages: ['mammoth', 'unpdf'],
  allowedDevOrigins,
  experimental: {
    // Server Actions handle multi-megabyte knowledge-base uploads.
    serverActions: { bodySizeLimit: '25mb' },
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
