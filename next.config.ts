import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // We generate the Prisma client into ./lib/generated/prisma — local-path
  // imports bypass Next.js 16 Turbopack's external-package hashing entirely,
  // so no entry in serverExternalPackages is needed.
  // xlsx (SheetJS) is server-only — keep it as an external so Turbopack
  // doesn't try to bundle its CJS+ESM shape into the client chunks.
  serverExternalPackages: ["xlsx"],
  experimental: {
    serverActions: { bodySizeLimit: "120mb" },
  },
};

export default nextConfig;
