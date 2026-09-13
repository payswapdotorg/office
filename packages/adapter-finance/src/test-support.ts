// Office adapter-finance — deterministic test support (OFF-024).
//
// The shared wiring every test suite in this package uses: fixed tenants and
// instants (constants — never a wall clock), sequential office-issued id
// suppliers, the adapter authorization context composed through the SDK's
// trusted path (adapterAuthorizationContext — the ADAPTER actor kind), the
// deny-by-default policy derived from the declared capability names (the
// structural Policy value the engines' authorize() evaluates; composed from
// the mapping table's parsed capabilities so the two can never drift), and
// the deterministic in-memory engine state (the SDK's store fixtures plus
// THE version ledger plus the canonical version table that stands in for
// the runtime's command execution — the graph the adapters never touch).
//
// Package-internal: NOT re-exported by src/index.ts.
import {
  formatEntityId,
  formatProjectId,
  parseIdempotencyKey,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  EntityId,
  IdempotencyKey,
  ProjectId,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { ok, parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, Result } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  createInMemoryConflictStore,
  createInMemorySourceMappingStore,
  createInMemorySyncCursorStore,
  providerObjectId,
  providerVersion,
} from '@office/adapters-sdk';
import type {
  AdapterAuthorization,
  CanonicalVersionLookup,
  SyncEngineDeps,
} from '@office/adapters-sdk';
import {
  FINANCE_ADAPTER_KIND,
  FINANCE_CAPABILITY_NAMES,
  FINANCE_SYSTEM_ID,
  INVOICE_OBJECT_KIND,
} from './vocabulary';
import {
  createInMemoryProviderVersionLedger,
} from './sync';
import type { FinanceSyncDeps, ProviderVersionLedger } from './sync';
import type { ErpProviderStore } from './provider-fixture';
import { financeSnapshotOf } from './snapshot-translation';
import { sourceRef } from '@office/adapters-sdk';
import type { ProviderBalanceFact } from './reconciliation';
import type { ErpInvoiceObject } from './provider-fixture';

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

/** Fixed instants (one per scenario phase; never a wall clock). */
export const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
export const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-13T09:00:00.000Z'));
export const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-14T09:00:00.000Z'));
export const NOW_4: Timestamp = unwrap(parseTimestamp('2026-09-15T09:00:00.000Z'));
export const NOW_5: Timestamp = unwrap(parseTimestamp('2026-09-16T09:00:00.000Z'));

/** The office-issued project id the ERP fixture's accounts reference. */
export const PROJECT_ID: ProjectId = formatProjectId({
  version: 'v1',
  opaque: 'prj0000000000001',
});

/** The office-issued budget id the fixture's cost codes reference (provisioned identity). */
export const BUDGET_REF_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'bud0000000000001',
});

/** The office-issued cost-item id the fixture's commitment lines reference. */
export const COST_ITEM_REF_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'cst0000000000001',
});

/** The office-issued commitment id the fixture's invoices reference. */
export const COMMITMENT_REF_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'cmt0000000000001',
});

/** The office-issued invoice id the fixture's payments reference. */
export const INVOICE_REF_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'inv0000000000001',
});

/** The office-issued invoice id the fixture's second scenario payment references. */
export const SECOND_INVOICE_REF_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'inv0000000000002',
});

/** The adapter actor's own office-issued id. */
export const ADAPTER_ACTOR_ID: EntityId = formatEntityId({
  version: 'v1',
  opaque: 'adp0000000000002',
});

/** Sequential office-issued entity ids (the injected canonical id supplier). */
export const entity = (n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `ent${String(n).padStart(13, '0')}` });

/** Trusted aggregate version literal (fixed constants in tests). */
export const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));

/** A trusted idempotency-key-shaped literal for resolution evidence. */
export const commandKey = (n: number): IdempotencyKey => {
  // Composed through the contracts parser on the trusted path (loud failure
  // on an invalid literal); typed as the branded IdempotencyKey.
  const parsed = parseIdempotencyKey(`office-cmd-v1-${String(n).padStart(13, '0')}`);
  if (!parsed.ok) {
    throw new TypeError(`invalid command key literal: ${n}`);
  }
  return parsed.value;
};

/**
 * The adapter authorization the engines run under: the ADAPTER actor context
 * composed through the SDK's trusted path, holding every capability the
 * mapping table declares (deduplicated — the actor's capability list is a
 * set), plus the deny-by-default allow rule for exactly those capabilities
 * (foreign actors/capabilities are denied — the engines prove it before
 * anything moves).
 */
export const financeAuthorization = (): AdapterAuthorization => {
  const capabilities = [...new Set(FINANCE_CAPABILITY_NAMES)];
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
 * Deterministic engine state: the SDK's in-memory store fixtures plus THE
 * version ledger plus the canonical version table standing in for the
 * runtime's command execution. `now` defaults to NOW_1 and is advanced per
 * phase through `advanceClockTo`; `canonicalVersionOf` may be overridden to
 * poison a lookup (the interrupted-sync scenarios).
 */
export const engine = (parts?: {
  readonly now?: Timestamp;
  readonly canonicalVersionOf?: CanonicalVersionLookup;
}) => {
  let nextId = 1;
  let current: Timestamp = parts?.now ?? NOW_1;
  const versions = new Map<string, AggregateVersion | null>();
  const ledger = createInMemoryProviderVersionLedger();
  const fallbackLookup: CanonicalVersionLookup = async (tenantId, canonical) => {
    if (tenantId !== TENANT_A) return ok(null);
    return ok(versions.get(canonical.entityId) ?? null);
  };
  const deps: FinanceSyncDeps = {
    mappings: createInMemorySourceMappingStore(),
    cursors: createInMemorySyncCursorStore(),
    conflicts: createInMemoryConflictStore(),
    canonicalVersionOf: parts?.canonicalVersionOf ?? fallbackLookup,
    now: () => current,
    nextCanonicalId: () => entity(nextId++),
    ledger,
  };
  return {
    deps,
    versions,
    ledger,
    nextId: () => entity(nextId++),
    /** Step the injected clock to the next phase's fixed instant. */
    advanceClockTo: (now: Timestamp): void => {
      current = now;
    },
  };
};

/** The finance engine deps re-exposed as the plain SDK ports (webhook wiring). */
export const webhookDepsOf = (
  deps: FinanceSyncDeps,
): import('@office/adapters-sdk').WebhookEngineDeps => deps;

/**
 * THE provider balance facts of every active invoice in an ERP store: one
 * fact per invoice, the amount being the sum of its lines (the disputed
 * commercial balance), the source ref at the invoice's current version.
 */
export const invoiceBalanceFactsOf = (store: ErpProviderStore): ProviderBalanceFact[] =>
  store.objects
    .filter((object): object is ErpInvoiceObject => object.objectType === 'invoice')
    .filter((invoice) => invoice.status === 'active')
    .map((invoice) => ({
      source: sourceRef({
        adapterKind: FINANCE_ADAPTER_KIND,
        systemId: FINANCE_SYSTEM_ID,
        objectType: INVOICE_OBJECT_KIND,
        objectId: providerObjectId(invoice.objectId),
        version: providerVersion(invoice.version),
      }),
      amountMinor: invoice.lines.reduce((total, line) => total + line.amountMinor, 0),
    }));

/** The typed engine-deps view with the ledger kept (sync tests compose directly). */
export const financeDepsOf = (deps: SyncEngineDeps, ledger: ProviderVersionLedger): FinanceSyncDeps => ({
  ...deps,
  ledger,
});

/** Observe one snapshot through the ledger (scenario plumbing). */
export const snapshotSourceOf = (store: ErpProviderStore, objectId: string) => {
  const object = store.find(objectId);
  if (object === null) {
    throw new TypeError(`provider has no object '${objectId}'`);
  }
  const snapshot = financeSnapshotOf({ object, tenantId: TENANT_A, now: NOW_1 });
  return snapshot.source;
};

export { unwrap };
export type { FinanceSyncDeps, Result };
