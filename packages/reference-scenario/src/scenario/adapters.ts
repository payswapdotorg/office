// Office reference-scenario — THE four-adapter fixture rig (OFF-037).
//
// The deterministic wiring of the four landed adapters' fixture surfaces
// into the seeded world: the model / schedule seeded providers, the finance
// and construction provider stores (seeded with the generic commercial and
// change-event fixture rows), their Adapter implementations, their command
// translators, and their sync drivers — each driven through the SDK engine's
// public driver functions the adapter packages re-export (runModelSync /
// runScheduleSync / runFinanceSync / runConstructionSync).
//
// The structurally-required engine dependencies of the sync engine (the
// source-mapping store, the cursor store, the conflict store, the
// canonical-version lookup, the clock, and the office-issued canonical-id
// supplier) are satisfied by pure in-memory twins through STRUCTURAL typing
// — @office/adapters-sdk is NEVER imported by this scenario package (not
// even type-only, per the OFF-037 boundary). The world plays the runtime's
// role: it OWNS the graph, so the canonical-version lookup reads the world's
// own committed aggregate versions (fed from its command journal), and the
// engine's office-issued canonical ids are composed from the injected
// supplier through @office/contracts' formatEntityId.
//
// Deterministic: same injected parts → same mappings, same cursors, same
// proposals. Generic fixture vocabulary only ('acc-1'/'cc-1'/'po-1'/'inv-1',
// 'doc-1'/'ce-1', the landed model/schedule fixture identities).
import { authorizationContext, capability } from '@office/authz';
import type { Capability, Policy } from '@office/authz';
import { formatEntityId } from '@office/contracts';
import type { EntityId, Scope, Timestamp } from '@office/contracts';
import { invariantViolation, ok, parseAggregateVersion } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  MODEL_SYSTEM_ID,
  WALL_ELEMENT_ID,
  createSeededModelProvider,
  runModelSync,
} from '@office/adapter-model';
import type { ModelSyncOutcome } from '@office/adapter-model';
import {
  SCHEDULE_SYSTEM_ID,
  STRUCTURE_ACTIVITY_ID,
  TOWER_SCHEDULE_ID,
  createSeededScheduleProvider,
  runScheduleSync,
} from '@office/adapter-schedule';
import type { ScheduleSyncOutcome } from '@office/adapter-schedule';
import {
  FINANCE_CAPABILITY_NAMES,
  FINANCE_SYSTEM_ID,
  createErpProviderStore,
  createFinanceAdapter,
  createFinanceTranslator,
  createInMemoryProviderVersionLedger,
  runFinanceSync,
} from '@office/adapter-finance';
import type { FinanceSyncReport } from '@office/adapter-finance';
import {
  CONSTRUCTION_CAPABILITY_NAMES,
  CONSTRUCTION_SYSTEM_ID,
  createConstructionAdapter,
  createConstructionProviderStore,
  createConstructionTranslator,
  runConstructionSync,
} from '@office/adapter-construction';
import type { ConstructionSyncReport } from '@office/adapter-construction';
import { costOpaqueId, type SeededWorld } from './world';

// ---------------------------------------------------------------------------
// The in-memory structural twins of the sync engine's dependency ports.
// (No @office/adapters-sdk import: every port below is satisfied by shape.)
// ---------------------------------------------------------------------------

/** The provider coordinate of one mapping-store entry, as plain strings. */
export interface CoordinateKey {
  readonly adapterKind: string;
  readonly systemId: string;
  readonly objectType: string;
  readonly objectId: string;
}

/** One recorded source mapping (the engine's own record, kept as given). */
export interface RecordedMapping {
  readonly kind: 'source-mapping';
  readonly tenantId: string;
  readonly coordinate: CoordinateKey;
  readonly canonical: { readonly entityKind: string; readonly entityId: string };
  readonly providerVersion: string;
  readonly canonicalVersion: number;
  readonly actor: unknown;
  readonly mappedAt: Timestamp;
  readonly lastSyncedAt: Timestamp;
}

/**
 * The in-memory source-mapping store twin: the engine records every provider
 * → canonical binding here; the HOST-side execution seam reads it back to
 * resolve provider references into canonical ids, and re-binds a mapping to
 * the EXECUTED aggregate after the host executes a proposal (the runtime
 * owns the graph). The adapters' replay discipline lives at this layer — the
 * same provider version never maps twice, so re-delivering the same
 * notification is a no-op.
 */
export interface SourceMappingTwin {
  readonly mappings: readonly RecordedMapping[];
  /** The canonical entity of one provider coordinate (or null — unmapped). */
  canonicalOf(
    coordinate: CoordinateKey,
  ): { readonly entityKind: string; readonly entityId: string } | null;
  /** The engine port: find by (tenant, coordinate). */
  findByCoordinate(
    tenantId: string,
    coordinate: CoordinateKey,
  ): Promise<RecordedMapping | null>;
  /** The engine port: list by canonical entity. */
  listByCanonical(
    tenantId: string,
    canonical: { readonly entityKind: string; readonly entityId: string },
  ): Promise<readonly RecordedMapping[]>;
  /** The engine port: persist (re-save advances version bookkeeping). */
  save(mapping: RecordedMapping): Promise<Result<RecordedMapping, DomainError>>;
}

const createSourceMappingTwin = (): SourceMappingTwin => {
  const byKey = new Map<string, RecordedMapping>();
  const keyOf = (tenantId: string, coordinate: CoordinateKey): string =>
    `${tenantId}|${coordinate.adapterKind}|${coordinate.systemId}|${coordinate.objectType}|${coordinate.objectId}`;
  return {
    get mappings(): readonly RecordedMapping[] {
      return [...byKey.values()];
    },
    canonicalOf(coordinate) {
      for (const mapping of byKey.values()) {
        if (
          mapping.coordinate.adapterKind === coordinate.adapterKind &&
          mapping.coordinate.systemId === coordinate.systemId &&
          mapping.coordinate.objectType === coordinate.objectType &&
          mapping.coordinate.objectId === coordinate.objectId
        ) {
          return mapping.canonical;
        }
      }
      return null;
    },
    findByCoordinate: async (tenantId, coordinate) =>
      byKey.get(keyOf(tenantId, coordinate)) ?? null,
    listByCanonical: async (_tenantId, canonical) =>
      [...byKey.values()].filter(
        (mapping) =>
          mapping.canonical.entityKind === canonical.entityKind &&
          mapping.canonical.entityId === canonical.entityId,
      ),
    save: async (mapping) => {
      byKey.set(keyOf(mapping.tenantId, mapping.coordinate), mapping);
      return ok(mapping);
    },
  };
};

/** A sync stream's identity, as plain strings (the cursor-store key). */
interface StreamKey {
  readonly tenantId: string;
  readonly adapterKind: string;
  readonly systemId: string;
  readonly objectKind: string;
}

/** The in-memory sync-cursor store twin (positions only ever advance). */
interface CursorTwin {
  load(stream: StreamKey): unknown;
  save(cursor: { readonly stream: StreamKey }): Promise<Result<unknown, DomainError>>;
}

const createCursorTwin = (): CursorTwin => {
  const cursors = new Map<string, unknown>();
  const keyOf = (stream: StreamKey): string =>
    `${stream.tenantId}|${stream.adapterKind}|${stream.systemId}|${stream.objectKind}`;
  return {
    load: (stream) => cursors.get(keyOf(stream)) ?? null,
    save: async (cursor) => {
      cursors.set(keyOf(cursor.stream), cursor);
      return ok(cursor);
    },
  };
};

/** The in-memory conflict store twin (append is idempotent by identity). */
interface ConflictTwin {
  append(conflict: { readonly conflictId: string }): Promise<Result<unknown, DomainError>>;
  findById(tenantId: string, conflictId: string): Promise<unknown>;
  listBySource(tenantId: string, coordinate: CoordinateKey): Promise<readonly unknown[]>;
  recordResolution(resolved: { readonly conflictId: string }): Promise<Result<unknown, DomainError>>;
}

const createConflictTwin = (): ConflictTwin => {
  const byId = new Map<string, unknown>();
  return {
    append: async (conflict) => {
      byId.set(conflict.conflictId, conflict);
      return ok(conflict);
    },
    findById: async (_tenantId, conflictId) => byId.get(conflictId) ?? null,
    listBySource: async () => [],
    recordResolution: async (resolved) => {
      byId.set(resolved.conflictId, resolved);
      return ok(resolved);
    },
  };
};

// ---------------------------------------------------------------------------
// THE adapter rig: the four seeded fixtures + their sync drivers.
// ---------------------------------------------------------------------------

/** The injected deterministic parts of one adapter rig. */
export interface AdapterRigParts {
  /** The adapter actor's canonical entity id. */
  readonly adapterActorId: EntityId;
  /** Injected clock — the canonical 'now' of each engine run. */
  readonly now: () => Timestamp;
  /** Injected office-issued opaque-id supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
}

/** One canonical command proposal of a sync pass (the host seam's input). */
export interface AdapterProposal {
  readonly commandName: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly scope: Scope;
}

/** Extract the canonical command proposals of one sync pass (stream order). */
export const proposalsOf = (
  outcome: { readonly commands?: readonly unknown[] } & {
    readonly streams?: readonly { readonly applications?: readonly { readonly command: unknown }[] }[];
  },
): readonly AdapterProposal[] => {
  const extract = (command: unknown): AdapterProposal | null => {
    if (command === null || typeof command !== 'object') return null;
    const envelope = command as {
      readonly commandName?: unknown;
      readonly payload?: unknown;
      readonly idempotencyKey?: unknown;
      readonly scope?: Scope;
    };
    if (
      typeof envelope.commandName !== 'string' ||
      typeof envelope.idempotencyKey !== 'string' ||
      envelope.scope === undefined
    ) {
      return null;
    }
    return {
      commandName: envelope.commandName,
      payload: (envelope.payload ?? {}) as Record<string, unknown>,
      idempotencyKey: envelope.idempotencyKey,
      scope: envelope.scope,
    };
  };
  if (outcome.commands !== undefined) {
    return outcome.commands
      .map(extract)
      .filter((proposal): proposal is AdapterProposal => proposal !== null);
  }
  const fromStreams: AdapterProposal[] = [];
  for (const stream of outcome.streams ?? []) {
    for (const application of stream.applications ?? []) {
      const proposal = extract(application.command);
      if (proposal !== null) fromStreams.push(proposal);
    }
  }
  return fromStreams;
};

/** The adapter-actor authorization the engines run under (one per family). */
const adapterAuthorizationOf = (
  actorId: EntityId,
  scope: Scope,
  capabilities: readonly Capability[],
): { readonly context: ReturnType<typeof authorizationContext>; readonly policy: Policy } => {
  // The mapped capability-name lists (e.g. FINANCE_CAPABILITY_NAMES) carry
  // one entry PER OBJECT KIND — several kinds legitimately share one
  // capability (account/cost-code/commitment all gate on 'cost.write').
  // authorizationContext's parseCapabilityList fails closed on duplicate
  // VALUES, so the actor's held-capability set is the DEDUPLICATED distinct
  // list (capability identity is the distinct name set, never the per-kind
  // mapping multiplicity).
  const distinct = [...new Set(capabilities)] as readonly Capability[];
  return {
    context: authorizationContext({
      actor: { kind: 'adapter', actorId },
      scope,
      capabilities: [...distinct],
    }),
    policy: {
      rules: [{ effect: 'allow', actorKinds: ['adapter'], capabilities: [...distinct] }],
    },
  };
};

/** The four-adapter rig over one seeded world. */
export interface AdapterRig {
  readonly kind: 'reference-scenario-adapter-rig';
  /** The shared source-mapping twin (the host's graph-binding surface). */
  readonly mappings: SourceMappingTwin;
  /** The model adapter family (the chain's INGRESS surface). */
  readonly model: {
    readonly provider: ReturnType<typeof createSeededModelProvider>;
    run(): Promise<Result<ModelSyncOutcome, DomainError>>;
  };
  /** The schedule adapter family (the chain's activity-update surface). */
  readonly schedule: {
    readonly provider: ReturnType<typeof createSeededScheduleProvider>;
    run(): Promise<Result<ScheduleSyncOutcome, DomainError>>;
  };
  /** The finance adapter family (the world's cost-record ingress). */
  readonly finance: {
    readonly store: ReturnType<typeof createErpProviderStore>;
    run(): Promise<Result<FinanceSyncReport, DomainError>>;
  };
  /** The construction adapter family (the change-event/document surface). */
  readonly construction: {
    readonly store: ReturnType<typeof createConstructionProviderStore>;
    run(): Promise<Result<ConstructionSyncReport, DomainError>>;
  };
}

/**
 * Wire the four landed adapters' fixture surfaces over the seeded world and
 * expose their sync drivers. The finance fixture is seeded with the generic
 * commercial baseline (account / cost code / commitment / invoice / payment
 * rows referencing the world's project and the canonical identities the
 * world's cost command service issues — see world.costOpaqueId), and the
 * construction fixture with the generic change-event document surface. The
 * model + schedule fixtures carry their landed deterministic seeds.
 */
export function createAdapterRig(world: SeededWorld, parts: AdapterRigParts): AdapterRig {
  const tenantScope: Scope = world.tenantScope;
  const mappings = createSourceMappingTwin();
  const cursors = createCursorTwin();
  const conflicts = createConflictTwin();

  /** The canonical-version lookup: the world owns the graph. */
  const canonicalVersionOf = async (
    tenantId: string,
    canonical: { readonly entityId: string },
  ): Promise<Result<number | null, DomainError>> => {
    if (tenantId !== world.scope.tenantId) return ok(null);
    const version = world.canonicalVersionOf(canonical.entityId as EntityId);
    if (version === null) return ok(null);
    const parsed = parseAggregateVersion(version);
    return parsed.ok
      ? ok(parsed.value)
      : {
          ok: false,
          error: invariantViolation(
            {
              name: 'adapter-rig-canonical-version',
              statement: `the world reports canonical version '${String(version)}' of ${canonical.entityId} which the aggregate-version grammar rejects`,
            },
            { scope: world.scope, correlationId: null },
          ),
        };
  };

  /** The office-issued canonical id supplier (the engine's mapping issuer). */
  const nextCanonicalId = (): EntityId =>
    formatEntityId({ version: 'v1', opaque: parts.newOpaqueId() });

  /**
   * The shared engine dependencies — the in-memory structural twin of the
   * sync engine's dependency port. The port's declared type lives in
   * @office/adapters-sdk, which this package NEVER imports (the OFF-037
   * boundary), so the twin is handed to the drivers through the one
   * structural bridge below: every field satisfies the port's shape by
   * construction (the mapping/cursor/conflict stores, the world's own
   * canonical-version lookup, the injected clock, and the office-issued
   * canonical-id supplier composed through @office/contracts).
   */
  const engineDeps = {
    mappings,
    cursors,
    conflicts,
    canonicalVersionOf,
    now: parts.now,
    nextCanonicalId,
  } as const;
  /** The structural bridge (see engineDeps above — the SDK types are unnamed here by boundary rule). */
  const engineDepsPort = engineDeps as never;

  // ---- the model family (THE chain's ingress surface) ---------------------
  const modelProvider = createSeededModelProvider();
  const modelAuthorization = adapterAuthorizationOf(parts.adapterActorId, tenantScope, [
    capability('models.write'),
  ]);
  const model = {
    provider: modelProvider,
    run: (): Promise<Result<ModelSyncOutcome, DomainError>> =>
      runModelSync(
        {
          authorization: modelAuthorization,
          adapter: modelProvider.adapter,
          translator: modelProvider.translator,
          systemId: MODEL_SYSTEM_ID,
          limit: 50,
        },
        engineDepsPort,
      ),
  };

  // ---- the schedule family (the chain's activity-update surface) ----------
  const scheduleProvider = createSeededScheduleProvider();
  const scheduleAuthorization = adapterAuthorizationOf(parts.adapterActorId, tenantScope, [
    capability('schedule.write'),
  ]);
  const schedule = {
    provider: scheduleProvider,
    run: (): Promise<Result<ScheduleSyncOutcome, DomainError>> =>
      runScheduleSync(
        {
          authorization: scheduleAuthorization,
          adapter: scheduleProvider.adapter,
          translator: scheduleProvider.translator,
          systemId: SCHEDULE_SYSTEM_ID,
          limit: 50,
          divergenceView: scheduleProvider.divergenceView,
        },
        engineDepsPort,
      ),
  };

  // ---- the finance family (the world's cost-record ingress) ---------------
  const financeStore = createErpProviderStore();
  const financeRef = (n: number): EntityId =>
    formatEntityId({ version: 'v1', opaque: costOpaqueId(n) });
  const BUDGET_REF = financeRef(1);
  const COST_ITEM_REF = financeRef(2);
  // The cost command service's opaque-id sequence over this fixture's own
  // command order: createBudget -> cst1; recordCostItem -> cst2 (the cost
  // item); createCommitment -> the commitment LINES each consume an id
  // FIRST (commitmentLinesGate issues lineId per line), so with ONE line the
  // line takes cst3 and the COMMITMENT itself is cst4; recordInvoice ->
  // invoiceId cst5 (then its line cst6); referencePayment -> cst7. The
  // fixture's canonical references must point at the AGGREGATE ids, never
  // the incidental line ids.
  const COMMITMENT_REF = financeRef(4);
  const INVOICE_REF = financeRef(5);
  financeStore.putAccount({
    objectId: 'acc-1',
    code: '5010',
    name: 'Structure works costs',
    currency: 'EUR',
    projectRef: world.identities.projectId,
    updatedAt: parts.now(),
  });
  financeStore.putCostCode({
    objectId: 'cc-1',
    code: '0320',
    description: 'Concrete walls package',
    unit: 'm2',
    budgetRef: BUDGET_REF,
    quantityMilli: 1_200,
    unitRateMinor: 2_500,
    updatedAt: parts.now(),
  });
  financeStore.putCommitment({
    objectId: 'po-1',
    number: 'PO-2026-014',
    commitmentKind: 'purchase-order',
    description: 'Concrete walls package order',
    currency: 'EUR',
    budgetRef: BUDGET_REF,
    lines: [
      { costItemRef: COST_ITEM_REF, description: 'Concrete walls', amountMinor: 3_000_000 },
    ],
    updatedAt: parts.now(),
  });
  financeStore.putInvoice({
    objectId: 'inv-1',
    number: 'INV-2026-0301',
    description: 'Walls package invoice 1',
    currency: 'EUR',
    commitmentRef: COMMITMENT_REF,
    issuedOn: parts.now(),
    dueOn: parts.now(),
    lines: [{ description: 'Concrete walls progress', amountMinor: 250_000 }],
    updatedAt: parts.now(),
  });
  financeStore.putPayment({
    objectId: 'pay-1',
    invoiceRef: INVOICE_REF,
    reference: 'TRC-8841',
    amountMinor: 250_000,
    paidAt: parts.now(),
    updatedAt: parts.now(),
  });
  const financeAuthorization = adapterAuthorizationOf(
    parts.adapterActorId,
    tenantScope,
    FINANCE_CAPABILITY_NAMES,
  );
  const financeLedger = createInMemoryProviderVersionLedger();
  const finance = {
    store: financeStore,
    run: (): Promise<Result<FinanceSyncReport, DomainError>> =>
      runFinanceSync(
        {
          authorization: financeAuthorization,
          adapter: createFinanceAdapter({ store: financeStore }),
          translator: createFinanceTranslator(),
          systemId: FINANCE_SYSTEM_ID,
          limit: 50,
        },
        { ...engineDeps, ledger: financeLedger } as never,
      ),
  };

  // ---- the construction family (the change-event/document surface) --------
  const constructionStore = createConstructionProviderStore();
  constructionStore.putDocument({
    // 'doc-9': the EXACT provider coordinate the model fixture's seeded
    // LINKED_DOCUMENT_REF names ('construction-cde'/'cde-instance-01'/
    // 'document'/'doc-9') — seeding the same coordinate means the
    // construction sync itself records the provider→canonical mapping the
    // evidence packet's linked-document resolution reads back.
    objectId: 'doc-9',
    title: 'Wall quantity change proposal',
    projectId: world.identities.projectId,
    discipline: 'structure',
    revision: { revisionId: 'rev-1', contentBase64: 'd2FsbC1xdWFudGl0eS1jaGFuZ2U=' },
    updatedAt: parts.now(),
  });
  constructionStore.putChangeEvent({
    objectId: 'ce-1',
    title: 'Wall element quantity increase',
    changeType: 'modification',
    // The canonical EntityId of the CONTRACT the change event is raised
    // against — the executed commitment (the purchase-order contract the
    // finance ingress materializes as cst4). The adapter's fail-closed
    // provider-data parser requires the office-issued EntityId format.
    contractRef: COMMITMENT_REF,
    costImpacts: [{ budgetId: BUDGET_REF, costItemId: COST_ITEM_REF }],
    // The canonical EntityId of the impacted STRUCTURE activity: the
    // schedule command service's opaque-id sequence over the first sync
    // pass's own command order — createSchedule -> sch1, addActivity
    // Foundations -> sch2, addActivity STRUCTURE -> sch3 (dependencies and
    // baselines issue their own ids only AFTER the activities exist).
    // The construction adapter's provider-data parser requires the
    // office-issued EntityId format, never the provider object id.
    scheduleImpactActivityIds: [
      formatEntityId({ version: 'v1', opaque: 'sch0000000000003' }),
    ],
    updatedAt: parts.now(),
  });
  const constructionAuthorization = adapterAuthorizationOf(
    parts.adapterActorId,
    tenantScope,
    CONSTRUCTION_CAPABILITY_NAMES,
  );
  const construction = {
    store: constructionStore,
    run: (): Promise<Result<ConstructionSyncReport, DomainError>> =>
      runConstructionSync(
        {
          authorization: constructionAuthorization,
          adapter: createConstructionAdapter({ store: constructionStore }),
          translator: createConstructionTranslator(),
          systemId: CONSTRUCTION_SYSTEM_ID,
          limit: 50,
        },
        engineDepsPort,
      ),
  };

  return {
    kind: 'reference-scenario-adapter-rig',
    mappings,
    model,
    schedule,
    finance,
    construction,
  };
}

/** The fixed provider identities the golden chain addresses. */
export const CHAIN_PROVIDER_IDS = {
  /** The model fixture's wall element (the chain's mutated element). */
  wallElement: WALL_ELEMENT_ID,
  /** The schedule fixture's structure-framing activity (the impacted one). */
  structureActivity: STRUCTURE_ACTIVITY_ID,
  /** The schedule fixture's schedule container. */
  schedule: TOWER_SCHEDULE_ID,
} as const;
