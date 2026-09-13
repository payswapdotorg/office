// Office security — THE deterministic conformance harness (OFF-036).
//
// The wiring that every conformance check drives: the REAL action gateway
// (@office/actions createActionGateway — registry, counting handlers,
// in-memory approval authority + idempotency registry, its own audit sink)
// wrapped in a COUNTING gateway, and the REAL app runtime
// (@office/app-runtime createAppRuntime) over the in-memory store
// pre-populated through the package's exported fail-closed parses (two
// ACTIVE installations — one per tenant — with live A9 grants and a
// registered command/event namespace). Both surfaces' audit sinks feed ONE
// in-memory audit ledger (the security read model).
//
// Every fixture is composed through the packages' PUBLIC surfaces only:
// app identities/permissions/namespace entries arrive as untrusted values
// and are parsed fail-closed (parseAppInstallation,
// parseInstallationPermission, parseAppCommandNamespaceEntry,
// parseAppEventNamespaceEntry) — exactly how a host would wire the runtime
// from its own records. Determinism: fixed identities, an injected
// auto-ticking clock over a FIXED epoch, sequential id suppliers, and
// sequential idempotency keys — no wall clock, no randomness; two harnesses
// built the same way drive byte-identical flows.
import {
  parseActor,
  parseCausationId,
  parseCommandEnvelope,
  parseCommandName,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseEventName,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  ActorKind,
  CommandEnvelope,
  CommandName,
  CorrelationId,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  ProjectId,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  createActionGateway,
  createInMemoryActionHandlers,
  createInMemoryActionRegistry,
  createInMemoryApprovalAuthority,
  createInMemoryEventSink,
  defineActionDescriptor,
} from '@office/actions';
import type {
  ActionCommandHandler,
  ActionGateway,
  ActionProposal,
  EventSink,
  InMemoryApprovalAuthority,
  InMemoryEventSink,
} from '@office/actions';
import { createInMemoryIdempotencyRegistry, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  createAppRuntime,
  createInMemoryAppEventSink,
  createInMemoryAppRuntimeStore,
  parseAppCommandNamespaceEntry,
  parseAppEventNamespaceEntry,
  parseAppInstallation,
  parseInstallationPermission,
} from '@office/app-runtime';
import type {
  AppEventSink,
  AppRuntime,
  InMemoryAppEventSink,
  InMemoryAppRuntimeStore,
} from '@office/app-runtime';
import { createInMemoryAuditLedger } from '../audit-ledger';
import type { InMemoryAuditLedger } from '../audit-ledger';

// ----- typed Result helpers (package-internal) -----------------------------------------------

/** Any typed result shape (contracts ParseResult or kernel Result alike). */
export type AnyResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Unwrap a successful typed result of any shape (fails loud). */
export const expectOk = <T>(result: AnyResult<T, unknown>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result)}`);
};

/** Unwrap a failed typed result of any shape (fails loud). */
export const expectFail = <T, E>(result: AnyResult<T, E>): E => {
  if (!result.ok) return result.error;
  throw new Error(`expected a typed failure, got: ${JSON.stringify(result.value)}`);
};

// ----- fixed identities -----------------------------------------------------------------------

export const TENANT_A: TenantId = expectOk(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);
export const TENANT_B: TenantId = expectOk(
  parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'),
);
export const PROJECT_1: ProjectId = expectOk(
  parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
);
export const PROJECT_2: ProjectId = expectOk(
  parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'),
);

export const USER: EntityId = expectOk(
  parseEntityId('office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1'),
);
export const MANAGER: EntityId = expectOk(
  parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'),
);
export const AGENT: EntityId = expectOk(
  parseEntityId('office-ent-v1-a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
);
export const APP_ID_A: EntityId = expectOk(
  parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'),
);
export const APP_ID_B: EntityId = expectOk(
  parseEntityId('office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322'),
);
export const ADAPTER: EntityId = expectOk(
  parseEntityId('office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3'),
);
export const SUBJECT: EntityId = expectOk(
  parseEntityId('office-ent-v1-f60718293a4b45c6d7e8f9a1b2c3d4e5'),
);

/** The fixed correlation id of the harness's causal chains. */
export const CORRELATION_ID: CorrelationId = expectOk(
  parseCorrelationId('corr-0f1e2d3c4b5a6789'),
);

/** The fixture epoch (T0) of the injected clock. */
const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);

/** A canonical timestamp at `offsetSeconds` from the fixture epoch. */
const tsAt = (offsetSeconds: number): Timestamp =>
  expectOk(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

export const T0: Timestamp = tsAt(0);

/** The sample app identity the installations instantiate (fixture constants). */
export const SAMPLE_APP = 'field-progress-tracker' as const;
export const SAMPLE_APP_VERSION = '1.4.0' as const;

/** A canonical entity id from a 16-hex opaque part (deterministic supplier). */
const entityIdOf = (n: number): EntityId =>
  expectOk(parseEntityId(`office-ent-v1-${String(n).padStart(16, '0')}`));

/** The transaction executor fixture (queries return nothing; structural). */
const FAKE_EXECUTOR = { query: async (): Promise<{ rows: never[]; rowCount: number }> => ({ rows: [], rowCount: 0 }) } as const;

/** The fixture actor of one kind (the system actor carries no id). */
export const actorOf = (kind: ActorKind, actorId: EntityId = USER): Actor =>
  kind === 'system' ? { kind } : expectOk(parseActor({ kind, actorId }));

/** The installation's own 'app' actor (the ONLY actor an app command carries). */
export const appActorOf = (installationId: EntityId): Actor =>
  expectOk(parseActor({ kind: 'app', actorId: installationId }));

/** The tenant-A project-1 scope fixture. */
export const projectOneScope = (): Scope => ({ kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 });
/** The tenant-B project-2 scope fixture. */
export const projectTwoScope = (): Scope => ({ kind: 'project', tenantId: TENANT_B, projectId: PROJECT_2 });
/** The tenant-A tenant scope fixture. */
export const tenantAScope = (): Scope => ({ kind: 'tenant', tenantId: TENANT_A });
/** The tenant-B tenant scope fixture. */
export const tenantBScope = (): Scope => ({ kind: 'tenant', tenantId: TENANT_B });

/** The budget-revision subject fixture (the approval workflow subject). */
export const subjectRef = (): EntityRef => ({
  entityKind: expectOk(parseEntityKind('budget-revision')),
  entityId: SUBJECT,
});

// ----- the canonical action-descriptor vocabulary --------------------------------------------

const ALL_ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'app', 'adapter', 'system'];

/** Read-class fixture: a cost item query. */
export const LIST_COST_ITEMS = defineActionDescriptor({
  commandName: 'cost.listCostItems',
  title: 'List cost items',
  description: 'Query the cost items of a project (read class).',
  actionClass: 'read',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['cost.read'],
  policyRef: 'policy/cost-queries@1',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
});

/** Reversible-class fixture: a field progress record with an evidence slot. */
export const RECORD_PROGRESS = defineActionDescriptor({
  commandName: 'field.recordProgress',
  title: 'Record field progress',
  description: 'Record a field progress observation (reversible class).',
  actionClass: 'reversible',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['work.write'],
  policyRef: 'policy/field-progress@2',
  evidenceRequirements: [
    { slot: 'observation', description: 'The field observation backing the progress record.' },
  ],
  requiredConfidence: 'medium',
  resourceKind: 'field-report',
  compensatingCommand: 'field.correctProgress',
  approval: null,
});

/** Reversible-class fixture restricted to human actors (the actor-kind gate). */
export const SUBMIT_DAILY_LOG = defineActionDescriptor({
  commandName: 'documents.submitDailyLog',
  title: 'Submit the daily log',
  description: 'Submit a daily log entry (human actors only).',
  actionClass: 'reversible',
  actorKinds: ['user'],
  requiredCapabilities: ['documents.write'],
  policyRef: 'policy/daily-logs@1',
  evidenceRequirements: [],
  requiredConfidence: 'medium',
  resourceKind: 'daily-log',
  compensatingCommand: 'documents.correctDailyLog',
  approval: null,
});

/** Approval-required fixture: a budget revision commit (A4 evidence + approval). */
export const COMMIT_BUDGET_REVISION = defineActionDescriptor({
  commandName: 'cost.commitBudgetRevision',
  title: 'Commit a budget revision',
  description: 'Commit a budget revision (approval-required class).',
  actionClass: 'approval-required',
  actorKinds: [...ALL_ACTOR_KINDS],
  requiredCapabilities: ['cost.write'],
  policyRef: 'policy/budget-revisions@2',
  evidenceRequirements: [
    { slot: 'justification', description: 'The written justification of the revision.' },
    { slot: 'margin-assessment', description: 'The margin impact assessment behind it.' },
  ],
  requiredConfidence: 'high',
  resourceKind: 'budget-revision',
  compensatingCommand: 'cost.revertBudgetRevision',
  approval: {
    definitionKey: 'action-approval',
    approvalKey: 'action',
    requiredCapability: 'cost.write',
    policyRef: 'policy/budget-revisions@2',
  },
});

/** Prohibited fixture: a destructive ledger purge (never executed). */
export const PURGE_COST_LEDGER = defineActionDescriptor({
  commandName: 'cost.purgeCostLedger',
  title: 'Purge the cost ledger',
  description: 'Destructive purge (prohibited class — never executed).',
  actionClass: 'prohibited',
  actorKinds: [],
  requiredCapabilities: [],
  policyRef: 'policy/destructive@0',
  evidenceRequirements: [],
  requiredConfidence: 'low',
  resourceKind: 'cost-item',
  compensatingCommand: null,
  approval: null,
});

/** The canonical descriptor set of the conformance suites, in order. */
export const CANONICAL_DESCRIPTORS = [
  LIST_COST_ITEMS,
  RECORD_PROGRESS,
  SUBMIT_DAILY_LOG,
  COMMIT_BUDGET_REVISION,
  PURGE_COST_LEDGER,
] as const;

/** The commands of the canonical vocabulary (typed names). */
export const LIST_COST_ITEMS_COMMAND: CommandName = expectOk(
  parseCommandName('cost.listCostItems'),
);
export const RECORD_PROGRESS_COMMAND: CommandName = expectOk(
  parseCommandName('field.recordProgress'),
);
export const SUBMIT_DAILY_LOG_COMMAND: CommandName = expectOk(
  parseCommandName('documents.submitDailyLog'),
);
export const COMMIT_BUDGET_REVISION_COMMAND: CommandName = expectOk(
  parseCommandName('cost.commitBudgetRevision'),
);
export const PURGE_COST_LEDGER_COMMAND: CommandName = expectOk(
  parseCommandName('cost.purgeCostLedger'),
);

// ----- policies + authorization fixtures ------------------------------------------------------

/** The allow-all policy (read + write allowed for everyone). */
export const allowAllPolicy: Policy = definePolicy([
  { effect: 'allow', actions: ['read', 'write'] },
]);

/** THE deny-by-default fixture: no allow rule at all (empty policy). */
export const emptyPolicy: Policy = definePolicy([]);

/** An explicit deny-write policy (deny wins over the trailing allow). */
export const denyWritePolicy: Policy = definePolicy([
  { effect: 'deny', actions: ['write'] },
  { effect: 'allow', actions: ['read', 'write'] },
]);

/** Every capability the canonical vocabulary requires (the full grant). */
export const FULL_CAPABILITIES = [
  'cost.read',
  'cost.write',
  'work.read',
  'work.write',
  'documents.write',
] as const;

/** The full authorization fixture (allow-all policy + every capability). */
export const fullGrant = { policy: allowAllPolicy, capabilities: [...FULL_CAPABILITIES] } as const;

/** The empty-policy authorization (deny-by-default probe). */
export const emptyPolicyGrant = { policy: emptyPolicy, capabilities: [...FULL_CAPABILITIES] } as const;

/** Missing cost.write (the capability-state probe). */
export const missingCostWriteGrant = {
  policy: allowAllPolicy,
  capabilities: ['cost.read', 'work.read', 'work.write', 'documents.write'],
} as const;

/** No capabilities at all (the no-capability probe). */
export const noCapabilitiesGrant = { policy: allowAllPolicy, capabilities: [] } as const;

/** The deny-write authorization (the explicit-deny probe). */
export const denyWriteGrant = { policy: denyWritePolicy, capabilities: [...FULL_CAPABILITIES] } as const;

// ----- app-runtime fixture records (composed through the exported parses) ---------------------

/** One active installation record of the sample app for a tenant (parsed). */
const activeInstallationOf = (installationId: EntityId, tenantId: TenantId) =>
  expectOk(
    parseAppInstallation({
      kind: 'app-installation',
      installationId,
      tenantId,
      appId: SAMPLE_APP,
      manifestVersion: SAMPLE_APP_VERSION,
      state: 'active',
      hooks: [],
      installedAt: T0,
      installedBy: { kind: 'user', actorId: MANAGER },
      activatedAt: T0,
      suspendedAt: null,
      suspendedBy: null,
      revokedAt: null,
      revokedBy: null,
      uninstalledAt: null,
      uninstalledBy: null,
    }),
  );

/** One live granted permission of the sample app (parsed, deterministic id). */
const grantedPermissionOf = (
  n: number,
  installationId: EntityId,
  tenantId: TenantId,
  capabilityName: string,
) =>
  expectOk(
    parseInstallationPermission({
      kind: 'app-permission-grant',
      permissionId: `office-prm-v1-${String(n).padStart(32, '0')}`,
      tenantId,
      installationId,
      appId: SAMPLE_APP,
      spec: { kind: 'app-permission', capability: capabilityName, scopeKind: 'project', version: 1 },
      version: 1,
      grantedAt: T0,
      grantedBy: { kind: 'user', actorId: MANAGER },
      state: 'granted',
      revokedAt: null,
      revokedBy: null,
    }),
  );

/** The installation's command namespace entry (the field progress binding). */
const commandNamespaceOf = (installationId: EntityId) =>
  expectOk(
    parseAppCommandNamespaceEntry({
      kind: 'app-command-namespace',
      installationId,
      appId: SAMPLE_APP,
      commandName: 'field.recordProgress',
      binding: {
        kind: 'command-binding',
        commandName: 'field.recordProgress',
        handler: {
          kind: 'app-handler',
          handlerId: 'record-progress-handler',
          title: 'Record progress',
          description: null,
        },
        actionClass: 'reversible',
      },
    }),
  );

/** The installation's event namespace entry (the progress-recorded subscription). */
const eventNamespaceOf = (installationId: EntityId) =>
  expectOk(
    parseAppEventNamespaceEntry({
      kind: 'app-event-namespace',
      installationId,
      appId: SAMPLE_APP,
      eventName: 'work.progressRecorded',
      subscription: {
        kind: 'event-subscription',
        eventName: 'work.progressRecorded',
        filter: { kind: 'entity-kind', entityKind: 'field-report' },
      },
    }),
  );

// ----- THE harness ----------------------------------------------------------------------------

/** The counting gateway: records every executeAction call (THE proof). */
export interface CountingGateway {
  readonly gateway: ActionGateway;
  readonly calls: { count: number; commands: CommandEnvelope[] };
  readonly proposals: ActionProposal[];
}

/** The deterministic conformance harness (see the module comment). */
export interface ConformanceHarness {
  /** The scenario name (carried into the report). */
  readonly name: string;
  readonly tenants: { readonly a: TenantId; readonly b: TenantId };
  readonly projects: { readonly one: ProjectId; readonly two: ProjectId };
  readonly installations: { readonly a: EntityId; readonly b: EntityId };
  /** THE REAL action gateway (wrapped in the counting gateway). */
  readonly gateway: ActionGateway;
  readonly countedGateway: CountingGateway;
  /** Handler invocations across every canonical command (THE effect proof). */
  readonly handlerInvocations: { count: number; commands: CommandEnvelope[] };
  /** THE REAL app runtime over the in-memory store. */
  readonly appRuntime: AppRuntime;
  readonly store: InMemoryAppRuntimeStore;
  /** The combined audit ledger both surfaces' sinks feed. */
  readonly ledger: InMemoryAuditLedger;
  readonly appSink: InMemoryAppEventSink;
  readonly gatewaySink: InMemoryEventSink;
  readonly approvalAuthority: InMemoryApprovalAuthority;
  /** Jump the injected clock to `offsetSeconds` from the harness epoch. */
  readonly setClock: (offsetSeconds: number) => void;
  /** The injected clock's current tick instant. */
  readonly now: () => Timestamp;
  /** Mint the next deterministic idempotency key. */
  readonly nextKey: () => string;
}

/**
 * Build the deterministic conformance harness: the REAL gateway + REAL app
 * runtime wired in memory, both audit sinks feeding ONE audit ledger, two
 * ACTIVE installations (tenant A and tenant B) with live grants and a
 * registered namespace. Two harnesses built the same way drive
 * byte-identical flows (the determinism proofs rely on it).
 */
export const makeConformanceHarness = (
  options: { readonly name?: string } = {},
): ConformanceHarness => {
  // --- the injected clock + id suppliers (deterministic) ---
  let clockTick = 0;
  const now = (): Timestamp => tsAt(clockTick++ * 7);
  const setClock = (offsetSeconds: number): void => {
    clockTick = Math.ceil(offsetSeconds / 7);
  };
  let keyTick = 0;
  const nextKey = (): string => `sec-${String(++keyTick).padStart(5, '0')}`;
  const ids = { entities: 0, installations: 0, deliveries: 0 };

  const gatewaySink = createInMemoryEventSink();
  const approvalAuthority = createInMemoryApprovalAuthority();

  // --- the combined audit ledger both sinks feed ---
  const ledger = createInMemoryAuditLedger();
  const projectIntoLedger = async (
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>> => {
    for (const envelope of events) {
      const appended = ledger.append(envelope);
      if (!appended.ok) return appended;
    }
    return ok(true);
  };

  // --- the sink views: every append is recorded AND projected into the
  // --- combined audit ledger (THE wiring the completeness check counts on)
  const appSink = createInMemoryAppEventSink();
  const gatewaySinkView: EventSink = {
    appendEvents: async (executor, events) => {
      const inner = await gatewaySink.appendEvents(executor, events);
      if (!inner.ok) return inner;
      return projectIntoLedger(events);
    },
  };
  const appSinkView: AppEventSink = {
    appendEvents: async (executor, events) => {
      const inner = await appSink.appendEvents(executor, events);
      if (!inner.ok) return inner;
      return projectIntoLedger(events);
    },
  };

  // --- the REAL action gateway over the canonical descriptors ---
  const registry = createInMemoryActionRegistry([...CANONICAL_DESCRIPTORS]);
  const invocations = { count: 0, commands: [] as CommandEnvelope[] };
  const handler: ActionCommandHandler = async (command) => {
    invocations.count += 1;
    invocations.commands.push(command);
    return ok({ handled: command.commandName as string, payload: command.payload });
  };
  const handlers = createInMemoryActionHandlers({
    'cost.listCostItems': handler,
    'field.recordProgress': handler,
    'documents.submitDailyLog': handler,
    'cost.commitBudgetRevision': handler,
    'cost.purgeCostLedger': handler,
  });
  const realGateway = createActionGateway({
    registry,
    handlers,
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    eventSink: gatewaySinkView,
    approvalAuthority,
    now,
    newEntityId: () => entityIdOf(++ids.entities),
    executor: FAKE_EXECUTOR,
  });

  // --- the counting gateway: records every executeAction call (THE proof) ---
  const calls = { count: 0, commands: [] as CommandEnvelope[] };
  const proposals: ActionProposal[] = [];
  const countedGateway: CountingGateway = {
    calls,
    proposals,
    gateway: {
      executeAction: async (proposal, authorization) => {
        calls.count += 1;
        calls.commands.push(proposal.command);
        proposals.push(proposal);
        return realGateway.executeAction(proposal, authorization);
      },
    },
  };

  // --- the REAL app runtime over the in-memory store ---
  const store = createInMemoryAppRuntimeStore();
  const appRuntime = createAppRuntime(
    {
      gateway: countedGateway.gateway,
      actions: { find: (commandName) => registry.find(commandName) },
      sink: appSinkView,
      executor: FAKE_EXECUTOR,
      policy: allowAllPolicy,
      now,
      newDeliveryId: () => entityIdOf(5000 + ++ids.deliveries),
      newInstallationId: () => entityIdOf(1000 + ++ids.installations),
    },
    store,
  );

  // --- pre-populate the two ACTIVE installations (fail-closed parses) ---
  const installationA = activeInstallationOf(APP_ID_A, TENANT_A);
  const installationB = activeInstallationOf(APP_ID_B, TENANT_B);
  store.installations.put(installationA);
  store.installations.put(installationB);
  for (const [installation, base] of [
    [installationA, 10],
    [installationB, 40],
  ] as const) {
    store.permissions.put(grantedPermissionOf(base + 1, installation.installationId, installation.tenantId, 'work.read'));
    store.permissions.put(grantedPermissionOf(base + 2, installation.installationId, installation.tenantId, 'work.write'));
    const commandEntry = commandNamespaceOf(installation.installationId);
    const registered = store.namespace.registerCommand(commandEntry);
    if (!registered.ok) throw new TypeError(`command namespace registration failed: ${registered.error.message}`);
    const eventEntry = eventNamespaceOf(installation.installationId);
    const subscribed = store.namespace.registerEvent(eventEntry);
    if (!subscribed.ok) throw new TypeError(`event namespace registration failed: ${subscribed.error.message}`);
  }

  return {
    name: options.name ?? 'office-security-conformance',
    tenants: { a: TENANT_A, b: TENANT_B },
    projects: { one: PROJECT_1, two: PROJECT_2 },
    installations: { a: APP_ID_A, b: APP_ID_B },
    gateway: countedGateway.gateway,
    countedGateway,
    handlerInvocations: invocations,
    appRuntime,
    store,
    ledger,
    appSink,
    gatewaySink,
    approvalAuthority,
    setClock,
    now,
    nextKey,
  };
};

// ----- command / proposal / event fixtures ----------------------------------------------------

/** Build a validated command envelope (explicit deterministic key, fixed issuedAt). */
export const commandEnvelopeOf = (
  commandName: CommandName | string,
  options: {
    readonly payload?: unknown;
    readonly scope?: Scope;
    readonly actor?: Actor;
    readonly key: string;
    readonly causationId?: string | null;
    readonly correlationId?: string;
  },
): CommandEnvelope =>
  expectOk(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? projectOneScope(),
      actor: options.actor ?? actorOf('user'),
      idempotencyKey: options.key,
      causality: {
        correlationId: options.correlationId ?? CORRELATION_ID,
        causationId: options.causationId ?? null,
      },
      issuedAt: T0,
      schemaVersion: '1.0.0',
      payload: options.payload ?? { note: 'conformance fixture' },
    }),
  );

/** Build one canonical domain event envelope for the delivery fixtures. */
export const domainEventOf = (
  eventName: string,
  options: {
    readonly scope?: Scope;
    readonly actor?: Actor;
    readonly entityKind?: string | null;
    readonly entityId?: EntityId;
    readonly occurredAt?: Timestamp;
    readonly causationId?: string | null;
    readonly correlationId?: string;
    readonly payload?: Record<string, unknown>;
  } = {},
): DomainEventEnvelope =>
  expectOk(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName,
      scope: options.scope ?? tenantAScope(),
      actor: options.actor ?? actorOf('user'),
      source: 'domain',
      causality: {
        correlationId: options.correlationId ?? CORRELATION_ID,
        causationId: options.causationId ?? null,
      },
      schemaVersion: '1.0.0',
      occurredAt: options.occurredAt ?? T0,
      entityRefs: {
        before: null,
        after:
          options.entityKind === null || options.entityKind === undefined
            ? null
            : {
                entityKind: expectOk(parseEntityKind(options.entityKind)),
                entityId: options.entityId ?? entityIdOf(9001),
              },
      },
      payload: options.payload ?? { note: 'conformance fixture' },
    }),
  );

/** Parse a fixture causation id (trusted path, loud on invalid input). */
export const causationIdOf = (token: string) => expectOk(parseCausationId(token));

/** The canonical event name of the sample subscription (typed). */
export const PROGRESS_RECORDED_EVENT = expectOk(parseEventName('work.progressRecorded'));
