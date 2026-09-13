// Office web application shell — deterministic test support (OFF-030).
//
// The fixed fixture identities (generic vocabulary only — canonical grammar
// ids, neutral names, no provider vocabulary, no real vendor names) and the
// seeded-world/session/data-plane harnesses every shell test composes with.
// Determinism discipline: every clock and id supplier is INJECTED and
// sequential — no wall clock, no randomness, no Date construction in this
// file (tests construct fixed instants themselves).
import { formatEntityId, formatProjectId, formatTenantId } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { createWebSession } from './session/session';
import type { WebSession } from './session/session';
import { seedOfficeWorld } from './session/world';
import type { SeededWorld } from './session/world';
import { openWebDataPlane } from './session/stream';
import type { WebDataPlane } from './session/stream';

// ---- Fixed canonical identities (deterministic, opaque 32-hex parts). ----

export const TENANT_A = formatTenantId({ version: 'v1', opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
export const TENANT_B = formatTenantId({ version: 'v1', opaque: 'f9e8d7c6b5a493827160504f3e2d1c0b' });
export const PROJECT_1 = formatProjectId({ version: 'v1', opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9' });
export const PROJECT_OTHER = formatProjectId({ version: 'v1', opaque: '3c4d5e6f708192a3b4c5d6e7f8a9b4c5' });
export const OPERATOR = formatEntityId({ version: 'v1', opaque: 'a1b2c3d4e5f60718293a4b5c6d7e8f9' });

/** The seed's causal-chain correlation id (one fixed literal). */
export const SEED_CORRELATION = 'seed-corr-0001';
/** The shell session's causal-chain correlation id (mirrors stream.ts). */
export const WEB_SESSION_CORRELATION = 'web-shell-corr-0001';

// ---- The injected deterministic suppliers (the kernel rule). ----

/** The injected suppliers of one deterministic world (clock + id sequence). */
export interface DeterministicSuppliers {
  readonly now: () => Timestamp;
  readonly newOpaqueId: () => string;
}

/** The canonical-id opaque-part supplier: a zero-padded deterministic counter. */
export const sequentialOpaqueIds = (): (() => string) => {
  let issued = 0;
  return () => {
    issued += 1;
    return String(issued).padStart(16, '0');
  };
};

/** A shared deterministic supplier pair (one clock tick + one id per call). */
export const sharedSuppliers = (now: () => Timestamp): DeterministicSuppliers => ({
  now,
  newOpaqueId: sequentialOpaqueIds(),
});

// ---- The unwrapping helper (a failed expectation is a LOUD wiring error). ----

export const unwrapShell = <T, E>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
  what: string,
): T => {
  if (result.ok) return result.value;
  throw new TypeError(`unexpected failure (${what}): ${JSON.stringify(result.error)}`);
};

// ---- The harnesses. ----

/** Seed ONE deterministic world for tenant A's project 1 (the fixed scope). */
export const seededWorldOf = async (suppliers: DeterministicSuppliers): Promise<SeededWorld> =>
  seedOfficeWorld({
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    actorId: OPERATOR,
    correlationId: SEED_CORRELATION,
    now: suppliers.now,
    newOpaqueId: suppliers.newOpaqueId,
  });

/** The tenant-A operator session over the seeded world's project. */
export const operatorSessionOf = (): WebSession =>
  unwrapShell(
    createWebSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: OPERATOR }),
    'operator session',
  );

/** A session with ARBITRARY valid identities (the A12 probes). */
export const sessionOf = (tenantId: string, projectId: string, actorId: string): WebSession =>
  unwrapShell(createWebSession({ tenantId, projectId, actorId }), 'probe session');

/** Open the session's online data plane (grant serial/ordinal fixed at 1). */
export const dataPlaneOf = async (
  world: SeededWorld,
  session: WebSession,
  suppliers: DeterministicSuppliers,
): Promise<WebDataPlane> =>
  openWebDataPlane(world, session, { now: suppliers.now, serial: 1, ordinal: 1 });

/** One fully wired shell: the seeded world + the operator session + the plane. */
export interface ShellHarness {
  readonly world: SeededWorld;
  readonly session: WebSession;
  readonly plane: WebDataPlane;
}

/** Wire one complete shell over freshly injected deterministic suppliers. */
export const shellHarnessOf = async (suppliers: DeterministicSuppliers): Promise<ShellHarness> => {
  const world = await seededWorldOf(suppliers);
  const session = operatorSessionOf();
  const plane = await dataPlaneOf(world, session, suppliers);
  return { world, session, plane };
};
