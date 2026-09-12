// Office schedule domain — audit events + the EventSink port (OFF-010).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the schedule event vocabulary (activity
// added/updated, dependency added/removed, milestone added, baseline set,
// progress recorded — plus schedule created) and the builder that turns a
// command envelope + the next state into a DomainEventEnvelope.
//
// The EventSink PORT mirrors the landed OFF-007 identity-module shape
// EXACTLY (byte-for-byte in structure — see packages/domain/organization/
// src/events.ts): command handlers hand their envelope(s) to an injected
// sink TOGETHER with the store writes, inside the SAME transaction — the
// sink receives the transaction's SqlExecutor so a real implementation (the
// OFF-005 event ledger, e.g. the thin adapter in ledger-sink.ts) writes the
// ledger rows in that transaction and the whole mutation is atomic. This
// package ships an in-memory sink for tests and a failing sink for
// failure-path tests. No domain-to-domain import happens (dependency rule):
// mirroring the shape is enough for any transactional EventSink
// implementation to satisfy both packages structurally.
//
// Payload convention (consumed by the ledger-backed adapter): every schedule
// event payload carries the owning scheduleId — the ledger-assigned
// aggregate stream key of the schedule root.
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
  ActivityState,
  BaselineState,
  DependencyState,
  DependencyLinkType,
  MilestoneState,
  ProgressUpdateState,
  ScheduleState,
} from './state';
import { BASELINE_KIND, DEPENDENCY_KIND, MILESTONE_KIND, PROGRESS_UPDATE_KIND, ACTIVITY_KIND, SCHEDULE_KIND } from './state';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid schedule event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the schedule-created lifecycle event (A3 audit). */
export const SCHEDULE_CREATED_EVENT: EventName = eventNameOf('schedule.scheduleCreated');
/** Event name of the activity-added event (A3 audit). */
export const ACTIVITY_ADDED_EVENT: EventName = eventNameOf('schedule.activityAdded');
/** Event name of the activity-updated event (A3 audit). */
export const ACTIVITY_UPDATED_EVENT: EventName = eventNameOf('schedule.activityUpdated');
/** Event name of the dependency-added event (A3 audit). */
export const DEPENDENCY_ADDED_EVENT: EventName = eventNameOf('schedule.dependencyAdded');
/** Event name of the dependency-removed event (A3 audit). */
export const DEPENDENCY_REMOVED_EVENT: EventName = eventNameOf('schedule.dependencyRemoved');
/** Event name of the milestone-added event (A3 audit). */
export const MILESTONE_ADDED_EVENT: EventName = eventNameOf('schedule.milestoneAdded');
/** Event name of the baseline-set event (A3 audit) — the consequential baseline decision. */
export const BASELINE_SET_EVENT: EventName = eventNameOf('schedule.baselineSet');
/** Event name of the progress-recorded event (A3 audit). */
export const PROGRESS_RECORDED_EVENT: EventName = eventNameOf('schedule.progressRecorded');

/** Marker: every schedule event payload carries the owning schedule id (the ledger aggregate key). */
export interface ScheduleEventPayload {
  readonly scheduleId: EntityId;
}

/** Audit payload of `schedule.scheduleCreated`. */
export interface ScheduleCreatedPayload extends ScheduleEventPayload {
  readonly name: string;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `schedule.activityAdded`. */
export interface ActivityAddedPayload extends ScheduleEventPayload {
  readonly activityId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly parentActivityId: EntityId | null;
  readonly version: number;
}

/** Audit payload of `schedule.activityUpdated`. */
export interface ActivityUpdatedPayload extends ScheduleEventPayload {
  readonly activityId: EntityId;
  readonly code: string;
  readonly plannedDuration: number;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `schedule.dependencyAdded`. */
export interface DependencyAddedPayload extends ScheduleEventPayload {
  readonly dependencyId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: DependencyLinkType;
  readonly lagDays: number;
  readonly version: number;
}

/** Audit payload of `schedule.dependencyRemoved`. */
export interface DependencyRemovedPayload extends ScheduleEventPayload {
  readonly dependencyId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: DependencyLinkType;
  readonly version: number;
}

/** Audit payload of `schedule.milestoneAdded`. */
export interface MilestoneAddedPayload extends ScheduleEventPayload {
  readonly milestoneId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly boundActivityId: EntityId | null;
  readonly version: number;
}

/** Audit payload of `schedule.baselineSet` — the consequential baseline decision. */
export interface BaselineSetPayload extends ScheduleEventPayload {
  readonly baselineId: EntityId;
  readonly sequence: number;
  readonly label: string;
  readonly supersedes: EntityId | null;
  readonly activityCount: number;
  readonly dependencyCount: number;
  readonly milestoneCount: number;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `schedule.progressRecorded`. */
export interface ProgressRecordedPayload extends ScheduleEventPayload {
  readonly progressUpdateId: EntityId;
  readonly activityId: EntityId;
  readonly percentComplete: number;
  readonly remainingDuration: number;
  readonly actualStart: Timestamp | null;
  readonly actualFinish: Timestamp | null;
  readonly version: number;
}

/** The union of all schedule event payloads. */
export type ScheduleEventPayloads =
  | ScheduleCreatedPayload
  | ActivityAddedPayload
  | ActivityUpdatedPayload
  | DependencyAddedPayload
  | DependencyRemovedPayload
  | MilestoneAddedPayload
  | BaselineSetPayload
  | ProgressRecordedPayload;

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention): the correlation id of the causal chain is carried over; the
 * causation id of the resulting event is the COMMAND's idempotency key — the
 * id of the message that caused this mutation. Trusted path: the envelope was
 * already validated (the idempotency-key grammar is exactly the causation-id
 * grammar), so a parse failure here is a loud TypeError, never a silent drop.
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
 * Build one schedule event envelope (trusted path; self-checked through the
 * contracts parser so an emitted event can never be invalid): source is
 * 'domain' by definition, scope is the aggregate's owning project scope,
 * actor and causal chain come from the command, occurredAt from the injected
 * clock, and entityRefs carry before/after per the transition kind.
 */
export function scheduleEventEnvelope(
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly eventName: EventName;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly entityRefs: EntityRefs;
    readonly payload: ScheduleEventPayloads;
  },
): DomainEventEnvelope<ScheduleEventPayloads> {
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
      `schedule event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<ScheduleEventPayloads>;
}

/** Entity reference of the schedule root (before/after refs, A3). */
export const scheduleRef = (state: ScheduleState): EntityRef => ({
  entityKind: SCHEDULE_KIND,
  entityId: state.entityId,
});

/** Entity reference of an activity. */
export const activityRef = (activity: ActivityState): EntityRef => ({
  entityKind: ACTIVITY_KIND,
  entityId: activity.entityId,
});

/** Entity reference of a dependency link. */
export const dependencyRef = (dependency: DependencyState): EntityRef => ({
  entityKind: DEPENDENCY_KIND,
  entityId: dependency.entityId,
});

/** Entity reference of a milestone. */
export const milestoneRef = (milestone: MilestoneState): EntityRef => ({
  entityKind: MILESTONE_KIND,
  entityId: milestone.entityId,
});

/** Entity reference of a baseline. */
export const baselineRef = (baseline: BaselineState): EntityRef => ({
  entityKind: BASELINE_KIND,
  entityId: baseline.entityId,
});

/** Entity reference of a progress update record. */
export const progressUpdateRef = (update: ProgressUpdateState): EntityRef => ({
  entityKind: PROGRESS_UPDATE_KIND,
  entityId: update.entityId,
});

/**
 * THE EventSink port (minimal, by design — mirrored exactly from the landed
 * OFF-007 identity modules): append audit events using the caller's open
 * transaction executor, so a real implementation writes them atomically with
 * the mutation that produced them. The in-memory sink below records instead
 * of writing; the OFF-005 ledger implements this port (directly, or through
 * the thin adapter this package ships in ledger-sink.ts).
 */
export interface EventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation (handlers roll the transaction back),
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
