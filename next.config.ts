import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['mammoth', 'unpdf'],
  experimental: {
    // Server Actions handle multi-megabyte knowledge-base uploads.
    serverActions: { bodySizeLimit: '25mb' },
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
