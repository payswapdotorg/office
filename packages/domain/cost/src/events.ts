// Office cost domain — audit events + the EventSink port (OFF-011).
//
// Freeze A3: every consequential domain mutation emits an immutable domain
// event carrying event name, tenant/project scope, actor, source, correlation
// and causation ids, schema version, occurred-at, and before/after entity
// references. This module defines the commercial event vocabulary (budget
// created/revised, cost item recorded, commitment created/amended/closed,
// invoice recorded, payment referenced) and the builder that turns a command
// envelope + the next state into a DomainEventEnvelope.
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
// implementation to satisfy every domain package structurally.
//
// Payload convention (consumed by the ledger-backed adapter): every cost
// event payload carries the owning aggregate-root id — budget events carry
// budgetId, commitment events carry commitmentId, invoice events carry
// invoiceId (plus the commitmentId they are billed against) — the
// ledger-assigned aggregate stream keys of the three roots.
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
  BudgetRevisionState,
  BudgetState,
  CommitmentKind,
  CommitmentLineSetState,
  CommitmentState,
  CostItemState,
  InvoiceState,
  PaymentReferenceState,
} from './state';
import {
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  COMMITMENT_AMENDMENT_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  INVOICE_KIND,
  PAYMENT_REFERENCE_KIND,
} from './state';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid cost event name literal: ${name}`);
  }
  return parsed.value;
};

/** Event name of the budget-created lifecycle event (A3 audit). */
export const BUDGET_CREATED_EVENT: EventName = eventNameOf('cost.budgetCreated');
/** Event name of the cost-item-recorded event (A3 audit). */
export const COST_ITEM_RECORDED_EVENT: EventName = eventNameOf('cost.costItemRecorded');
/** Event name of the budget-revised event (A3 audit) — the consequential re-anchoring decision. */
export const BUDGET_REVISED_EVENT: EventName = eventNameOf('cost.budgetRevised');
/** Event name of the commitment-created lifecycle event (A3 audit). */
export const COMMITMENT_CREATED_EVENT: EventName = eventNameOf('cost.commitmentCreated');
/** Event name of the commitment-amended event (A3 audit). */
export const COMMITMENT_AMENDED_EVENT: EventName = eventNameOf('cost.commitmentAmended');
/** Event name of the commitment-closed lifecycle event (A3 audit). */
export const COMMITMENT_CLOSED_EVENT: EventName = eventNameOf('cost.commitmentClosed');
/** Event name of the invoice-recorded event (A3 audit). */
export const INVOICE_RECORDED_EVENT: EventName = eventNameOf('cost.invoiceRecorded');
/** Event name of the payment-referenced event (A3 audit). */
export const PAYMENT_REFERENCED_EVENT: EventName = eventNameOf('cost.paymentReferenced');

/** Marker: every budget-domain event payload carries the owning budget id (the ledger aggregate key). */
export interface BudgetEventPayload {
  readonly budgetId: EntityId;
}

/** Audit payload of `cost.budgetCreated`. */
export interface BudgetCreatedPayload extends BudgetEventPayload {
  readonly name: string;
  readonly currency: string;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `cost.costItemRecorded`. */
export interface CostItemRecordedPayload extends BudgetEventPayload {
  readonly costItemId: EntityId;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
  readonly amountMinor: number;
  readonly version: number;
}

/** Audit payload of `cost.budgetRevised` — the consequential re-anchoring decision. */
export interface BudgetRevisedPayload extends BudgetEventPayload {
  readonly revisionId: EntityId;
  readonly sequence: number;
  readonly label: string;
  readonly supersedes: EntityId | null;
  readonly costItemCount: number;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `cost.commitmentCreated`. */
export interface CommitmentCreatedPayload {
  readonly commitmentId: EntityId;
  readonly budgetId: EntityId;
  readonly number: string;
  readonly commitmentKind: CommitmentKind;
  readonly description: string;
  readonly lineCount: number;
  readonly committedAmountMinor: number;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `cost.commitmentAmended`. */
export interface CommitmentAmendedPayload {
  readonly commitmentId: EntityId;
  readonly amendmentId: EntityId;
  readonly sequence: number;
  readonly reason: string | null;
  readonly lineCount: number;
  readonly committedAmountMinor: number;
  readonly version: number;
  readonly amendedAt: Timestamp;
}

/** Audit payload of `cost.commitmentClosed`. */
export interface CommitmentClosedPayload {
  readonly commitmentId: EntityId;
  readonly status: string;
  readonly closeReason: string;
  readonly closedAt: Timestamp;
  readonly version: number;
}

/** Audit payload of `cost.invoiceRecorded`. */
export interface InvoiceRecordedPayload {
  readonly invoiceId: EntityId;
  readonly commitmentId: EntityId;
  readonly number: string;
  readonly lineCount: number;
  readonly invoicedAmountMinor: number;
  readonly version: number;
  readonly createdAt: Timestamp;
}

/** Audit payload of `cost.paymentReferenced`. */
export interface PaymentReferencedPayload {
  readonly invoiceId: EntityId;
  readonly commitmentId: EntityId;
  readonly paymentReferenceId: EntityId;
  readonly reference: string;
  readonly amountMinor: number;
  readonly paidAt: Timestamp;
  readonly version: number;
  readonly recordedAt: Timestamp;
}

/** The union of all cost event payloads. */
export type CostEventPayloads =
  | BudgetCreatedPayload
  | CostItemRecordedPayload
  | BudgetRevisedPayload
  | CommitmentCreatedPayload
  | CommitmentAmendedPayload
  | CommitmentClosedPayload
  | InvoiceRecordedPayload
  | PaymentReferencedPayload;

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
 * Build one cost event envelope (trusted path; self-checked through the
 * contracts parser so an emitted event can never be invalid): source is
 * 'domain' by definition, scope is the aggregate's owning project scope,
 * actor and causal chain come from the command, occurredAt from the injected
 * clock, and entityRefs carry before/after per the transition kind.
 */
export function costEventEnvelope(
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly eventName: EventName;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly entityRefs: EntityRefs;
    readonly payload: CostEventPayloads;
  },
): DomainEventEnvelope<CostEventPayloads> {
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
      `cost event envelope failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<CostEventPayloads>;
}

/** Entity reference of the budget root (before/after refs, A3). */
export const budgetRef = (state: BudgetState): EntityRef => ({
  entityKind: BUDGET_KIND,
  entityId: state.entityId,
});

/** Entity reference of a cost item. */
export const costItemRef = (item: CostItemState): EntityRef => ({
  entityKind: COST_ITEM_KIND,
  entityId: item.entityId,
});

/** Entity reference of a budget revision. */
export const budgetRevisionRef = (revision: BudgetRevisionState): EntityRef => ({
  entityKind: BUDGET_REVISION_KIND,
  entityId: revision.entityId,
});

/** Entity reference of the commitment root. */
export const commitmentRef = (state: CommitmentState): EntityRef => ({
  entityKind: COMMITMENT_KIND,
  entityId: state.entityId,
});

/** Entity reference of a commitment amendment line set. */
export const commitmentAmendmentRef = (lineSet: CommitmentLineSetState): EntityRef => ({
  entityKind: COMMITMENT_AMENDMENT_KIND,
  entityId: lineSet.entityId,
});

/** Entity reference of the invoice root. */
export const invoiceRef = (state: InvoiceState): EntityRef => ({
  entityKind: INVOICE_KIND,
  entityId: state.entityId,
});

/** Entity reference of a payment reference record. */
export const paymentReferenceRef = (payment: PaymentReferenceState): EntityRef => ({
  entityKind: PAYMENT_REFERENCE_KIND,
  entityId: payment.entityId,
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
