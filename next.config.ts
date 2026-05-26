import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We generate the Prisma client into ./lib/generated/prisma — local-path
  // imports bypass Next.js 16 Turbopack's external-package hashing entirely,
  // so no entry in serverExternalPackages is needed.
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
