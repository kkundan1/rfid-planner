/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  poweredByHeader: false,
  experimental: { serverComponentsExternalPackages: ['better-sqlite3', 'nodemailer'] },
};
module.exports = nextConfig;
