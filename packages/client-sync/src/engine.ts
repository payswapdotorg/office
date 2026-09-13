// Office client-sync — the composed in-memory SyncEngine (OFF-029, freeze A9).
//
// THE SyncEngine: the client-side offline sync protocol, composed. One engine
// instance is ONE CLIENT'S sync session over one subscribed project slice; the
// server-side world (the broker, the slice source, the operation registry, the
// applied-operation journal, the conflict log, the typed command path, and the
// audit sink) is INJECTED — two engines sharing one world is the two-client
// convergence scenario, exactly like the landed broker tests compose two
// subscriptions over one source.
//
// The session lifecycle (typed at every step):
//
//   subscribe()      the online session start, via @office/sync's broker and
//                    the A9 grant chain: the initial catchup is consumed with
//                    the exactly-once cursor discipline (the engine's
//                    confirmed position is its causal-token basis);
//   goOffline()      the disconnect: the engine stops consuming its stream —
//                    captures accumulate in the bounded LocalQueue, each with
//                    a CLIENT-GENERATED deterministic operation id and the
//                    CAUSAL/VERSION TOKEN (the position the client had
//                    consumed when it composed the mutation);
//   captureOffline() the disconnected mutation capture (typed-rejected while
//                    connected: the online path is submitOnline);
//   submitOnline()   the connected twin: compose @office/sync's ONLINE
//                    deterministic operation id (subscription + observed
//                    cursor + operation kind), authorize (grant → capability
//                    → policy write, deny-by-default), then the same typed
//                    command path + journal + publish the drain uses —
//                    idempotent by operation id, so an unconfirmed retry is a
//                    typed duplicate, never a second effect;
//   reconnect()      the reconnection: catchup (resubscribe from the client's
//                    LAST CONFIRMED cursor — no duplicates, no gaps) + replay
//                    (the queue drain: each mutation exactly once) + conflict
//                    surfacing (protected divergences park for EXPLICIT
//                    resolution) + consumption of the client's own replayed
//                    effects, delivered live by the broker;
//   resolveConflict() the ONLY exit from a protected conflict: the typed
//                    explicit resolution command (strategy + resolving actor
//                    + audit evidence) resolves the surfaced record through
//                    @office/sync's resolveConflict, and the RECONCILED
//                    mutation RE-ENTERS the queue discipline — captured like
//                    any offline mutation (fresh deterministic operation id,
//                    the CURRENT causal token) and replayed through the typed
//                    command path exactly once. An identical re-resolution is
//                    an idempotent no-op (nothing re-enters the queue).
//
// Determinism: NO clock, NO randomness inside the engine — every instant is
// an injected `now` parameter and every identity is a deterministic
// derivation, so the same world + the same call sequence replays
// byte-identically (the kernel's injected clock/id-supplier rule).
import type { EntityId, ProjectScope, Timestamp } from '@office/contracts';
import { CURRENT_SCHEMA_VERSION, parseCommandEnvelope } from '@office/contracts';
import type { Policy } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import {
  clientOperation,
  operationDigestOf,
  operationIdOf,
  parseConflictResolution,
  parseStreamMessage,
  resolveConflict as resolveConflictRecord,
  sliceCursor,
} from '@office/sync';
import type {
  ConflictRecord,
  LiveSubscription,
  OperationId,
  OperationRegistry,
  ProjectSliceSource,
  SlicePosition,
  Subscription,
  SubscriptionBroker,
  SubscriptionGrantId,
} from '@office/sync';
import { createLocalQueue } from './queue';
import type { LocalQueue, OfflineMutation, QueueEntry } from './queue';
import type { ConflictLog, ConflictResolutionCommand, OperationJournal } from './conflict';
import type { SyncAuditSinkExecutor, SyncEventSink } from './audit';
import { conflictResolvedEnvelope } from './audit';
import type { DrainDeps, DrainEntryOutcome, DrainReport, TypedCommandPath } from './replay';
import { authorizeQueuedMutation, drainLocalQueue } from './replay';

/** One disconnected capture request (the engine adds the session basis). */
export type OfflineCapture = Omit<OfflineMutation, 'subscriptionId' | 'basePosition'>;

/**
 * One online submission request (the connected twin of the offline capture):
 * the engine composes the ONLINE deterministic operation id and the
 * client-observed instant is the injected `now`. Protection classes apply to
 * QUEUED captures (the divergence gate), not to online submissions.
 */
export type OnlineSubmission = Omit<
  OfflineMutation,
  'subscriptionId' | 'basePosition' | 'issuedAt' | 'protection'
>;

/** The typed outcome of one online submission through the command path. */
export interface OnlineSubmissionOutcome {
  /** The applied client operation (the online deterministic identity). */
  readonly operation: ReturnType<typeof clientOperation>;
  /** The ledger event the submission appended (its canonical effect). */
  readonly event: LedgerEvent;
  /** True when an unconfirmed retry replayed the RECORDED outcome. */
  readonly replayed: boolean;
}

/** The report of one reconnection: catchup + replay + conflict surfacing. */
export interface ReconnectReport {
  /** The entries consumed by the reconnect catchup (the missed window). */
  readonly catchup: readonly LedgerEvent[];
  /** The queue drain's typed report (per-entry outcomes, surfaced conflicts). */
  readonly drain: DrainReport;
  /** The entries consumed AFTER the drain: the client's own replayed effects. */
  readonly replayed: readonly LedgerEvent[];
}

/** The report of one explicit conflict resolution. */
export interface ConflictResolutionReport {
  /** The stored, resolved conflict record. */
  readonly conflict: ConflictRecord;
  /**
   * The queue entry the reconciled mutation re-entered under — null exactly
   * when an identical resolution was replayed (the idempotent no-op).
   */
  readonly entry: QueueEntry | null;
  /** The re-entered entry's drain outcome (null on the idempotent no-op). */
  readonly outcome: DrainEntryOutcome | null;
}

/** The injected world + session parts one SyncEngine composes. */
export interface SyncEngineParts {
  // ---- The shared, injected server-side world (no I/O of the engine's own).
  /** The @office/sync subscription broker (grants, streams, fan-out). */
  readonly broker: SubscriptionBroker;
  /** The ledger read port (project slices). */
  readonly slice: ProjectSliceSource;
  /** The protocol-level operation registry (typed dedup by operation id). */
  readonly registry: OperationRegistry;
  /** The typed command path every mutation drains through. */
  readonly commandPath: TypedCommandPath;
  /** The applied-operation journal (the conflict model's cause chain). */
  readonly journal: OperationJournal;
  /** The conflict log (surfaced records). */
  readonly conflicts: ConflictLog;
  /** The caller-supplied deny-by-default write policy. */
  readonly policy: Policy;
  /** The audit discipline (freeze A3): the sink + the caller's executor. */
  readonly audit: {
    readonly sink: SyncEventSink;
    readonly executor: SyncAuditSinkExecutor;
  };
  // ---- The client's own session.
  /** The owning client's canonical identity. */
  readonly clientId: EntityId;
  /** The session's subscription contract (subscribe/resubscribe basis). */
  readonly subscription: Subscription;
  /** The A9 grant backing the subscription (re-checked on every replay). */
  readonly grantId: SubscriptionGrantId;
  /** The subscribed project slice's scope (freeze A12). */
  readonly scope: ProjectScope;
  /** The bounded offline queue's capacity (default: DEFAULT_QUEUE_CAPACITY). */
  readonly capacity?: number;
}

/**
 * THE composed in-memory SyncEngine: one client's offline sync session. All
 * effects flow through the injected ports (typed command path, broker, audit
 * sink) — the engine itself performs NO I/O, reads NO clock, and generates NO
 * randomness.
 */
export interface SyncEngine {
  /** The owning client's canonical identity. */
  readonly clientId: EntityId;
  /** The session's subscription contract. */
  readonly subscription: Subscription;
  /** The client's bounded offline mutation queue. */
  readonly queue: LocalQueue;
  /** Is the session currently connected (between goOffline and reconnect)? */
  readonly connected: boolean;
  /** The client's LAST CONFIRMED slice position (its causal-token basis). */
  readonly consumedPosition: SlicePosition;
  /** Every event this client consumed, in consumption order (its own view). */
  readonly consumedEvents: readonly LedgerEvent[];
  /** The conflict records delivered to this client's stream, in order. */
  readonly conflictsNotified: readonly ConflictRecord[];
  /** Start the online session (the initial catchup is consumed). */
  subscribe(): Promise<Result<LiveSubscription, DomainError>>;
  /** Disconnect: stop consuming; captures accumulate in the queue. */
  goOffline(): Result<true, DomainError>;
  /** Capture one mutation while disconnected (typed-rejected while online). */
  captureOffline(mutation: OfflineCapture): Result<QueueEntry, DomainError>;
  /** Submit one mutation while connected (the online deterministic path). */
  submitOnline(
    mutation: OnlineSubmission,
    now: Timestamp,
  ): Promise<Result<OnlineSubmissionOutcome, DomainError>>;
  /** Reconnect: catchup + replay + conflict surfacing (typed at every step). */
  reconnect(now: Timestamp): Promise<Result<ReconnectReport, DomainError>>;
  /** Resolve a surfaced conflict explicitly; the reconciled mutation re-enters the queue. */
  resolveConflict(
    command: ConflictResolutionCommand,
    now: Timestamp,
  ): Promise<Result<ConflictResolutionReport, DomainError>>;
  /** Consume this client's unread live deliveries (cursor-disciplined). */
  consumeLive(): Result<readonly LedgerEvent[], DomainError>;
}

const grantLookupFailure = (grantId: SubscriptionGrantId): DomainError =>
  domainError(
    'not-found',
    `subscription grant ${grantId} not found`,
    [{ code: 'subscription-grant-not-found', message: grantId, path: 'grantId' }],
  );

const sessionFailure = (action: string, statement: string): DomainError =>
  domainError(
    'invariant-violation',
    `${action} requires ${statement} (the sync session lifecycle is typed)`,
    [{ code: 'sync-session-state', message: statement, path: 'session' }],
  );

const crossScopeFailure = (
  clientId: EntityId,
  scope: ProjectScope,
  session: ProjectScope,
): DomainError =>
  domainError(
    'unauthorized',
    `client ${clientId} may not mutate tenant ${scope.tenantId} project ${scope.projectId} under a session scoped to tenant ${session.tenantId} project ${session.projectId} — queue entries and replays are tenant-scoped (freeze A12)`,
    [
      {
        code: 'mutation-scope-outside-session',
        message: `${scope.tenantId}/${scope.projectId} vs ${session.tenantId}/${session.projectId}`,
        path: 'scope',
      },
    ],
    { scope: { kind: 'tenant', tenantId: session.tenantId } },
  );

const invalidSubmissionFailure = (statement: string): DomainError =>
  domainError(
    'invariant-violation',
    `the mutation submission is not structurally valid: ${statement}`,
    [{ code: 'submission-invalid', message: statement, path: null }],
  );

const conflictNotFoundFailure = (conflictId: ConflictRecord['conflictId']): DomainError =>
  domainError(
    'not-found',
    `conflict record ${conflictId} not found`,
    [{ code: 'conflict-not-found', message: conflictId, path: 'conflictId' }],
  );

const streamMessageFailure = (
  clientId: EntityId,
  code: string,
  received: string,
): DomainError =>
  domainError(
    'invariant-violation',
    `the sync stream of client ${clientId} delivered a message that does not parse (${code}) — the client consumes whole protocol messages only, never partial or corrupt ones`,
    [{ code: 'stream-message-invalid', message: received, path: null }],
  );

/**
 * Create the composed in-memory SyncEngine. The world is injected; the
 * session parts are validated once on the trusted path (loud TypeErrors —
 * wiring errors are programming errors, never silent runtime behavior).
 */
export function createSyncEngine(parts: SyncEngineParts): SyncEngine {
  if (parts.subscription.grantId !== parts.grantId) {
    throw new TypeError(
      `the engine session's subscription cites grant ${parts.subscription.grantId} but the engine was wired with grant ${parts.grantId}`,
    );
  }
  const sessionScope = parts.subscription.filter.scope;
  if (
    sessionScope.tenantId !== parts.scope.tenantId ||
    sessionScope.projectId !== parts.scope.projectId
  ) {
    throw new TypeError(
      `the engine session's subscription scope (${sessionScope.tenantId}/${sessionScope.projectId}) does not match the engine scope (${parts.scope.tenantId}/${parts.scope.projectId})`,
    );
  }

  const queue = createLocalQueue({ clientId: parts.clientId, capacity: parts.capacity });
  let live: LiveSubscription | null = null;
  let connected = false;
  let consumedPosition: SlicePosition = 0 as SlicePosition;
  const consumedEvents: LedgerEvent[] = [];
  const conflictsNotified: ConflictRecord[] = [];

  const drainDeps = (): DrainDeps => ({
    clientId: parts.clientId,
    subscriptionId: parts.subscription.subscriptionId,
    grantId: parts.grantId,
    scope: parts.scope,
    queue,
    registry: parts.registry,
    slice: parts.slice,
    commandPath: parts.commandPath,
    policy: parts.policy,
    audit: parts.audit,
    journal: parts.journal,
    conflicts: parts.conflicts,
    broker: parts.broker,
  });

  /**
   * Fold this client's delivered stream with the EXACTLY-ONCE cursor
   * discipline: entries at positions beyond the CONFIRMED cursor are consumed
   * (advancing it); anything at or behind it was already consumed — the
   * cursor is the dedup basis, so an at-least-once transport (the in-memory
   * broker buffers deliveries for streams whose client went offline) never
   * double-folds. Conflict notifications dedup by conflict id; a
   * grant-revoked message marks the session disconnected (the stream is
   * dead); anything unparseable is a typed protocol failure.
   */
  const fold = (): Result<readonly LedgerEvent[], DomainError> => {
    if (live === null) return ok([]);
    const newly: LedgerEvent[] = [];
    for (const message of live.received()) {
      const parsed = parseStreamMessage(message);
      if (!parsed.ok) {
        return fail(
          streamMessageFailure(parts.clientId, parsed.error.code, parsed.error.received),
        );
      }
      const delivered = parsed.value;
      if (delivered.kind === 'event-delivered') {
        if (delivered.position > consumedPosition) {
          consumedEvents.push(delivered.event);
          newly.push(delivered.event);
          consumedPosition = delivered.position;
        }
      } else if (delivered.kind === 'slice-catchup') {
        for (const entry of delivered.entries) {
          if (entry.position > consumedPosition) {
            consumedEvents.push(entry.event);
            newly.push(entry.event);
            consumedPosition = entry.position;
          }
        }
      } else if (delivered.kind === 'conflict-notified') {
        if (!conflictsNotified.some((c) => c.conflictId === delivered.conflict.conflictId)) {
          conflictsNotified.push(delivered.conflict);
        }
      } else if (delivered.kind === 'grant-revoked') {
        // The stream stopped cleanly: the session is offline as of now.
        connected = false;
      } else {
        return fail(
          streamMessageFailure(parts.clientId, 'protocol-error', delivered.kind),
        );
      }
    }
    return ok(newly);
  };

  /** The A12 session-scope gate every captured or submitted mutation passes. */
  const scopeGate = (scope: ProjectScope): Result<true, DomainError> => {
    if (scope.tenantId !== parts.scope.tenantId || scope.projectId !== parts.scope.projectId) {
      return fail(crossScopeFailure(parts.clientId, scope, parts.scope));
    }
    return ok(true);
  };

  return {
    clientId: parts.clientId,
    subscription: parts.subscription,
    queue,
    get connected(): boolean {
      return connected;
    },
    get consumedPosition(): SlicePosition {
      return consumedPosition;
    },
    get consumedEvents(): readonly LedgerEvent[] {
      return [...consumedEvents];
    },
    get conflictsNotified(): readonly ConflictRecord[] {
      return [...conflictsNotified];
    },
    subscribe: async () => {
      if (live !== null) {
        return fail(sessionFailure('subscribe', 'a session that has not started yet'));
      }
      const started = await parts.broker.subscribe(parts.subscription);
      if (!started.ok) return fail(started.error);
      live = started.value;
      connected = true;
      const folded = fold();
      if (!folded.ok) return fail(folded.error);
      return ok(started.value);
    },
    goOffline: () => {
      if (live === null || !connected) {
        return fail(sessionFailure('goOffline', 'a connected session'));
      }
      connected = false;
      return ok(true);
    },
    captureOffline: (mutation) => {
      if (live === null) {
        return fail(sessionFailure('captureOffline', 'a started session'));
      }
      if (connected) {
        return fail(
          sessionFailure(
            'captureOffline',
            'a disconnected session — submit online mutations through submitOnline while connected',
          ),
        );
      }
      const gate = scopeGate(mutation.scope);
      if (!gate.ok) return fail(gate.error);
      return queue.capture({
        ...mutation,
        subscriptionId: parts.subscription.subscriptionId,
        basePosition: consumedPosition,
      });
    },
    submitOnline: async (mutation, now) => {
      if (live === null || !connected) {
        return fail(sessionFailure('submitOnline', 'a connected session'));
      }
      const gate = scopeGate(mutation.scope);
      if (!gate.ok) return fail(gate.error);
      const grant = parts.broker.grantOf(parts.grantId);
      if (grant === null) return fail(grantLookupFailure(parts.grantId));
      const authorization = authorizeQueuedMutation({
        grant,
        policy: parts.policy,
        scope: mutation.scope,
        target: mutation.target,
        requiredCapability: mutation.requiredCapability,
      });
      if (!authorization.ok) return fail(authorization.error);
      // The ONLINE deterministic operation id (A9: subscription + the
      // client's observed cursor + the operation kind) — the envelope's
      // idempotency key, so an unconfirmed retry is a typed duplicate.
      const operationId: OperationId = operationIdOf({
        subscriptionId: parts.subscription.subscriptionId,
        position: consumedPosition,
        operationKind: mutation.operationKind,
      });
      const envelope = parseCommandEnvelope({
        kind: 'command',
        commandName: mutation.commandName,
        scope: mutation.scope,
        actor: mutation.actor,
        idempotencyKey: operationId,
        causality: { correlationId: mutation.correlationId, causationId: null },
        issuedAt: now,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        payload: mutation.payload,
      });
      if (!envelope.ok) {
        return fail(invalidSubmissionFailure(envelope.error.code));
      }
      const operation = clientOperation({
        operationId,
        subscriptionId: parts.subscription.subscriptionId,
        position: consumedPosition,
        operationKind: mutation.operationKind,
        actor: mutation.actor,
        scope: mutation.scope,
        target: mutation.target,
        payloadDigest: operationDigestOf(mutation.payload),
      });
      const registration = await parts.registry.register(operation);
      if (!registration.ok) return fail(registration.error);
      if (registration.value.status === 'duplicate') {
        // An unconfirmed retry: the recorded outcome comes back, never a
        // second effect. (Registered but never journaled — the true crash
        // gap — falls through to the idempotent re-presentation below.)
        const priorEvent = parts.journal.eventOf(operationId);
        if (priorEvent !== null) {
          return ok({ operation, event: priorEvent, replayed: true });
        }
      }
      const executed = await parts.commandPath.execute(envelope.value, {
        now,
        target: mutation.target,
      });
      if (!executed.ok) return fail(executed.error);
      const recorded = parts.journal.record({ operation, event: executed.value.event });
      if (!recorded.ok) return fail(recorded.error);
      const published = await parts.broker.publish(executed.value.event);
      if (!published.ok) return fail(published.error);
      return ok({ operation, event: executed.value.event, replayed: executed.value.replayed });
    },
    reconnect: async (now) => {
      if (live === null) {
        return fail(sessionFailure('reconnect', 'a started session'));
      }
      if (connected) {
        return fail(sessionFailure('reconnect', 'a disconnected session'));
      }
      // 1. The catchup: resume from the client's LAST CONFIRMED cursor —
      //    exactly-once (no duplicates, no gaps).
      const cursor = sliceCursor({
        subscriptionId: parts.subscription.subscriptionId,
        position: consumedPosition,
      });
      const resumed = await parts.broker.resubscribe(parts.subscription.subscriptionId, cursor);
      if (!resumed.ok) return fail(resumed.error);
      connected = true;
      const catchup = fold();
      if (!catchup.ok) return fail(catchup.error);
      // 2. The replay: drain the queue (conflict surfacing included).
      const drain = await drainLocalQueue(drainDeps(), { now });
      if (!drain.ok) return fail(drain.error);
      // 3. Consume the client's own replayed effects (the broker delivered
      //    them live while the drain ran).
      const replayed = fold();
      if (!replayed.ok) return fail(replayed.error);
      return ok({ catchup: catchup.value, drain: drain.value, replayed: replayed.value });
    },
    resolveConflict: async (command, now) => {
      if (live === null || !connected) {
        return fail(sessionFailure('resolveConflict', 'a connected session'));
      }
      const stored = parts.conflicts.conflictOf(command.conflictId);
      if (stored === null) return fail(conflictNotFoundFailure(command.conflictId));
      const resolution = parseConflictResolution({
        kind: 'conflict-resolution',
        strategy: command.strategy,
        resolvedBy: command.resolvedBy,
        resolvedAt: now,
        auditEventRefs: command.auditEventRefs,
      });
      if (!resolution.ok) {
        return fail(invalidSubmissionFailure(resolution.error.code));
      }
      const resolvedRecord = resolveConflictRecord(stored, resolution.value);
      if (!resolvedRecord.ok) return fail(resolvedRecord.error);
      // An identical re-resolution is the idempotent no-op: the record was
      // already resolved exactly this way, so nothing re-enters the queue and
      // nothing applies twice.
      if (stored.state === 'resolved') {
        const storedBack = parts.conflicts.resolve(resolvedRecord.value);
        if (!storedBack.ok) return fail(storedBack.error);
        return ok({ conflict: storedBack.value, entry: null, outcome: null });
      }
      // The reconciled mutation RE-ENTERS the queue discipline: captured like
      // any offline mutation — a fresh deterministic operation id (the next
      // local sequence + the reconciled command's fingerprint) and the
      // CURRENT causal token (the world as the client has now consumed it,
      // diverging event included).
      const captured = queue.capture({
        ...command.mutation,
        subscriptionId: parts.subscription.subscriptionId,
        basePosition: consumedPosition,
      });
      if (!captured.ok) return fail(captured.error);
      const storedBack = parts.conflicts.resolve(resolvedRecord.value);
      if (!storedBack.ok) return fail(storedBack.error);
      // The audit discipline (freeze A3): the EXPLICIT resolution is audited,
      // caused by the resolution command (its re-entered operation id).
      const audited = await parts.audit.sink.appendEvents(parts.audit.executor, [
        conflictResolvedEnvelope({
          conflictId: storedBack.value.conflictId,
          scope: parts.scope,
          target: storedBack.value.target,
          strategy: command.strategy,
          resolvedBy: command.resolvedBy,
          resolutionOperationId: captured.value.operationId,
          correlationId: command.mutation.correlationId,
          auditEventRefs: command.auditEventRefs,
          occurredAt: now,
        }),
      ]);
      if (!audited.ok) return fail(audited.error);
      // The re-entered entry replays through the typed command path exactly
      // once (the drain's full discipline: authorize → register → divergence
      // check → apply → journal → publish → audit → mark).
      const drain = await drainLocalQueue(drainDeps(), { now });
      if (!drain.ok) return fail(drain.error);
      const outcome =
        drain.value.outcomes.find(
          (candidate) => candidate.operationId === captured.value.operationId,
        ) ?? null;
      const folded = fold();
      if (!folded.ok) return fail(folded.error);
      return ok({ conflict: storedBack.value, entry: captured.value, outcome });
    },
    consumeLive: () => {
      if (live === null || !connected) {
        return fail(sessionFailure('consumeLive', 'a connected session'));
      }
      return fold();
    },
  };
}
