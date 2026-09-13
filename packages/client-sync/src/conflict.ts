// Office client-sync — protection policy, conflict surfacing, and the
// server-side sync records (OFF-029, freeze A9).
//
// THE PROTECTED-CONFLICT RULE (the named acceptance): a captured mutation
// whose base has diverged is surfaced as an EXPLICIT @office/sync
// ConflictRecord — both sides, deterministic side order — and its
// protection class decides what may happen next:
//
// - PROTECTED mutations (material commercial state — financial,
//   contractual, schedule-critical) are PARKED: the replay engine has NO
//   path that applies them (structurally — the drain's diverged-protected
//   branch never invokes the typed command path; see replay.ts). The ONLY
//   way forward is the typed EXPLICIT resolution command
//   (ConflictResolutionCommand below), which re-enters the queue
//   discipline and applies exactly once. The protocol NEVER auto-resolves
//   a protected conflict — no destructive automatic resolution, no
//   last-write-wins (frozen anti-patterns).
//
// - OPEN mutations (domain-declared non-commercial state) are superseded
//   DETERMINISTICALLY: the committed server-side operation stands (the
//   engine never reverts committed state), the supersession is recorded as
//   a RESOLVED conflict record (strategy named in the record's canonical
//   side vocabulary, audit evidence = the diverging ledger event), and the
//   offline entry lands in 'superseded'. Explicit and audited — never
//   silent.
//
// This module also owns the two server-side records the conflict model
// needs: the OperationJournal (every applied operation — online submission
// or replayed queue entry — linked to its ledger event, so a divergence can
// name its cause) and the ConflictLog (every surfaced conflict record,
// idempotent re-detection).
import type { Actor, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  parseConflictResolution,
  resolveConflict,
} from '@office/sync';
import type {
  ClientOperation,
  ConflictRecord,
  ConflictRecordId,
  ConflictResolutionStrategy,
  OperationId,
  SubscriptionId,
} from '@office/sync';
import type { OfflineMutation } from './queue';

// ---------------------------------------------------------------------------
// The server-side record of applied operations (the conflict model's cause
// chain: a diverging event's producing operation is always known).
// ---------------------------------------------------------------------------

/** One applied operation, linked to its appended ledger event. */
export interface AppliedOperation {
  /** The applied client operation (online submission or replayed queue entry). */
  readonly operation: ClientOperation;
  /** The ledger event the mutation appended (its effect). */
  readonly event: LedgerEvent;
}

/**
 * The journal of applied operations: operation id → effect, and ledger
 * event id → operation. This is what lets a divergence name its cause (the
 * conflict record's server side) — every mutation that moves a target
 * flows through the engine, so its operation is always recorded here.
 */
export interface OperationJournal {
  /**
   * Record one applied operation. Re-recording the SAME operation id with
   * the SAME event is an idempotent no-op; the same id with a DIFFERENT
   * event is a typed invariant-violation (an operation id never switches
   * effects).
   */
  record(applied: AppliedOperation): Result<true, DomainError>;
  /** The operation that produced a ledger event, or null. */
  operationOf(eventId: LedgerEventId): ClientOperation | null;
  /** The appended event of an operation, or null. */
  eventOf(operationId: OperationId): LedgerEvent | null;
  /** The ledger event ids a subscription's own operations produced (the
   * client's own causal chain — knowledge, not divergence). */
  ownEventIds(subscriptionId: SubscriptionId): ReadonlySet<string>;
  /** The number of recorded operations. */
  readonly size: number;
}

const journalReuseFailure = (
  operationId: OperationId,
  recorded: LedgerEventId,
  presented: LedgerEventId,
): DomainError =>
  domainError(
    'invariant-violation',
    `operation ${operationId} was already recorded with event ${recorded} — an operation id never switches effects`,
    [
      {
        code: 'operation-effect-reuse',
        message: `${recorded} recorded, ${presented} presented`,
        path: 'event',
      },
    ],
  );

/** Create an empty in-memory OperationJournal (deterministic, pure memory). */
export function createInMemoryOperationJournal(): OperationJournal {
  const byOperation = new Map<string, AppliedOperation>();
  const byEvent = new Map<string, AppliedOperation>();
  return {
    get size(): number {
      return byOperation.size;
    },
    record: (applied) => {
      const existing = byOperation.get(applied.operation.operationId);
      if (existing !== undefined) {
        if (existing.event.eventId !== applied.event.eventId) {
          return fail(
            journalReuseFailure(
              applied.operation.operationId,
              existing.event.eventId,
              applied.event.eventId,
            ),
          );
        }
        return ok(true);
      }
      byOperation.set(applied.operation.operationId, applied);
      byEvent.set(applied.event.eventId, applied);
      return ok(true);
    },
    operationOf: (eventId) => byEvent.get(eventId)?.operation ?? null,
    eventOf: (operationId) => byOperation.get(operationId)?.event ?? null,
    ownEventIds: (subscriptionId) => {
      const ids = new Set<string>();
      for (const applied of byOperation.values()) {
        if (applied.operation.subscriptionId === subscriptionId) {
          ids.add(applied.event.eventId);
        }
      }
      return ids;
    },
  };
}

// ---------------------------------------------------------------------------
// The conflict log (surfaced records, idempotent re-detection).
// ---------------------------------------------------------------------------

const conflictContext = (conflict: {
  readonly tenantId: ConflictRecord['tenantId'];
}): DomainErrorContext => ({ scope: { kind: 'tenant', tenantId: conflict.tenantId } });

/**
 * The log of surfaced conflict records: every divergence's explicit record.
 * Re-detecting the same divergence (e.g. after an interrupted drain) keeps
 * the FIRST record — conflict ids are deterministic, so re-detection is
 * idempotent by construction.
 */
export interface ConflictLog {
  /**
   * Surface (or re-detect) a conflict record: the first record of a
   * conflict id is kept verbatim; a re-detection returns the stored record.
   */
  surface(conflict: ConflictRecord): Result<ConflictRecord, DomainError>;
  /** Replace a stored record with its resolved form (the engine's explicit
   * resolution path; the record must exist and keep its identity). */
  resolve(resolved: ConflictRecord): Result<ConflictRecord, DomainError>;
  /** The stored record of a conflict id, or null. */
  conflictOf(conflictId: ConflictRecordId): ConflictRecord | null;
  /** Every stored record in insertion order. */
  readonly conflicts: readonly ConflictRecord[];
}

const conflictNotFoundFailure = (conflictId: ConflictRecordId): DomainError =>
  domainError(
    'not-found',
    `conflict record ${conflictId} not found`,
    [{ code: 'conflict-not-found', message: conflictId, path: 'conflictId' }],
  );

/** Create an empty in-memory ConflictLog (deterministic, pure memory). */
export function createInMemoryConflictLog(): ConflictLog {
  const records = new Map<string, ConflictRecord>();
  return {
    get conflicts(): readonly ConflictRecord[] {
      return [...records.values()];
    },
    surface: (conflict) => {
      const existing = records.get(conflict.conflictId);
      if (existing !== undefined) {
        // Idempotent re-detection: the first record stands (deterministic).
        return ok(existing);
      }
      records.set(conflict.conflictId, conflict);
      return ok(conflict);
    },
    resolve: (resolved) => {
      const existing = records.get(resolved.conflictId);
      if (existing === undefined) {
        return fail(conflictNotFoundFailure(resolved.conflictId));
      }
      if (existing.tenantId !== resolved.tenantId || existing.projectId !== resolved.projectId) {
        return fail(
          domainError(
            'invariant-violation',
            `resolved conflict ${resolved.conflictId} does not match the stored record's scope`,
            [
              {
                code: 'conflict-identity-mismatch',
                message: `${resolved.tenantId}/${resolved.projectId} vs ${existing.tenantId}/${existing.projectId}`,
                path: 'conflictId',
              },
            ],
            conflictContext(resolved),
          ),
        );
      }
      records.set(resolved.conflictId, resolved);
      return ok(resolved);
    },
    conflictOf: (conflictId) => records.get(conflictId) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The open-state deterministic supersession (never silent, never destructive).
// ---------------------------------------------------------------------------

/**
 * Deterministically auto-resolve an OPEN-state conflict (freeze A9: the
 * domain declared the state non-commercial): the COMMITTED server-side
 * operation stands — the engine never reverts committed ledger state — and
 * the supersession is recorded as a RESOLVED conflict record whose strategy
 * names the standing side in the record's canonical side order, with the
 * diverging ledger event as audit evidence. The resolution actor is the
 * system (the protocol's deterministic rule, not a human decision).
 */
export function autoResolveOpenConflict(input: {
  readonly conflict: ConflictRecord;
  /** The operation id of the committed (already-applied) server side. */
  readonly committedOperationId: OperationId;
  /** The diverging ledger event: the reconciliation's audit evidence (>= 1). */
  readonly auditEventRefs: readonly LedgerEventId[];
  readonly resolvedAt: Timestamp;
}): Result<ConflictRecord, DomainError> {
  const strategy: ConflictResolutionStrategy =
    input.conflict.first.operationId === input.committedOperationId
      ? 'first-operation-wins'
      : 'second-operation-wins';
  const resolution = parseConflictResolution({
    kind: 'conflict-resolution',
    strategy,
    resolvedBy: { kind: 'system' },
    resolvedAt: input.resolvedAt,
    auditEventRefs: input.auditEventRefs,
  });
  if (!resolution.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `the open-state supersession of conflict ${input.conflict.conflictId} is not structurally valid: ${resolution.error.code}`,
        [
          {
            code: 'auto-resolution-invalid',
            message: resolution.error.received,
            path: resolution.error.path,
          },
        ],
        conflictContext(input.conflict),
      ),
    );
  }
  return resolveConflict(input.conflict, resolution.value);
}

// ---------------------------------------------------------------------------
// The typed EXPLICIT resolution command (the only exit from a protected
// conflict — it re-enters the queue discipline).
// ---------------------------------------------------------------------------

/**
 * THE typed explicit resolution command: the only way a PROTECTED conflict
 * (or any surfaced conflict a human chooses to overturn) proceeds. The
 * command cites the conflict, the explicit strategy, the resolving actor,
 * at least one ledger event proving the reconciliation (a resolution
 * without an audit trail is typed-rejected — mirror of @office/sync's
 * resolveConflict), and the RECONCILED mutation, which RE-ENTERS the queue
 * discipline: it is captured like any offline mutation (deterministic
 * operation id, current causal token) and replays through the typed
 * command path exactly once.
 */
export interface ConflictResolutionCommand {
  /** The surfaced conflict being resolved. */
  readonly conflictId: ConflictRecordId;
  /** The explicit strategy (sides in the record's canonical order). */
  readonly strategy: ConflictResolutionStrategy;
  /** The actor explicitly resolving the conflict (audit provenance). */
  readonly resolvedBy: Actor;
  /**
   * Ledger events proving the reconciliation — at least one. A resolution
   * without an audit trail is typed-rejected, never accepted.
   */
  readonly auditEventRefs: readonly LedgerEventId[];
  /** The reconciled mutation that re-enters the queue discipline. */
  readonly mutation: Omit<OfflineMutation, 'subscriptionId' | 'basePosition'>;
}
