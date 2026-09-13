// Office app-runtime — gateway-mediated dispatch (OFF-026).
//
// THE two dispatch engines of the sandbox boundary:
//
// - appCommandDispatch (installation + binding + command envelope → the
//   action gateway): EVERY gate below runs BEFORE executeAction() is ever
//   reached, so an app can never touch an undeclared capability, another
//   tenant, or a non-active lifecycle:
//     1. LIFECYCLE — only an ACTIVE installation dispatches (suspended
//        receives NO commands; revoked/uninstalled/installing never do);
//     2. BINDING — the envelope's command name must equal the binding's;
//     3. ACTOR — the envelope's actor must be exactly the installation's
//        own 'app' actor (no spoofing user/system/other installations);
//     4. TENANT (A12, both directions) — the command's scope tenant must
//        equal the installation's tenant, and so must the proposal's
//        resource scope when the caller knows it;
//     5. CLASSIFICATION — the command must resolve against the injected
//        action-descriptor source (unknown commands never reach the
//        gateway's fail-closed classifier);
//     6. A9 GRANTS — every required capability of the action must be held
//        by a LIVE grant OF THIS INSTALLATION (a foreign permission record
//        is a typed wiring defect, never a usable grant).
//   The proposal then travels through THE gateway (freeze A8 — the only
//   mutation path) with the installation's live grant capabilities and the
//   host's policy; the gateway's decision is recorded VERBATIM.
//
// - appEventDispatch (installation + subscription + event → the typed
//   delivery record): the same lifecycle/tenant discipline plus the typed
//   subscription filter, with the A9 grants RE-CHECKED at delivery time
//   (the event's area read capability must be live-granted). Delivery is
//   at-least-once (freeze A3): consumers must be idempotent.
//
// Both engines are FULLY AUDITED (DomainEventEnvelope audit events through
// the AppEventSink port): every dispatched command, every typed pre-gateway
// rejection (with its reason — the suspension rejection is auditable),
// every delivered event, and every typed event rejection.
import { parseCausationId, parseCommandEnvelope, parseDomainEventEnvelope } from '@office/contracts';
import type {
  CausationId,
  CommandEnvelope,
  CommandName,
  CorrelationId,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  EventName,
  IdempotencyKey,
  Scope,
  Timestamp,
} from '@office/contracts';
import type { Policy } from '@office/authz';
import { actionProposal } from '@office/actions';
import type {
  ActionGateway,
  ConfidenceLevel,
  ApprovalReference,
} from '@office/actions';
import type {
  ActionDescriptorSource,
  AppHandlerId,
  AppId,
  CommandBinding,
  EventSubscription,
  Permission,
} from '@office/app-sdk';
import type { EventSubscriptionFilter } from '@office/app-sdk';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { AppInstallation } from './installation';
import { installationActor, isInstallationDispatchable } from './installation';
import type { AppLifecycleState } from './installation';
import {
  checkInstallationCapabilities,
  requiredCapabilityOfEvent,
} from './permissions';
import {
  APP_COMMAND_DISPATCHED_EVENT,
  APP_COMMAND_REJECTED_EVENT,
  APP_EVENT_DELIVERED_EVENT,
  APP_EVENT_REJECTED_EVENT,
  appRuntimeEventEnvelope,
  commandCausationIdOf,
} from './audit-events';
import type {
  AppEventSink,
  AppRuntimeAuditPayload,
} from './audit-events';

// ----- rejection vocabularies ------------------------------------------------------------

/** Every typed pre-gateway rejection reason of the command path. */
export const APP_COMMAND_REJECTION_REASONS = [
  'installation-installing',
  'installation-suspended',
  'installation-revoked',
  'installation-uninstalled',
  'binding-command-mismatch',
  'actor-not-installation',
  'cross-tenant-scope',
  'unknown-command',
  'capability-not-granted',
  'capability-revoked',
  'permission-foreign',
  'invalid-envelope',
] as const;

/** A typed pre-gateway rejection reason of the command path. */
export type AppCommandRejectionReason = (typeof APP_COMMAND_REJECTION_REASONS)[number];

/** Every typed rejection reason of the event path. */
export const APP_EVENT_REJECTION_REASONS = [
  'installation-installing',
  'installation-suspended',
  'installation-revoked',
  'installation-uninstalled',
  'subscription-mismatch',
  'cross-tenant-scope',
  'filter-not-matched',
  'event-area-capability-unknown',
  'capability-not-granted',
  'capability-revoked',
  'permission-foreign',
  'invalid-envelope',
] as const;

/** A typed rejection reason of the event path. */
export type AppEventRejectionReason = (typeof APP_EVENT_REJECTION_REASONS)[number];

// ----- deps + inputs ---------------------------------------------------------------------

/**
 * The wiring dependencies of both dispatch engines: THE action gateway
// (executeAction — the only mutation path), the action-descriptor source
// (the classification + required-capability lookup the A9 gate needs, the
 * same port the app-sdk validation uses), the audit-event sink + the
 * caller's transaction executor, the host's deny-by-default policy, and
 * the injected clock and delivery-id supplier (determinism: no wall clock,
 * no randomness).
 */
export interface AppDispatchDeps {
  /** THE action gateway: executeAction is the ONLY mutation path (A8). */
  readonly gateway: ActionGateway;
  /** The known actions (command classification + required capabilities). */
  readonly actions: ActionDescriptorSource;
  /** The runtime's own audit-event sink. */
  readonly sink: AppEventSink;
  /** The executor (transaction handle) the sink appends with. */
  readonly executor: SqlExecutor;
  /** The host's static, deny-by-default policy (A8: no app bypasses it). */
  readonly policy: Policy;
  /** Injected clock: the canonical 'now' of each decision. */
  readonly now: () => Timestamp;
  /** Injected delivery-id supplier (typed delivery records). */
  readonly newDeliveryId: () => EntityId;
}

/** The A4 provenance + addressing an app command dispatch carries. */
export interface AppCommandDispatchInput {
  /** The typed command envelope (actor must be the installation's). */
  readonly command: CommandEnvelope;
  /** The A4 evidence references the proposal carries. */
  readonly evidence?: readonly { readonly slot: string; readonly ref: string }[];
  /** The proposal's A4 confidence level. */
  readonly confidence: ConfidenceLevel;
  /** The entity the action is about, or null. */
  readonly subject?: EntityRef | null;
  /** The target resource's owning scope when known, or null. */
  readonly resourceScope?: Scope | null;
}

// ----- records ----------------------------------------------------------------------------

/** The verbatim outcome of one dispatched app command. */
export type AppCommandOutcome =
  | { readonly decision: 'executed'; readonly replayed: boolean; readonly value: unknown }
  | {
      readonly decision: 'routed-to-approval';
      readonly replayed: boolean;
      readonly approval: ApprovalReference;
    }
  | { readonly decision: 'denied'; readonly denial: DomainError };

/**
 * The typed record of one app command dispatch: which installation (its
 * app identity), which binding (command + symbolic handler), which
 * idempotency key, when the dispatch happened, and the gateway's decision
 * recorded VERBATIM (executed / routed-to-approval / denied).
 */
export interface AppCommandDispatchRecord {
  readonly kind: 'app-command-dispatch';
  readonly installationId: EntityId;
  readonly appId: AppId;
  readonly commandName: CommandName;
  readonly handlerId: AppHandlerId;
  readonly idempotencyKey: IdempotencyKey;
  readonly dispatchedAt: Timestamp;
  readonly outcome: AppCommandOutcome;
}

/**
 * The typed record of one event delivery to an installation: which
 * installation, which subscription (event name + the filter that matched),
 * the delivery identity, when it was delivered, and the delivered event's
 * own identity (occurred-at + causality) for the consumer's idempotency.
 */
export interface AppEventDeliveryRecord {
  readonly kind: 'app-event-delivery';
  readonly deliveryId: EntityId;
  readonly installationId: EntityId;
  readonly appId: AppId;
  readonly eventName: EventName;
  readonly filter: EventSubscriptionFilter;
  readonly deliveredAt: Timestamp;
  readonly eventOccurredAt: Timestamp;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
}

// ----- shared helpers ---------------------------------------------------------------------

const dispatchContext = (
  installation: AppInstallation,
  correlationId: CorrelationId,
): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: installation.tenantId },
  correlationId,
});

/** Build the typed lifecycle rejection for a non-active installation. */
const lifecycleRejection = (
  installation: AppInstallation,
  correlationId: CorrelationId,
): Result<never, DomainError> =>
  fail(
    domainError(
      'forbidden',
      `installation ${installation.installationId} of app '${installation.appId}' is ${installation.state} — only an active installation dispatches commands and receives events (A7 suspend/revoke semantics)`,
      [
        {
          code: `installation-${installation.state}`,
          message: installation.installationId,
          path: 'state',
        },
      ],
      dispatchContext(installation, correlationId),
    ),
  );

/** The reason literal of a lifecycle rejection ('installation-suspended' etc.). */
const lifecycleReason = (installation: {
  readonly state: AppLifecycleState;
}): `installation-${AppLifecycleState}` => `installation-${installation.state}`;

/** Append one runtime audit event through the sink (typed passthrough). */
const audit = async (
  deps: AppDispatchDeps,
  event: DomainEventEnvelope<AppRuntimeAuditPayload>,
): Promise<Result<true, DomainError>> =>
  deps.sink.appendEvents(deps.executor, [event]);

/** The base audit payload of any decision about one installation. */
const payloadBaseOf = (installation: AppInstallation): AppRuntimeAuditPayload => ({
  installationId: installation.installationId,
  appId: installation.appId,
  tenantId: installation.tenantId,
  installationState: installation.state,
  decision: 'command-dispatched',
  commandName: null,
  handlerId: null,
  idempotencyKey: null,
  eventName: null,
  reason: null,
  deliveryId: null,
  invokedHooks: [],
});

/**
 * Does the subscription's typed filter match the event? 'all' matches every
 * occurrence; an 'entity-kind' filter matches when the occurrence's entity
 * reference (after, else before) carries the declared kind — events bound
 * to no entity never match an entity-kind filter.
 */
export function matchEventSubscription(
  subscription: Pick<EventSubscription, 'filter'>,
  event: Pick<DomainEventEnvelope, 'entityRefs'>,
): boolean {
  if (subscription.filter.kind === 'all') return true;
  const occurrence = event.entityRefs.after ?? event.entityRefs.before;
  return occurrence !== null && occurrence.entityKind === subscription.filter.entityKind;
}

// ----- THE command dispatch engine ---------------------------------------------------------

/**
 * Dispatch one app command through THE gateway (freeze A8 — the only
 * mutation path). Every gate (lifecycle, binding, actor, tenant,
 * classification, A9 grants) runs BEFORE the gateway is reached; the
 * gateway's decision is recorded verbatim; every decision (dispatched or
 * typed-rejected, with its reason) is audited through the AppEventSink
 * port. A sink failure aborts the dispatch: no record, no gateway call
 * side effects are claimed.
 */
export async function appCommandDispatch(
  deps: AppDispatchDeps,
  installation: AppInstallation,
  permissions: readonly Permission[],
  binding: CommandBinding,
  input: AppCommandDispatchInput,
): Promise<Result<AppCommandDispatchRecord, DomainError>> {
  const command = input.command;
  const correlationId = command.causality.correlationId;
  const occurredAt = deps.now();

  // 0. The envelope must parse (fail-closed boundary on the wide world).
  const envelope = parseCommandEnvelope(command);
  if (!envelope.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `the command envelope does not satisfy the canonical contract: ${envelope.error.code} at '${envelope.error.path}'`,
        [{ code: 'invalid-envelope', message: envelope.error.code, path: envelope.error.path }],
      ),
    );
  }

  // 1. LIFECYCLE — only an active installation dispatches (audited).
  if (!isInstallationDispatchable(installation)) {
    const rejection = lifecycleRejection(installation, correlationId);
    const appended = await audit(
      deps,
      appRuntimeEventEnvelope({
        eventName: APP_COMMAND_REJECTED_EVENT,
        payload: {
          ...payloadBaseOf(installation),
          decision: 'command-rejected',
          commandName: command.commandName,
          handlerId: binding.handler.handlerId,
          idempotencyKey: command.idempotencyKey,
          reason: lifecycleReason(installation),
        },
        actor: installationActor(installation),
        tenantId: installation.tenantId,
        correlationId,
        causationId: commandCausationIdOf(command),
        occurredAt,
      }),
    );
    if (!appended.ok) return appended;
    return rejection;
  }

  // 2. BINDING — the envelope serves the binding's command.
  if (command.commandName !== binding.commandName) {
    return rejectCommand(deps, installation, binding, command, occurredAt, 'binding-command-mismatch', domainError(
      'invariant-violation',
      `dispatch for command '${command.commandName}' does not match binding '${binding.commandName}' of installation ${installation.installationId}`,
      [
        {
          code: 'binding-command-mismatch',
          message: `${command.commandName} vs ${binding.commandName}`,
          path: 'command.commandName',
        },
      ],
      dispatchContext(installation, correlationId),
    ));
  }

  // 3. ACTOR — the installation's own 'app' actor, never a spoofed one.
  const actorIsInstallation =
    command.actor.kind === 'app' && command.actor.actorId === installation.installationId;
  if (!actorIsInstallation) {
    return rejectCommand(deps, installation, binding, command, occurredAt, 'actor-not-installation', domainError(
      'forbidden',
      `the command actor must be the installation's own 'app' actor ${installation.installationId} — an app command never carries another identity`,
      [
        {
          code: 'actor-not-installation',
          message: installation.installationId,
          path: 'command.actor',
        },
      ],
      dispatchContext(installation, correlationId),
    ));
  }

  // 4. TENANT (A12, both directions) — command scope AND resource scope.
  if (command.scope.tenantId !== installation.tenantId) {
    return rejectCommand(deps, installation, binding, command, occurredAt, 'cross-tenant-scope', domainError(
      'unauthorized',
      `installation ${installation.installationId} of tenant ${installation.tenantId} cannot dispatch into tenant ${command.scope.tenantId}'s scope (A12)`,
      [
        {
          code: 'cross-tenant-scope',
          message: `installation tenant ${installation.tenantId}, command tenant ${command.scope.tenantId}`,
          path: 'command.scope.tenantId',
        },
      ],
      dispatchContext(installation, command.causality.correlationId),
    ));
  }
  const resourceScope = input.resourceScope ?? null;
  if (resourceScope !== null && resourceScope.tenantId !== installation.tenantId) {
    return rejectCommand(deps, installation, binding, command, occurredAt, 'cross-tenant-scope', domainError(
      'unauthorized',
      `installation ${installation.installationId} of tenant ${installation.tenantId} cannot address a resource of tenant ${resourceScope.tenantId} (A12)`,
      [
        {
          code: 'cross-tenant-scope',
          message: `installation tenant ${installation.tenantId}, resource tenant ${resourceScope.tenantId}`,
          path: 'resourceScope.tenantId',
        },
      ],
      dispatchContext(installation, correlationId),
    ));
  }

  // 5. CLASSIFICATION — the command must be a known action.
  const action = deps.actions.find(binding.commandName);
  if (action === null) {
    return rejectCommand(deps, installation, binding, command, occurredAt, 'unknown-command', domainError(
      'not-found',
      `command '${binding.commandName}' has no registered action descriptor — an app command never reaches the gateway unclassified`,
      [
        {
          code: 'unknown-command',
          message: binding.commandName,
          path: 'command.commandName',
        },
      ],
      dispatchContext(installation, correlationId),
    ));
  }

  // 6. A9 GRANTS — live grants of THIS installation cover every required
  //    capability, BEFORE the gateway (the named acceptance).
  const grants = checkInstallationCapabilities(
    installation,
    permissions,
    action.requiredCapabilities,
  );
  if (!grants.ok) {
    const reason = grants.error.details[0]?.code ?? 'capability-not-granted';
    return rejectCommand(deps, installation, binding, command, occurredAt, reason, grants.error);
  }

  // 7. THE GATEWAY — freeze A8: the only mutation path, with the
  //    installation's live grant capabilities and the host's policy.
  const proposal = actionProposal({
    command,
    subject: input.subject ?? null,
    evidence: input.evidence ?? [],
    confidence: input.confidence,
    resourceScope,
    approval: null,
  });
  const decided = await deps.gateway.executeAction(proposal, {
    policy: deps.policy,
    capabilities: [...grants.value],
  });
  const outcome: AppCommandOutcome = decided.ok
    ? decided.value.decision === 'executed'
      ? { decision: 'executed', replayed: decided.value.replayed, value: decided.value.value }
      : {
          decision: 'routed-to-approval',
          replayed: decided.value.replayed,
          approval: decided.value.approval,
        }
    : { decision: 'denied', denial: decided.error };

  // 8. AUDIT + the typed dispatch record (decision verbatim).
  const dispatchedAt = deps.now();
  const appended = await audit(
    deps,
    appRuntimeEventEnvelope({
      eventName: APP_COMMAND_DISPATCHED_EVENT,
      payload: {
        ...payloadBaseOf(installation),
        decision: 'command-dispatched',
        commandName: command.commandName,
        handlerId: binding.handler.handlerId,
        idempotencyKey: command.idempotencyKey,
        reason: null,
      },
      actor: installationActor(installation),
      tenantId: installation.tenantId,
      correlationId,
      causationId: commandCausationIdOf(command),
      occurredAt: dispatchedAt,
    }),
  );
  if (!appended.ok) return appended;
  return ok({
    kind: 'app-command-dispatch',
    installationId: installation.installationId,
    appId: installation.appId,
    commandName: command.commandName,
    handlerId: binding.handler.handlerId,
    idempotencyKey: command.idempotencyKey,
    dispatchedAt,
    outcome,
  } satisfies AppCommandDispatchRecord);
}

/** Audit one typed command rejection, then return it. */
const rejectCommand = async (
  deps: AppDispatchDeps,
  installation: AppInstallation,
  binding: CommandBinding,
  command: CommandEnvelope,
  occurredAt: Timestamp,
  reason: string,
  error: DomainError,
): Promise<Result<AppCommandDispatchRecord, DomainError>> => {
  const appended = await audit(
    deps,
    appRuntimeEventEnvelope({
      eventName: APP_COMMAND_REJECTED_EVENT,
      payload: {
        ...payloadBaseOf(installation),
        decision: 'command-rejected',
        commandName: command.commandName,
        handlerId: binding.handler.handlerId,
        idempotencyKey: command.idempotencyKey,
        reason,
      },
      actor: installationActor(installation),
      tenantId: installation.tenantId,
      correlationId: command.causality.correlationId,
      causationId: commandCausationIdOf(command),
      occurredAt,
    }),
  );
  if (!appended.ok) return appended;
  return fail(error);
};

// ----- THE event dispatch engine -----------------------------------------------------------

/**
 * Deliver one canonical event to one installation's subscription: the typed
 * delivery record. The same discipline as the command path — lifecycle (a
 * suspended installation receives NO events), subscription consistency,
 * tenant scope (A12, both directions), the typed filter, and the A9 grants
 * RE-CHECKED at delivery (the event's area read capability must be
 * live-granted). Delivery is at-least-once (freeze A3): consumers must be
 * idempotent. Every decision is audited.
 */
export async function appEventDispatch(
  deps: AppDispatchDeps,
  installation: AppInstallation,
  permissions: readonly Permission[],
  subscription: EventSubscription,
  event: DomainEventEnvelope,
): Promise<Result<AppEventDeliveryRecord, DomainError>> {
  const correlationId = event.causality.correlationId;
  // The delivery/rejection audit event is CAUSED BY the delivered event:
  // its causation id when chained, its correlation id for chain roots.
  const causationId = parseCausationIdValue(
    event.causality.causationId ?? event.causality.correlationId,
  );
  const occurredAt = deps.now();

  // 0. The event envelope must parse (fail-closed boundary).
  const envelope = parseDomainEventEnvelope(event);
  if (!envelope.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `the event envelope does not satisfy the canonical contract: ${envelope.error.code} at '${envelope.error.path}'`,
        [{ code: 'invalid-envelope', message: envelope.error.code, path: envelope.error.path }],
      ),
    );
  }

  // 1. LIFECYCLE — a suspended installation receives NO events (audited).
  if (!isInstallationDispatchable(installation)) {
    const rejection = lifecycleRejection(installation, correlationId);
    const appended = await audit(
      deps,
      appRuntimeEventEnvelope({
        eventName: APP_EVENT_REJECTED_EVENT,
        payload: {
          ...payloadBaseOf(installation),
          decision: 'event-rejected',
          eventName: event.eventName,
          reason: lifecycleReason(installation),
        },
        actor: installationActor(installation),
        tenantId: installation.tenantId,
        correlationId,
        causationId,
        occurredAt,
      }),
    );
    if (!appended.ok) return appended;
    return rejection;
  }

  // 2. SUBSCRIPTION — the event must be the subscribed one.
  if (event.eventName !== subscription.eventName) {
    return rejectEvent(
      deps,
      installation,
      event,
      correlationId,
      causationId,
      occurredAt,
      'subscription-mismatch',
      domainError(
        'invariant-violation',
        `event '${event.eventName}' does not match subscription '${subscription.eventName}' of installation ${installation.installationId}`,
        [
          {
            code: 'subscription-mismatch',
            message: `${event.eventName} vs ${subscription.eventName}`,
            path: 'event.eventName',
          },
        ],
        dispatchContext(installation, correlationId),
      ),
    );
  }

  // 3. TENANT (A12, both directions) — the event's scope tenant.
  if (event.scope.tenantId !== installation.tenantId) {
    return rejectEvent(
      deps,
      installation,
      event,
      correlationId,
      causationId,
      occurredAt,
      'cross-tenant-scope',
      domainError(
        'unauthorized',
        `installation ${installation.installationId} of tenant ${installation.tenantId} cannot receive an event of tenant ${event.scope.tenantId}'s scope (A12)`,
        [
          {
            code: 'cross-tenant-scope',
            message: `installation tenant ${installation.tenantId}, event tenant ${event.scope.tenantId}`,
            path: 'event.scope.tenantId',
          },
        ],
        dispatchContext(installation, correlationId),
      ),
    );
  }

  // 4. FILTER — the typed subscription filter must match the occurrence.
  if (!matchEventSubscription(subscription, event)) {
    return rejectEvent(
      deps,
      installation,
      event,
      correlationId,
      causationId,
      occurredAt,
      'filter-not-matched',
      domainError(
        'invariant-violation',
        `event '${event.eventName}' does not match the subscription's typed filter of installation ${installation.installationId}`,
        [
          {
            code: 'filter-not-matched',
            message: subscription.filter.kind === 'all' ? 'all' : subscription.filter.entityKind,
            path: 'subscription.filter',
          },
        ],
        dispatchContext(installation, correlationId),
      ),
    );
  }

  // 5. A9 GRANTS RE-CHECKED — the event's area read capability must be
  //    live-granted at delivery time.
  const required = requiredCapabilityOfEvent(event.eventName);
  if (!required.ok) {
    return rejectEvent(
      deps,
      installation,
      event,
      correlationId,
      causationId,
      occurredAt,
      'event-area-capability-unknown',
      required.error,
    );
  }
  const grants = checkInstallationCapabilities(installation, permissions, [required.value]);
  if (!grants.ok) {
    const reason = grants.error.details[0]?.code ?? 'capability-not-granted';
    return rejectEvent(
      deps,
      installation,
      event,
      correlationId,
      causationId,
      occurredAt,
      reason,
      grants.error,
    );
  }

  // 6. DELIVERY — the typed record + the audit event.
  const deliveryId = deps.newDeliveryId();
  const deliveredAt = deps.now();
  const appended = await audit(
    deps,
    appRuntimeEventEnvelope({
      eventName: APP_EVENT_DELIVERED_EVENT,
      payload: {
        ...payloadBaseOf(installation),
        decision: 'event-delivered',
        eventName: event.eventName,
        deliveryId,
        reason: null,
      },
      actor: installationActor(installation),
      tenantId: installation.tenantId,
      correlationId,
      causationId,
      occurredAt: deliveredAt,
    }),
  );
  if (!appended.ok) return appended;
  return ok({
    kind: 'app-event-delivery',
    deliveryId,
    installationId: installation.installationId,
    appId: installation.appId,
    eventName: event.eventName,
    filter: subscription.filter,
    deliveredAt,
    eventOccurredAt: event.occurredAt,
    correlationId,
    causationId,
  } satisfies AppEventDeliveryRecord);
}

/** Audit one typed event rejection, then return it. */
const rejectEvent = async (
  deps: AppDispatchDeps,
  installation: AppInstallation,
  event: DomainEventEnvelope,
  correlationId: CorrelationId,
  causationId: CausationId,
  occurredAt: Timestamp,
  reason: string,
  error: DomainError,
): Promise<Result<AppEventDeliveryRecord, DomainError>> => {
  const appended = await audit(
    deps,
    appRuntimeEventEnvelope({
      eventName: APP_EVENT_REJECTED_EVENT,
      payload: {
        ...payloadBaseOf(installation),
        decision: 'event-rejected',
        eventName: event.eventName,
        reason,
      },
      actor: installationActor(installation),
      tenantId: installation.tenantId,
      correlationId,
      causationId,
      occurredAt,
    }),
  );
  if (!appended.ok) return appended;
  return fail(error);
};

/** Re-validate a causation token (defense in depth for audit envelopes). */
const parseCausationIdValue = (raw: string): CausationId => {
  const parsed = parseCausationId(raw);
  if (!parsed.ok) {
    throw new TypeError(`event causation token '${raw}' is not a valid causation id`);
  }
  return parsed.value;
};