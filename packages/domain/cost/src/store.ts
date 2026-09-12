// Office cost domain — the transactional store port + in-memory store (OFF-011).
//
// This package is PURE DOMAIN: no SQL, no migrations, no repository layer.
// The CostStore port below is the domain's OWN transactional seam — the
// pure-domain counterpart of the identity modules' repository +
// TransactionRunner pair, in ONE minimal port spanning the package's three
// aggregate families (budgets, commitments, invoices):
//
//   * runInTransaction mirrors @office/persistence's TransactionRunner
//     semantics exactly (work resolves → commit; work throws → rollback and
//     the ORIGINAL error is rethrown; tx.rollback(value) → rollback and
//     `value` becomes the call's value), so handler code keeps the exact
//     shape of the landed identity modules: `return tx.rollback(failure)`.
//   * The transaction extends SqlExecutor (the persistence package's minimal
//     typed surface) so the EventSink port — mirrored byte-for-byte from the
//     identity modules — binds unchanged: a production wiring implements
//     this store over PostgreSQL and passes its REAL transaction; the
//     ledger-backed EventSink adapter (ledger-sink.ts) then appends the
//     event-ledger and outbox rows in the SAME transaction. The in-memory
//     implementation's `query` fails loudly instead: in-memory transactions
//     execute no SQL, and a sink that tries to has been mis-wired.
//   * Every read/write is SCOPE-GUARDED (freeze A12): an aggregate invisible
//     under the caller's scope (foreign tenant, or foreign project under a
//     project-scoped command) loads as a typed not-found — no existence
//     oracle. Cross-scope writes are equally invisible.
//
// The in-memory store shipped here keeps the whole package deterministic and
// in-memory-testable: pending writes stage inside the transaction, commit
// publishes them atomically, and rollback discards them entirely — proving
// the state-write + event-append atomicity contract without any database.
// One budget per project, and commitment/invoice numbers unique per project,
// are enforced exactly like the schedule's single program-of-work root.
import type { EntityId, ProjectScope, Scope } from '@office/contracts';
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
  AggregateVersion,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  Result,
} from '@office/domain-kernel';
import type { SqlExecutor, SqlResult, SqlValue } from '@office/persistence';
import type { BudgetState, CommitmentState, InvoiceState } from './state';
import { BUDGET_KIND, COMMITMENT_KIND, INVOICE_KIND } from './state';

/**
 * One open cost-store transaction: a SqlExecutor (so EventSink
 * implementations bind unchanged) plus the cooperative rollback escape and
 * the scoped reads/writes of the three aggregate families.
 */
export interface CostStoreTransaction extends SqlExecutor {
  /**
   * Roll the transaction back (discarding every write of the attempt) and
   * make `value` the result of the surrounding runInTransaction call.
   * Never returns; throws an internal control signal caught by the runner.
   */
  readonly rollback: <T>(value: T) => never;
  /**
   * Load a budget by canonical id, visible under `scope` ONLY (A12: a
   * foreign tenant's or foreign project's budget is a typed not-found —
   * invisible, never an existence oracle).
   */
  loadBudget(
    scope: Scope,
    budgetId: EntityId,
  ): Promise<Result<BudgetState, DomainError>>;
  /**
   * Insert a newly created budget root. Rejects a second budget for the same
   * project (typed invariant-violation) and a create whose state is not
   * covered by the command scope (typed unauthorized, second-boundary guard).
   */
  insertBudget(
    scope: Scope,
    state: BudgetState,
  ): Promise<Result<BudgetState, DomainError>>;
  /**
   * Save the next state of an existing budget, guarded by the caller's
   * expected version (stale → typed concurrency-conflict; the recorded
   * commercial state is never partially or silently overwritten).
   */
  saveBudget(
    scope: Scope,
    state: BudgetState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<BudgetState, DomainError>>;
  /**
   * Load a commitment by canonical id, visible under `scope` ONLY (A12 —
   * same invisibility rule as budgets).
   */
  loadCommitment(
    scope: Scope,
    commitmentId: EntityId,
  ): Promise<Result<CommitmentState, DomainError>>;
  /**
   * Insert a newly created commitment. Rejects a duplicate commitment number
   * within the same project (typed invariant-violation) and a create whose
   * state is not covered by the command scope (typed unauthorized).
   */
  insertCommitment(
    scope: Scope,
    state: CommitmentState,
  ): Promise<Result<CommitmentState, DomainError>>;
  /**
   * Save the next state of an existing commitment, guarded by the caller's
   * expected version (stale → typed concurrency-conflict).
   */
  saveCommitment(
    scope: Scope,
    state: CommitmentState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<CommitmentState, DomainError>>;
  /**
   * Load an invoice by canonical id, visible under `scope` ONLY (A12 — same
   * invisibility rule as budgets).
   */
  loadInvoice(
    scope: Scope,
    invoiceId: EntityId,
  ): Promise<Result<InvoiceState, DomainError>>;
  /**
   * Insert a newly recorded invoice. Rejects a duplicate invoice number
   * within the same project (typed invariant-violation) and a create whose
   * state is not covered by the command scope (typed unauthorized).
   */
  insertInvoice(
    scope: Scope,
    state: InvoiceState,
  ): Promise<Result<InvoiceState, DomainError>>;
  /**
   * Save the next state of an existing invoice, guarded by the caller's
   * expected version (stale → typed concurrency-conflict).
   */
  saveInvoice(
    scope: Scope,
    state: InvoiceState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<InvoiceState, DomainError>>;
}

/** THE transactional seam of the cost domain (see module docs). */
export interface CostStore {
  runInTransaction<T>(work: (tx: CostStoreTransaction) => Promise<T>): Promise<T>;
}

/** Internal control signal: rollback requested with a value to return. */
class RollbackSignal {
  readonly kind = 'rollback-signal' as const;
  constructor(readonly value: unknown) {}
}

/** The in-memory CostStore, with committed-state introspection for tests/reads. */
export interface InMemoryCostStore extends CostStore {
  /** Committed budgets in insertion order (test introspection; rollback discards). */
  readonly budgets: readonly BudgetState[];
  /** Committed commitments in insertion order (test introspection; rollback discards). */
  readonly commitments: readonly CommitmentState[];
  /** Committed invoices in insertion order (test introspection; rollback discards). */
  readonly invoices: readonly InvoiceState[];
  /** Number of runInTransaction calls executed (test introspection). */
  readonly transactionCount: number;
}

/**
 * Create a deterministic in-memory CostStore. Single-process and
 * single-threaded by design: the pending-write staging proves the
 * commit-or-discard atomicity semantics, and the scope guards prove the A12
 * invisibility semantics, without any database.
 */
export function createInMemoryCostStore(): InMemoryCostStore {
  const budgets = new Map<string, BudgetState>();
  const commitments = new Map<string, CommitmentState>();
  const invoices = new Map<string, InvoiceState>();
  const budgetRoots = new Map<string, EntityId>();
  const commitmentNumbers = new Map<string, EntityId>();
  const invoiceNumbers = new Map<string, EntityId>();
  let transactionCount = 0;

  const keyOf = (tenantId: string, projectId: string): string =>
    `${tenantId}|${projectId}`;
  const numberKeyOf = (tenantId: string, projectId: string, number: string): string =>
    `${tenantId}|${projectId}|${number}`;

  /** Can `scope` see a project-scoped aggregate? (A12 visibility — pure.) */
  const visibleUnder = (
    scope: Scope,
    state: BudgetState | CommitmentState | InvoiceState,
  ): boolean => {
    if (scope.tenantId !== state.scope.tenantId) return false;
    if (scope.kind === 'project') {
      return state.scope.kind === 'project' && scope.projectId === state.scope.projectId;
    }
    return true;
  };

  const contextOf = (scope: Scope): DomainErrorContext => ({ scope, correlationId: null });

  /**
   * Second-boundary guards (mirror the identity modules' repository guards):
   * the command scope must cover the new aggregate's owning scope — same
   * tenant, and the same project when the command is project-scoped. Success
   * returns the PROVEN project scope (narrowed, so the uniqueness keys below
   * type-check against the guarantee the guard just established).
   */
  const coverCreateScope = (
    scope: Scope,
    state: BudgetState | CommitmentState | InvoiceState,
  ): Result<ProjectScope, DomainError> => {
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
            name: 'cost-aggregates-are-project-scoped',
            statement: `the created aggregate ${state.entityId} must carry project scope`,
          },
          contextOf(scope),
        ),
      );
    }
    return ok(state.scope);
  };

  /** Guard an insert id: never reused inside this store. */
  const requireFreshId = (
    family: Map<string, unknown>,
    entityId: EntityId,
    scope: Scope,
    entityKind: string,
  ): Result<true, DomainError> => {
    if (family.has(entityId)) {
      return fail(
        invariantViolation(
          {
            name: 'cost-id-not-reused',
            statement: `${entityKind} id ${entityId} already exists`,
          },
          contextOf(scope),
        ),
      );
    }
    return ok(true);
  };

  const createTransaction = (
    pendingBudgets: Map<string, BudgetState>,
    pendingCommitments: Map<string, CommitmentState>,
    pendingInvoices: Map<string, InvoiceState>,
    pendingBudgetRoots: Map<string, EntityId>,
    pendingCommitmentNumbers: Map<string, EntityId>,
    pendingInvoiceNumbers: Map<string, EntityId>,
  ): CostStoreTransaction => {
    const currentBudget = (id: EntityId): BudgetState | undefined =>
      pendingBudgets.get(id) ?? budgets.get(id);
    const currentCommitment = (id: EntityId): CommitmentState | undefined =>
      pendingCommitments.get(id) ?? commitments.get(id);
    const currentInvoice = (id: EntityId): InvoiceState | undefined =>
      pendingInvoices.get(id) ?? invoices.get(id);
    const budgetRootOf = (tenantId: string, projectId: string): EntityId | undefined =>
      pendingBudgetRoots.get(keyOf(tenantId, projectId)) ??
      budgetRoots.get(keyOf(tenantId, projectId));
    const commitmentNumberOf = (
      tenantId: string,
      projectId: string,
      number: string,
    ): EntityId | undefined =>
      pendingCommitmentNumbers.get(numberKeyOf(tenantId, projectId, number)) ??
      commitmentNumbers.get(numberKeyOf(tenantId, projectId, number));
    const invoiceNumberOf = (
      tenantId: string,
      projectId: string,
      number: string,
    ): EntityId | undefined =>
      pendingInvoiceNumbers.get(numberKeyOf(tenantId, projectId, number)) ??
      invoiceNumbers.get(numberKeyOf(tenantId, projectId, number));

    const concurrencyChecked = (
      entityKind: string,
      entityId: EntityId,
      expectedVersion: AggregateVersion,
      actual: BudgetState | CommitmentState | InvoiceState,
      scope: Scope,
    ): Result<true, DomainError> => {
      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: actual.entityKind,
        entityId,
        version: expectedVersion,
      };
      return checkConcurrency(
        expected,
        concurrencyTokenOf(actual),
        contextOf(scope),
      ) as Result<true, DomainError>;
    };

    const loadBudget = async (
      scope: Scope,
      budgetId: EntityId,
    ): Promise<Result<BudgetState, DomainError>> => {
      const state = currentBudget(budgetId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(
          entityNotFound({ entityKind: BUDGET_KIND, entityId: budgetId }, contextOf(scope)),
        );
      }
      return ok(state);
    };

    const insertBudget = async (
      scope: Scope,
      state: BudgetState,
    ): Promise<Result<BudgetState, DomainError>> => {
      const coverage = coverCreateScope(scope, state);
      if (!coverage.ok) return coverage;
      const aggregateScope = coverage.value;
      const existingRoot = budgetRootOf(aggregateScope.tenantId, aggregateScope.projectId);
      if (existingRoot !== undefined) {
        return fail(
          invariantViolation(
            {
              name: 'budget-project-has-one-budget',
              statement: `project ${aggregateScope.projectId} already has budget ${existingRoot}; a project owns exactly one canonical budget`,
            },
            contextOf(scope),
          ),
        );
      }
      const fresh = requireFreshId(budgets, state.entityId, scope, 'budget');
      if (!fresh.ok) return fresh;
      if (pendingBudgets.has(state.entityId)) {
        return fail(
          invariantViolation(
            {
              name: 'cost-id-not-reused',
              statement: `budget id ${state.entityId} already exists`,
            },
            contextOf(scope),
          ),
        );
      }
      pendingBudgets.set(state.entityId, state);
      pendingBudgetRoots.set(
        keyOf(aggregateScope.tenantId, aggregateScope.projectId),
        state.entityId,
      );
      return ok(state);
    };

    const saveBudget = async (
      scope: Scope,
      state: BudgetState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<BudgetState, DomainError>> => {
      const existing = currentBudget(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(
          entityNotFound({ entityKind: BUDGET_KIND, entityId: state.entityId }, contextOf(scope)),
        );
      }
      const concurrency = concurrencyChecked(
        'budget',
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingBudgets.set(state.entityId, state);
      return ok(state);
    };

    const loadCommitment = async (
      scope: Scope,
      commitmentId: EntityId,
    ): Promise<Result<CommitmentState, DomainError>> => {
      const state = currentCommitment(commitmentId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(
          entityNotFound(
            { entityKind: COMMITMENT_KIND, entityId: commitmentId },
            contextOf(scope),
          ),
        );
      }
      return ok(state);
    };

    const insertCommitment = async (
      scope: Scope,
      state: CommitmentState,
    ): Promise<Result<CommitmentState, DomainError>> => {
      const coverage = coverCreateScope(scope, state);
      if (!coverage.ok) return coverage;
      const aggregateScope = coverage.value;
      const existingNumber = commitmentNumberOf(
        aggregateScope.tenantId,
        aggregateScope.projectId,
        state.number,
      );
      if (existingNumber !== undefined) {
        return fail(
          invariantViolation(
            {
              name: 'commitment-numbers-unique-per-project',
              statement: `commitment number '${state.number}' is already used by commitment ${existingNumber} of project ${aggregateScope.projectId}`,
            },
            contextOf(scope),
          ),
        );
      }
      const fresh = requireFreshId(commitments, state.entityId, scope, 'commitment');
      if (!fresh.ok) return fresh;
      if (pendingCommitments.has(state.entityId)) {
        return fail(
          invariantViolation(
            {
              name: 'cost-id-not-reused',
              statement: `commitment id ${state.entityId} already exists`,
            },
            contextOf(scope),
          ),
        );
      }
      pendingCommitments.set(state.entityId, state);
      pendingCommitmentNumbers.set(
        numberKeyOf(aggregateScope.tenantId, aggregateScope.projectId, state.number),
        state.entityId,
      );
      return ok(state);
    };

    const saveCommitment = async (
      scope: Scope,
      state: CommitmentState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<CommitmentState, DomainError>> => {
      const existing = currentCommitment(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(
          entityNotFound(
            { entityKind: COMMITMENT_KIND, entityId: state.entityId },
            contextOf(scope),
          ),
        );
      }
      const concurrency = concurrencyChecked(
        'commitment',
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingCommitments.set(state.entityId, state);
      return ok(state);
    };

    const loadInvoice = async (
      scope: Scope,
      invoiceId: EntityId,
    ): Promise<Result<InvoiceState, DomainError>> => {
      const state = currentInvoice(invoiceId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(
          entityNotFound({ entityKind: INVOICE_KIND, entityId: invoiceId }, contextOf(scope)),
        );
      }
      return ok(state);
    };

    const insertInvoice = async (
      scope: Scope,
      state: InvoiceState,
    ): Promise<Result<InvoiceState, DomainError>> => {
      const coverage = coverCreateScope(scope, state);
      if (!coverage.ok) return coverage;
      const aggregateScope = coverage.value;
      const existingNumber = invoiceNumberOf(
        aggregateScope.tenantId,
        aggregateScope.projectId,
        state.number,
      );
      if (existingNumber !== undefined) {
        return fail(
          invariantViolation(
            {
              name: 'invoice-numbers-unique-per-project',
              statement: `invoice number '${state.number}' is already used by invoice ${existingNumber} of project ${aggregateScope.projectId}`,
            },
            contextOf(scope),
          ),
        );
      }
      const fresh = requireFreshId(invoices, state.entityId, scope, 'invoice');
      if (!fresh.ok) return fresh;
      if (pendingInvoices.has(state.entityId)) {
        return fail(
          invariantViolation(
            {
              name: 'cost-id-not-reused',
              statement: `invoice id ${state.entityId} already exists`,
            },
            contextOf(scope),
          ),
        );
      }
      pendingInvoices.set(state.entityId, state);
      pendingInvoiceNumbers.set(
        numberKeyOf(aggregateScope.tenantId, aggregateScope.projectId, state.number),
        state.entityId,
      );
      return ok(state);
    };

    const saveInvoice = async (
      scope: Scope,
      state: InvoiceState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<InvoiceState, DomainError>> => {
      const existing = currentInvoice(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(
          entityNotFound({ entityKind: INVOICE_KIND, entityId: state.entityId }, contextOf(scope)),
        );
      }
      const concurrency = concurrencyChecked(
        'invoice',
        state.entityId,
        expectedVersion,
        existing,
        scope,
      );
      if (!concurrency.ok) return concurrency;
      pendingInvoices.set(state.entityId, state);
      return ok(state);
    };

    return {
      // In-memory transactions execute NO SQL. The field exists only so the
      // transaction satisfies the SqlExecutor contract the mirrored
      // EventSink port binds to; a sink that actually tries to execute SQL
      // against this store has been mis-wired — fail loudly, never silently.
      query: (_text: string, _values?: readonly SqlValue[]): Promise<SqlResult> => {
        throw new TypeError(
          'the in-memory cost store executes no SQL: wire a transactional EventSink (ledger adapter) to a real persistence transaction',
        );
      },
      rollback: <T>(value: T): never => {
        throw new RollbackSignal(value);
      },
      loadBudget,
      insertBudget,
      saveBudget,
      loadCommitment,
      insertCommitment,
      saveCommitment,
      loadInvoice,
      insertInvoice,
      saveInvoice,
    };
  };

  const store: InMemoryCostStore = {
    get budgets(): readonly BudgetState[] {
      return [...budgets.values()];
    },
    get commitments(): readonly CommitmentState[] {
      return [...commitments.values()];
    },
    get invoices(): readonly InvoiceState[] {
      return [...invoices.values()];
    },
    get transactionCount(): number {
      return transactionCount;
    },
    runInTransaction: async <T>(
      work: (tx: CostStoreTransaction) => Promise<T>,
    ): Promise<T> => {
      transactionCount += 1;
      const pendingBudgets = new Map<string, BudgetState>();
      const pendingCommitments = new Map<string, CommitmentState>();
      const pendingInvoices = new Map<string, InvoiceState>();
      const pendingBudgetRoots = new Map<string, EntityId>();
      const pendingCommitmentNumbers = new Map<string, EntityId>();
      const pendingInvoiceNumbers = new Map<string, EntityId>();
      const tx = createTransaction(
        pendingBudgets,
        pendingCommitments,
        pendingInvoices,
        pendingBudgetRoots,
        pendingCommitmentNumbers,
        pendingInvoiceNumbers,
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
      for (const [budgetId, state] of pendingBudgets) {
        budgets.set(budgetId, state);
      }
      for (const [commitmentId, state] of pendingCommitments) {
        commitments.set(commitmentId, state);
      }
      for (const [invoiceId, state] of pendingInvoices) {
        invoices.set(invoiceId, state);
      }
      for (const [projectKey, budgetId] of pendingBudgetRoots) {
        budgetRoots.set(projectKey, budgetId);
      }
      for (const [numberKey, commitmentId] of pendingCommitmentNumbers) {
        commitmentNumbers.set(numberKey, commitmentId);
      }
      for (const [numberKey, invoiceId] of pendingInvoiceNumbers) {
        invoiceNumbers.set(numberKey, invoiceId);
      }
      return value;
    },
  };
  return store;
}
