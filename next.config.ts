import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ioredis", "@prisma/client"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
