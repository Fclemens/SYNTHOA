/** @type {import('next').NextConfig} */
// STATIC_EXPORT=1 builds plain files into out/, served by the backend itself
// (desktop app, single container). Otherwise `next dev` / `next start` proxy
// /api to the backend.
const staticExport = !!process.env.STATIC_EXPORT;

const nextConfig = staticExport
  ? {
      output: "export",
      trailingSlash: true,
      images: { unoptimized: true },
      env: { NEXT_PUBLIC_API_URL: "" },   // same origin as the page
    }
  : {
      async rewrites() {
        return [
          {
            source: "/api/:path*",
            destination: `${process.env.BACKEND_URL ?? "http://localhost:8000"}/api/:path*`,
          },
        ];
      },
    };

module.exports = nextConfig;
