/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@rekoda/core'],
  experimental: { optimizePackageImports: [] },
};
export default nextConfig;
