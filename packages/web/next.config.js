/* eslint-disable no-undef */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  reactStrictMode: true,
  transpilePackages: [
    "@kettigo/protocol",
    "@safe-global/protocol-kit",
    "@safe-global/relay-kit",
  ],
  generateBuildId: async () => "static",
  images: {
    unoptimized: true,
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

module.exports = nextConfig;
