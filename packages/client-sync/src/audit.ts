// Office client-sync — audit events + the EventSink port (OFF-029, freeze A3).
//
// AUDIT DISCIPLINE: every consequential queue-drain transition emits an
// immutable DomainEventEnvelope through the EventSink port — a replayed
// mutation (clean apply, or an idempotent replay after an interrupted
// drain), a typed server rejection (surfaced, never lost), a surfaced
// protected conflict, an open-state deterministic supersession, and an
// explicit conflict resolution. The envelopes follow freeze A3 exactly:
// event name, tenant/project scope, actor, source, correlation/causation
// ids, schema version, occurred-at, and before/after entity references —
// the audit events ADDRESS the target entity without changing it
// (before === after, the landed audit-only convention).
//
// THE EventSink PORT mirrors the landed domain packages' shape
// byte-for-byte in structure (appendEvents(executor, events) inside the
// CALLER'S transaction — see packages/domain/*/src/events.ts and
// packages/intelligence/margin/src/assessment-events.ts): a real
// implementation receives the caller's open transaction executor and a
// failure result MUST abort the surrounding drain, so a partially-audited
// replay can never silently pass. Two documented local structural types
// (the dependency rule keeps this package off @office/persistence):
// - SyncAuditSinkExecutor mirrors @office/persistence's SqlExecutor surface
//   (the `query` method);
// - the envelope is built through @office/contracts' canonical parser, so
//   an emitted audit event can never be invalid.
import { CURRENT_SCHEMA_VERSION, parseDomainEventEnvelope, parseEventName } from '@office/contracts';
import type {
  Actor,
  CorrelationId,
  DomainEventEnvelope,
  EntityRef,
  EventName,
  ProjectScope,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { LedgerEventId } from '@office/events';
import type { ConflictRecordId, OperationId, SlicePosition } from '@office/sync';
import type { ConflictResolutionStrategy } from '@office/sync';
import type { LocalSequence } from './identity';
import type { ProtectionClass } from './queue';

// ---------------------------------------------------------------------------
// The audit event vocabulary (freeze A3, emitted by the offline discipline).
// ---------------------------------------------------------------------------

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid sync audit event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the mutation-replayed audit event (clean apply or idempotent replay). */
export const MUTATION_REPLAYED_EVENT: EventName = eventNameOf('sync.mutationReplayed');
/** Event name of the mutation-rejected audit event (a typed server rejection). */
export const MUTATION_REJECTED_EVENT: EventName = eventNameOf('sync.mutationRejected');
/** Event name of the conflict-surfaced audit event (a protected divergence parked). */
export const CONFLICT_SURFACED_EVENT: EventName = eventNameOf('sync.conflictSurfaced');
/** Event name of the conflict-auto-resolved audit event (open-state supersession). */
export const CONFLICT_AUTO_RESOLVED_EVENT: EventName = eventNameOf('sync.conflictAutoResolved');
/** Event name of the conflict-resolved audit event (an EXPLICIT resolution). */
export const CONFLICT_RESOLVED_EVENT: EventName = eventNameOf('sync.conflictResolved');

/** Every audit event name this module emits, in emission-group order. */
export const SYNC_AUDIT_EVENT_NAMES: readonly EventName[] = [
  MUTATION_REPLAYED_EVENT,
  MUTATION_REJECTED_EVENT,
  CONFLICT_SURFACED_EVENT,
  CONFLICT_AUTO_RESOLVED_EVENT,
  CONFLICT_RESOLVED_EVENT,
];

// ---------------------------------------------------------------------------
// The EventSink port (mirrors the landed domain packages' shape).
// ---------------------------------------------------------------------------

/**
 * The executor surface an audit sink needs (a local structural mirror of
 * @office/persistence's SqlExecutor — that package is not importable from
 * the client-sync layer; the shape is the port, mirroring the landed
 * domain EventSink and intelligence AssessmentEventSink conventions
 * exactly).
 */
export interface SyncAuditSinkExecutor {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

/**
 * THE audit event sink port: append audit events inside the caller's
 * transaction (the executor it hands over). A failure result MUST abort the
 * surrounding drain, exactly like the domain packages' EventSink — a
 * partially-audited replay can never silently pass.
 */
export interface SyncEventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding drain, so a partially-applied write can
   * never commit.
   */
  appendEvents(
    executor: SyncAuditSinkExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedSyncAppend {
  readonly executor: SyncAuditSinkExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory audit event sink: records appends instead of writing (tests). */
export interface InMemorySyncEventSink extends SyncEventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedSyncAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory audit event sink for deterministic tests. */
export function createInMemorySyncEventSink(): InMemorySyncEventSink {
  const appends: RecordedSyncAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed sink failure (for tests and wiring guards). */
export const syncSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `sync audit event sink rejected the append: ${reason}`,
    [{ code: 'sync-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingSyncEventSink = (reason: string): SyncEventSink => ({
  appendEvents: async () => fail(syncSinkFailure(reason)),
});

/**
 * A sink that succeeds for its first `successfulAppends` appends and then
 * fails with a typed error — the deterministic mid-drain interruption
 * fixture (an at-least-once replay world: the drain aborts, the resume
 * must continue exactly-once).
 */
export const failAfterSyncEventSink = (
  successfulAppends: number,
  reason: string,
): SyncEventSink => {
  let appends = 0;
  return {
    appendEvents: async (_executor, _events) => {
      if (appends >= successfulAppends) {
        return fail(syncSinkFailure(reason));
      }
      appends += 1;
      return ok(true);
    },
  };
};

// ---------------------------------------------------------------------------
// The audit event envelopes (freeze A3, fail-closed self-checked).
// ---------------------------------------------------------------------------

/** The shared envelope parts of every sync audit event. */
interface AuditEnvelopeParts {
  readonly eventName: EventName;
  readonly scope: ProjectScope;
  readonly actor: Actor;
  /** The causal chain (validated fail-closed by the envelope parse below). */
  readonly causality: { readonly correlationId: string; readonly causationId: string | null };
  readonly occurredAt: Timestamp;
  readonly target: EntityRef;
  readonly payload: Record<string, unknown>;
}

const auditEnvelope = (
  parts: AuditEnvelopeParts,
): DomainEventEnvelope<Record<string, unknown>> => {
  const parsed = parseDomainEventEnvelope({
    kind: 'event',
    eventName: parts.eventName,
    scope: parts.scope,
    actor: parts.actor,
    source: 'system',
    causality: parts.causality,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: { before: parts.target, after: parts.target },
    payload: parts.payload,
  });
  if (!parsed.ok) {
    throw new TypeError(
      `invalid sync audit event envelope: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value as DomainEventEnvelope<Record<string, unknown>>;
};

/** Parts of the mutation-replayed audit envelope. */
export interface MutationReplayedAudit {
  readonly operationId: OperationId;
  readonly localSequence: LocalSequence;
  readonly eventId: LedgerEventId;
  readonly scope: ProjectScope;
  readonly actor: Actor;
  readonly correlationId: CorrelationId;
  readonly target: EntityRef;
  readonly protection: ProtectionClass;
  /** True when the command path replayed a recorded outcome (idempotent). */
  readonly replayed: boolean;
  readonly occurredAt: Timestamp;
}

/** Build the mutation-replayed audit envelope (caused by the applied event). */
export function mutationReplayedEnvelope(
  audit: MutationReplayedAudit,
): DomainEventEnvelope<Record<string, unknown>> {
  return auditEnvelope({
    eventName: MUTATION_REPLAYED_EVENT,
    scope: audit.scope,
    actor: audit.actor,
    causality: { correlationId: audit.correlationId, causationId: audit.eventId },
    occurredAt: audit.occurredAt,
    target: audit.target,
    payload: {
      operationId: audit.operationId,
      localSequence: audit.localSequence,
      eventId: audit.eventId,
      protection: audit.protection,
      replayed: audit.replayed,
    },
  });
}

/** Parts of the mutation-rejected audit envelope. */
export interface MutationRejectedAudit {
  readonly operationId: OperationId;
  readonly localSequence: LocalSequence;
  readonly scope: ProjectScope;
  readonly actor: Actor;
  readonly correlationId: CorrelationId;
  readonly target: EntityRef;
  readonly protection: ProtectionClass;
  /** The typed rejection's code (the DomainError taxonomy code). */
  readonly rejectionCode: string;
  /** The typed rejection's message (safe to display). */
  readonly rejectionMessage: string;
  readonly occurredAt: Timestamp;
}

/** Build the mutation-rejected audit envelope (caused by the rejected command). */
export function mutationRejectedEnvelope(
  audit: MutationRejectedAudit,
): DomainEventEnvelope<Record<string, unknown>> {
  return auditEnvelope({
    eventName: MUTATION_REJECTED_EVENT,
    scope: audit.scope,
    actor: audit.actor,
    // The causing message of a rejection is the command itself (its
    // idempotency key — the A3 convention for command-caused events).
    causality: { correlationId: audit.correlationId, causationId: audit.operationId },
    occurredAt: audit.occurredAt,
    target: audit.target,
    payload: {
      operationId: audit.operationId,
      localSequence: audit.localSequence,
      protection: audit.protection,
      rejectionCode: audit.rejectionCode,
      rejectionMessage: audit.rejectionMessage,
    },
  });
}

/** Parts of the conflict-surfaced audit envelope. */
export interface ConflictSurfacedAudit {
  readonly operationId: OperationId;
  readonly localSequence: LocalSequence;
  readonly conflictId: ConflictRecordId;
  readonly scope: ProjectScope;
  readonly correlationId: CorrelationId;
  readonly target: EntityRef;
  readonly protection: ProtectionClass;
  /** The causal token the mutation was composed against. */
  readonly basePosition: SlicePosition;
  /** The target's base version at the token. */
  readonly baseVersion: number;
  /** The target's actual version at the head. */
  readonly actualVersion: number;
  /** The divergence's cause: the first foreign event that moved the target. */
  readonly divergingEventId: LedgerEventId;
  readonly occurredAt: Timestamp;
}

/** Build the conflict-surfaced audit envelope (caused by the diverging event). */
export function conflictSurfacedEnvelope(
  audit: ConflictSurfacedAudit,
): DomainEventEnvelope<Record<string, unknown>> {
  return auditEnvelope({
    eventName: CONFLICT_SURFACED_EVENT,
    scope: audit.scope,
    actor: { kind: 'system' },
    causality: { correlationId: audit.correlationId, causationId: audit.divergingEventId },
    occurredAt: audit.occurredAt,
    target: audit.target,
    payload: {
      operationId: audit.operationId,
      localSequence: audit.localSequence,
      conflictId: audit.conflictId,
      protection: audit.protection,
      basePosition: audit.basePosition,
      baseVersion: audit.baseVersion,
      actualVersion: audit.actualVersion,
      divergingEventId: audit.divergingEventId,
    },
  });
}

/** Parts of the conflict-auto-resolved audit envelope. */
export interface ConflictAutoResolvedAudit {
  readonly conflictId: ConflictRecordId;
  readonly scope: ProjectScope;
  readonly correlationId: CorrelationId;
  readonly target: EntityRef;
  /** The superseded (offline, open-state) operation. */
  readonly supersededOperationId: OperationId;
  /** The committed (server-side) operation that stands. */
  readonly committedOperationId: OperationId;
  /** The deterministic strategy the supersession resolved with. */
  readonly strategy: ConflictResolutionStrategy;
  /** The divergence's cause (the reconciliation's audit evidence). */
  readonly divergingEventId: LedgerEventId;
  readonly occurredAt: Timestamp;
}

/** Build the conflict-auto-resolved audit envelope (open-state supersession). */
export function conflictAutoResolvedEnvelope(
  audit: ConflictAutoResolvedAudit,
): DomainEventEnvelope<Record<string, unknown>> {
  return auditEnvelope({
    eventName: CONFLICT_AUTO_RESOLVED_EVENT,
    scope: audit.scope,
    actor: { kind: 'system' },
    causality: { correlationId: audit.correlationId, causationId: audit.divergingEventId },
    occurredAt: audit.occurredAt,
    target: audit.target,
    payload: {
      conflictId: audit.conflictId,
      supersededOperationId: audit.supersededOperationId,
      committedOperationId: audit.committedOperationId,
      strategy: audit.strategy,
      divergingEventId: audit.divergingEventId,
    },
  });
}

/** Parts of the conflict-resolved audit envelope (the EXPLICIT resolution). */
export interface ConflictResolvedAudit {
  readonly conflictId: ConflictRecordId;
  readonly scope: ProjectScope;
  readonly target: EntityRef;
  readonly strategy: ConflictResolutionStrategy;
  /** The actor that explicitly resolved the conflict. */
  readonly resolvedBy: Actor;
  /** The resolution command's operation id (it re-entered the queue). */
  readonly resolutionOperationId: OperationId;
  /** The causal chain the resolution command carried. */
  readonly correlationId: CorrelationId;
  /** The ledger events the resolution cited as audit evidence. */
  readonly auditEventRefs: readonly LedgerEventId[];
  readonly occurredAt: Timestamp;
}

/** Build the conflict-resolved audit envelope (caused by the resolution command). */
export function conflictResolvedEnvelope(
  audit: ConflictResolvedAudit,
): DomainEventEnvelope<Record<string, unknown>> {
  return auditEnvelope({
    eventName: CONFLICT_RESOLVED_EVENT,
    scope: audit.scope,
    actor: audit.resolvedBy,
    // The causing message of the resolution is the resolution command itself
    // (its idempotency key — the operation id it re-entered the queue under).
    causality: {
      correlationId: audit.correlationId,
      causationId: audit.resolutionOperationId,
    },
    occurredAt: audit.occurredAt,
    target: audit.target,
    payload: {
      conflictId: audit.conflictId,
      strategy: audit.strategy,
      resolutionOperationId: audit.resolutionOperationId,
      auditEventRefs: [...audit.auditEventRefs],
    },
  });
}
