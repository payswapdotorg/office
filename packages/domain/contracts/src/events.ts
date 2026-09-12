// Office contracts/change domain — audit events + the EventSink port (OFF-012).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the contracts/change event vocabulary
// (contract created/updated/archived, obligation recorded, change event
// raised/linked, change order submitted/approved/rejected/executed, claim
// referenced) and the builder that turns a command envelope + the next state
// into a DomainEventEnvelope.
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
// Payload convention (consumed by the ledger-backed adapter): every
// contracts-domain event payload carries the owning contractId — the
// ledger-assigned aggregate stream key of the commercial aggregate (the
// contract root owns its whole commercial stream: obligations, change
// events, change orders and claim references all belong to a contract).
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
  ChangeEventState,
  ChangeOrderState,
  ClaimReferenceState,
  ContractState,
  ScopeObligationState,
} from './state';
import {
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  CONTRACT_KIND,
  SCOPE_OBLIGATION_KIND,
} from './state';
import type { Money } from './parse';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid contracts-domain event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the contract-created lifecycle event (A3 audit). */
export const CONTRACT_CREATED_EVENT: EventName = eventNameOf('contracts.contractCreated');
/** Event name of the contract-updated lifecycle event (A3 audit). */
export const CONTRACT_UPDATED_EVENT: EventName = eventNameOf('contracts.contractUpdated');
/** Event name of the contract-archived lifecycle event (A3 audit) — the one-way archive. */
export const CONTRACT_ARCHIVED_EVENT: EventName = eventNameOf('contracts.contractArchived');
/** Event name of the obligation-recorded event (A3 audit). */
export const OBLIGATION_RECORDED_EVENT: EventName = eventNameOf('contracts.obligationRecorded');
/** Event name of the change-event-raised event (A3 audit). */
export const CHANGE_EVENT_RAISED_EVENT: EventName = eventNameOf('contracts.changeEventRaised');
/** Event name of the change-event-linked event (A3 audit) — appended typed links. */
export const CHANGE_EVENT_LINKED_EVENT: EventName = eventNameOf('contracts.changeEventLinked');
/** Event name of the change-order-submitted event (A3 audit). */
export const CHANGE_ORDER_SUBMITTED_EVENT: EventName = eventNameOf('contracts.changeOrderSubmitted');
/** Event name of the change-order-approved event (A3 audit). */
export const CHANGE_ORDER_APPROVED_EVENT: EventName = eventNameOf('contracts.changeOrderApproved');
/** Event name of the change-order-rejected event (A3 audit). */
export const CHANGE_ORDER_REJECTED_EVENT: EventName = eventNameOf('contracts.changeOrderRejected');
/** Event name of the change-order-executed event (A3 audit) — the supersession of the proposed state. */
export const CHANGE_ORDER_EXECUTED_EVENT: EventName = eventNameOf('contracts.changeOrderExecuted');
/** Event name of the claim-referenced event (A3 audit). */
export const CLAIM_REFERENCED_EVENT: EventName = eventNameOf('contracts.claimReferenced');

/** Marker: every contracts-domain event payload carries the owning contract id (the ledger aggregate key). */
export interface ContractsEventPayload {
  readonly contractId: EntityId;
}

/** Audit payload of `contracts.contractCreated`. */
export interface ContractCreatedPayload extends ContractsEventPayload {
  readonly title: string;
  readonly version: number;
  readonly contractValue: Money;
  readonly executionStatus: string;
  readonly createdAt: Timestamp;
}

/** Audit payload of `contracts.contractUpdated`. */
export interface ContractUpdatedPayload extends ContractsEventPayload {
  readonly title: string;
  readonly executionStatus: string;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `contracts.contractArchived` — the explicit one-way archive. */
export interface ContractArchivedPayload extends ContractsEventPayload {
  readonly lifecycleStatus: string;
  readonly archivedAt: Timestamp;
  readonly version: number;
  readonly updatedAt: Timestamp;
}

/** Audit payload of `contracts.obligationRecorded`. */
export interface ObligationRecordedPayload extends ContractsEventPayload {
  readonly obligationId: EntityId;
  readonly code: string;
  readonly quantity: string;
  readonly unit: string;
  readonly version: number;
}

/** Audit payload of `contracts.changeEventRaised` — the full recorded link set (ids and refs ONLY). */
export interface ChangeEventRaisedPayload extends ContractsEventPayload {
  readonly changeEventId: EntityId;
  readonly title: string;
  readonly changeType: string;
  readonly status: string;
  readonly affectedObligationIds: readonly EntityId[];
  readonly evidenceLinks: readonly {
    readonly documentId: EntityId;
    readonly revisionId: EntityId;
  }[];
  readonly costImpactLinks: readonly {
    readonly budgetId: EntityId | null;
    readonly costItemId: EntityId | null;
  }[];
  readonly scheduleImpactActivityIds: readonly EntityId[];
  readonly version: number;
}

/** Audit payload of `contracts.changeEventLinked` — the appended link entries (ids and refs ONLY). */
export interface ChangeEventLinkedPayload extends ContractsEventPayload {
  readonly changeEventId: EntityId;
  readonly addedObligationIds: readonly EntityId[];
  readonly addedEvidenceLinks: readonly {
    readonly documentId: EntityId;
    readonly revisionId: EntityId;
  }[];
  readonly addedCostImpactLinks: readonly {
    readonly budgetId: EntityId | null;
    readonly costItemId: EntityId | null;
  }[];
  readonly addedActivityIds: readonly EntityId[];
  readonly version: number;
}

/** Audit payload of `contracts.changeOrderSubmitted`. */
export interface ChangeOrderSubmittedPayload extends ContractsEventPayload {
  readonly changeOrderId: EntityId;
  readonly changeEventId: EntityId;
  readonly title: string;
  readonly changeValue: Money | null;
  readonly status: string;
  readonly version: number;
}

/** Audit payload of `contracts.changeOrderApproved`. */
export interface ChangeOrderApprovedPayload extends ContractsEventPayload {
  readonly changeOrderId: EntityId;
  readonly status: string;
  readonly decidedAt: Timestamp;
  readonly version: number;
}

/** Audit payload of `contracts.changeOrderRejected`. */
export interface ChangeOrderRejectedPayload extends ContractsEventPayload {
  readonly changeOrderId: EntityId;
  readonly status: string;
  readonly decidedAt: Timestamp;
  readonly version: number;
}

/**
 * Audit payload of `contracts.changeOrderExecuted` — the consequential
 * transition: the approved order executes AND supersedes its originating
 * change event's proposed state in the same unit of work.
 */
export interface ChangeOrderExecutedPayload extends ContractsEventPayload {
  readonly changeOrderId: EntityId;
  readonly changeEventId: EntityId;
  readonly status: string;
  readonly changeEventStatus: string;
  readonly changeEventVersion: number;
  readonly executedAt: Timestamp;
  readonly version: number;
}

/** Audit payload of `contracts.claimReferenced`. */
export interface ClaimReferencedPayload extends ContractsEventPayload {
  readonly claimReferenceId: EntityId;
  readonly claimEntityKind: string;
  readonly claimEntityId: EntityId;
  readonly changeOrderId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

/** The union of all contracts-domain event payloads. */
export type ContractsEventPayloads =
  | ContractCreatedPayload
  | ContractUpdatedPayload
  | ContractArchivedPayload
  | ObligationRecordedPayload
  | ChangeEventRaisedPayload
  | ChangeEventLinkedPayload
  | ChangeOrderSubmittedPayload
  | ChangeOrderApprovedPayload
  | ChangeOrderRejectedPayload
  | ChangeOrderExecutedPayload
  | ClaimReferencedPayload;

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
 * Build one contracts-domain event envelope (trusted path; self-checked
 * through the contracts parser so an emitted event can never be invalid):
 * source is 'domain' by definition, scope is the aggregate's owning project
 * scope, actor and causal chain come from the command, occurredAt from the
 * injected clock, and entityRefs carry before/after per the transition kind.
 */
export function contractsEventEnvelope(
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly eventName: EventName;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly entityRefs: EntityRefs;
    readonly payload: ContractsEventPayloads;
  },
): DomainEventEnvelope<ContractsEventPayloads> {
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
      `contracts-domain event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<ContractsEventPayloads>;
}

/** Entity reference of the contract root (before/after refs, A3). */
export const contractRef = (state: ContractState): EntityRef => ({
  entityKind: CONTRACT_KIND,
  entityId: state.entityId,
});

/** Entity reference of a scope obligation. */
export const obligationRef = (obligation: ScopeObligationState): EntityRef => ({
  entityKind: SCOPE_OBLIGATION_KIND,
  entityId: obligation.entityId,
});

/** Entity reference of a change event. */
export const changeEventRef = (changeEvent: ChangeEventState): EntityRef => ({
  entityKind: CHANGE_EVENT_KIND,
  entityId: changeEvent.entityId,
});

/** Entity reference of a change order. */
export const changeOrderRef = (changeOrder: ChangeOrderState): EntityRef => ({
  entityKind: CHANGE_ORDER_KIND,
  entityId: changeOrder.entityId,
});

/** Entity reference of a claim reference. */
export const claimReferenceRef = (reference: ClaimReferenceState): EntityRef => ({
  entityKind: CLAIM_REFERENCE_KIND,
  entityId: reference.entityId,
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
