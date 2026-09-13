// Office adapter-construction — deterministic test support (OFF-021).
//
// The shared wiring every test suite in this package uses: fixed tenants and
// instants (constants — never a wall clock), sequential office-issued id
// suppliers, the adapter authorization context composed through the SDK's
// trusted path (adapterAuthorizationContext — the ADAPTER actor kind), the
// deny-by-default policy derived from the declared capability names (the
// structural Policy value the engines' authorize() evaluates; composed from
// the mapping table's parsed capabilities so the two can never drift), and
// the deterministic in-memory engine state (the SDK's store fixtures plus
// the canonical version table that stands in for the runtime's command
// execution — the graph the adapters never touch).
//
// Package-internal: NOT re-exported by src/index.ts.
import { formatEntityId, formatProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, ProjectId, TenantId, Timestamp } from '@office/contracts';
import { ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
} from '@office/adapters-sdk';
import type { AdapterAuthorization, SyncEngineDeps } from '@office/adapters-sdk';
import { CONSTRUCTION_CAPABILITY_NAMES } from './vocabulary';

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

/** The tenant whose adapter engine runs (fixed constant). */
export const TENANT_A: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);

/** A second tenant (the A12 cross-tenant probes). */
export const TENANT_B: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0b1c2d3e4f5f60718293a4b5c6d7e8f9a'),
);

/** Fixed instants (one per round-trip phase; never a wall clock). */
export const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
export const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
export const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));
export const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-15T09:00:00.000Z'));
export const NOW_5: Timestamp = unwrap(parseTimestamp('2026-09-16T09:00:00.000Z'));

/** The office-issued project id the CDE fixture's objects reference. */
export const PROJECT_ID: ProjectId = formatProjectId({
  version: 'v1',
  opaque: 'prj0000000000001',
});

/** The office-issued contract id the fixture's change events reference. */
export const CONTRACT_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'ctr0000000000001',
});

/** The office-issued user id the fixture's RFIs/observations reference. */
export const USER_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'usr0000000000001',
});

/** The office-issued document/revision ids the fixture's evidence references. */
export const EVIDENCE_DOCUMENT_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'doc0000000000002',
});
export const EVIDENCE_REVISION_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'rev0000000000002',
});

/** The adapter actor's own office-issued id. */
export const ADAPTER_ACTOR_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'adp0000000000001',
});

/** Sequential office-issued entity ids (the injected canonical id supplier). */
export const entity = (n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `ent${String(n).padStart(13, '0')}` });

/** Trusted aggregate version literal (fixed constants in tests). */
export const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));

/**
 * The adapter authorization the engines run under: the ADAPTER actor context
 * composed through the SDK's trusted path, holding every capability the
 * mapping table declares (deduplicated — two object kinds may authorize
 * through the same capability, while an actor's capability list is a set),
 * plus the deny-by-default allow rule for exactly those capabilities
 * (foreign actors/capabilities are denied — the engines prove it before
 * anything moves).
 */
export const constructionAuthorization = (): AdapterAuthorization => {
  const capabilities = [...new Set(CONSTRUCTION_CAPABILITY_NAMES)];
  return {
    context: adapterAuthorizationContext({
      actorId: ADAPTER_ACTOR_ID,
      scope: { kind: 'tenant', tenantId: TENANT_A },
      capabilities,
    }),
    policy: {
      rules: [
        {
          effect: 'allow',
          actorKinds: ['adapter'],
          capabilities,
        },
      ],
    },
  };
};

/**
 * Deterministic engine state: the SDK's in-memory store fixtures plus the
 * canonical version table standing in for the runtime's command execution.
 * `now` defaults to NOW_1 and is advanced per phase through `advanceClockTo`
 * (multi-phase scenarios step the injected clock explicitly; single-phase
 * suites never need to).
 */
export const engine = (parts?: { readonly now?: Timestamp }) => {
  let nextId = 1;
  let current: Timestamp = parts?.now ?? NOW_1;
  const versions = new Map<string, AggregateVersion | null>();
  const deps: SyncEngineDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: async (tenantId, canonical) => {
      if (tenantId !== TENANT_A) return ok(null);
      return ok(versions.get(canonical.entityId) ?? null);
    },
    now: () => current,
    nextCanonicalId: () => entity(nextId++),
  };
  return {
    deps,
    versions,
    nextId: () => entity(nextId++),
    /** Step the injected clock to the next phase's fixed instant. */
    advanceClockTo: (now: Timestamp): void => {
      current = now;
    },
  };
};

export { unwrap };
