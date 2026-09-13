// Office client-sync — the replay protocol: the typed command path port and
// the exactly-once queue drain (OFF-029, freeze A8/A9/A12).
//
// THE REPLAY PROTOCOL: on reconnection the queue drains through the typed
// command path in DETERMINISTIC order (local sequence ascending). Each
// mutation replays EXACTLY ONCE — idempotency BY OPERATION ID at two
// layers that compose:
//
//   1. the protocol layer — @office/sync's OperationRegistry: the drain
//      registers the entry's ClientOperation BEFORE presenting the command;
//      a re-drain after a partial failure sees the typed duplicate and
//      resumes WITHOUT duplicates;
//   2. the effect layer — the command envelope's idempotency key IS the
//      deterministic offline operation id, and the typed command path is
//      idempotent by (scope, key) exactly like every landed domain command
//      path (the domain kernel's IdempotencyRegistry discipline): an
//      interrupted drain that re-presents a command whose effect already
//      happened gets the RECORDED outcome back (replayed: true) — the inner
//      handler runs exactly once.
//
// The drain's per-entry discipline (fail-closed, typed at every step):
//
//   authorize (grant active → capability → policy write, deny-by-default,
//   BEFORE any effect) → register (protocol dedup) → resume bookkeeping (an
//   operation already applied + journaled in an earlier interrupted drain
//   re-surfaces its audit + mark, nothing else) → divergence check
//   (tokens.ts: base version vs actual — EVERY not-yet-applied entry, first
//   presentations AND crash-gap resumes, so the protection gate is
//   STRUCTURAL) → clean-apply (command path → journal → publish → audit →
//   mark) or conflict path (detect → surface → protection gate: PROTECTED
//   parks the entry — there is NO code path from a diverged protected entry
//   to the command path, on first presentation OR on any resume; OPEN
//   supersedes deterministically) — server rejections surface as typed
//   per-entry outcomes, never lost; an audit-sink failure ABORTS the whole
//   drain (a partially-audited replay never silently passes), and the resume
//   continues exactly-once.
import type {
  Actor,
  CommandEnvelope,
  EntityRef,
  ProjectScope,
  Timestamp,
} from '@office/contracts';
import { authorize, resourceScope } from '@office/authz';
import type { Policy } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  MAX_SLICE_READ_LIMIT,
  detectConflict,
} from '@office/sync';
import type {
  ConflictRecord,
  ConflictRecordId,
  OperationId,
  OperationRegistry,
  ProjectSliceSource,
  SliceEntry,
  SlicePosition,
  SubscriptionBroker,
  SubscriptionGrant,
  SubscriptionGrantId,
  SubscriptionId,
} from '@office/sync';
import type { LocalSequence } from './identity';
import { clientOperationOf } from './queue';
import type { LocalQueue, ProtectionClass } from './queue';
import {
  autoResolveOpenConflict,
} from './conflict';
import type { ConflictLog, OperationJournal } from './conflict';
import {
  conflictAutoResolvedEnvelope,
  conflictSurfacedEnvelope,
  mutationReplayedEnvelope,
  mutationRejectedEnvelope,
} from './audit';
import type { SyncAuditSinkExecutor, SyncEventSink } from './audit';
import { assessTargetDivergence } from './tokens';

// ---------------------------------------------------------------------------
// The typed command path (the authorized domain boundary the queue drains
// through — freeze A8/A11: no sync engine ever writes state directly).
// ---------------------------------------------------------------------------

/** The execution context the replay hands to the typed command path. */
export interface CommandPathContext {
  /** The injected clock's 'now' for this execution (determinism rule). */
  readonly now: Timestamp;
  /**
   * The canonical entity the mutation addresses — the domain path validates
   * the payload's own entity id against it (defense in depth, mirroring the
   * domain command paths' scope re-checks).
   */
  readonly target: EntityRef;
}

/** The outcome of one command execution through the typed command path. */
export interface CommandPathOutcome {
  /** The ledger event the mutation appended (its canonical effect). */
  readonly event: LedgerEvent;
  /**
   * True when the path's own idempotency replayed the RECORDED outcome of
   * an earlier execution of the same (scope, idempotency key) — the inner
   * handler did not run again (exactly-once at the effect layer).
   */
  readonly replayed: boolean;
}

/**
 * THE typed command path port: the authorized, idempotent command boundary
 * every queued mutation drains through (the domain packages' command
 * handlers behind their parse/authorize/idempotency pipeline). Contract:
 *
 * - idempotent by (scope, idempotency key) — the domain kernel's
 *   IdempotencyRegistry discipline (the offline operation id IS the key);
 * - the appended effect event carries causationId = the command's
 *   idempotency key (the A3 causedByCommand convention every landed domain
 *   path follows) — the offline engine's own-event recognition depends on
 *   it;
 * - a failure Result is a typed server rejection (surfaced per-entry by
 *   the drain, never lost, never retried silently).
 */
export interface TypedCommandPath {
  execute(
    command: CommandEnvelope<unknown>,
    context: CommandPathContext,
  ): Promise<Result<CommandPathOutcome, DomainError>>;
}

// ---------------------------------------------------------------------------
// The deny-by-default authorization gate (mirrors the broker's stream-start
// sequence; A12 holds offline too — authorization is re-checked ON REPLAY).
// ---------------------------------------------------------------------------

/**
 * Authorize one queued mutation (or online submission) BEFORE any effect:
 * grant active (a grant revoked while the client was offline typed-denies
 * its replay) → the required write capability → the caller-supplied policy
 * (authorize() runs the structural A12 scope coverage first, then explicit
 * deny wins, then first allow, then default deny).
 */
export function authorizeQueuedMutation(input: {
  readonly grant: SubscriptionGrant;
  readonly policy: Policy;
  readonly scope: ProjectScope;
  readonly target: EntityRef;
  readonly requiredCapability: SubscriptionGrant['context']['capabilities'][number];
}): Result<true, DomainError> {
  if (input.grant.state === 'revoked') {
    return fail(
      domainError(
        'forbidden',
        `subscription grant ${input.grant.grantId} is revoked — the offline replay is denied (authorization holds on replay)`,
        [{ code: 'grant-revoked', message: input.grant.grantId, path: 'grantId' }],
        { scope: { kind: 'tenant', tenantId: input.grant.tenantId } },
      ),
    );
  }
  if (!input.grant.context.capabilities.includes(input.requiredCapability)) {
    return fail(
      domainError(
        'forbidden',
        `subscription grant ${input.grant.grantId} does not confer the '${String(input.requiredCapability)}' capability the queued mutation requires`,
        [
          {
            code: 'missing-write-capability',
            message: String(input.requiredCapability),
            path: 'requiredCapability',
          },
        ],
        { scope: { kind: 'tenant', tenantId: input.grant.tenantId } },
      ),
    );
  }
  const resource = resourceScope({
    scope: input.scope,
    resourceKind: input.target.entityKind,
    resourceId: input.target.entityId,
    ownerId: null,
  });
  const decision = authorize(input.policy, input.grant.context, resource, 'write');
  if (!decision.ok) return fail(decision.error);
  return ok(true);
}

// ---------------------------------------------------------------------------
// The drain report (typed outcomes — server rejections surface, never lost).
// ---------------------------------------------------------------------------

/** The typed outcome of one drained queue entry. */
export type DrainEntryOutcome =
  | {
      readonly status: 'applied';
      readonly operationId: OperationId;
      readonly localSequence: LocalSequence;
      /** The ledger event the replay appended. */
      readonly eventId: LedgerEventId;
      /** True when the outcome was replayed (idempotent), not first-applied. */
      readonly replayed: boolean;
    }
  | {
      readonly status: 'conflicted';
      readonly operationId: OperationId;
      readonly localSequence: LocalSequence;
      /** The surfaced conflict record (awaiting EXPLICIT resolution). */
      readonly conflictId: ConflictRecordId;
      readonly protection: ProtectionClass;
    }
  | {
      readonly status: 'superseded';
      readonly operationId: OperationId;
      readonly localSequence: LocalSequence;
      /** The auto-resolved conflict record proving the supersession. */
      readonly conflictId: ConflictRecordId;
    }
  | {
      readonly status: 'rejected';
      readonly operationId: OperationId;
      readonly localSequence: LocalSequence;
      /** The typed server rejection (surfaced, never lost; the entry stays pending and retryable). */
      readonly error: DomainError;
    };

/** The report of one queue drain. */
export interface DrainReport {
  /** Per-entry outcomes in drain order (local sequence ascending). */
  readonly outcomes: readonly DrainEntryOutcome[];
  /** The conflict records surfaced (or idempotently re-detected) this drain. */
  readonly conflictsSurfaced: readonly ConflictRecord[];
  /** The ledger events this drain applied on behalf of the client, in order. */
  readonly appliedEvents: readonly LedgerEvent[];
  /** The entries still pending after the drain (rejections stay retryable). */
  readonly remaining: number;
}

/** The ports the queue drain composes (all injected — no I/O of its own). */
export interface DrainDeps {
  /** The client whose queue drains. */
  readonly clientId: import('@office/contracts').EntityId;
  /** The client's live subscription basis (the queue entries' subscription). */
  readonly subscriptionId: SubscriptionId;
  /** The A9 grant backing the subscription (re-checked on replay). */
  readonly grantId: SubscriptionGrantId;
  /** The project scope of the subscribed slice (freeze A12). */
  readonly scope: ProjectScope;
  /** The queue being drained. */
  readonly queue: LocalQueue;
  /** @office/sync's operation registry (the protocol-level dedup). */
  readonly registry: OperationRegistry;
  /** The ledger read port (project slices — re-read per entry, deterministically). */
  readonly slice: ProjectSliceSource;
  /** The typed command path every clean mutation drains through. */
  readonly commandPath: TypedCommandPath;
  /** The caller-supplied deny-by-default write policy. */
  readonly policy: Policy;
  /** The audit discipline (freeze A3): the sink + the caller's executor. */
  readonly audit: {
    readonly sink: SyncEventSink;
    readonly executor: SyncAuditSinkExecutor;
  };
  /** The applied-operation journal (the conflict model's cause chain). */
  readonly journal: OperationJournal;
  /** The conflict log (surfaced records). */
  readonly conflicts: ConflictLog;
  /** The @office/sync broker (grant lookup + conflict fan-out). */
  readonly broker: SubscriptionBroker;
}

const grantLookupFailure = (grantId: SubscriptionGrantId): DomainError =>
  domainError(
    'not-found',
    `subscription grant ${grantId} not found`,
    [{ code: 'subscription-grant-not-found', message: grantId, path: 'grantId' }],
  );

const SYSTEM_ACTOR: Actor = { kind: 'system' };

/** Read the full ordered slice (the deterministic (occurredAt, eventId) order). */
const readFullSlice = async (
  slice: ProjectSliceSource,
  scope: ProjectScope,
): Promise<Result<readonly SliceEntry[], DomainError>> =>
  slice.readSlice({ scope, after: 0 as SlicePosition, limit: MAX_SLICE_READ_LIMIT });

/**
 * Drain the queue: replay every pending entry through the typed command
 * path in deterministic local-sequence order, exactly once per mutation.
 * Drain-level failures (authorization denial, journal/audit/notify
 * invariants) abort the whole drain typed — the processed entries keep
 * their journaled states and the resume continues without duplicates;
 * per-entry server rejections surface as typed outcomes and the entry
 * stays pending (retryable).
 */
export async function drainLocalQueue(
  deps: DrainDeps,
  input: { readonly now: Timestamp },
): Promise<Result<DrainReport, DomainError>> {
  const grant = deps.broker.grantOf(deps.grantId);
  if (grant === null) {
    return fail(grantLookupFailure(deps.grantId));
  }
  const outcomes: DrainEntryOutcome[] = [];
  const conflictsSurfaced: ConflictRecord[] = [];
  const appliedEvents: LedgerEvent[] = [];
  const queueOperationIds = new Set<string>(
    deps.queue.entries.map((entry) => entry.operationId),
  );

  /** Append one audit envelope (a failure aborts the drain). */
  const audit = async (
    envelope: import('@office/contracts').DomainEventEnvelope,
  ): Promise<Result<true, DomainError>> =>
    deps.audit.sink.appendEvents(deps.audit.executor, [envelope]);

  for (const entry of deps.queue.pending) {
    // 1. Authorization — deny-by-default, BEFORE any effect (A12 on replay).
    const authorization = authorizeQueuedMutation({
      grant,
      policy: deps.policy,
      scope: entry.command.scope as ProjectScope,
      target: entry.target,
      requiredCapability: entry.requiredCapability,
    });
    if (!authorization.ok) return fail(authorization.error);

    // 2. Protocol-level dedup: register the entry's ClientOperation.
    const operation = clientOperationOf(entry);
    const registration = await deps.registry.register(operation);
    if (!registration.ok) {
      // A typed idempotency-conflict at the protocol layer — surfaced, never lost.
      outcomes.push({
        status: 'rejected',
        operationId: entry.operationId,
        localSequence: entry.localSequence,
        error: registration.error,
      });
      continue;
    }

    // 3. Resume bookkeeping: an operation already applied AND journaled in an
    //    earlier (interrupted) drain never re-runs anything — re-surface the
    //    audit + the terminal mark, exactly once overall.
    if (registration.value.status === 'duplicate') {
      const priorEvent = deps.journal.eventOf(entry.operationId);
      if (priorEvent !== null) {
        // Applied and journaled earlier: re-surface (audit + mark, exactly
        // once overall — a previously failed audit append never recorded).
        const audited = await audit(
          mutationReplayedEnvelope({
            operationId: entry.operationId,
            localSequence: entry.localSequence,
            eventId: priorEvent.eventId,
            scope: entry.command.scope as ProjectScope,
            actor: entry.command.actor,
            correlationId: entry.command.causality.correlationId,
            target: entry.target,
            protection: entry.protection,
            replayed: true,
            occurredAt: input.now,
          }),
        );
        if (!audited.ok) return fail(audited.error);
        const marked = deps.queue.markApplied(entry.operationId, {
          eventId: priorEvent.eventId,
          replayed: true,
        });
        if (!marked.ok) return fail(marked.error);
        outcomes.push({
          status: 'applied',
          operationId: entry.operationId,
          localSequence: entry.localSequence,
          eventId: priorEvent.eventId,
          replayed: true,
        });
        continue;
      }
      // Presented earlier, outcome UNKNOWN (the true crash gap: registered,
      // never journaled). The entry's fate is still undecided, so it FALLS
      // THROUGH to the divergence check below — the protection gate is
      // STRUCTURAL: no resume path may reach the command path without
      // passing it. Two sub-cases compose there:
      // - the crashed attempt's effect event is already in the slice: the
      //   queue's own causal chain recognizes it (the event's causation id IS
      //   the entry's operation id) → 'clean' → the typed command path is
      //   idempotent by operation id, so the RECORDED outcome comes back
      //   (replayed: true) and the inner handler never runs twice;
      // - the world moved instead: the conflict path runs — a PROTECTED entry
      //   is parked, never applied, exactly like a first presentation.
    }

    // 4. The server-side divergence check (base version vs actual) — EVERY
    //    not-yet-applied entry (first presentations and crash-gap resumes
    //    alike): it determines clean-apply vs conflict.
    const slice = await readFullSlice(deps.slice, deps.scope);
    if (!slice.ok) return fail(slice.error);
    // The client's own causal chain: journal-recorded own events PLUS events
    // caused by this queue's own commands (the A3 causedByCommand convention
    // — robust even when an interrupted drain's journal write was missed).
    const ownEventIds = new Set<string>(deps.journal.ownEventIds(deps.subscriptionId));
    for (const sliceEntry of slice.value) {
      const causationId = sliceEntry.event.envelope.causality.causationId;
      if (causationId !== null && queueOperationIds.has(causationId)) {
        ownEventIds.add(sliceEntry.event.eventId);
      }
    }
    const assessment = assessTargetDivergence({
      entries: slice.value,
      target: entry.target,
      basePosition: entry.basePosition,
      ownEventIds,
    });

    if (assessment.status === 'clean') {
      // 5a. Clean apply (first presentation or crash-gap resume — the command
      //     path is idempotent by operation id either way): the typed command
      //     path, journaled, published, audited, and marked — in that order,
      //     typed at every step.
      const executed = await deps.commandPath.execute(entry.command, {
        now: input.now,
        target: entry.target,
      });
      if (!executed.ok) {
        // A typed server rejection: surfaced (audit + report), never lost;
        // the entry stays pending and retryable.
        const audited = await audit(
          mutationRejectedEnvelope({
            operationId: entry.operationId,
            localSequence: entry.localSequence,
            scope: entry.command.scope as ProjectScope,
            actor: entry.command.actor,
            correlationId: entry.command.causality.correlationId,
            target: entry.target,
            protection: entry.protection,
            rejectionCode: executed.error.code,
            rejectionMessage: executed.error.message,
            occurredAt: input.now,
          }),
        );
        if (!audited.ok) return fail(audited.error);
        outcomes.push({
          status: 'rejected',
          operationId: entry.operationId,
          localSequence: entry.localSequence,
          error: executed.error,
        });
        continue;
      }
      const recorded = deps.journal.record({ operation, event: executed.value.event });
      if (!recorded.ok) return fail(recorded.error);
      const published = await deps.broker.publish(executed.value.event);
      if (!published.ok) return fail(published.error);
      const audited = await audit(
        mutationReplayedEnvelope({
          operationId: entry.operationId,
          localSequence: entry.localSequence,
          eventId: executed.value.event.eventId,
          scope: entry.command.scope as ProjectScope,
          actor: entry.command.actor,
          correlationId: entry.command.causality.correlationId,
          target: entry.target,
          protection: entry.protection,
          replayed: executed.value.replayed,
          occurredAt: input.now,
        }),
      );
      if (!audited.ok) return fail(audited.error);
      const marked = deps.queue.markApplied(entry.operationId, {
        eventId: executed.value.event.eventId,
        replayed: executed.value.replayed,
      });
      if (!marked.ok) return fail(marked.error);
      appliedEvents.push(executed.value.event);
      outcomes.push({
        status: 'applied',
        operationId: entry.operationId,
        localSequence: entry.localSequence,
        eventId: executed.value.event.eventId,
        replayed: executed.value.replayed,
      });
      continue;
    }

    // 5b. Diverged: the explicit conflict path. The diverging event's
    //     producing operation names the server side (both sides, canonical
    //     order — @office/sync's detectConflict).
    const divergingEvent = assessment.divergingEvent;
    if (divergingEvent === null) {
      return fail(
        domainError(
          'invariant-violation',
          'a diverged assessment must carry its diverging event',
          [{ code: 'divergence-without-event', message: 'impossible', path: null }],
        ),
      );
    }
    const serverOperation = deps.journal.operationOf(divergingEvent.eventId);
    if (serverOperation === null) {
      outcomes.push({
        status: 'rejected',
        operationId: entry.operationId,
        localSequence: entry.localSequence,
        error: domainError(
          'invariant-violation',
          `the base of mutation ${entry.operationId} diverged (event ${divergingEvent.eventId} moved ${entry.target.entityKind} ${entry.target.entityId}), but no recorded operation produced that event — every target-moving mutation must flow through the sync engine so its operation is recorded`,
          [
            {
              code: 'divergence-without-recorded-operation',
              message: divergingEvent.eventId,
              path: 'divergingEvent',
            },
          ],
          { scope: entry.command.scope },
        ),
      });
      continue;
    }
    const detected = detectConflict({
      operations: [operation, serverOperation],
      detectedAt: input.now,
      detectedBy: SYSTEM_ACTOR,
    });
    if (!detected.ok) {
      outcomes.push({
        status: 'rejected',
        operationId: entry.operationId,
        localSequence: entry.localSequence,
        error: detected.error,
      });
      continue;
    }
    const surfaced = deps.conflicts.surface(detected.value);
    if (!surfaced.ok) return fail(surfaced.error);
    const stored = surfaced.value;
    conflictsSurfaced.push(stored);

    if (entry.protection === 'protected') {
      // THE PROTECTED GATE: park the entry — there is NO path from here to
      // the command path. The ONLY exit is the typed explicit resolution
      // command (engine.resolveConflict), which re-enters the queue.
      const audited = await audit(
        conflictSurfacedEnvelope({
          operationId: entry.operationId,
          localSequence: entry.localSequence,
          conflictId: stored.conflictId,
          scope: entry.command.scope as ProjectScope,
          correlationId: entry.command.causality.correlationId,
          target: entry.target,
          protection: entry.protection,
          basePosition: entry.basePosition,
          baseVersion: assessment.baseVersion,
          actualVersion: assessment.actualVersion,
          divergingEventId: divergingEvent.eventId,
          occurredAt: input.now,
        }),
      );
      if (!audited.ok) return fail(audited.error);
      const marked = deps.queue.markConflicted(entry.operationId, stored.conflictId);
      if (!marked.ok) return fail(marked.error);
      const notified = await deps.broker.notifyConflict(stored);
      if (!notified.ok) return fail(notified.error);
      outcomes.push({
        status: 'conflicted',
        operationId: entry.operationId,
        localSequence: entry.localSequence,
        conflictId: stored.conflictId,
        protection: entry.protection,
      });
      continue;
    }

    // OPEN state: deterministic supersession — the committed server side
    // stands; the supersession is recorded as a RESOLVED conflict record
    // with the diverging event as audit evidence (never silent). Idempotent
    // across interrupted drains: the first attempt that stored the resolved
    // record wins; a resume re-detects the same conflict id and keeps the
    // stored (already resolved) form instead of re-resolving with a fresh
    // resolvedAt.
    let resolved: ConflictRecord;
    if (stored.state === 'resolved') {
      // An earlier interrupted attempt already recorded the supersession.
      resolved = stored;
    } else {
      const autoResolved = autoResolveOpenConflict({
        conflict: stored,
        committedOperationId: serverOperation.operationId,
        auditEventRefs: [divergingEvent.eventId],
        resolvedAt: input.now,
      });
      if (!autoResolved.ok) return fail(autoResolved.error);
      const resolvedStored = deps.conflicts.resolve(autoResolved.value);
      if (!resolvedStored.ok) return fail(resolvedStored.error);
      resolved = resolvedStored.value;
    }
    const audited = await audit(
      conflictAutoResolvedEnvelope({
        conflictId: resolved.conflictId,
        scope: entry.command.scope as ProjectScope,
        correlationId: entry.command.causality.correlationId,
        target: entry.target,
        supersededOperationId: entry.operationId,
        committedOperationId: serverOperation.operationId,
        strategy: resolved.resolution?.strategy ?? 'merge',
        divergingEventId: divergingEvent.eventId,
        occurredAt: input.now,
      }),
    );
    if (!audited.ok) return fail(audited.error);
    const marked = deps.queue.markSuperseded(entry.operationId, resolved.conflictId);
    if (!marked.ok) return fail(marked.error);
    const notified = await deps.broker.notifyConflict(resolved);
    if (!notified.ok) return fail(notified.error);
    outcomes.push({
      status: 'superseded',
      operationId: entry.operationId,
      localSequence: entry.localSequence,
      conflictId: resolved.conflictId,
    });
  }

  return ok({
    outcomes,
    conflictsSurfaced,
    appliedEvents,
    remaining: deps.queue.pending.length,
  } satisfies DrainReport);
}
