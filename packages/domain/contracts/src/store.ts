// Office contracts/change domain — the transactional store port + in-memory store (OFF-012).
//
// This package is PURE DOMAIN: no SQL, no migrations, no repository layer.
// The ContractsStore port below is the domain's OWN transactional seam — the
// pure-domain counterpart of the identity modules' repository +
// TransactionRunner pair, in ONE minimal port (mirroring the schedule
// package's store exactly):
//
//   * runInTransaction mirrors @office/persistence's TransactionRunner
//     semantics exactly (work resolves → commit; work throws → rollback and
//     the ORIGINAL error is rethrown; tx.rollback(value) → rollback and
//     `value` becomes the call's value), so handler code keeps the exact
//     shape of the landed domain modules: `return tx.rollback(failure)`.
//   * The transaction extends SqlExecutor (the persistence package's minimal
//     typed surface) so the EventSink port — mirrored byte-for-byte from the
//     identity modules — binds unchanged: a production wiring implements
//     this store over PostgreSQL and passes its REAL transaction; the
//     ledger-backed EventSink adapter (ledger-sink.ts) then appends the
//     event-ledger and outbox rows in the SAME transaction. The in-memory
//     implementation's `query` fails loudly instead: in-memory transactions
//     execute no SQL, and a sink that tries to has been mis-wired.
//   * Every read/write is SCOPE-GUARDED (freeze A12): a contract, change
//     event, change order or claim reference invisible under the caller's
//     scope (foreign tenant, or foreign project under a project-scoped
//     command) loads as a typed not-found — no existence oracle. Cross-scope
//     writes are equally invisible.
//
// The in-memory store shipped here keeps the whole package deterministic and
// in-memory-testable: pending writes stage inside the transaction, commit
// publishes them atomically, and rollback discards them entirely — proving
// the state-write + event-append atomicity contract without any database.
// The contract root owns its scope obligations (embedded, immutable rows);
// change events, change orders and claim references are SEPARATE aggregates
// kept by the same store, each guarded by its own optimistic concurrency.
import type { EntityId, EntityKind, Scope } from '@office/contracts';
import {
  checkConcurrency,
  concurrencyTokenOf,
  entityNotFound,
  fail,
  invariantViolation,
  ok,
  projectScopeViolation,
  tenantScopeViolation,
} from '@office/domain-kernel';
import type {
  Aggregate,
  AggregateVersion,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  Result,
} from '@office/domain-kernel';
import type { SqlExecutor, SqlResult, SqlValue } from '@office/persistence';
import type {
  ChangeEventState,
  ChangeOrderState,
  ClaimReferenceState,
  ContractState,
} from './state';
import { CHANGE_EVENT_KIND, CHANGE_ORDER_KIND, CONTRACT_KIND } from './state';

/**
 * One open contracts-store transaction: a SqlExecutor (so EventSink
 * implementations bind unchanged) plus the cooperative rollback escape and
 * the scoped aggregate reads/writes of the mutation path.
 */
export interface ContractsStoreTransaction extends SqlExecutor {
  /**
   * Roll the transaction back (discarding every write of the attempt) and
   * make `value` the result of the surrounding runInTransaction call.
   * Never returns; throws an internal control signal caught by the runner.
   */
  readonly rollback: <T>(value: T) => never;
  /**
   * Load a contract by canonical id, visible under `scope` ONLY (A12: a
   * foreign tenant's or foreign project's contract is a typed not-found —
   * invisible, never an existence oracle).
   */
  loadContract(
    scope: Scope,
    contractId: EntityId,
  ): Promise<Result<ContractState, DomainError>>;
  /**
   * Insert a newly created contract. Rejects a create whose state is not
   * covered by the command scope (typed unauthorized, second-boundary
   * guard) and a duplicate canonical id (typed invariant-violation).
   */
  insertContract(scope: Scope, state: ContractState): Promise<Result<ContractState, DomainError>>;
  /**
   * Save the next state of an existing contract, guarded by the caller's
   * expected version (stale → typed concurrency-conflict; the commercial
   * baseline is never partially or silently overwritten).
   */
  saveContract(
    scope: Scope,
    state: ContractState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<ContractState, DomainError>>;
  /**
   * Load a change event by canonical id, visible under `scope` ONLY (A12).
   */
  loadChangeEvent(
    scope: Scope,
    changeEventId: EntityId,
  ): Promise<Result<ChangeEventState, DomainError>>;
  /**
   * Insert a newly raised change event (scope coverage + duplicate id
   * guards, mirroring insertContract).
   */
  insertChangeEvent(
    scope: Scope,
    state: ChangeEventState,
  ): Promise<Result<ChangeEventState, DomainError>>;
  /**
   * Save the next state of an existing change event (appended links or the
   * supersession), guarded by the caller's expected version.
   */
  saveChangeEvent(
    scope: Scope,
    state: ChangeEventState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<ChangeEventState, DomainError>>;
  /**
   * Load a change order by canonical id, visible under `scope` ONLY (A12).
   */
  loadChangeOrder(
    scope: Scope,
    changeOrderId: EntityId,
  ): Promise<Result<ChangeOrderState, DomainError>>;
  /**
   * Insert a newly submitted change order (scope coverage + duplicate id
   * guards, mirroring insertContract).
   */
  insertChangeOrder(
    scope: Scope,
    state: ChangeOrderState,
  ): Promise<Result<ChangeOrderState, DomainError>>;
  /**
   * Save the next state of an existing change order (a lifecycle
   * transition), guarded by the caller's expected version.
   */
  saveChangeOrder(
    scope: Scope,
    state: ChangeOrderState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<ChangeOrderState, DomainError>>;
  /**
   * Stage the insert of one immutable claim reference. Duplicate canonical
   * id → typed invariant-violation; a duplicate natural key (the same claim
   * pinned to the same change order + document revision) → typed
   * invariant-violation (`claim-reference-already-exists`) — the
   * immutability guard. There is intentionally NO update/delete/repoint.
   */
  insertClaimReference(
    scope: Scope,
    reference: ClaimReferenceState,
  ): Promise<Result<true, DomainError>>;
}

/** THE transactional seam of the contracts/change domain (see module docs). */
export interface ContractsStore {
  runInTransaction<T>(
    work: (tx: ContractsStoreTransaction) => Promise<T>,
  ): Promise<T>;

  /** Load a contract within the scope (typed not-found otherwise). */
  loadContract(scope: Scope, contractId: EntityId): Promise<Result<ContractState, DomainError>>;
  /**
   * List every change event raised against the contract visible to the
   * scope, in insertion order (the contract's change history).
   */
  listChangeEventsOfContract(
    scope: Scope,
    contractId: EntityId,
  ): Promise<Result<readonly ChangeEventState[], DomainError>>;
  /**
   * List every change order of the contract visible to the scope, in
   * insertion order (the contract's commercial change history).
   */
  listChangeOrdersOfContract(
    scope: Scope,
    contractId: EntityId,
  ): Promise<Result<readonly ChangeOrderState[], DomainError>>;
  /** Load a change event within the scope (typed not-found otherwise). */
  loadChangeEvent(
    scope: Scope,
    changeEventId: EntityId,
  ): Promise<Result<ChangeEventState, DomainError>>;
  /** Load a change order within the scope (typed not-found otherwise). */
  loadChangeOrder(
    scope: Scope,
    changeOrderId: EntityId,
  ): Promise<Result<ChangeOrderState, DomainError>>;
  /**
   * Load the claim reference pinning (claim entity, change order, document,
   * revision) within the scope; typed not-found when no such pin exists.
   */
  findClaimReferenceByTarget(
    scope: Scope,
    claim: { readonly entityKind: EntityKind; readonly entityId: EntityId },
    changeOrderId: EntityId,
    documentId: EntityId,
    revisionId: EntityId,
  ): Promise<Result<ClaimReferenceState, DomainError>>;
  /**
   * List every claim reference of the evidenced claim visible to the scope,
   * in creation order (the claim's entitlement evidence trail, A4).
   */
  listClaimReferencesOfClaim(
    scope: Scope,
    claim: { readonly entityKind: EntityKind; readonly entityId: EntityId },
  ): Promise<Result<readonly ClaimReferenceState[], DomainError>>;
}

/** Internal control signal: rollback requested with a value to return. */
class RollbackSignal {
  readonly kind = 'rollback-signal' as const;
  constructor(readonly value: unknown) {}
}

/** The in-memory ContractsStore, with committed-state introspection for tests. */
export interface InMemoryContractsStore extends ContractsStore {
  /** Committed contracts in insertion order (test introspection; rollback discards). */
  readonly contracts: readonly ContractState[];
  /** Committed change events in insertion order (test introspection). */
  readonly changeEvents: readonly ChangeEventState[];
  /** Committed change orders in insertion order (test introspection). */
  readonly changeOrders: readonly ChangeOrderState[];
  /** Committed claim references in insertion order (test introspection). */
  readonly claimReferences: readonly ClaimReferenceState[];
  /** Number of runInTransaction calls executed (test introspection). */
  readonly transactionCount: number;
}

/** Natural key of a claim reference: (claim entity, change order, document, revision). */
const claimTargetKey = (
  claim: { readonly entityKind: EntityKind; readonly entityId: EntityId },
  changeOrderId: EntityId,
  documentId: EntityId,
  revisionId: EntityId,
): string =>
  `${claim.entityKind}|${claim.entityId}|${changeOrderId}|${documentId}|${revisionId}`;

/**
 * Create a deterministic in-memory ContractsStore. Single-process and
 * single-threaded by design: the pending-write staging proves the
 * commit-or-discard atomicity semantics, and the scope guards prove the A12
 * invisibility semantics, without any database.
 */
export function createInMemoryContractsStore(): InMemoryContractsStore {
  const committedContracts = new Map<string, ContractState>();
  const committedChangeEvents = new Map<string, ChangeEventState>();
  const committedChangeOrders = new Map<string, ChangeOrderState>();
  const committedClaimReferences = new Map<string, ClaimReferenceState>();
  const claimTargets = new Map<string, EntityId>();
  let transactionCount = 0;

  const contextOf = (scope: Scope): DomainErrorContext => ({ scope, correlationId: null });

  /** Can `scope` see the aggregate `state`? (A12 visibility — pure.) */
  const visibleUnder = (scope: Scope, state: { readonly scope: Scope }): boolean => {
    if (scope.tenantId !== state.scope.tenantId) return false;
    if (scope.kind === 'project') {
      return state.scope.kind === 'project' && scope.projectId === state.scope.projectId;
    }
    return true;
  };

  /** Second-boundary guards (mirror the identity modules' repository guards). */
  const checkInsertScope = (
    scope: Scope,
    state: { readonly entityId: EntityId; readonly scope: Scope },
  ): Result<true, DomainError> => {
    if (scope.tenantId !== state.scope.tenantId) {
      return fail(
        tenantScopeViolation(
          {
            commandTenantId: scope.tenantId,
            aggregateTenantId: state.scope.tenantId,
          },
          contextOf(scope),
        ),
      );
    }
    if (
      scope.kind === 'project' &&
      (state.scope.kind !== 'project' || scope.projectId !== state.scope.projectId)
    ) {
      return fail(
        projectScopeViolation(
          {
            commandProjectId: scope.projectId,
            aggregateProjectId:
              state.scope.kind === 'project' ? state.scope.projectId : scope.projectId,
          },
          contextOf(scope),
        ),
      );
    }
    if (state.scope.kind !== 'project') {
      return fail(
        invariantViolation(
          {
            name: 'contracts-aggregates-are-project-scoped',
            statement: `the created aggregate ${state.entityId} must carry project scope`,
          },
          contextOf(scope),
        ),
      );
    }
    return ok(true);
  };

  /** The not-found failure naming the sought id — never an existence oracle. */
  const notFound = (
    entityKind: EntityKind,
    entityId: EntityId,
    scope: Scope,
  ): DomainError =>
    entityNotFound({ entityKind, entityId }, contextOf(scope));

  /** The duplicate-canonical-id failure of an insert. */
  const duplicateId = (name: string, statement: string, scope: Scope): DomainError =>
    invariantViolation({ name, statement }, contextOf(scope));

  /** The optimistic-concurrency guard of one save (kernel checkConcurrency). */
  const concurrencyCheck = (
    entityKind: EntityKind,
    entityId: EntityId,
    expectedVersion: AggregateVersion,
    existing: Aggregate,
    scope: Scope,
  ): Result<true, DomainError> => {
    const expected: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind,
      entityId,
      version: expectedVersion,
    };
    return checkConcurrency(expected, concurrencyTokenOf(existing), contextOf(scope));
  };

  const createTransaction = (
    pendingContracts: Map<string, ContractState>,
    pendingChangeEvents: Map<string, ChangeEventState>,
    pendingChangeOrders: Map<string, ChangeOrderState>,
    pendingClaimReferences: Map<string, ClaimReferenceState>,
    pendingClaimTargets: Map<string, EntityId>,
  ): ContractsStoreTransaction => {
    const currentContract = (id: EntityId): ContractState | undefined =>
      pendingContracts.get(id) ?? committedContracts.get(id);
    const currentChangeEvent = (id: EntityId): ChangeEventState | undefined =>
      pendingChangeEvents.get(id) ?? committedChangeEvents.get(id);
    const currentChangeOrder = (id: EntityId): ChangeOrderState | undefined =>
      pendingChangeOrders.get(id) ?? committedChangeOrders.get(id);

    const loadContract = async (
      scope: Scope,
      contractId: EntityId,
    ): Promise<Result<ContractState, DomainError>> => {
      const state = currentContract(contractId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CONTRACT_KIND, contractId, scope));
      }
      return ok(state);
    };

    const insertContract = async (
      scope: Scope,
      state: ContractState,
    ): Promise<Result<ContractState, DomainError>> => {
      const coverage = checkInsertScope(scope, state);
      if (!coverage.ok) return coverage;
      if (currentContract(state.entityId) !== undefined) {
        return fail(
          duplicateId(
            'contract-id-not-reused',
            `contract id ${state.entityId} already exists`,
            scope,
          ),
        );
      }
      pendingContracts.set(state.entityId, state);
      return ok(state);
    };

    const saveContract = async (
      scope: Scope,
      state: ContractState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<ContractState, DomainError>> => {
      const existing = currentContract(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(notFound(CONTRACT_KIND, state.entityId, scope));
      }
      const concurrency = concurrencyCheck(
        CONTRACT_KIND,
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingContracts.set(state.entityId, state);
      return ok(state);
    };

    const loadChangeEvent = async (
      scope: Scope,
      changeEventId: EntityId,
    ): Promise<Result<ChangeEventState, DomainError>> => {
      const state = currentChangeEvent(changeEventId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CHANGE_EVENT_KIND, changeEventId, scope));
      }
      return ok(state);
    };

    const insertChangeEvent = async (
      scope: Scope,
      state: ChangeEventState,
    ): Promise<Result<ChangeEventState, DomainError>> => {
      const coverage = checkInsertScope(scope, state);
      if (!coverage.ok) return coverage;
      if (currentChangeEvent(state.entityId) !== undefined) {
        return fail(
          duplicateId(
            'change-event-id-not-reused',
            `change event id ${state.entityId} already exists`,
            scope,
          ),
        );
      }
      pendingChangeEvents.set(state.entityId, state);
      return ok(state);
    };

    const saveChangeEvent = async (
      scope: Scope,
      state: ChangeEventState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<ChangeEventState, DomainError>> => {
      const existing = currentChangeEvent(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(notFound(CHANGE_EVENT_KIND, state.entityId, scope));
      }
      const concurrency = concurrencyCheck(
        CHANGE_EVENT_KIND,
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingChangeEvents.set(state.entityId, state);
      return ok(state);
    };

    const loadChangeOrder = async (
      scope: Scope,
      changeOrderId: EntityId,
    ): Promise<Result<ChangeOrderState, DomainError>> => {
      const state = currentChangeOrder(changeOrderId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CHANGE_ORDER_KIND, changeOrderId, scope));
      }
      return ok(state);
    };

    const insertChangeOrder = async (
      scope: Scope,
      state: ChangeOrderState,
    ): Promise<Result<ChangeOrderState, DomainError>> => {
      const coverage = checkInsertScope(scope, state);
      if (!coverage.ok) return coverage;
      if (currentChangeOrder(state.entityId) !== undefined) {
        return fail(
          duplicateId(
            'change-order-id-not-reused',
            `change order id ${state.entityId} already exists`,
            scope,
          ),
        );
      }
      pendingChangeOrders.set(state.entityId, state);
      return ok(state);
    };

    const saveChangeOrder = async (
      scope: Scope,
      state: ChangeOrderState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<ChangeOrderState, DomainError>> => {
      const existing = currentChangeOrder(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(notFound(CHANGE_ORDER_KIND, state.entityId, scope));
      }
      const concurrency = concurrencyCheck(
        CHANGE_ORDER_KIND,
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingChangeOrders.set(state.entityId, state);
      return ok(state);
    };

    const insertClaimReference = async (
      scope: Scope,
      reference: ClaimReferenceState,
    ): Promise<Result<true, DomainError>> => {
      const coverage = checkInsertScope(scope, reference);
      if (!coverage.ok) return coverage;
      if (
        pendingClaimReferences.has(reference.entityId) ||
        committedClaimReferences.has(reference.entityId)
      ) {
        return fail(
          duplicateId(
            'claim-reference-id-not-reused',
            `claim reference id ${reference.entityId} already exists`,
            scope,
          ),
        );
      }
      const targetKey = claimTargetKey(
        { entityKind: reference.claimEntityKind, entityId: reference.claimEntityId },
        reference.changeOrderId,
        reference.documentId,
        reference.revisionId,
      );
      const existingId =
        pendingClaimTargets.get(targetKey) ?? claimTargets.get(targetKey);
      if (existingId !== undefined) {
        return fail(
          invariantViolation(
            {
              name: 'claim-reference-already-exists',
              statement: `claim ${reference.claimEntityKind} ${reference.claimEntityId} is already pinned to revision ${reference.revisionId} of document ${reference.documentId} against change order ${reference.changeOrderId} by claim reference ${existingId}: claim references are immutable and never re-pinned`,
            },
            contextOf(scope),
          ),
        );
      }
      pendingClaimReferences.set(reference.entityId, reference);
      pendingClaimTargets.set(targetKey, reference.entityId);
      return ok(true);
    };

    return {
      // In-memory transactions execute NO SQL. The field exists only so the
      // transaction satisfies the SqlExecutor contract the mirrored
      // EventSink port binds to; a sink that actually tries to execute SQL
      // against this store has been mis-wired — fail loudly, never silently.
      query: (_text: string, _values?: readonly SqlValue[]): Promise<SqlResult> => {
        throw new TypeError(
          'the in-memory contracts store executes no SQL: wire a transactional EventSink (ledger adapter) to a real persistence transaction',
        );
      },
      rollback: <T>(value: T): never => {
        throw new RollbackSignal(value);
      },
      loadContract,
      insertContract,
      saveContract,
      loadChangeEvent,
      insertChangeEvent,
      saveChangeEvent,
      loadChangeOrder,
      insertChangeOrder,
      saveChangeOrder,
      insertClaimReference,
    };
  };

  const store: InMemoryContractsStore = {
    get contracts(): readonly ContractState[] {
      return [...committedContracts.values()];
    },
    get changeEvents(): readonly ChangeEventState[] {
      return [...committedChangeEvents.values()];
    },
    get changeOrders(): readonly ChangeOrderState[] {
      return [...committedChangeOrders.values()];
    },
    get claimReferences(): readonly ClaimReferenceState[] {
      return [...committedClaimReferences.values()];
    },
    get transactionCount(): number {
      return transactionCount;
    },
    runInTransaction: async <T>(
      work: (tx: ContractsStoreTransaction) => Promise<T>,
    ): Promise<T> => {
      transactionCount += 1;
      const pendingContracts = new Map<string, ContractState>();
      const pendingChangeEvents = new Map<string, ChangeEventState>();
      const pendingChangeOrders = new Map<string, ChangeOrderState>();
      const pendingClaimReferences = new Map<string, ClaimReferenceState>();
      const pendingClaimTargets = new Map<string, EntityId>();
      const tx = createTransaction(
        pendingContracts,
        pendingChangeEvents,
        pendingChangeOrders,
        pendingClaimReferences,
        pendingClaimTargets,
      );
      let value: T;
      try {
        value = await work(tx);
      } catch (error) {
        if (error instanceof RollbackSignal) {
          // Cooperative rollback: discard the writes, return the caller's value.
          return error.value as T;
        }
        // Unexpected failure: discard the writes, rethrow the ORIGINAL error —
        // the runner never masks what actually went wrong.
        throw error;
      }
      for (const [id, state] of pendingContracts) {
        committedContracts.set(id, state);
      }
      for (const [id, state] of pendingChangeEvents) {
        committedChangeEvents.set(id, state);
      }
      for (const [id, state] of pendingChangeOrders) {
        committedChangeOrders.set(id, state);
      }
      for (const [id, reference] of pendingClaimReferences) {
        committedClaimReferences.set(id, reference);
      }
      for (const [targetKey, referenceId] of pendingClaimTargets) {
        claimTargets.set(targetKey, referenceId);
      }
      return value;
    },
    loadContract: async (scope, contractId) => {
      const state = committedContracts.get(contractId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CONTRACT_KIND, contractId, scope));
      }
      return ok(state);
    },
    listChangeEventsOfContract: async (scope, contractId) => {
      const contract = committedContracts.get(contractId);
      if (contract === undefined || !visibleUnder(scope, contract)) {
        return fail(notFound(CONTRACT_KIND, contractId, scope));
      }
      return ok(
        [...committedChangeEvents.values()].filter(
          (changeEvent) => changeEvent.contractId === contractId,
        ),
      );
    },
    listChangeOrdersOfContract: async (scope, contractId) => {
      const contract = committedContracts.get(contractId);
      if (contract === undefined || !visibleUnder(scope, contract)) {
        return fail(notFound(CONTRACT_KIND, contractId, scope));
      }
      return ok(
        [...committedChangeOrders.values()].filter(
          (changeOrder) => changeOrder.contractId === contractId,
        ),
      );
    },
    loadChangeEvent: async (scope, changeEventId) => {
      const state = committedChangeEvents.get(changeEventId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CHANGE_EVENT_KIND, changeEventId, scope));
      }
      return ok(state);
    },
    loadChangeOrder: async (scope, changeOrderId) => {
      const state = committedChangeOrders.get(changeOrderId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(notFound(CHANGE_ORDER_KIND, changeOrderId, scope));
      }
      return ok(state);
    },
    findClaimReferenceByTarget: async (scope, claim, changeOrderId, documentId, revisionId) => {
      const referenceId = claimTargets.get(
        claimTargetKey(claim, changeOrderId, documentId, revisionId),
      );
      const reference =
        referenceId === undefined ? undefined : committedClaimReferences.get(referenceId);
      if (reference === undefined || !visibleUnder(scope, reference)) {
        // A12 + the documents evidence-reference convention: report the
        // EVIDENCED entity's own canonical id — there is no canonical id for
        // a pin that does not exist, and a foreign tenant's pin stays
        // invisible (no existence oracle).
        return fail(
          entityNotFound(
            { entityKind: claim.entityKind, entityId: claim.entityId },
            contextOf(scope),
          ),
        );
      }
      return ok(reference);
    },
    listClaimReferencesOfClaim: async (scope, claim) =>
      ok(
        [...committedClaimReferences.values()].filter(
          (reference) =>
            reference.claimEntityKind === claim.entityKind &&
            reference.claimEntityId === claim.entityId &&
            visibleUnder(scope, reference),
        ),
      ),
  };
  return store;
}
