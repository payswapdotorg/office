// Office browser host — the Next.js configuration (OFF-DEPLOY).
//
// Minimal by design: no rewrites (the API routes are colocated under
// src/app/api/**), the default server output (the hosting platform runs its
// own `next build`), nothing exotic. The five repository gates never run
// `next build`; this config exists for the platform's build and for editors.
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;
