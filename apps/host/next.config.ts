// Office browser host — the Next.js configuration (OFF-DEPLOY).
//
// Minimal by design: no rewrites (the API routes are colocated under
// src/app/api/**), the default server output (the hosting platform runs its
// own `next build`), nothing exotic. The five repository gates never run
// `next build`; this config exists for the platform's build and for editors.
//
// serverExternalPackages: the landed persistence package's PUBLIC surface
// (src/index.ts) re-exports its integration-test harness (src/testing.ts),
// whose `await import('embedded-postgres')` is the sanctioned dynamic seam
// for the embedded local-database mode — a ROOT devDependency shipping
// optional per-platform binaries (@embedded-postgres/*) that exist only on
// the machine running the test suite. Production code never executes that
// path (the gateway composes the pool/migrator/repositories, never the test
// harness), but the bundler statically traces the dynamic import through the
// re-export and fails on the platform binary that is not installed. Marking
// the package external keeps the dev-only binary out of the production
// bundle exactly as the runtime discipline already does.
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['embedded-postgres'],
};

export default nextConfig;
