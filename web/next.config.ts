import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Marketing site is fully static — exportable per the design spec.
  output: "export",
  // Folder-style export (download/index.html) so any static file server
  // resolves /download without extension tricks.
  trailingSlash: true,
  // Set NEXT_PUBLIC_BASE_PATH=/repo-name when hosting under a sub-path
  // (e.g. GitHub Pages project sites); empty for root-domain hosting.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
};

export default nextConfig;
