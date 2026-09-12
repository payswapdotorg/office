// Office schedule domain — the transactional store port + in-memory store (OFF-010).
//
// This package is PURE DOMAIN: no SQL, no migrations, no repository layer.
// The ScheduleStore port below is the domain's OWN transactional seam — the
// pure-domain counterpart of the identity modules' repository +
// TransactionRunner pair, in ONE minimal port:
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
//   * Every read/write is SCOPE-GUARDED (freeze A12): a schedule invisible
//     under the caller's scope (foreign tenant, or foreign project under a
//     project-scoped command) loads as a typed not-found — no existence
//     oracle. Cross-scope writes are equally invisible.
//
// The in-memory store shipped here keeps the whole package deterministic and
// in-memory-testable: pending writes stage inside the transaction, commit
// publishes them atomically, and rollback discards them entirely — proving
// the state-write + event-append atomicity contract without any database.
import type { EntityId, Scope } from '@office/contracts';
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
import type { ScheduleState } from './state';
import { SCHEDULE_KIND } from './state';

/**
 * One open schedule-store transaction: a SqlExecutor (so EventSink
 * implementations bind unchanged) plus the cooperative rollback escape and
 * the scoped schedule reads/writes of the mutation path.
 */
export interface ScheduleStoreTransaction extends SqlExecutor {
  /**
   * Roll the transaction back (discarding every write of the attempt) and
   * make `value` the result of the surrounding runInTransaction call.
   * Never returns; throws an internal control signal caught by the runner.
   */
  readonly rollback: <T>(value: T) => never;
  /**
   * Load a schedule by canonical id, visible under `scope` ONLY (A12: a
   * foreign tenant's or foreign project's schedule is a typed not-found —
   * invisible, never an existence oracle).
   */
  loadSchedule(
    scope: Scope,
    scheduleId: EntityId,
  ): Promise<Result<ScheduleState, DomainError>>;
  /**
   * Insert a newly created schedule root. Rejects a second schedule for the
   * same project (typed invariant-violation) and a create whose state is not
   * covered by the command scope (typed unauthorized, second-boundary
   * guard).
   */
  insertSchedule(
    scope: Scope,
    state: ScheduleState,
  ): Promise<Result<ScheduleState, DomainError>>;
  /**
   * Save the next state of an existing schedule, guarded by the caller's
   * expected version (stale → typed concurrency-conflict; the network is
   * never partially or silently overwritten).
   */
  saveSchedule(
    scope: Scope,
    state: ScheduleState,
    expectedVersion: AggregateVersion,
  ): Promise<Result<ScheduleState, DomainError>>;
}

/** THE transactional seam of the schedule domain (see module docs). */
export interface ScheduleStore {
  runInTransaction<T>(work: (tx: ScheduleStoreTransaction) => Promise<T>): Promise<T>;
}

/** Internal control signal: rollback requested with a value to return. */
class RollbackSignal {
  readonly kind = 'rollback-signal' as const;
  constructor(readonly value: unknown) {}
}

/** The in-memory ScheduleStore, with committed-state introspection for tests. */
export interface InMemoryScheduleStore extends ScheduleStore {
  /** Committed schedules in insertion order (test introspection; rollback discards). */
  readonly schedules: readonly ScheduleState[];
  /** Number of runInTransaction calls executed (test introspection). */
  readonly transactionCount: number;
}

/**
 * Create a deterministic in-memory ScheduleStore. Single-process and
 * single-threaded by design: the pending-write staging proves the
 * commit-or-discard atomicity semantics, and the scope guards prove the A12
 * invisibility semantics, without any database.
 */
export function createInMemoryScheduleStore(): InMemoryScheduleStore {
  const committed = new Map<string, ScheduleState>();
  const projectRoots = new Map<string, EntityId>();
  let transactionCount = 0;

  const keyOf = (tenantId: string, projectId: string): string => `${tenantId}|${projectId}`;

  /** Can `scope` see the schedule at all? (A12 visibility — pure.) */
  const visibleUnder = (scope: Scope, state: ScheduleState): boolean => {
    if (scope.tenantId !== state.scope.tenantId) return false;
    if (scope.kind === 'project') {
      return state.scope.kind === 'project' && scope.projectId === state.scope.projectId;
    }
    return true;
  };

  const contextOf = (scope: Scope): DomainErrorContext => ({ scope, correlationId: null });

  const createTransaction = (
    pending: Map<string, ScheduleState>,
    pendingRoots: Map<string, EntityId>,
  ): ScheduleStoreTransaction => {
    const current = (scheduleId: EntityId): ScheduleState | undefined =>
      pending.get(scheduleId) ?? committed.get(scheduleId);
    const rootOf = (tenantId: string, projectId: string): EntityId | undefined =>
      pendingRoots.get(keyOf(tenantId, projectId)) ?? projectRoots.get(keyOf(tenantId, projectId));

    const loadSchedule = async (
      scope: Scope,
      scheduleId: EntityId,
    ): Promise<Result<ScheduleState, DomainError>> => {
      const state = current(scheduleId);
      if (state === undefined || !visibleUnder(scope, state)) {
        return fail(
          entityNotFound(
            { entityKind: SCHEDULE_KIND, entityId: scheduleId },
            contextOf(scope),
          ),
        );
      }
      return ok(state);
    };

    const insertSchedule = async (
      scope: Scope,
      state: ScheduleState,
    ): Promise<Result<ScheduleState, DomainError>> => {
      // Second-boundary guards (mirror the identity modules' repository
      // guards): the command scope must cover the new aggregate's scope —
      // same tenant, and the same project when the command is project-scoped.
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
              aggregateProjectId: state.scope.kind === 'project' ? state.scope.projectId : scope.projectId,
            },
            contextOf(scope),
          ),
        );
      }
      if (state.scope.kind !== 'project') {
        return fail(
          invariantViolation(
            {
              name: 'schedule-is-project-scoped',
              statement: `the created schedule ${state.entityId} must carry project scope`,
            },
            contextOf(scope),
          ),
        );
      }
      const existingRoot = rootOf(state.scope.tenantId, state.scope.projectId);
      if (existingRoot !== undefined) {
        return fail(
          invariantViolation(
            {
              name: 'schedule-project-has-one-program-of-work',
              statement: `project ${state.scope.projectId} already has schedule ${existingRoot}; a project owns exactly one program of work`,
            },
            contextOf(scope),
          ),
        );
      }
      if (committed.has(state.entityId) || pending.has(state.entityId)) {
        return fail(
          invariantViolation(
            {
              name: 'schedule-id-not-reused',
              statement: `schedule id ${state.entityId} already exists`,
            },
            contextOf(scope),
          ),
        );
      }
      pending.set(state.entityId, state);
      pendingRoots.set(
        keyOf(state.scope.tenantId, state.scope.projectId),
        state.entityId,
      );
      return ok(state);
    };

    const saveSchedule = async (
      scope: Scope,
      state: ScheduleState,
      expectedVersion: AggregateVersion,
    ): Promise<Result<ScheduleState, DomainError>> => {
      const existing = current(state.entityId);
      if (existing === undefined || !visibleUnder(scope, existing)) {
        return fail(
          entityNotFound(
            { entityKind: SCHEDULE_KIND, entityId: state.entityId },
            contextOf(scope),
          ),
        );
      }
      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: SCHEDULE_KIND,
        entityId: state.entityId,
        version: expectedVersion,
      };
      const concurrency = checkConcurrency(
        expected,
        concurrencyTokenOf(existing),
        contextOf(scope),
      );
      if (!concurrency.ok) return concurrency;
      pending.set(state.entityId, state);
      return ok(state);
    };

    return {
      // In-memory transactions execute NO SQL. The field exists only so the
      // transaction satisfies the SqlExecutor contract the mirrored
      // EventSink port binds to; a sink that actually tries to execute SQL
      // against this store has been mis-wired — fail loudly, never silently.
      query: (_text: string, _values?: readonly SqlValue[]): Promise<SqlResult> => {
        throw new TypeError(
          'the in-memory schedule store executes no SQL: wire a transactional EventSink (ledger adapter) to a real persistence transaction',
        );
      },
      rollback: <T>(value: T): never => {
        throw new RollbackSignal(value);
      },
      loadSchedule,
      insertSchedule,
      saveSchedule,
    };
  };

  const store: InMemoryScheduleStore = {
    get schedules(): readonly ScheduleState[] {
      return [...committed.values()];
    },
    get transactionCount(): number {
      return transactionCount;
    },
    runInTransaction: async <T>(work: (tx: ScheduleStoreTransaction) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      const pending = new Map<string, ScheduleState>();
      const pendingRoots = new Map<string, EntityId>();
      const tx = createTransaction(pending, pendingRoots);
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
      for (const [scheduleId, state] of pending) {
        committed.set(scheduleId, state);
      }
      for (const [projectKey, scheduleId] of pendingRoots) {
        projectRoots.set(projectKey, scheduleId);
      }
      return value;
    },
  };
  return store;
}
