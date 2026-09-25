const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  ...(process.env.AGENT_HQ_NEXT_DIST_DIR ? { distDir: process.env.AGENT_HQ_NEXT_DIST_DIR } : {}),
  // Multiple sibling lockfiles can make Next infer a parent monorepo root, which nests this app
  // under .next/standalone/ui and leaves Docker's /app/server.js missing. This package is the
  // complete tracing boundary for the UI image, so pin it explicitly.
  outputFileTracingRoot: path.resolve(__dirname),
  reactStrictMode: true,
  poweredByHeader: false,
  // The operator UI drives host-executing tools with a click, so no other site may frame it.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
      ],
    }];
  },
};

module.exports = nextConfig;
