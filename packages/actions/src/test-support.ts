// Office action gateway — deterministic test support (OFF-017).
//
// The shared fixtures of the package's acceptance suites, mirroring the
// landed packages' test idioms (workflows/domain-kernel/authz): fixed
// tenants/projects/actors, an injected clock + canonical-id suppliers (no
// wall clock, no randomness), the in-memory registry/handlers/sink/
// idempotency registry/approval authority wired through the REAL gateway,
// the canonical action-descriptor vocabulary, counting handlers (the
// handler-invocation proofs), the real-workflow-engine wiring for the
// adapter suite, and typed Result assertion helpers.
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import {
  parseCommandEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  ActorKind,
  CommandEnvelope,
  CommandName,
  EntityRef,
  Scope,
  Timestamp,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  createInMemoryIdempotencyRegistry,
  domainError,
  ok,
} from '@office/domain-kernel';
import type { DomainError, IdempotencyRegistry, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  APPROVE_APPROVAL_COMMAND,
  CREATE_DEFINITION_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  REJECT_APPROVAL_COMMAND,
  START_INSTANCE_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  createInMemoryEventSink as createWorkflowEventSink,
  createInMemoryWorkflowStore,
  createWorkflowCommands,
} from '@office/workflows';
import type { WorkflowCommandAuthorization, WorkflowCommands, WorkflowStore } from '@office/workflows';
import { defineActionDescriptor } from './descriptor';
import type { ActionDescriptor } from './descriptor';
import { createInMemoryActionRegistry } from './registry';
import type { ActionRegistry } from './registry';
import { createInMemoryActionHandlers } from './handlers';
import type { ActionCommandHandler } from './handlers';
import { createInMemoryEventSink } from './audit-events';
import type { InMemoryEventSink } from './audit-events';
import { createInMemoryApprovalAuthority } from './approval';
import type { InMemoryApprovalAuthority } from './approval';
import { createActionGateway } from './gateway';
import type { ActionGateway } from './gateway';
import type { ActionAuthorization, ActionProposal } from './proposal';
import { parseActionProposal } from './proposal';
import type { ParseResult } from '@office/contracts';

/** Unwrap a successful ParseResult (fails loud in tests). */
export const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

/** Unwrap a successful Result (fails loud in tests). */
export const expectOk = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

// ----- fixed identities ----------------------------------------------------------------

export const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
export const TENANT_B = unwrap(parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'));
export const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
export const PROJECT_2 = unwrap(parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'));

export const USER = unwrap(parseEntityId('office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1'));
export const AGENT = unwrap(parseEntityId('office-ent-v1-a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
export const APP = unwrap(parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'));
export const ADAPTER = unwrap(parseEntityId('office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3'));
export const MANAGER = unwrap(parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'));
export const SUBJECT_ID = unwrap(parseEntityId('office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5'));

export const CORRELATION_ID = 'corr-0f1e2d3c4b5a';

export const projectScopeOf = (projectId: typeof PROJECT_1, tenantId = TENANT_A): Scope => ({
  kind: 'project',
  tenantId,
  projectId,
});

export const tenantScopeOf = (tenantId: typeof TENANT_A): Scope => ({
  kind: 'tenant',
  tenantId,
});

export const actorOf = (kind: ActorKind, actorId: string = USER): Actor =>
  kind === 'system' ? { kind } : { kind, actorId: unwrap(parseEntityId(actorId)) };

export const subjectRef = (): EntityRef => ({
  entityKind: unwrap(parseEntityKind('budget-revision')),
  entityId: SUBJECT_ID,
});

// ----- the canonical action-descriptor vocabulary ---------------------------------------

const ALL_ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'app', 'adapter', 'system'];

/** Read-class fixture: a pure query over cost items. */
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

/** The canonical descriptor set of the acceptance suites, in order. */
export const CANONICAL_DESCRIPTORS: readonly ActionDescriptor[] = [
  LIST_COST_ITEMS,
  RECORD_PROGRESS,
  SUBMIT_DAILY_LOG,
  COMMIT_BUDGET_REVISION,
  PURGE_COST_LEDGER,
];

// ----- deterministic clock / id suppliers ------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const tsAt = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

export const FAKE_EXECUTOR: SqlExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

// ----- counting handlers (the invocation proofs) -----------------------------------------

/** A counting handler: records invocations (commands + contexts), succeeds. */
export interface CountingHandler {
  readonly handler: ActionCommandHandler;
  readonly invocations: { count: number; commands: CommandEnvelope[] };
}

/** Create a counting handler; optionally fails typed after counting. */
export const makeCountingHandler = (
  options: { readonly failWith?: DomainError } = {},
): CountingHandler => {
  const invocations = { count: 0, commands: [] as CommandEnvelope[] };
  const handler: ActionCommandHandler = async (command) => {
    invocations.count += 1;
    invocations.commands.push(command);
    if (options.failWith !== undefined) {
      return { ok: false, error: options.failWith };
    }
    return ok({
      handled: command.commandName as string,
      payload: command.payload,
    });
  };
  return { handler, invocations };
};

/** A typed invariant-violation for handler-failure tests. */
export const handlerFailure = (): DomainError =>
  domainError(
    'invariant-violation',
    'the handler rejected the command (test fixture)',
    [{ code: 'handler-rejected', message: 'test fixture failure', path: null }],
  );

// ----- the deterministic gateway harness --------------------------------------------------

export interface Harness {
  readonly gateway: ActionGateway;
  readonly registry: ActionRegistry;
  readonly handlers: Record<string, CountingHandler>;
  readonly sink: InMemoryEventSink;
  readonly approvalAuthority: InMemoryApprovalAuthority;
  readonly registryStats: { lookups: number; records: number };
  readonly ids: { issued: number };
  /** Jump the injected clock to `offsetSeconds` from the harness epoch. */
  readonly setClock: (offsetSeconds: number) => void;
}

/**
 * Build the deterministic gateway harness: the canonical descriptor registry,
 * counting handlers for every canonical action, the in-memory event sink,
 * the in-memory approval authority (with its decide driver + opened counter),
 * an idempotency registry with lookup/record counters, an auto-ticking
 * injected clock (7-second steps, jumpable), and a sequential canonical-id
 * supplier — all wired through the REAL gateway.
 */
export const makeHarness = (
  options: { readonly sink?: InMemoryEventSink } = {},
): Harness => {
  const registry = createInMemoryActionRegistry(CANONICAL_DESCRIPTORS);
  const counting = {
    [LIST_COST_ITEMS.commandName as string]: makeCountingHandler(),
    [RECORD_PROGRESS.commandName as string]: makeCountingHandler(),
    [SUBMIT_DAILY_LOG.commandName as string]: makeCountingHandler(),
    [COMMIT_BUDGET_REVISION.commandName as string]: makeCountingHandler(),
    [PURGE_COST_LEDGER.commandName as string]: makeCountingHandler(),
  };
  const handlers = createInMemoryActionHandlers(
    Object.fromEntries(
      Object.entries(counting).map(([name, entry]) => [name, entry.handler]),
    ),
  );
  const sink = options.sink ?? createInMemoryEventSink();
  const approvalAuthority = createInMemoryApprovalAuthority();
  const inner = createInMemoryIdempotencyRegistry();
  const registryStats = { lookups: 0, records: 0 };
  const idempotencyRegistry: IdempotencyRegistry = {
    lookup: (scope, key, fingerprint, context) => {
      registryStats.lookups += 1;
      return inner.lookup(scope, key, fingerprint, context);
    },
    record: (scope, key, fingerprint, outcome, context) => {
      registryStats.records += 1;
      return inner.record(scope, key, fingerprint, outcome, context);
    },
  };
  const ids = { issued: 0 };
  let clockTick = 0;
  const gateway = createActionGateway({
    registry,
    handlers,
    idempotencyRegistry,
    eventSink: sink,
    approvalAuthority,
    now: () => tsAt(clockTick++ * 7),
    newEntityId: () => {
      ids.issued += 1;
      return unwrap(
        parseEntityId(`office-ent-v1-${String(ids.issued).padStart(16, '0')}`),
      );
    },
    executor: FAKE_EXECUTOR,
  });
  return {
    gateway,
    registry,
    handlers: counting,
    sink,
    approvalAuthority,
    registryStats,
    ids,
    setClock: (offsetSeconds: number) => {
      clockTick = Math.floor(offsetSeconds / 7);
    },
  };
};

// ----- proposal / envelope fixtures --------------------------------------------------------

let keyTick = 0;
export const nextKey = (): string => `act-${String(++keyTick).padStart(5, '0')}`;

/** Build a validated command envelope (deterministic keys, fixed issuedAt). */
export const envelope = (
  payload: unknown,
  commandName: CommandName,
  options: {
    readonly scope?: Scope;
    readonly key?: string;
    readonly actor?: Actor;
    readonly causationId?: string | null;
  } = {},
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? projectScopeOf(PROJECT_1),
      actor: options.actor ?? actorOf('user'),
      idempotencyKey: options.key ?? nextKey(),
      causality: {
        correlationId: CORRELATION_ID,
        causationId: options.causationId ?? null,
      },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

/** Build a validated action proposal from plain parts. */
export const proposal = (
  command: CommandEnvelope,
  options: {
    readonly subject?: EntityRef | null;
    readonly evidence?: readonly { slot: string; ref: string }[];
    readonly confidence?: string;
    readonly resourceScope?: Scope | null;
    readonly approval?: { instanceId: string; approvalKey: string } | null;
  } = {},
): ActionProposal =>
  unwrap(
    parseActionProposal({
      command,
      subject: options.subject ?? null,
      evidence: options.evidence ?? [],
      confidence: options.confidence ?? 'certain',
      resourceScope: options.resourceScope ?? null,
      approval: options.approval ?? null,
    }),
  );

// ----- authorization fixtures --------------------------------------------------------------

export const allowAllPolicy: Policy = definePolicy([
  { effect: 'allow', actions: ['read', 'write'] },
]);
export const denyWritePolicy: Policy = definePolicy([
  { effect: 'deny', actions: ['write'] },
  { effect: 'allow', actions: ['read', 'write'] },
]);
export const denyReadPolicy: Policy = definePolicy([
  { effect: 'deny', actions: ['read'] },
  { effect: 'allow', actions: ['read', 'write'] },
]);
export const allowReadOnlyPolicy: Policy = definePolicy([{ effect: 'allow', actions: ['read'] }]);
export const allowWriteOnlyPolicy: Policy = definePolicy([{ effect: 'allow', actions: ['write'] }]);

/** Compose an ActionAuthorization from capabilities + policy. */
export const grantOf = (
  capabilities: readonly string[],
  policy: Policy = allowAllPolicy,
): ActionAuthorization => ({ policy, capabilities });

/** The full grant: every capability the canonical vocabulary requires. */
export const fullGrant: ActionAuthorization = grantOf([
  'cost.read',
  'cost.write',
  'work.write',
  'documents.write',
]);

/** Missing cost.write (the capability-state fixture). */
export const missingCostWriteGrant: ActionAuthorization = grantOf([
  'cost.read',
  'work.write',
  'documents.write',
]);

/** No capabilities at all. */
export const noCapabilitiesGrant: ActionAuthorization = grantOf([]);

// ----- the real workflow-engine wiring (adapter suite) --------------------------------------

export interface WorkflowEngine {
  readonly commands: WorkflowCommands;
  readonly store: WorkflowStore;
  readonly sink: InMemoryEventSink;
  readonly ids: { issued: number };
}

/**
 * Wire the REAL workflow engine (in-memory store + sink + registry, injected
 * clock/id suppliers) for the workflow-approval adapter suite — the same
 * wiring the workflows package's own tests use.
 */
export const makeWorkflowEngine = (): WorkflowEngine => {
  const store = createInMemoryWorkflowStore();
  const sink = createWorkflowEventSink();
  const idempotencyRegistry = createInMemoryIdempotencyRegistry();
  const ids = { issued: 0 };
  let clockTick = 0;
  const commands = createWorkflowCommands({
    store,
    eventSink: sink,
    idempotencyRegistry,
    now: () => tsAt(clockTick++ * 7),
    newOpaqueId: () => {
      ids.issued += 1;
      return String(ids.issued).padStart(16, '0');
    },
    executor: FAKE_EXECUTOR,
  });
  return { commands, store, sink, ids };
};

/** The workflow-operator grant (engine operations: create/publish/start). */
export const workflowOperatorGrant: WorkflowCommandAuthorization = {
  policy: allowAllPolicy,
  capabilities: ['workflows.write'],
};

/** The commercial-manager grant (decides the action approval). */
export const workflowManagerGrant: WorkflowCommandAuthorization = {
  policy: allowAllPolicy,
  capabilities: ['workflows.write', 'cost.write'],
};

/** The approval workflow model backing the canonical approval fixture. */
export const ACTION_APPROVAL_MODEL_RAW = {
  states: [
    { name: 'awaiting-approval', kind: 'initial' },
    { name: 'approved', kind: 'success' },
    { name: 'rejected', kind: 'failure' },
  ],
  transitions: [
    {
      key: 'approve',
      from: 'awaiting-approval',
      to: 'approved',
      conditions: [{ kind: 'approval-decision', approval: 'action', decision: 'approved' }],
    },
    {
      key: 'reject',
      from: 'awaiting-approval',
      to: 'rejected',
      conditions: [{ kind: 'approval-decision', approval: 'action', decision: 'rejected' }],
    },
  ],
  tasks: [],
  approvals: [
    {
      key: 'action',
      title: 'Action approval',
      state: 'awaiting-approval',
      requiredCapability: 'cost.write',
      policyRef: 'policy/budget-revisions@2',
    },
  ],
  retryPolicy: { maxAttempts: 1, backoffBaseSeconds: 30, backoffMaxSeconds: 300 },
  escalationRules: [],
} as const;

let workflowKeyTick = 0;
const nextWorkflowKey = (): string => `wfc-${String(++workflowKeyTick).padStart(4, '0')}`;

/** A workflow command envelope fixture (deterministic keys, operator actor). */
export const workflowEnvelope = (
  payload: unknown,
  commandName: CommandName,
  options: { readonly actor?: Actor; readonly scope?: Scope } = {},
): CommandEnvelope =>
  envelope(payload, commandName, {
    key: nextWorkflowKey(),
    actor: options.actor ?? actorOf('user', MANAGER),
    scope: options.scope ?? projectScopeOf(PROJECT_1),
  });

export {
  APPROVE_APPROVAL_COMMAND,
  CREATE_DEFINITION_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  REJECT_APPROVAL_COMMAND,
  START_INSTANCE_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
};

/**
 * Publish the action-approval definition through the REAL engine (create +
 * publish, capability-gated operator commands) and return its definition id.
 */
export const publishActionApprovalDefinition = async (
  engine: WorkflowEngine,
  options: {
    readonly scope?: Scope;
    readonly approvalCapability?: string;
    readonly approvalKey?: string;
  } = {},
): Promise<string> => {
  const scope = options.scope ?? projectScopeOf(PROJECT_1);
  const capabilityName = options.approvalCapability ?? 'cost.write';
  const approvalKey = options.approvalKey ?? 'action';
  const model = {
    ...ACTION_APPROVAL_MODEL_RAW,
    approvals: [
      {
        ...ACTION_APPROVAL_MODEL_RAW.approvals[0],
        key: approvalKey,
        requiredCapability: capabilityName,
      },
    ],
  };
  const created = await engine.commands.definitions.createDefinition(
    workflowEnvelope(
      { key: 'action-approval', title: 'Action approval workflow', model },
      CREATE_DEFINITION_COMMAND,
      { scope },
    ),
    workflowOperatorGrant,
  );
  const definitionId = expectOk(created).state.entityId;
  const published = await engine.commands.definitions.publishDefinition(
    workflowEnvelope(
      { definitionId, expectedVersion: 1 },
      PUBLISH_DEFINITION_COMMAND,
      { scope },
    ),
    workflowOperatorGrant,
  );
  expectOk(published);
  return definitionId;
};

/** Drive an approval of the action-approval instance to 'approved' through the REAL engine. */
export const approveThroughEngine = async (
  engine: WorkflowEngine,
  instanceId: string,
  options: { readonly scope?: Scope; readonly approvalKey?: string } = {},
): Promise<void> => {
  const scope = options.scope ?? projectScopeOf(PROJECT_1);
  const approvalKey = options.approvalKey ?? 'action';
  const submitted = await engine.commands.approvals.submitApproval(
    workflowEnvelope(
      { instanceId, expectedVersion: 1, approvalKey },
      SUBMIT_APPROVAL_COMMAND,
      { scope, actor: actorOf('user', MANAGER) },
    ),
    workflowManagerGrant,
  );
  expectOk(submitted);
  const approved = await engine.commands.approvals.approveApproval(
    workflowEnvelope(
      { instanceId, expectedVersion: 2, approvalKey, note: 'approved in test' },
      APPROVE_APPROVAL_COMMAND,
      { scope, actor: actorOf('user', MANAGER) },
    ),
    workflowManagerGrant,
  );
  expectOk(approved);
};

/** Drive an approval of the action-approval instance to 'rejected' through the REAL engine. */
export const rejectThroughEngine = async (
  engine: WorkflowEngine,
  instanceId: string,
  options: { readonly scope?: Scope; readonly approvalKey?: string } = {},
): Promise<void> => {
  const scope = options.scope ?? projectScopeOf(PROJECT_1);
  const approvalKey = options.approvalKey ?? 'action';
  const submitted = await engine.commands.approvals.submitApproval(
    workflowEnvelope(
      { instanceId, expectedVersion: 1, approvalKey },
      SUBMIT_APPROVAL_COMMAND,
      { scope, actor: actorOf('user', MANAGER) },
    ),
    workflowManagerGrant,
  );
  expectOk(submitted);
  const rejected = await engine.commands.approvals.rejectApproval(
    workflowEnvelope(
      { instanceId, expectedVersion: 2, approvalKey, reason: 'rejected in test' },
      REJECT_APPROVAL_COMMAND,
      { scope, actor: actorOf('user', MANAGER) },
    ),
    workflowManagerGrant,
  );
  expectOk(rejected);
};
