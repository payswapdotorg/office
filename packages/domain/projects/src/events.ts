// Office project domain — audit events + the EventSink port (OFF-007).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the project lifecycle event vocabulary and
// the builder that turns a command envelope + the next state into a
// DomainEventEnvelope.
//
// The EventSink PORT (deliberately minimal): command handlers hand their
// envelope(s) to an injected sink TOGETHER with the repository writes, inside
// the SAME transaction — the sink receives the transaction's SqlExecutor so a
// real implementation (the OFF-005 event ledger, wired by the runtime) writes
// the ledger rows in that transaction and the whole mutation is atomic. This
// package ships an in-memory sink for tests. The port is mirrored (byte-for-
// byte in shape) in @office/domain-organization: the two domain packages stay
// independent (no domain-to-domain imports, dependency rule), and any
// transactional EventSink implementation satisfies both structurally.
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
import type { ProjectState, ProjectStatus } from './state';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid project event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the project-created lifecycle event (A3 audit). */
export const PROJECT_CREATED_EVENT: EventName = eventNameOf(
  'projects.projectCreated',
);
/** Event name of the project-updated lifecycle event (A3 audit). */
export const PROJECT_UPDATED_EVENT: EventName = eventNameOf(
  'projects.projectUpdated',
);
/** Event name of the project-archived lifecycle event (A3 audit). */
export const PROJECT_ARCHIVED_EVENT: EventName = eventNameOf(
  'projects.projectArchived',
);

/** Audit payload of `projects.projectCreated`. */
export interface ProjectCreatedPayload {
  readonly projectId: EntityId;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `projects.projectUpdated`. */
export interface ProjectUpdatedPayload {
  readonly projectId: EntityId;
  readonly name: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `projects.projectArchived`. */
export interface ProjectArchivedPayload {
  readonly projectId: EntityId;
  readonly status: ProjectStatus;
  readonly archivedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

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
 * Build one project lifecycle event envelope (trusted path; self-checked
 * through the contracts parser so an emitted event can never be invalid):
 * source is 'domain' by definition, scope is the aggregate's OWNING project
 * scope (the second boundary travels on every audit event), actor and causal
 * chain come from the command, occurredAt from the injected clock, and
 * entityRefs carry before/after per the transition kind.
 */
export function projectEventEnvelope(
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly eventName: EventName;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly entityRefs: EntityRefs;
    readonly payload:
      | ProjectCreatedPayload
      | ProjectUpdatedPayload
      | ProjectArchivedPayload;
  },
): DomainEventEnvelope<
  ProjectCreatedPayload | ProjectUpdatedPayload | ProjectArchivedPayload
> {
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
      `project event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<
    ProjectCreatedPayload | ProjectUpdatedPayload | ProjectArchivedPayload
  >;
}

/** Entity reference of a project state (before/after refs, A3). */
export const projectRef = (state: ProjectState): EntityRef => ({
  entityKind: state.entityKind,
  entityId: state.entityId,
});

/**
 * THE EventSink port (minimal, by design): append audit events using the
 * caller's open transaction executor, so a real implementation writes them
 * atomically with the mutation that produced them. The in-memory sink below
 * records instead of writing; the OFF-005 ledger implements this port later.
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
