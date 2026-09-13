// Office action gateway — audit events + THE EventSink port (OFF-017).
//
// The gateway's OWN audit trail (freeze A3/A4): every DECISION the gateway
// makes emits an immutable DomainEventEnvelope — executed, routed-to-approval,
// denied, duplicate-observed — carrying the actor, scope, causality
// (causationId = the proposal's idempotency key per the contracts causation
// convention: the audit event is caused by the command), the declared policy
// gate (required capabilities + policy reference), the proposal's A4
// provenance (evidence references + confidence), and the approval reference
// when one is involved. Handler-level domain events are the domain's own
// concern; these events audit the GATEWAY's decision trail.
//
// THE EventSink PORT (mirrored byte-for-byte in shape from the landed
// packages — @office/workflows mirrors it the same way; no cross-package port
// imports): the gateway hands its audit envelopes to an injected sink together
// with the caller's transaction executor, so a real implementation (the
// OFF-005 event ledger wired by the runtime) writes them atomically with the
// mutation in the SAME transaction. An append failure aborts the surrounding
// action: no audit, no idempotency record, no committed effect.
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEventName,
} from '@office/contracts';
import type {
  ActorKind,
  CausationId,
  CommandEnvelope,
  DomainEventEnvelope,
  EntityRef,
  EntityRefs,
  EventName,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { ActionClass } from './descriptor';
import type { ActionProposal } from './proposal';
import type { ApprovalReference } from './approval';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid action event name literal: ${name}`);
  }
  return parsed.value;
};

// ----- event name vocabulary --------------------------------------------------------------

/** Event name of the executed decision (the handler ran; effects committed). */
export const ACTION_EXECUTED_EVENT: EventName = eventNameOf('actions.actionExecuted');
/** Event name of the routed-to-approval decision (the approval awaits decision). */
export const ACTION_ROUTED_TO_APPROVAL_EVENT: EventName = eventNameOf(
  'actions.actionRoutedToApproval',
);
/** Event name of the denied decision (typed rejection before any execution). */
export const ACTION_DENIED_EVENT: EventName = eventNameOf('actions.actionDenied');
/** Event name of the duplicate-observed decision (a recorded outcome replayed). */
export const ACTION_DUPLICATE_OBSERVED_EVENT: EventName = eventNameOf(
  'actions.actionDuplicateObserved',
);

/** Every event name this module emits, in vocabulary order. */
export const ACTION_EVENT_NAMES: readonly EventName[] = [
  ACTION_EXECUTED_EVENT,
  ACTION_ROUTED_TO_APPROVAL_EVENT,
  ACTION_DENIED_EVENT,
  ACTION_DUPLICATE_OBSERVED_EVENT,
] as const;

// ----- audit payloads ---------------------------------------------------------------------

/** Every gateway decision kind, in vocabulary order. */
export type ActionDecision =
  | 'executed'
  | 'routed-to-approval'
  | 'denied'
  | 'duplicate-observed';

/** Every decision kind, in vocabulary order. */
export const ACTION_DECISIONS: readonly ActionDecision[] = [
  'executed',
  'routed-to-approval',
  'denied',
  'duplicate-observed',
] as const;

/**
 * The audit payload of a gateway decision: which command, its class, the
 * decision, the acting actor, the declared gate (capabilities + policy
 * reference), the proposal's A4 provenance (evidence references + confidence),
 * the approval reference + its status + decider when one is involved, the
 * reversibility contract, and whether a recorded outcome was replayed.
 */
export interface ActionAuditPayload {
  readonly commandName: string;
  readonly actionClass: ActionClass;
  readonly decision: ActionDecision;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly replayed: boolean;
  readonly denialCode: string | null;
  readonly requiredCapabilities: readonly string[];
  readonly policyRef: string | null;
  readonly confidence: string;
  readonly evidence: readonly { readonly slot: string; readonly ref: string }[];
  readonly approval: { readonly instanceId: string; readonly approvalKey: string } | null;
  readonly approvalStatus: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Timestamp | null;
  readonly compensatingCommand: string | null;
}

// ----- the envelope builder ----------------------------------------------------------------

/**
 * The causation id of a gateway audit event: the proposal's idempotency key —
 * the audit event is CAUSED BY the command (the contracts causation
 * convention). Idempotency keys satisfy the CausationId grammar by
 * construction; this re-validates fail-closed as defense in depth (a loud
 * TypeError, never a silent envelope corruption).
 */
const causationIdOf = (command: CommandEnvelope): CausationId => {
  const parsed = parseCausationId(command.idempotencyKey);
  if (!parsed.ok) {
    throw new TypeError(
      `action idempotency key '${command.idempotencyKey}' is not a valid causation id`,
    );
  }
  return parsed.value;
};

/** The before/after entity refs of a gateway event: the subject on both sides. */
const subjectRefsOf = (subject: EntityRef | null): EntityRefs => ({
  before: subject,
  after: subject,
});

/** Inputs of the audit envelope builder. */
export interface ActionAuditEventInputs {
  /** The proposal's command envelope (actor, scope, causality from it). */
  readonly command: CommandEnvelope;
  /** The event name of the decision. */
  readonly eventName: EventName;
  /** The audit payload of the decision. */
  readonly payload: ActionAuditPayload;
  /** The proposal's subject (entity refs), or null. */
  readonly subject: EntityRef | null;
  /** The occurred-at instant (the injected now of the decision). */
  readonly occurredAt: Timestamp;
}

/**
 * Build one gateway audit event as a DomainEventEnvelope (source 'system' —
 * the gateway is platform execution machinery acting on behalf of the
 * proposal's actor) and validate it against the canonical contract: a builder
 * that cannot produce a contract-valid envelope is a loud programming error,
 * never a silent malformed audit trail.
 */
export function actionEventEnvelope(
  inputs: ActionAuditEventInputs,
): DomainEventEnvelope<ActionAuditPayload> {
  const envelope = {
    kind: 'event',
    eventName: inputs.eventName,
    scope: inputs.command.scope,
    actor: inputs.command.actor,
    source: 'system',
    causality: {
      correlationId: inputs.command.causality.correlationId,
      causationId: causationIdOf(inputs.command),
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: inputs.occurredAt,
    entityRefs: subjectRefsOf(inputs.subject),
    payload: inputs.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `action audit event failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<ActionAuditPayload>;
}

/** Build the base payload fields shared by every decision of one proposal. */
export const auditPayloadBaseOf = (parts: {
  readonly proposal: ActionProposal;
  readonly commandName: string;
  readonly actionClass: ActionClass;
  readonly decision: ActionDecision;
  readonly requiredCapabilities: readonly string[];
  readonly policyRef: string | null;
  readonly compensatingCommand: string | null;
}): ActionAuditPayload => ({
  commandName: parts.commandName,
  actionClass: parts.actionClass,
  decision: parts.decision,
  actorKind: parts.proposal.command.actor.kind,
  actorId: parts.proposal.command.actor.kind === 'system' ? null : parts.proposal.command.actor.actorId,
  replayed: false,
  denialCode: null,
  requiredCapabilities: [...parts.requiredCapabilities],
  policyRef: parts.policyRef,
  confidence: parts.proposal.confidence,
  evidence: parts.proposal.evidence.map((reference) => ({
    slot: reference.slot,
    ref: reference.ref,
  })),
  approval: null,
  approvalStatus: null,
  decidedBy: null,
  decidedAt: null,
  compensatingCommand: parts.compensatingCommand,
});

/** Attach an approval reference (and its state) to an audit payload. */
export const withApprovalOnPayload = (
  payload: ActionAuditPayload,
  approval: ApprovalReference | null,
  approvalStatus: string | null,
  decidedBy: string | null = null,
  decidedAt: Timestamp | null = null,
): ActionAuditPayload => ({
  ...payload,
  approval:
    approval === null
      ? null
      : { instanceId: approval.instanceId, approvalKey: approval.approvalKey },
  approvalStatus,
  decidedBy,
  decidedAt,
});

// ----- THE EventSink port (mirrors the landed packages byte-for-byte) ---------------------

/**
 * THE EventSink port (minimal, by design): append gateway audit events using
 * the caller's open transaction executor, so a real implementation writes
 * them atomically with the action's effects. A failure result MUST abort the
 * surrounding action (the gateway rolls back — no idempotency record, no
 * committed effect), so a partially-applied action can never commit.
 */
export interface EventSink {
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
