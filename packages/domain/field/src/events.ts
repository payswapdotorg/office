// Office field domain — audit events + the EventSink port (OFF-009).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the field/work event vocabulary (capture,
// evidence attach, resolve; daily-log entry append, day close; issue
// raise/assign/comment/resolve/reopen; inspection schedule/conduct/outcome)
// and the builder that turns a command envelope + the next state into a
// DomainEventEnvelope.
//
// THE EventSink PORT (mirrored byte-for-byte in shape from the landed
// @office/domain-organization / @office/domain-projects modules of OFF-007 —
// no domain-to-domain imports, dependency rule): command handlers hand their
// envelope(s) to an injected sink TOGETHER with the state writes, inside the
// SAME transaction — the sink receives the transaction's SqlExecutor so a
// real implementation (the OFF-005 event ledger, wired by the runtime or the
// ledger-backed adapter in this package's ledger-sink.ts) writes the ledger
// rows in that transaction and the whole mutation is atomic. This package
// ships an in-memory sink for tests and a failing sink for failure-path
// tests. Any transactional EventSink implementation satisfies the identity
// modules' port and this one structurally.
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEventName,
} from '@office/contracts';
import type {
  CommandEnvelope,
  Causality,
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  EntityRefs,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type {
  DailyLogEntry,
  DailyLogState,
  DailyLogStatus,
  EvidenceReference,
  FieldEventState,
  FieldEventStatus,
  InspectionFinding,
  InspectionResult,
  InspectionState,
  InspectionStatus,
  IssueComment,
  IssueSeverity,
  IssueState,
  IssueStatus,
  Measurement,
} from './state';
import type { ChecklistItem } from './state';
import type { LogDay } from './parse';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid field event name literal: ${name}`);
  }
  return parsed.value;
};

// ----- event name vocabulary (freeze A3 audit) ------------------------------------

/** Event name of the field-event-captured event (the offline-style capture). */
export const FIELD_EVENT_CAPTURED_EVENT: EventName = eventNameOf('field.fieldEventCaptured');
/** Event name of the field-event-evidence-attached event. */
export const FIELD_EVENT_EVIDENCE_ATTACHED_EVENT: EventName = eventNameOf(
  'field.fieldEventEvidenceAttached',
);
/** Event name of the field-event-resolved event. */
export const FIELD_EVENT_RESOLVED_EVENT: EventName = eventNameOf('field.fieldEventResolved');
/** Event name of the daily-log-entry-appended event. */
export const DAILY_LOG_ENTRY_APPENDED_EVENT: EventName = eventNameOf(
  'field.dailyLogEntryAppended',
);
/** Event name of the daily-log-day-closed event (the day closes once). */
export const DAILY_LOG_DAY_CLOSED_EVENT: EventName = eventNameOf('field.dailyLogDayClosed');
/** Event name of the issue-raised event (offline-style capture). */
export const ISSUE_RAISED_EVENT: EventName = eventNameOf('field.issueRaised');
/** Event name of the issue-assigned event. */
export const ISSUE_ASSIGNED_EVENT: EventName = eventNameOf('field.issueAssigned');
/** Event name of the issue-commented event (append-only comments). */
export const ISSUE_COMMENTED_EVENT: EventName = eventNameOf('field.issueCommented');
/** Event name of the issue-resolved event. */
export const ISSUE_RESOLVED_EVENT: EventName = eventNameOf('field.issueResolved');
/** Event name of the issue-reopened event. */
export const ISSUE_REOPENED_EVENT: EventName = eventNameOf('field.issueReopened');
/** Event name of the inspection-scheduled event. */
export const INSPECTION_SCHEDULED_EVENT: EventName = eventNameOf('field.inspectionScheduled');
/** Event name of the inspection-conducted event (immutable checklist results). */
export const INSPECTION_CONDUCTED_EVENT: EventName = eventNameOf('field.inspectionConducted');
/** Event name of the inspection-outcomed event (terminal outcome + findings). */
export const INSPECTION_OUTCOMED_EVENT: EventName = eventNameOf('field.inspectionOutcomed');

/** Every event name this module emits, in emission-group order. */
export const FIELD_EVENT_NAMES: readonly EventName[] = [
  FIELD_EVENT_CAPTURED_EVENT,
  FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
  FIELD_EVENT_RESOLVED_EVENT,
  DAILY_LOG_ENTRY_APPENDED_EVENT,
  DAILY_LOG_DAY_CLOSED_EVENT,
  ISSUE_RAISED_EVENT,
  ISSUE_ASSIGNED_EVENT,
  ISSUE_COMMENTED_EVENT,
  ISSUE_RESOLVED_EVENT,
  ISSUE_REOPENED_EVENT,
  INSPECTION_SCHEDULED_EVENT,
  INSPECTION_CONDUCTED_EVENT,
  INSPECTION_OUTCOMED_EVENT,
] as const;

// ----- audit payloads (typed; consumed by the project read model) ------------------

/** Audit payload of `field.fieldEventCaptured`. */
export interface FieldEventCapturedPayload {
  readonly fieldEventId: EntityId;
  readonly category: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly location: string;
  readonly observedAt: Timestamp;
  readonly observedBy: EntityId;
  readonly quantity: Measurement | null;
  readonly evidence: readonly EvidenceReference[];
  readonly status: FieldEventStatus;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `field.fieldEventEvidenceAttached`. */
export interface FieldEventEvidenceAttachedPayload {
  readonly fieldEventId: EntityId;
  readonly attached: readonly EvidenceReference[];
  readonly evidenceCount: number;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.fieldEventResolved`. */
export interface FieldEventResolvedPayload {
  readonly fieldEventId: EntityId;
  readonly status: FieldEventStatus;
  readonly resolvedAt: Timestamp;
  readonly resolutionNote: string | null;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.dailyLogEntryAppended`. */
export interface DailyLogEntryAppendedPayload {
  readonly dailyLogId: EntityId;
  readonly day: LogDay;
  readonly party: EntityId;
  readonly entry: DailyLogEntry;
  readonly entryCount: number;
  readonly status: DailyLogStatus;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.dailyLogDayClosed`. */
export interface DailyLogDayClosedPayload {
  readonly dailyLogId: EntityId;
  readonly day: LogDay;
  readonly party: EntityId;
  readonly closedAt: Timestamp;
  readonly entryCount: number;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.issueRaised`. */
export interface IssueRaisedPayload {
  readonly issueId: EntityId;
  readonly title: string;
  readonly description: string | null;
  readonly category: string;
  readonly severity: IssueSeverity;
  readonly status: IssueStatus;
  readonly reportedAt: Timestamp;
  readonly reportedBy: EntityId;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `field.issueAssigned`. */
export interface IssueAssignedPayload {
  readonly issueId: EntityId;
  readonly assignee: EntityId;
  readonly assignedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.issueCommented`. */
export interface IssueCommentedPayload {
  readonly issueId: EntityId;
  readonly comment: IssueComment;
  readonly commentCount: number;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.issueResolved`. */
export interface IssueResolvedPayload {
  readonly issueId: EntityId;
  readonly status: IssueStatus;
  readonly resolvedAt: Timestamp;
  readonly resolutionNote: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.issueReopened`. */
export interface IssueReopenedPayload {
  readonly issueId: EntityId;
  readonly status: IssueStatus;
  readonly reopenedAt: Timestamp;
  readonly reopenReason: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.inspectionScheduled`. */
export interface InspectionScheduledPayload {
  readonly inspectionId: EntityId;
  readonly title: string;
  readonly description: string | null;
  readonly scheduledFor: Timestamp;
  readonly checklist: readonly ChecklistItem[];
  readonly status: InspectionStatus;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `field.inspectionConducted`. */
export interface InspectionConductedPayload {
  readonly inspectionId: EntityId;
  readonly status: InspectionStatus;
  readonly conductedAt: Timestamp;
  readonly results: readonly InspectionResult[];
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `field.inspectionOutcomed`. */
export interface InspectionOutcomedPayload {
  readonly inspectionId: EntityId;
  readonly status: InspectionStatus;
  readonly outcomeAt: Timestamp;
  readonly findings: readonly InspectionFinding[];
  readonly outcomeSummary: string | null;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** The union of every field-domain audit payload. */
export type FieldAuditPayload =
  | FieldEventCapturedPayload
  | FieldEventEvidenceAttachedPayload
  | FieldEventResolvedPayload
  | DailyLogEntryAppendedPayload
  | DailyLogDayClosedPayload
  | IssueRaisedPayload
  | IssueAssignedPayload
  | IssueCommentedPayload
  | IssueResolvedPayload
  | IssueReopenedPayload
  | InspectionScheduledPayload
  | InspectionConductedPayload
  | InspectionOutcomedPayload;

// ----- envelope builder ------------------------------------------------------------

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention, identical to the identity modules): the correlation id of the
 * causal chain is carried over; the causation id of the resulting event is
 * the COMMAND's idempotency key — the id of the message that caused this
 * mutation. Trusted path: the envelope was already validated (the
 * idempotency-key grammar is exactly the causation-id grammar), so a parse
 * failure here is a loud TypeError, never a silent drop.
 */
const causalityOf = (command: CommandEnvelope<unknown>): Causality => {
  const causationId = parseCausationId(command.idempotencyKey);
  if (!causationId.ok) {
    throw new TypeError(
      `command idempotency key is not a valid causation id: ${command.idempotencyKey}`,
    );
  }
  return {
    correlationId: command.causality.correlationId,
    causationId: causationId.value,
  };
};

/**
 * Build one field-domain audit event envelope (trusted path; self-checked
 * through the contracts parser so an emitted event can never be invalid):
 * source is 'domain' by definition, scope is the aggregate's owning project
 * scope, actor and causal chain come from the command, occurredAt from the
 * injected clock, and entityRefs carry before/after per the transition kind
 * (creation events carry before = null).
 */
export function fieldEventEnvelope(parts: {
  readonly command: CommandEnvelope<unknown>;
  readonly eventName: EventName;
  readonly scope: Scope;
  readonly occurredAt: Timestamp;
  readonly entityRefs: EntityRefs;
  readonly payload: FieldAuditPayload;
}): DomainEventEnvelope<FieldAuditPayload> {
  const envelope = {
    kind: 'event',
    eventName: parts.eventName,
    scope: parts.scope,
    actor: parts.command.actor,
    source: 'domain',
    causality: causalityOf(parts.command),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: parts.entityRefs,
    payload: parts.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `field event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<FieldAuditPayload>;
}

/** Entity reference of an aggregate state (before/after refs, A3). */
export const fieldEntityRef = (
  entityKind: EntityKind,
  entityId: EntityId,
): EntityRef => ({ entityKind, entityId });

/** The before/after refs of a creation transition (before = null, A3). */
export const createdRefs = (state: FieldEventState | DailyLogState | IssueState | InspectionState): EntityRefs => ({
  before: null,
  after: fieldEntityRef(state.entityKind, state.entityId),
});

/** The before/after refs of an update transition (same entity, changed payload). */
export const updatedRefs = (
  before: FieldEventState | DailyLogState | IssueState | InspectionState,
  after: FieldEventState | DailyLogState | IssueState | InspectionState,
): EntityRefs => ({
  before: fieldEntityRef(before.entityKind, before.entityId),
  after: fieldEntityRef(after.entityKind, after.entityId),
});

// ----- THE EventSink port (mirrors the identity modules byte-for-byte) -------------

/**
 * THE EventSink port (minimal, by design): append audit events using the
 * caller's open transaction executor, so a real implementation writes them
 * atomically with the mutation that produced them. The in-memory sink below
 * records instead of writing; the OFF-005 ledger (via this package's
 * ledger-backed adapter or the runtime's own wiring) implements this port.
 */
export interface EventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation (handlers roll the mutation back),
   * so a partially-applied mutation can never commit.
   */
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedEventAppend {
  /** The executor the sink was handed (the open transaction in handlers). */
  readonly executor: SqlExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory EventSink: records appends instead of writing (tests). */
export interface InMemoryEventSink extends EventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedEventAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory EventSink for deterministic tests. */
export function createInMemoryEventSink(): InMemoryEventSink {
  const appends: RecordedEventAppend[] = [];
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
export const eventSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `event sink rejected the append: ${reason}`,
    [{ code: 'event-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingEventSink = (reason: string): EventSink => ({
  appendEvents: async () => fail(eventSinkFailure(reason)),
});
