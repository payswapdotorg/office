// Office desktop client protocol/reference shell — deterministic test support
// (OFF-032).
//
// The fixed fixture identities (generic vocabulary only — canonical grammar
// ids, neutral names, no provider vocabulary, no real vendor names, no real
// OS vendor names beyond the generic 'desktop-host' vocabulary of the shell
// itself) and the seeded-world/session/host/data-plane harnesses every
// desktop-shell test composes with. Determinism discipline: every clock and
// id supplier is INJECTED and sequential — no wall clock, no randomness, no
// Date construction in this file (tests construct fixed instants themselves).
import { formatEntityId, formatProjectId, formatTenantId } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { createDesktopSession } from './session/session';
import type { DesktopSession } from './session/session';
import { seedDesktopWorld } from './session/world';
import type { SeededDesktopWorld } from './session/world';
import { openDesktopDataPlane } from './session/stream';
import type { DesktopDataPlane } from './session/stream';
import { createReferenceDesktopHost } from './desktop/host';
import type { DesktopHostPort } from './host-port/host-port';

// ---- Fixed canonical identities (deterministic, opaque 32-hex parts). ----

export const TENANT_A = formatTenantId({ version: 'v1', opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f809' });
export const TENANT_B = formatTenantId({ version: 'v1', opaque: '908f7e6d5c4b3a291a0f8e7d6c5b4a398' });
export const PROJECT_1 = formatProjectId({ version: 'v1', opaque: '3c4d5e6f708192a3b4c5d6e7f8a9b0c4' });
export const PROJECT_OTHER = formatProjectId({ version: 'v1', opaque: '5e6f708192a3b4c5d6e7f8a9b0c2d3e6' });
/** The desktop planner (the reference host's offline client actor). */
export const DESKTOP_ACTOR = formatEntityId({ version: 'v1', opaque: 'd5e6f708192a3b4c5d6e7f8a9b0c2d3e' });
/** The office-side coordinator (the web-style twin client's actor). */
export const OFFICE_ACTOR = formatEntityId({ version: 'v1', opaque: 'e6f708192a3b4c5d6e7f8a9b0c2d3e6f' });

/** The seed's causal-chain correlation id (one fixed literal). */
export const SEED_CORRELATION = 'seed-corr-0003';

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

// ---- The unwrapping helper (a failed expectation is a LOUD wiring error). ----

export const unwrapDesktop = <T, E>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
  what: string,
): T => {
  if (result.ok) return result.value;
  throw new TypeError(`unexpected failure (${what}): ${JSON.stringify(result.error)}`);
};

// ---- The harnesses. ----

/** Seed ONE deterministic desktop world for tenant A's project 1 (the fixed scope). */
export const seededDesktopWorldOf = async (
  suppliers: DeterministicSuppliers,
): Promise<SeededDesktopWorld> =>
  seedDesktopWorld({
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    actorId: DESKTOP_ACTOR,
    correlationId: SEED_CORRELATION,
    now: suppliers.now,
    newOpaqueId: suppliers.newOpaqueId,
  });

/** The tenant-A desktop-planner session over the seeded world's project. */
export const desktopSessionOf = (): DesktopSession =>
  unwrapDesktop(
    createDesktopSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: DESKTOP_ACTOR }),
    'desktop session',
  );

/** The tenant-A office-coordinator session (the web-style twin client). */
export const officeSessionOf = (): DesktopSession =>
  unwrapDesktop(
    createDesktopSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: OFFICE_ACTOR }),
    'office session',
  );

/** A session with ARBITRARY valid identities (the A12 probes). */
export const sessionOf = (tenantId: string, projectId: string, actorId: string): DesktopSession =>
  unwrapDesktop(
    createDesktopSession({ tenantId, projectId, actorId }),
    'probe session',
  );

/** Open one session's data plane over the world (grant serial/ordinal fixed). */
export const dataPlaneOf = async (
  world: SeededDesktopWorld,
  session: DesktopSession,
  suppliers: DeterministicSuppliers,
  wiring: { readonly serial: number; readonly ordinal: number },
): Promise<DesktopDataPlane> =>
  openDesktopDataPlane(world, session, {
    now: suppliers.now,
    serial: wiring.serial,
    ordinal: wiring.ordinal,
  });

/**
 * The two-client reference-host harness: the seeded desktop world + THE
 * REFERENCE DESKTOP HOST (the platform shell host-port contract's in-memory
 * implementation) + the DESKTOP session's plane (the offline client) + the
 * OFFICE session's plane (the web-style twin), both over the world's SHARED
 * server-side sync parts — the cross-client convergence composition (freeze
 * A12: all clients share ONE project state).
 */
export interface DesktopHarness {
  readonly world: SeededDesktopWorld;
  /** The reference desktop host (validated separately by the tests). */
  readonly host: DesktopHostPort;
  readonly desktopSession: DesktopSession;
  readonly desktopPlane: DesktopDataPlane;
  readonly officeSession: DesktopSession;
  readonly officePlane: DesktopDataPlane;
}

/** Wire one complete two-client harness over freshly injected suppliers. */
export const desktopHarnessOf = async (
  suppliers: DeterministicSuppliers,
): Promise<DesktopHarness> => {
  const world = await seededDesktopWorldOf(suppliers);
  const host = createReferenceDesktopHost(world);
  const desktopSession = desktopSessionOf();
  const officeSession = officeSessionOf();
  const desktopPlane = await dataPlaneOf(world, desktopSession, suppliers, { serial: 1, ordinal: 1 });
  const officePlane = await dataPlaneOf(world, officeSession, suppliers, { serial: 2, ordinal: 2 });
  return { world, host, desktopSession, desktopPlane, officeSession, officePlane };
};
