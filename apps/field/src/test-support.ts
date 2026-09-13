// Office field/offline web client — deterministic test support (OFF-031).
//
// The fixed fixture identities (generic vocabulary only — canonical grammar
// ids, neutral names, no provider vocabulary, no real vendor names) and the
// seeded-world/session/data-plane harnesses every field-client test
// composes with. Determinism discipline: every clock and id supplier is
// INJECTED and sequential — no wall clock, no randomness, no Date
// construction in this file (tests construct fixed instants themselves).
import { formatEntityId, formatProjectId, formatTenantId } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { createFieldSession } from './session/session';
import type { FieldSession } from './session/session';
import { seedFieldWorld } from './session/world';
import type { SeededFieldWorld } from './session/world';
import { openFieldDataPlane } from './session/stream';
import type { FieldDataPlane } from './session/stream';

// ---- Fixed canonical identities (deterministic, opaque 32-hex parts). ----

export const TENANT_A = formatTenantId({ version: 'v1', opaque: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' });
export const TENANT_B = formatTenantId({ version: 'v1', opaque: 'f0e1d2c3b4a5968778695a4b3c2d1e0f' });
export const PROJECT_1 = formatProjectId({ version: 'v1', opaque: '2b3c4d5e6f708192a3b4c5d6e7f8a9b0' });
export const PROJECT_OTHER = formatProjectId({ version: 'v1', opaque: '4d5e6f708192a3b4c5d6e7f8a9b0c2d3' });
/** The field crew's field supervisor (the offline client's actor). */
export const FIELD_ACTOR = formatEntityId({ version: 'v1', opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a0b' });
/** The office-side coordinator (the online twin client's actor). */
export const OFFICE_ACTOR = formatEntityId({ version: 'v1', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a0b2c' });

/** The seed's causal-chain correlation id (one fixed literal). */
export const SEED_CORRELATION = 'seed-corr-0002';

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

export const unwrapField = <T, E>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
  what: string,
): T => {
  if (result.ok) return result.value;
  throw new TypeError(`unexpected failure (${what}): ${JSON.stringify(result.error)}`);
};

// ---- The harnesses. ----

/** Seed ONE deterministic field world for tenant A's project 1 (the fixed scope). */
export const seededFieldWorldOf = async (
  suppliers: DeterministicSuppliers,
): Promise<SeededFieldWorld> =>
  seedFieldWorld({
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    actorId: FIELD_ACTOR,
    correlationId: SEED_CORRELATION,
    now: suppliers.now,
    newOpaqueId: suppliers.newOpaqueId,
  });

/** The tenant-A field-supervisor session over the seeded world's project. */
export const fieldSessionOf = (): FieldSession =>
  unwrapField(
    createFieldSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: FIELD_ACTOR }),
    'field session',
  );

/** The tenant-A office-coordinator session (the online twin client). */
export const officeSessionOf = (): FieldSession =>
  unwrapField(
    createFieldSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: OFFICE_ACTOR }),
    'office session',
  );

/** A session with ARBITRARY valid identities (the A12 probes). */
export const sessionOf = (tenantId: string, projectId: string, actorId: string): FieldSession =>
  unwrapField(
    createFieldSession({ tenantId, projectId, actorId }),
    'probe session',
  );

/** Open one session's data plane over the world (grant serial/ordinal fixed). */
export const dataPlaneOf = async (
  world: SeededFieldWorld,
  session: FieldSession,
  suppliers: DeterministicSuppliers,
  wiring: { readonly serial: number; readonly ordinal: number },
): Promise<FieldDataPlane> =>
  openFieldDataPlane(world, session, {
    now: suppliers.now,
    serial: wiring.serial,
    ordinal: wiring.ordinal,
  });

/**
 * The two-client offline harness: the seeded field world + the FIELD
 * session's plane (the offline client) + the OFFICE session's plane (the
 * online twin), both over the world's SHARED server-side sync parts.
 */
export interface FieldHarness {
  readonly world: SeededFieldWorld;
  readonly fieldSession: FieldSession;
  readonly fieldPlane: FieldDataPlane;
  readonly officeSession: FieldSession;
  readonly officePlane: FieldDataPlane;
}

/** Wire one complete two-client harness over freshly injected suppliers. */
export const fieldHarnessOf = async (suppliers: DeterministicSuppliers): Promise<FieldHarness> => {
  const world = await seededFieldWorldOf(suppliers);
  const fieldSession = fieldSessionOf();
  const officeSession = officeSessionOf();
  const fieldPlane = await dataPlaneOf(world, fieldSession, suppliers, { serial: 1, ordinal: 1 });
  const officePlane = await dataPlaneOf(world, officeSession, suppliers, { serial: 2, ordinal: 2 });
  return { world, fieldSession, fieldPlane, officeSession, officePlane };
};

// ---- The fixed evidence identities (the divergence fixtures). ----

/**
 * The office-side evidence link (the online twin's attachment): a canonical
 * document revision reference.
 */
export const OFFICE_EVIDENCE = {
  entityKind: 'document',
  entityId: formatEntityId({ version: 'v1', opaque: 'd4e5f60718293a4b5c6d7e8f9a0b2c3d4' }),
  revisionId: formatEntityId({ version: 'v1', opaque: 'e5f60718293a4b5c6d7e8f9a0b2c3d4e5' }),
} as const;

/**
 * The field crew's evidence link (the offline capture's attachment): a
 * canonical document revision reference, distinct from the office side's.
 */
export const FIELD_EVIDENCE = {
  entityKind: 'document',
  entityId: formatEntityId({ version: 'v1', opaque: 'f60718293a4b5c6d7e8f9a0b2c3d4e5f6' }),
  revisionId: formatEntityId({ version: 'v1', opaque: '0718293a4b5c6d7e8f9a0b2c3d4e5f60' }),
} as const;
