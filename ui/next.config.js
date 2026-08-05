const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Multiple sibling lockfiles can make Next infer a parent monorepo root, which nests this app
  // under .next/standalone/ui and leaves Docker's /app/server.js missing. This package is the
  // complete tracing boundary for the UI image, so pin it explicitly.
  outputFileTracingRoot: path.resolve(__dirname),
  reactStrictMode: true,
};

module.exports = nextConfig;
