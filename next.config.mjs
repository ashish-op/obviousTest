/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: [],
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3', '@react-pdf/renderer'],
  },
};

export default nextConfig;
