// Office app-runtime — deterministic test support (OFF-026).
//
// The shared fixtures of the package's acceptance suites, mirroring the
// landed packages' test idioms (actions/agents/app-sdk): fixed tenants/
// projects/installations/actors, an injected auto-ticking clock + canonical
// id suppliers (no wall clock, no randomness), the canonical sample app
// manifest composed through the SDK's trusted builder, the canonical action
// descriptors (mirroring the actions package's own fixture vocabulary),
// the REAL action gateway wired through counting handlers + the in-memory
// approval authority + idempotency registry (wrapped in a COUNTING gateway
// so the suites prove pre-gateway typed rejections by invocation counting),
// the composed runtime engine over the in-memory store, typed Result
// assertion helpers, and command/event envelope builders.
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import {
  parseActor,
  parseCommandEnvelope,
  parseCommandName,
  parseCorrelationId,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  CommandEnvelope,
  CommandName,
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
import { capability } from '@office/authz';
import {
  actionDescriptorSource,
  parseAppManifest,
  permissionIdOf,
} from '@office/app-sdk';
import type { AppManifest, Permission } from '@office/app-sdk';
import {
  createInMemoryActionHandlers,
  createInMemoryActionRegistry,
  createInMemoryApprovalAuthority,
  createInMemoryEventSink,
  createActionGateway,
  defineActionDescriptor,
} from '@office/actions';
import type {
  ActionCommandHandler,
  ActionGateway,
  ActionProposal,
  EventSink as GatewayEventSink,
  InMemoryApprovalAuthority,
} from '@office/actions';
import { createInMemoryIdempotencyRegistry, ok } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import { createInMemoryAppEventSink } from './audit-events';
import type { InMemoryAppEventSink } from './audit-events';
import { createAppRuntime } from './runtime';
import type { AppRuntime } from './runtime';
import type { AppDispatchDeps } from './dispatch';
import { createInMemoryAppRuntimeStore } from './registry';
import type { InMemoryAppRuntimeStore } from './registry';
import { grantManifestPermissions } from './permissions';
import { activateInstallation, installInstallation } from './installation';
import type { AppInstallation } from './installation';
import { parseAppLifecycleHooks } from './hooks';
import type { AppLifecycleHook } from './hooks';

// ----- typed Result assertion helpers -----------------------------------------------------

/** Any typed result shape (contracts ParseResult or kernel Result alike). */
export type AnyResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Unwrap a successful typed result of any shape (fails loud in tests). */
export const expectOk = <T>(result: AnyResult<T, unknown>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result)}`);
};

/** Unwrap a failed typed result of any shape (fails loud in tests). */
export const expectFail = <T, E>(result: AnyResult<T, E>): E => {
  if (!result.ok) return result.error;
  throw new Error(`expected a typed failure, got: ${JSON.stringify(result.value)}`);
};

/** Unwrap a successful contracts ParseResult (fails loud in tests). */
export const unwrap = <T>(result: AnyResult<T, unknown>): T => expectOk(result);

// ----- fixed identities --------------------------------------------------------------------

export const TENANT_A: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);
export const TENANT_B: TenantId = unwrap(
  parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'),
);
export const PROJECT_1: ProjectId = unwrap(
  parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
);
export const PROJECT_2: ProjectId = unwrap(
  parseProjectId('office-prj-v1-2b3c4d4e5f6f708192a3b4c5d6e7f8a9b'),
);
export const INSTALLATION: EntityId = unwrap(
  parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'),
);
export const INSTALLATION_B: EntityId = unwrap(
  parseEntityId('office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322'),
);
export const INSTALLATION_C: EntityId = unwrap(
  parseEntityId('office-ent-v1-5e4d3c2b1a0987654321fedcba9876543210'),
);
export const ADMIN: EntityId = unwrap(
  parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'),
);
export const OPERATOR: EntityId = unwrap(
  parseEntityId('office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5'),
);

/** The fixed admin actor that installs apps / grants permissions. */
export const adminActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: ADMIN }));
/** The fixed operator actor that suspends/revokes. */
export const operatorActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: OPERATOR }));
/** The installation's own 'app' actor (the ONLY actor an app command carries). */
export const appActorOf = (installationId: EntityId = INSTALLATION): Actor =>
  unwrap(parseActor({ kind: 'app', actorId: installationId }));
/** A foreign installation's app actor (the spoofing fixture). */
export const otherAppActor = (): Actor =>
  unwrap(parseActor({ kind: 'app', actorId: INSTALLATION_B }));

// ----- the injected clock / id suppliers ---------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const tsAt = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

/** The fixture epoch (T0). */
export const T0: Timestamp = tsAt(0);

/** A canonical entity id from a 16-hex opaque part (deterministic supplier). */
const entityIdOf = (n: number): EntityId =>
  unwrap(parseEntityId(`office-ent-v1-${String(n).padStart(16, '0')}`));

/** The transaction executor fixture (queries return nothing). */
export const FAKE_EXECUTOR: SqlExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

/** A fixed correlation id (the causal chain of the fixture flows). */
export const CORRELATION_ID = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a6789'));

// ----- the canonical sample app manifest ---------------------------------------------------

/** The sample app's own id/version (plain strings — the raw manifest form). */
export const SAMPLE_APP_ID = 'field-progress-tracker';
export const SAMPLE_APP_VERSION = '1.4.0';

/** The canonical sample command the sample app binds (reversible class). */
export const SAMPLE_COMMAND: CommandName = unwrap(parseCommandName('field.recordProgress'));

/**
 * The canonical sample manifest: the field progress tracker — two explicit
 * project-scoped A9 permission specs (work.read / work.write), ONE
 * reversible command binding (field.recordProgress) with a symbolic
 * handler, ONE event subscription (work.progressRecorded) with a typed
 * entity-kind filter.
 */
export const SAMPLE_MANIFEST: AppManifest = unwrap(
  parseAppManifest({
    kind: 'app-manifest',
    schemaVersion: '1.0.0',
    appId: SAMPLE_APP_ID,
    manifestVersion: SAMPLE_APP_VERSION,
    title: 'Field Progress Tracker',
    description: 'Tracks daily field progress against the plan.',
    permissions: [
      { kind: 'app-permission', capability: 'work.read', scopeKind: 'project', version: 1 },
      { kind: 'app-permission', capability: 'work.write', scopeKind: 'project', version: 1 },
    ],
    bindings: [
      {
        kind: 'command-binding',
        commandName: 'field.recordProgress',
        handler: {
          kind: 'app-handler',
          handlerId: 'record-progress-handler',
          title: 'Record progress',
          description: 'Records one field progress observation.',
        },
        actionClass: 'reversible',
      },
    ],
    subscriptions: [
      {
        kind: 'event-subscription',
        eventName: 'work.progressRecorded',
        filter: { kind: 'entity-kind', entityKind: 'field-report' },
      },
    ],
    uiExtensions: [],
    dependencies: [],
  }),
);

/** The sample app's declared lifecycle hooks (all four, symbolic handlers). */
export const sampleHooks = (): readonly AppLifecycleHook[] =>
  unwrap(
    parseAppLifecycleHooks([
      {
        kind: 'app-lifecycle-hook',
        hook: 'on-install',
        handler: {
          kind: 'app-handler',
          handlerId: 'install-hook',
          title: 'On install',
          description: null,
        },
      },
      {
        kind: 'app-lifecycle-hook',
        hook: 'on-activate',
        handler: {
          kind: 'app-handler',
          handlerId: 'activate-hook',
          title: 'On activate',
          description: null,
        },
      },
      {
        kind: 'app-lifecycle-hook',
        hook: 'on-suspend',
        handler: {
          kind: 'app-handler',
          handlerId: 'suspend-hook',
          title: 'On suspend',
          description: null,
        },
      },
      {
        kind: 'app-lifecycle-hook',
        hook: 'on-revoke',
        handler: {
          kind: 'app-handler',
          handlerId: 'revoke-hook',
          title: 'On revoke',
          description: null,
        },
      },
    ]),
  );

// ----- the canonical action descriptors ----------------------------------------------------

const ALL_ACTOR_KINDS = ['user', 'agent', 'app', 'adapter', 'system'] as const;

/** Reversible-class fixture: the sample command (work.write, A4 evidence). */
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

/** Approval-required fixture: a budget revision commit. */
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

/** The canonical descriptor set of the acceptance suites, in order. */
export const CANONICAL_DESCRIPTORS = [
  RECORD_PROGRESS,
  LIST_COST_ITEMS,
  SUBMIT_DAILY_LOG,
  COMMIT_BUDGET_REVISION,
] as const;

// ----- policies -----------------------------------------------------------------------------

/** The allow-all policy (the default host policy of the harness). */
export const allowAllPolicy: Policy = definePolicy([{ effect: 'allow' }]);

/** A deny-write policy (the gateway-policy fixture). */
export const denyWritePolicy: Policy = definePolicy([
  { effect: 'deny', actions: ['write'] },
  { effect: 'allow' },
]);

// ----- counting handlers + the counting gateway ----------------------------------------------

/** A counting handler: records invocations, succeeds with a fixed value. */
export interface CountingHandler {
  readonly invocations: { count: number; commands: CommandEnvelope[] };
  readonly handler: ActionCommandHandler;
}

/** The handler fixture value (a JSON-safe record). */
export const HANDLER_VALUE = { recorded: true, observedPercent: 37 };

const makeCountingHandler = (): CountingHandler => {
  const invocations = { count: 0, commands: [] as CommandEnvelope[] };
  const handler: ActionCommandHandler = async (command) => {
    invocations.count += 1;
    invocations.commands.push(command);
    return ok({ ...HANDLER_VALUE, idempotencyKey: command.idempotencyKey });
  };
  return { invocations, handler };
};

/** The counting gateway: records every executeAction call (THE proof). */
export interface CountingGateway {
  readonly gateway: ActionGateway;
  readonly calls: { count: number; commands: CommandEnvelope[] };
  readonly proposals: ActionProposal[];
}

// ----- envelope builders ---------------------------------------------------------------------

/** The fixture command counter (deterministic idempotency keys). */
let commandCounter = 0;

/** Reset the fixture counter (the harness calls this on build). */
export const resetFixtureCounters = (): void => {
  commandCounter = 0;
};

/** Build a canonical command envelope for the app dispatch fixtures. */
export const commandEnvelopeOf = (parts: {
  readonly installationId?: EntityId;
  readonly commandName: string;
  readonly scope?: Scope;
  readonly actor?: Actor;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}): CommandEnvelope => {
  commandCounter += 1;
  return unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: parts.commandName,
      scope: parts.scope ?? { kind: 'tenant', tenantId: TENANT_A },
      actor: parts.actor ?? appActorOf(parts.installationId ?? INSTALLATION),
      idempotencyKey: parts.idempotencyKey ?? `idem-${String(commandCounter).padStart(8, '0')}`,
      causality: {
        correlationId: parts.correlationId ?? CORRELATION_ID,
        causationId: null,
      },
      issuedAt: T0,
      schemaVersion: '1.0.0',
      payload: parts.payload ?? { percent: 37 },
    }),
  );
};

/** Build a canonical domain event envelope for the delivery fixtures. */
export const eventEnvelopeOf = (parts: {
  readonly eventName: string;
  readonly scope?: Scope;
  readonly entityKind?: string | null;
  readonly entityId?: EntityId;
  readonly occurredAt?: Timestamp;
  readonly correlationId?: string;
  readonly causationId?: string | null;
}): DomainEventEnvelope => {
  const entityKind = parts.entityKind ?? null;
  const ref: EntityRef | null =
    entityKind === null
      ? null
      : { entityKind: unwrap(parseEntityKind(entityKind)), entityId: parts.entityId ?? entityIdOf(9001) };
  return unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: parts.eventName,
      scope: parts.scope ?? { kind: 'tenant', tenantId: TENANT_A },
      actor: { kind: 'user', actorId: ADMIN },
      source: 'domain',
      causality: {
        correlationId: parts.correlationId ?? CORRELATION_ID,
        causationId: parts.causationId ?? null,
      },
      schemaVersion: '1.0.0',
      occurredAt: parts.occurredAt ?? T0,
      entityRefs: { before: null, after: ref },
      payload: { note: 'fixture' },
    }),
  );
};

// ----- THE deterministic app-runtime harnesses ----------------------------------------------

/** The dispatch-level harness: AppDispatchDeps + the counters that prove gates. */
export interface AppDispatchHarness {
  /** The wiring deps of appCommandDispatch / appEventDispatch. */
  readonly deps: AppDispatchDeps;
  /** The counting gateway: every executeAction call (THE pre-gateway proof). */
  readonly countedGateway: CountingGateway;
  /** The counting handler's invocations (THE handler-counting proof). */
  readonly handlerInvocations: { count: number; commands: CommandEnvelope[] };
  readonly appSink: InMemoryAppEventSink;
  readonly gatewaySink: GatewayEventSink;
  readonly approvalAuthority: InMemoryApprovalAuthority;
  /** Jump the injected clock to `offsetSeconds` from the harness epoch. */
  readonly setClock: (offsetSeconds: number) => void;
}

/** The full deterministic app-runtime harness (the engine over the deps). */
export interface AppRuntimeHarness extends AppDispatchHarness {
  readonly runtime: AppRuntime;
  readonly store: InMemoryAppRuntimeStore;
}

/**
 * Build the deterministic DISPATCH-level harness: the REAL action gateway
 * (counting handler, in-memory approval authority + idempotency registry,
 * the gateway's own audit sink) wrapped in a COUNTING gateway, the
 * app-runtime audit sink, and the action-descriptor source over the real
 * registry — with an auto-ticking injected clock and a sequential delivery-id
 * supplier. The pure dispatch engines (appCommandDispatch/appEventDispatch)
 * take `harness.deps` directly, so the suites prove pre-gateway typed
 * rejections by gateway/handler invocation counting.
 */
export const makeAppDispatchHarness = (options: {
  readonly policy?: Policy;
  readonly appSink?: InMemoryAppEventSink;
} = {}): AppDispatchHarness => {
  resetFixtureCounters();
  let clockTick = 0;
  const now = (): Timestamp => tsAt(clockTick++ * 7);
  const setClock = (offsetSeconds: number): void => {
    clockTick = Math.ceil(offsetSeconds / 7);
  };
  const ids = { deliveries: 0, entities: 0 };
  const registry = createInMemoryActionRegistry([...CANONICAL_DESCRIPTORS]);
  const counting = makeCountingHandler();
  const handlers = createInMemoryActionHandlers({
    'field.recordProgress': counting.handler,
    'cost.listCostItems': counting.handler,
    'documents.submitDailyLog': counting.handler,
    'cost.commitBudgetRevision': counting.handler,
  });
  const gatewaySink = createInMemoryEventSink();
  const approvalAuthority = createInMemoryApprovalAuthority();
  const realGateway = createActionGateway({
    registry,
    handlers,
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    eventSink: gatewaySink,
    approvalAuthority,
    now,
    newEntityId: () => {
      ids.entities += 1;
      return entityIdOf(ids.entities);
    },
    executor: FAKE_EXECUTOR,
  });
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
  const appSink = options.appSink ?? createInMemoryAppEventSink();
  const deps: AppDispatchDeps = {
    gateway: countedGateway.gateway,
    actions: actionDescriptorSource(registry),
    sink: appSink,
    executor: FAKE_EXECUTOR,
    policy: options.policy ?? allowAllPolicy,
    now,
    newDeliveryId: () => {
      ids.deliveries += 1;
      return entityIdOf(5000 + ids.deliveries);
    },
  };
  return {
    deps,
    countedGateway,
    handlerInvocations: counting.invocations,
    appSink,
    gatewaySink,
    approvalAuthority,
    setClock,
  };
};

/**
 * Build the deterministic app-RUNTIME harness: the dispatch-level harness
 * (real counting gateway, audit sinks, descriptor source, injected clock)
 * plus the composed runtime engine over the in-memory store with a sequential
 * installation-id supplier. Two harnesses built the same way produce
 * byte-identical flows.
 */
export const makeAppRuntimeHarness = (options: {
  readonly policy?: Policy;
  readonly appSink?: InMemoryAppEventSink;
} = {}): AppRuntimeHarness => {
  const dispatch = makeAppDispatchHarness(options);
  let installations = 0;
  const store = createInMemoryAppRuntimeStore();
  const runtime = createAppRuntime(
    {
      ...dispatch.deps,
      newInstallationId: () => {
        installations += 1;
        return entityIdOf(1000 + installations);
      },
    },
    store,
  );
  return {
    runtime,
    store,
    ...dispatch,
  };
};

// ----- common flow fixtures -------------------------------------------------------------------

/**
 * The canonical ACTIVE installation fixture (tenant A, the sample app, the
 * full hook set): the base record of the dispatch/permission suites.
 */
export const activeInstallationOf = (): AppInstallation =>
  expectOk(
    activateInstallation(
      installInstallation({
        installationId: INSTALLATION,
        tenantId: TENANT_A,
        appId: SAMPLE_MANIFEST.appId,
        manifestVersion: SAMPLE_MANIFEST.manifestVersion,
        hooks: sampleHooks(),
        installedAt: T0,
        installedBy: adminActor(),
      }),
      { at: T0 },
    ),
  ).installation;

/** The permission grants of the sample manifest for the fixed installation. */
export const samplePermissionsFor = (
  installation: Parameters<typeof grantManifestPermissions>[0],
): readonly Permission[] =>
  grantManifestPermissions(installation, SAMPLE_MANIFEST, {
    grantedAt: T0,
    grantedBy: adminActor(),
  });

/** The deterministic permission id of the sample manifest's work.write grant. */
export const workWritePermissionId = (installationId: EntityId): string =>
  permissionIdOf({
    tenantId: TENANT_A,
    installationId,
    capability: capability('work.write'),
    scopeKind: 'project',
  });
