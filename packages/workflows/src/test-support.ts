// Office workflow engine — deterministic test support (OFF-016).
//
// The shared fixtures of the package's acceptance suites, mirroring the
// landed domain packages' test idioms: fixed tenants/projects/parties,
// an injected clock + canonical-id supplier (no wall clock, no randomness),
// the in-memory store/sink/idempotency registry wired through the real
// command service, typed Result assertion helpers, and the two canonical
// workflow models (a full-featured change-order approval workflow and a
// minimal three-state machine for pure-determinism proofs).
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import { parseCommandEnvelope, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, CommandName, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import type { IdempotencyRegistry } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import { createWorkflowCommands } from './commands';
import type { WorkflowCommandAuthorization, WorkflowCommands, WorkflowCommandDeps } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryWorkflowStore } from './store';
import { parseWorkflowModel } from './definition';
import type { WorkflowModel } from './definition';
import type { ParseResult } from '@office/contracts';
import type { DomainError, Result } from '@office/domain-kernel';

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

export const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
export const MANAGER = 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2';
export const SUPERVISOR = 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3';
export const ASSIGNEE = 'office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4';
export const SUBJECT_ID = 'office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5';

export const CORRELATION_ID = 'corr-0f1e2d3c4b5a';

export const projectScopeOf = (projectId: typeof PROJECT_1, tenantId = TENANT_A): Scope => ({
  kind: 'project',
  tenantId,
  projectId,
});

// ----- the canonical workflow models ---------------------------------------------------

/**
 * The full-featured change-order approval workflow: an initial draft state,
 * a review state carrying one SLA-bound task + one unbounded task + the
 * capability-gated manager approval, and success/failure terminal states.
 */
export const CHANGE_ORDER_MODEL_RAW = {
  states: [
    { name: 'draft', kind: 'initial' },
    { name: 'review', kind: 'normal' },
    { name: 'approved', kind: 'success' },
    { name: 'rejected', kind: 'failure' },
  ],
  transitions: [
    {
      key: 'submit-for-review',
      from: 'draft',
      to: 'review',
      conditions: [{ kind: 'always' }],
    },
    {
      key: 'approve-change',
      from: 'review',
      to: 'approved',
      conditions: [
        { kind: 'task-outcome', task: 'verify-docs', outcome: 'completed' },
        { kind: 'approval-decision', approval: 'manager', decision: 'approved' },
      ],
    },
    {
      key: 'reject-change',
      from: 'review',
      to: 'rejected',
      conditions: [{ kind: 'approval-decision', approval: 'manager', decision: 'rejected' }],
      requiredCapabilities: ['contracts.write'],
    },
  ],
  tasks: [
    {
      key: 'verify-docs',
      title: 'Verify change order documents',
      state: 'review',
      assignment: { actorKinds: ['user'], roles: ['reviewer'] },
      slaMinutes: 60,
    },
    {
      key: 'notify-parties',
      title: 'Notify affected parties',
      state: 'review',
      assignment: { actorKinds: ['user', 'agent'], roles: [] },
    },
  ],
  approvals: [
    {
      key: 'manager',
      title: 'Commercial manager approval',
      state: 'review',
      requiredCapability: 'cost.write',
      policyRef: 'policy/change-orders@3',
    },
  ],
  retryPolicy: { maxAttempts: 2, backoffBaseSeconds: 60, backoffMaxSeconds: 600 },
  escalationRules: [{ task: 'verify-docs', reassignTo: SUPERVISOR }],
} as const;

/** The parsed change-order workflow model (validated fail-closed). */
export const CHANGE_ORDER_MODEL: WorkflowModel = unwrap(
  parseWorkflowModel(CHANGE_ORDER_MODEL_RAW),
);

/** The minimal three-state machine (pure-determinism proofs). */
export const SIMPLE_MODEL_RAW = {
  states: [
    { name: 'start', kind: 'initial' },
    { name: 'middle', kind: 'normal' },
    { name: 'done', kind: 'success' },
  ],
  transitions: [
    { key: 'go-middle', from: 'start', to: 'middle', conditions: [{ kind: 'always' }] },
    {
      key: 'go-done',
      from: 'middle',
      to: 'done',
      conditions: [{ kind: 'all-tasks-settled', state: 'middle' }],
    },
  ],
  tasks: [
    {
      key: 'work',
      title: 'Do the work',
      state: 'middle',
      assignment: { actorKinds: ['user'], roles: [] },
    },
  ],
  approvals: [],
  retryPolicy: { maxAttempts: 1, backoffBaseSeconds: 30, backoffMaxSeconds: 300 },
  escalationRules: [],
} as const;

/** The parsed minimal workflow model (validated fail-closed). */
export const SIMPLE_MODEL: WorkflowModel = unwrap(parseWorkflowModel(SIMPLE_MODEL_RAW));

// ----- deterministic harness -----------------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const tsAt = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

const FAKE_EXECUTOR: SqlExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

export interface Harness {
  readonly commands: WorkflowCommands;
  readonly store: ReturnType<typeof createInMemoryWorkflowStore>;
  readonly sink: InMemoryEventSink;
  readonly registryStats: { lookups: number; records: number };
  readonly ids: { issued: number };
  /** Jump the injected clock to `offsetSeconds` from the harness epoch. */
  readonly setClock: (offsetSeconds: number) => void;
}

/**
 * Build a deterministic command-service harness: in-memory store + sink +
 * idempotency registry (with lookup/record counters), an auto-ticking
 * injected clock (7-second steps, jumpable through setClock), and a
 * zero-padded sequential canonical-id supplier.
 */
export const makeHarness = (sink: InMemoryEventSink = createInMemoryEventSink()): Harness => {
  const store = createInMemoryWorkflowStore();
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
  const deps: WorkflowCommandDeps = {
    store,
    eventSink: sink,
    idempotencyRegistry,
    now: () => tsAt(clockTick++ * 7),
    newOpaqueId: () => {
      ids.issued += 1;
      return String(ids.issued).padStart(16, '0');
    },
    executor: FAKE_EXECUTOR,
  };
  return {
    commands: createWorkflowCommands(deps),
    store,
    sink,
    registryStats,
    ids,
    setClock: (offsetSeconds: number) => {
      clockTick = Math.floor(offsetSeconds / 7);
    },
  };
};

let keyTick = 0;
export const nextKey = (): string => `idem-${String(++keyTick).padStart(5, '0')}`;

export const envelope = (
  payload: unknown,
  commandName: CommandName,
  options: { scope?: Scope; key?: string; actorId?: string } = {},
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? projectScopeOf(PROJECT_1),
      actor: { kind: 'user', actorId: options.actorId ?? USER },
      idempotencyKey: options.key ?? nextKey(),
      causality: { correlationId: CORRELATION_ID, causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

// ----- authorization fixtures ----------------------------------------------------------

/** The workflow operator grant: workflows.write (engine operation). */
export const operatorGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] }]),
  capabilities: ['workflows.write'],
};

/** The commercial-manager grant: workflows.write + the approval's required cost.write. */
export const managerGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] }]),
  capabilities: ['workflows.write', 'cost.write'],
};

/** A workflow operator WITHOUT the approval capability (the bypass attempt). */
export const operatorWithoutCostGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] }]),
  capabilities: ['workflows.write'],
};

/** No grant at all (deny-by-default). */
export const noGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] }]),
  capabilities: [],
};

/** Holds the required capability but an explicit deny rule forbids writes. */
export const explicitDenyGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([
    { effect: 'deny', actorIds: [MANAGER], actions: ['write'] },
    { effect: 'allow', capabilities: ['workflows.write'], actions: ['write'] },
  ]),
  capabilities: ['workflows.write', 'cost.write'],
};

/** Holds the required capability but the policy has no allow rule. */
export const noAllowRuleGrant: WorkflowCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['documents.read'], actions: ['read'] }]),
  capabilities: ['workflows.write', 'cost.write'],
};
