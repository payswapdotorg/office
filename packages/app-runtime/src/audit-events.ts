// Office app-runtime — audit events + THE AppEventSink port (OFF-026).
//
// The runtime's OWN audit trail (freeze A3/A4): every decision the app
// runtime makes emits an immutable DomainEventEnvelope — an installation
// lifecycle transition (installed/activated/suspended/revoked/uninstalled,
// carrying the lifecycle hooks the host must invoke), a command dispatched
// to the gateway, a command TYPED-REJECTED before the gateway (with the
// rejection reason — the suspension rejection is auditable here), an event
// delivered to an installation, or an event typed-rejected (again with the
// reason). The gateway's own decision trail (actions.actionExecuted etc.)
// is the gateway's concern; these events audit the RUNTIME's decisions.
//
// Causality conventions (mirroring the action gateway's):
// - command dispatch/rejection events are CAUSED BY the command —
//   causationId = the command's idempotency key, correlationId = the
//   command's correlation id;
// - event delivered/rejected records are CAUSED BY the event — causationId
//   = the event's causation id (its correlation id for chain roots),
//   correlationId = the event's correlation id;
// - lifecycle events carry the caller-supplied correlation id (the install
//   flow's chain) and an optional causation id (null = chain root).
//
// THE AppEventSink PORT mirrors the landed packages' EventSink shape
// byte-for-byte in structure (appendEvents(executor, events) inside the
// caller's transaction): the runtime hands its audit envelopes to an
// injected sink together with the caller's transaction executor, so a real
// implementation writes them atomically with the surrounding work. An
// append failure aborts the surrounding operation: no audit, no dispatch
// record, no committed effect.
import {
  CURRENT_SCHEMA_VERSION,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEventName,
} from '@office/contracts';
import type {
  Actor,
  CausationId,
  CommandEnvelope,
  CorrelationId,
  DomainEventEnvelope,
  EventName,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { AppLifecycleState } from './installation';
import type { LifecycleHookName } from './hooks';

const eventNameOf = (name: string): EventName => {
  const parsed = parseEventName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid app-runtime event name literal: ${name}`);
  }
  return parsed.value;
};

// ----- event name vocabulary ------------------------------------------------------------

/** Event name of the installed transition (installation created). */
export const APP_INSTALLED_EVENT: EventName = eventNameOf('apps.appInstalled');
/** Event name of the activated transition (incl. re-activation). */
export const APP_ACTIVATED_EVENT: EventName = eventNameOf('apps.appActivated');
/** Event name of the suspended transition (the STOP sign). */
export const APP_SUSPENDED_EVENT: EventName = eventNameOf('apps.appSuspended');
/** Event name of the revoked transition (terminal, one-way). */
export const APP_REVOKED_EVENT: EventName = eventNameOf('apps.appRevoked');
/** Event name of the uninstalled transition (terminal). */
export const APP_UNINSTALLED_EVENT: EventName = eventNameOf('apps.appUninstalled');
/** Event name of a command dispatched to the action gateway. */
export const APP_COMMAND_DISPATCHED_EVENT: EventName = eventNameOf('apps.appCommandDispatched');
/** Event name of a command typed-rejected BEFORE the gateway. */
export const APP_COMMAND_REJECTED_EVENT: EventName = eventNameOf('apps.appCommandRejected');
/** Event name of an event delivered to an installation. */
export const APP_EVENT_DELIVERED_EVENT: EventName = eventNameOf('apps.appEventDelivered');
/** Event name of an event typed-rejected (not delivered). */
export const APP_EVENT_REJECTED_EVENT: EventName = eventNameOf('apps.appEventRejected');

/** Every event name this module emits, in vocabulary order. */
export const APP_RUNTIME_EVENT_NAMES: readonly EventName[] = [
  APP_INSTALLED_EVENT,
  APP_ACTIVATED_EVENT,
  APP_SUSPENDED_EVENT,
  APP_REVOKED_EVENT,
  APP_UNINSTALLED_EVENT,
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
] as const;

/** Every lifecycle transition the runtime audits. */
export type AppLifecycleDecision = 'installed' | 'activated' | 'suspended' | 'revoked' | 'uninstalled';

/** Every runtime decision kind, in vocabulary order. */
export type AppRuntimeDecision =
  | AppLifecycleDecision
  | 'command-dispatched'
  | 'command-rejected'
  | 'event-delivered'
  | 'event-rejected';

/** Every decision kind, in vocabulary order. */
export const APP_RUNTIME_DECISIONS: readonly AppRuntimeDecision[] = [
  'installed',
  'activated',
  'suspended',
  'revoked',
  'uninstalled',
  'command-dispatched',
  'command-rejected',
  'event-delivered',
  'event-rejected',
] as const;

// ----- audit payloads --------------------------------------------------------------------

/**
 * The audit payload of a runtime decision: which installation (id, app,
 * tenant, lifecycle state at the decision), the decision, the command or
 * event involved (command name, symbolic handler, idempotency key / event
 * name, delivery id), the typed rejection reason (null unless rejected),
 * and the lifecycle hooks the host must invoke for a lifecycle transition.
 */
export interface AppRuntimeAuditPayload {
  readonly installationId: string;
  readonly appId: string;
  readonly tenantId: string;
  readonly installationState: AppLifecycleState;
  readonly decision: AppRuntimeDecision;
  readonly commandName: string | null;
  readonly handlerId: string | null;
  readonly idempotencyKey: string | null;
  readonly eventName: string | null;
  readonly reason: string | null;
  readonly deliveryId: string | null;
  readonly invokedHooks: readonly { readonly hook: LifecycleHookName; readonly handlerId: string }[];
}

// ----- the envelope builder ----------------------------------------------------------------

/** Inputs of the runtime audit envelope builder. */
export interface AppRuntimeAuditEventInputs {
  /** The event name of the decision. */
  readonly eventName: EventName;
  /** The audit payload of the decision. */
  readonly payload: AppRuntimeAuditPayload;
  /** The actor of the audited operation (the installation's 'app' actor). */
  readonly actor: Actor;
  /** The tenant scope of the installation. */
  readonly tenantId: TenantId;
  /** The correlation id of the audited chain. */
  readonly correlationId: CorrelationId;
  /** The causation id of the audited message, or null for chain roots. */
  readonly causationId: CausationId | null;
  /** The occurred-at instant (the injected now of the decision). */
  readonly occurredAt: Timestamp;
}



/**
 * Build one runtime audit event as a DomainEventEnvelope (source 'system' —
 * the runtime is platform execution machinery acting on behalf of the
 * installation's 'app' actor) and validate it against the canonical
 * contract: a builder that cannot produce a contract-valid envelope is a
 * loud programming error, never a silent malformed audit trail.
 */
export function appRuntimeEventEnvelope(
  inputs: AppRuntimeAuditEventInputs,
): DomainEventEnvelope<AppRuntimeAuditPayload> {
  const envelope = {
    kind: 'event',
    eventName: inputs.eventName,
    scope: { kind: 'tenant', tenantId: inputs.tenantId },
    actor: inputs.actor,
    source: 'system',
    causality: {
      correlationId: inputs.correlationId,
      causationId: inputs.causationId,
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: inputs.occurredAt,
    entityRefs: { before: null, after: null },
    payload: inputs.payload,
  } as const satisfies DomainEventEnvelope;
  const checked = parseDomainEventEnvelope(envelope);
  if (!checked.ok) {
    throw new TypeError(
      `app-runtime audit event failed its own contract: ${JSON.stringify(checked.error)}`,
    );
  }
  return checked.value as DomainEventEnvelope<AppRuntimeAuditPayload>;
}

/**
 * The causation id of a command-caused audit event: the command's
 * idempotency key — the audit event is CAUSED BY the command (the gateway's
 * causation convention). Idempotency keys satisfy the CausationId grammar by
 * construction; this re-validates fail-closed as defense in depth.
 */
export const commandCausationIdOf = (command: CommandEnvelope): CausationId => {
  const parsed = parseCausationId(command.idempotencyKey);
  if (!parsed.ok) {
    throw new TypeError(
      `command idempotency key '${command.idempotencyKey}' is not a valid causation id`,
    );
  }
  return parsed.value;
};

// ----- THE AppEventSink port (mirrors the landed packages byte-for-byte) -----------------

/**
 * THE AppEventSink port (minimal, by design): append runtime audit events
 * using the caller's open transaction executor, so a real implementation
 * writes them atomically with the surrounding operation's effects. A
 * failure result MUST abort the surrounding operation (no dispatch record,
 * no committed effect), so a partially-applied decision can never commit.
 */
export interface AppEventSink {
  appendEvents(
    executor: SqlExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedAppEventAppend {
  /** The executor the sink was handed (the open transaction in callers). */
  readonly executor: SqlExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory AppEventSink: records appends instead of writing (tests). */
export interface InMemoryAppEventSink extends AppEventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedAppEventAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory AppEventSink for deterministic tests. */
export function createInMemoryAppEventSink(): InMemoryAppEventSink {
  const appends: RecordedAppEventAppend[] = [];
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
export const appSinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `app event sink rejected the append: ${reason}`,
    [{ code: 'app-event-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingAppEventSink = (reason: string): AppEventSink => ({
  appendEvents: async () => fail(appSinkFailure(reason)),
});
