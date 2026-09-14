// Office browser host — the server-only host-runtime singleton (OFF-DEPLOY).
//
// THE one composition holder of the browser host: every server component and
// API route resolves the SAME lazily-booted HostRuntime through
// getHostRuntime(). The runtime is NEVER constructed at module top level —
// the Next.js build phase imports route/page modules without serving
// requests, so the composition (and its pg pool) must materialize only when
// the first request actually asks for it. The pool itself connects lazily
// (the node-postgres contract), and DATABASE_URL is read HERE — at the host's
// route layer, on first request — never inside @office/host-gateway: the
// package takes the connection string as an explicit option so it stays
// testable with explicit input (its README's rule). With DATABASE_URL unset
// (plain local development) the pool simply cannot connect: /api/health
// answers the honest 503 unreachable, while the seeded reference world's
// read surfaces (workspace / control tower / evidence) still resolve.
//
// Determinism mirrors the landed pattern (packages/host-gateway's own test
// suite): an injected sequential clock — one tick per call, 60s apart, from
// a fixed epoch, never the wall clock — and an injected sequential
// opaque-id supplier (zero-padded counters). The release identity is
// resolved once per boot from the deployment environment.
import { createHostRuntime, DEFAULT_RELEASE_ID } from '@office/host-gateway';
import type { HostRuntime, HostRuntimeOptions } from '@office/host-gateway';

/** The fixed hosted-clock epoch (2026-09-14T08:00:00Z — the landed base). */
const HOST_EPOCH_MS = Date.UTC(2026, 8, 14, 8, 0, 0);

/** The injected sequential clock: one tick per call, 60s apart, from a fixed epoch. */
const sequentialClock = (): HostRuntimeOptions['now'] => {
  let at = HOST_EPOCH_MS;
  return () => {
    at += 60_000;
    return new Date(at).toISOString() as ReturnType<HostRuntimeOptions['now']>;
  };
};

/** The injected sequential opaque-id supplier: zero-padded counters. */
const sequentialOpaqueIds = (): HostRuntimeOptions['newOpaqueId'] => {
  let issued = 0;
  return () => {
    issued += 1;
    return String(issued).padStart(16, '0');
  };
};

/** The release identity of this deployment (surfaced verbatim by health()). */
const releaseIdOf = (): string =>
  process.env.VERCEL_DEPLOYMENT_ID ?? process.env.RELEASE_ID ?? DEFAULT_RELEASE_ID;

/** The memoized real runtime (null until the first request boots it). */
let booted: Promise<HostRuntime> | null = null;

/** The test seam's injected runtime (null outside tests). */
let testRuntime: HostRuntime | null = null;

const boot = (): Promise<HostRuntime> =>
  createHostRuntime({
    connectionString: process.env.DATABASE_URL ?? '',
    now: sequentialClock(),
    newOpaqueId: sequentialOpaqueIds(),
    releaseId: releaseIdOf(),
  });

/**
 * Resolve THE hosted runtime. The first call boots the composition (the
 * deterministic seeded reference world materializes eagerly; the pg pool
 * connects lazily on its first query); every later call returns the SAME
 * memoized promise. Routes and server components never construct a runtime
 * of their own — this accessor is the one wiring point.
 */
export const getHostRuntime = (): Promise<HostRuntime> => {
  if (testRuntime !== null) return Promise.resolve(testRuntime);
  if (booted === null) booted = boot();
  return booted;
};

/**
 * The test seam: inject a structural fake runtime, or null to reset. Route
 * module tests inject ONLY the members the route under test touches (the
 * value is cast by the test, not here); a reset also drops the memoized
 * real runtime so a later boot starts fresh. Never called by application
 * code.
 */
export const __setHostRuntimeForTests = (runtime: HostRuntime | null): void => {
  testRuntime = runtime;
  booted = null;
};
