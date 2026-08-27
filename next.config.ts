import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow SerpAPI thumbnail images
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.googleusercontent.com" },
      { protocol: "https", hostname: "**.gstatic.com" },
      { protocol: "https", hostname: "encrypted-tbn*.gstatic.com" },
    ],
  },
};

export default nextConfig;
