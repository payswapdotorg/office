// Office web application shell — the SEEDED WORLD (OFF-030).
//
// The seeded project the shell operates: the in-memory reference engines of
// the landed domain packages wired into ONE deterministic world, composed
// ONLY through the packages' public surfaces (their command services, their
// stores, their audit-event sinks). This is the shell's composition layer —
// the web client's stand-in for the server runtime: it NEVER touches a
// database (structurally database-free — no @office/persistence import
// anywhere, no SQL, no repositories), never constructs an action gateway,
// and never writes canonical state directly (every mutation flows through
// the landed packages' own command handlers with their authorization,
// idempotency, concurrency, and audit-event gates).
//
// Every executed command's audit envelope lands in the ledger-shaped
// in-memory project-slice source (@office/sync's reference implementation —
// dense per-aggregate sequences, ledgerEventIdOf-derived ids, the SAME
// identity semantics as the OFF-005 event ledger), so the whole world is
// ONE append-only event stream the shell's views project from (A2/A7: the
// views are rebuildable from this stream alone; run-twice identical).
//
// Determinism (the kernel rule): no wall clock, no randomness — the clock
// and the canonical-id supplier are INJECTED (`parts.now`, `parts.newOpaqueId`),
// and every seed identity below is a fixed literal, so the same parts always
// produce the byte-identical world.
import { createHash } from 'node:crypto';
import { capability, definePolicy } from '@office/authz';
import type { Capability, Policy } from '@office/authz';
import { CURRENT_SCHEMA_VERSION } from '@office/contracts';
import {
  parseCommandEnvelope,
  parseCorrelationId,
  parseEntityId,
  parseIdempotencyKey,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type {
  Actor,
  CommandEnvelope,
  CommandName,
  CorrelationId,
  DomainEventEnvelope,
  EntityId,
  EventName,
  IdempotencyKey,
  ProjectId,
  ProjectScope,
  Scope,
  Timestamp,
} from '@office/contracts';
import {
  concurrencyConflict,
  createInMemoryIdempotencyRegistry,
  domainError,
  entityNotFound,
  invariantViolation,
  ok,
  projectScopeViolation,
} from '@office/domain-kernel';
import type { DomainError, IdempotencyRegistry, Result } from '@office/domain-kernel';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import { createInMemorySliceSource, createSubscriptionBroker } from '@office/sync';
import type { InMemorySliceSource, SubscriptionBroker } from '@office/sync';
import { entityRefOf } from './session';

import { CREATE_ORGANIZATION_COMMAND, createOrganizationCommands, createOrganizationState } from '@office/domain-organization';
import type { OrganizationState, OrganizationsRepository } from '@office/domain-organization';
import { CREATE_PROJECT_COMMAND, createProjectCommands, createProjectState } from '@office/domain-projects';
import type { ProjectState, ProjectsDomainRepository } from '@office/domain-projects';
import {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  SET_BASELINE_COMMAND,
  createInMemoryScheduleStore,
  createScheduleCommands,
} from '@office/domain-schedule';
import type { InMemoryScheduleStore, ScheduleCommands } from '@office/domain-schedule';
import { CAPTURE_FIELD_EVENT_COMMAND, createFieldCommands, createInMemoryFieldStore } from '@office/domain-field';
import type { FieldCommands, FieldStore } from '@office/domain-field';
import {
  CREATE_BUDGET_COMMAND,
  CREATE_COMMITMENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  createCostCommands,
  createInMemoryCostStore,
} from '@office/domain-cost';
import type { CostCommands, InMemoryCostStore } from '@office/domain-cost';
import {
  CREATE_CONTRACT_COMMAND,
  RAISE_CHANGE_EVENT_COMMAND,
  createContractsCommands,
  createInMemoryContractsStore,
} from '@office/domain-contracts';
import type { ContractsCommands, InMemoryContractsStore } from '@office/domain-contracts';
import {
  ATTACH_REVISION_COMMAND,
  REGISTER_DOCUMENT_COMMAND,
  createDocumentsCommands,
  createInMemoryDocumentsStore,
  createInMemoryObjectStorage,
} from '@office/domain-documents';
import type { DocumentsCommands, DocumentsStore, RevisionHash } from '@office/domain-documents';
import {
  APPROVE_APPROVAL_COMMAND,
  CREATE_DEFINITION_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  START_INSTANCE_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  createInMemoryWorkflowStore,
  createWorkflowCommands,
} from '@office/workflows';
import type { WorkflowCommands, WorkflowStore } from '@office/workflows';

// ---------------------------------------------------------------------------
// Trusted-path assertion helpers (seed wiring errors are loud, never silent).
// ---------------------------------------------------------------------------

const expectOk = <T, E>(result: Result<T, E>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`seed wiring error (${what}): ${JSON.stringify(result)}`);
};

// ---------------------------------------------------------------------------
// The world's deterministic shared audit-event sink.
// ---------------------------------------------------------------------------

/**
 * The shared EventSink every domain command service appends through
 * (structurally each domain's mirrored EventSink port; the executor handle
 * is accepted opaquely — the shell never inspects it, a real runtime's sink
 * writes the ledger with it). ONE recorder = ONE audit trail.
 */
export interface WorldEventRecorder {
  /** Every appended envelope, in append order (the world's audit trail). */
  readonly envelopes: readonly DomainEventEnvelope[];
  /** The port shape every domain's command deps accept. */
  readonly sink: {
    appendEvents(
      executor: unknown,
      events: readonly DomainEventEnvelope[],
    ): Promise<Result<true, DomainError>>;
  };
  /** The number of envelopes recorded so far. */
  readonly count: number;
}

const createWorldEventRecorder = (): WorldEventRecorder => {
  const envelopes: DomainEventEnvelope[] = [];
  return {
    get envelopes(): readonly DomainEventEnvelope[] {
      return [...envelopes];
    },
    get count(): number {
      return envelopes.length;
    },
    sink: {
      appendEvents: async (_executor, events) => {
        envelopes.push(...events);
        return ok(true);
      },
    },
  };
};

// ---------------------------------------------------------------------------
// The shell's command journal — its own record of every command IT executed.
// ---------------------------------------------------------------------------

/** One entry of the shell's command journal (the shell's dispatch log). */
export interface CommandJournalEntry {
  readonly commandName: CommandName;
  readonly idempotencyKey: IdempotencyKey;
  readonly actor: Actor;
  readonly issuedAt: Timestamp;
  readonly correlationId: CorrelationId;
  readonly outcome: 'executed' | 'rejected';
  /** The typed rejection code when the command was rejected. */
  readonly rejectionCode: string | null;
  /** The ledger event the command produced (null on rejection). */
  readonly eventId: LedgerEventId | null;
  readonly eventName: EventName | null;
}

// ---------------------------------------------------------------------------
// The in-memory identity repositories (the port implementations; the OFF-004
// foundation's SQL repositories are their durable production twins).
// ---------------------------------------------------------------------------

const notFound = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  entityNotFound(entityRefOf(entityKind, entityId), { scope, correlationId: null });

const staleVersion = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  concurrencyConflict(
    { ...entityRefOf(entityKind, entityId), expectedVersion: 0, actualVersion: 0 },
    { scope, correlationId: null },
  );

const duplicateId = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  invariantViolation(
    {
      name: 'seed-entity-id-already-exists',
      statement: `canonical ${entityKind} id already exists: ${entityId}`,
    },
    { scope, correlationId: null },
  );

const scopeMismatch = (
  commandProjectId: ProjectId,
  aggregateProjectId: ProjectId,
  scope: Scope,
): DomainError =>
  projectScopeViolation(
    { commandProjectId, aggregateProjectId },
    { scope, correlationId: null },
  );

/** Deterministic in-memory ProjectsDomainRepository over ProjectState rows. */
const createInMemoryProjectsRepository = (): ProjectsDomainRepository => {
  const rows = new Map<string, ProjectState>();
  const visible = (scope: Scope, row: ProjectState): boolean =>
    row.scope.tenantId === scope.tenantId &&
    (scope.kind !== 'project' || row.entityId === scope.projectId);
  const load = (scope: Scope, projectId: ProjectId): Result<ProjectState, DomainError> => {
    const row = rows.get(projectId);
    if (row === undefined || !visible(scope, row)) {
      return { ok: false, error: notFound('project', projectId, scope) };
    }
    if (scope.kind === 'project' && scope.projectId !== projectId) {
      return { ok: false, error: scopeMismatch(scope.projectId, projectId, scope) };
    }
    return { ok: true, value: row };
  };
  return {
    insert: async (_db, scope, input) => {
      const created = createProjectState(input, scope.tenantId);
      if (!created.ok) return created;
      if (rows.has(input.projectId)) {
        return { ok: false, error: duplicateId('project', input.projectId, scope) };
      }
      rows.set(input.projectId, created.value);
      return created;
    },
    findById: async (_db, scope, projectId) => load(scope, projectId),
    list: async (_db, scope) => ({
      ok: true as const,
      value: [...rows.values()].filter((row) => visible(scope, row)),
    }),
    update: async (_db, scope, projectId, expectedVersion, changes, now) => {
      const loaded = load(scope, projectId);
      if (!loaded.ok) return loaded;
      if (loaded.value.version !== expectedVersion) {
        return { ok: false, error: staleVersion('project', projectId, scope) };
      }
      const next: ProjectState = {
        ...loaded.value,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.extensionMetadata !== undefined
          ? { extensionMetadata: changes.extensionMetadata }
          : {}),
        updatedAt: now,
      };
      rows.set(projectId, next);
      return { ok: true as const, value: next };
    },
    archive: async (_db, scope, projectId, expectedVersion, now) => {
      const loaded = load(scope, projectId);
      if (!loaded.ok) return loaded;
      if (loaded.value.version !== expectedVersion) {
        return { ok: false, error: staleVersion('project', projectId, scope) };
      }
      const next: ProjectState = {
        ...loaded.value,
        status: 'archived',
        archivedAt: now,
        updatedAt: now,
      };
      rows.set(projectId, next);
      return { ok: true as const, value: next };
    },
  };
};

/** Deterministic in-memory OrganizationsRepository over OrganizationState rows. */
const createInMemoryOrganizationsRepository = (): OrganizationsRepository => {
  const rows = new Map<string, OrganizationState>();
  const visible = (scope: Scope, row: OrganizationState): boolean =>
    row.scope.tenantId === scope.tenantId;
  const load = (scope: Scope, organizationId: EntityId): Result<OrganizationState, DomainError> => {
    const row = rows.get(organizationId);
    if (row === undefined || !visible(scope, row)) {
      return { ok: false, error: notFound('organization', organizationId, scope) };
    }
    return { ok: true, value: row };
  };
  return {
    insert: async (_db, scope, input) => {
      // The row's owning scope is derived from the CALLER's scope (the SQL
      // twin binds tenant_id from the scope, never the input).
      const created = createOrganizationState(input, { kind: 'tenant', tenantId: scope.tenantId });
      if (!created.ok) return created;
      if (rows.has(input.organizationId)) {
        return { ok: false, error: duplicateId('organization', input.organizationId, scope) };
      }
      rows.set(input.organizationId, created.value);
      return created;
    },
    findById: async (_db, scope, organizationId) => load(scope, organizationId),
    list: async (_db, scope) => ({
      ok: true as const,
      value: [...rows.values()].filter((row) => visible(scope, row)),
    }),
    update: async (_db, scope, organizationId, expectedVersion, changes, now) => {
      const loaded = load(scope, organizationId);
      if (!loaded.ok) return loaded;
      if (loaded.value.version !== expectedVersion) {
        return { ok: false, error: staleVersion('organization', organizationId, scope) };
      }
      const next: OrganizationState = {
        ...loaded.value,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.extensionMetadata !== undefined
          ? { extensionMetadata: changes.extensionMetadata }
          : {}),
        updatedAt: now,
      };
      rows.set(organizationId, next);
      return { ok: true as const, value: next };
    },
    archive: async (_db, scope, organizationId, expectedVersion, now) => {
      const loaded = load(scope, organizationId);
      if (!loaded.ok) return loaded;
      if (loaded.value.version !== expectedVersion) {
        return { ok: false, error: staleVersion('organization', organizationId, scope) };
      }
      const next: OrganizationState = {
        ...loaded.value,
        status: 'archived',
        archivedAt: now,
        updatedAt: now,
      };
      rows.set(organizationId, next);
      return { ok: true as const, value: next };
    },
  };
};

// ---------------------------------------------------------------------------
// The seeded world itself.
// ---------------------------------------------------------------------------

/** The injected deterministic parts of one seeded world. */
export interface SeededWorldParts {
  /** The tenant the world is seeded for (canonical TenantId grammar). */
  readonly tenantId: string;
  /** THE project the world is seeded around (canonical ProjectId grammar). */
  readonly projectId: string;
  /** The seed acting user's canonical entity id. */
  readonly actorId: string;
  /** The seed causal-chain correlation id. */
  readonly correlationId: string;
  /** Injected clock — the canonical 'now' of every seed command (never wall time). */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier. */
  readonly newOpaqueId: () => string;
}

/** The fixed identities the seed script captured (for tests and hosts). */
export interface SeedIdentities {
  readonly organizationId: EntityId;
  readonly projectId: ProjectId;
  readonly scheduleId: EntityId;
  readonly activityIds: readonly EntityId[];
  readonly contractId: EntityId;
  readonly budgetId: EntityId;
  readonly costItemIds: readonly EntityId[];
  readonly commitmentId: EntityId;
  readonly changeEventId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly workflowDefinitionId: EntityId;
  readonly workflowInstanceId: EntityId;
}

/** The deterministic seeded world: services, stores, ledger, broker, journal. */
export interface SeededWorld {
  readonly kind: 'seeded-world';
  /** The ledger-shaped in-memory project-slice source (the world's stream). */
  readonly slice: InMemorySliceSource;
  /** Every ledger event, in append order (the projection basis of every view). */
  readonly ledgerEvents: readonly LedgerEvent[];
  /** The in-memory subscription broker (the session's data plane server). */
  readonly broker: SubscriptionBroker;
  /** The shell's command journal — every command the world executed. */
  readonly commandJournal: readonly CommandJournalEntry[];
  /** The seed's captured identities. */
  readonly identities: SeedIdentities;
  /** The world's tenant/project scope. */
  readonly scope: ProjectScope;
  /** The world's actor (the seed user). */
  readonly actor: Actor;
  /** The world's deny-by-default policy (the server-side grant). */
  readonly policy: Policy;
  /** The capabilities the world's command authorizations hold. */
  readonly capabilities: readonly Capability[];
  /** The in-memory reference stores (read surface inputs of the views). */
  readonly stores: {
    readonly projects: ProjectsDomainRepository;
    readonly organizations: OrganizationsRepository;
    readonly schedule: InMemoryScheduleStore;
    readonly field: FieldStore;
    readonly cost: InMemoryCostStore;
    readonly contracts: InMemoryContractsStore;
    readonly documents: DocumentsStore;
    readonly workflows: WorkflowStore;
  };
  /** The typed command services of every landed domain package. */
  readonly services: {
    readonly organizations: ReturnType<typeof createOrganizationCommands>;
    readonly projects: ReturnType<typeof createProjectCommands>;
    readonly schedule: ScheduleCommands;
    readonly field: FieldCommands;
    readonly cost: CostCommands;
    readonly contracts: ContractsCommands;
    readonly documents: DocumentsCommands;
    readonly workflows: WorkflowCommands;
  };
  /** The world's audit-event recorder (the shared sink every service uses). */
  readonly recorder: WorldEventRecorder;
  /** The idempotency registries the wired command services share. */
  readonly registries: {
    readonly field: IdempotencyRegistry;
    readonly workflows: IdempotencyRegistry;
    readonly documents: IdempotencyRegistry;
  };
  /**
   * Execute ONE command through the landed command surface its name
   * addresses — the generic typed path (the sync engine's command path and
   * the seed both use it). The state is the committed aggregate (typed by
   * the caller); the event is the ledger event the command produced.
   */
  execute<S>(command: CommandEnvelope<unknown>): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  >;
  /** The fail-closed command-envelope composer the shell dispatches through. */
  composeCommand(parts: {
    readonly commandName: CommandName;
    readonly payload: unknown;
    readonly scope: Scope;
    readonly actor: Actor;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly issuedAt: Timestamp;
  }): Result<CommandEnvelope<unknown>, DomainError>;
}

/** The world's server-side authorization (the full operator grant). */
const worldAuthorization = (policy: Policy, capabilities: readonly Capability[]) => ({
  policy,
  capabilities: [...capabilities] as string[],
});

const WORLD_CAPABILITIES: readonly Capability[] = [
  capability('organization.write'),
  capability('projects.write'),
  capability('schedule.write'),
  capability('work.write'),
  capability('cost.write'),
  capability('contracts.write'),
  capability('documents.write'),
  capability('workflows.write'),
];

const WORLD_POLICY: Policy = definePolicy([
  { effect: 'allow', capabilities: ['organization.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['projects.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['schedule.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['work.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['cost.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['contracts.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['documents.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['workflows.write'], actions: ['read', 'write'] },
]);

/**
 * Create + seed the deterministic office world: one tenant, one project, a
 * schedule with activities + a baseline, an executed contract, a budget with
 * cost items + a committed purchase order, a raised change event evidenced
 * by a document revision, and a published approval workflow with a live
 * instance over the change event. Every seed mutation is a REAL command
 * through the landed packages' public command surfaces (authorization,
 * invariants, concurrency, audit events, idempotency keys 'seed-0001'...).
 */
export async function seedOfficeWorld(parts: SeededWorldParts): Promise<SeededWorld> {
  // ---- fail-closed identity parsing (trusted path — loud TypeErrors). ----
  const tenantId = expectOk(parseTenantId(parts.tenantId), 'tenant id');
  const projectId = expectOk(parseProjectId(parts.projectId), 'project id');
  const actorId = expectOk(parseEntityId(parts.actorId), 'actor id');
  const actor: Actor = { kind: 'user', actorId };
  const correlationId = expectOk(parseCorrelationId(parts.correlationId), 'correlation id');
  const scope: ProjectScope = { kind: 'project', tenantId, projectId };
  const tenantScope: Scope = { kind: 'tenant', tenantId };

  // ---- the shared wiring --------------------------------------------------
  const recorder = createWorldEventRecorder();
  const slice = createInMemorySliceSource();
  const broker = createSubscriptionBroker({ policy: WORLD_POLICY, source: slice });
  const commandJournal: CommandJournalEntry[] = [];

  const fieldRegistry = createInMemoryIdempotencyRegistry();
  const workflowRegistry = createInMemoryIdempotencyRegistry();
  const documentRegistry = createInMemoryIdempotencyRegistry();

  const projectsRepository = createInMemoryProjectsRepository();
  const organizationsRepository = createInMemoryOrganizationsRepository();
  const scheduleStore = createInMemoryScheduleStore();
  const fieldStore = createInMemoryFieldStore();
  const costStore = createInMemoryCostStore();
  const contractsStore = createInMemoryContractsStore();
  const documentsStore = createInMemoryDocumentsStore();
  const workflowStore = createInMemoryWorkflowStore();

  const organizations = createOrganizationCommands({
    repository: organizationsRepository,
    eventSink: recorder.sink,
    transactionRunner: {
      runInTransaction: async (work) => work(noOpExecutor),
    },
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const projects = createProjectCommands({
    repository: projectsRepository,
    eventSink: recorder.sink,
    transactionRunner: {
      runInTransaction: async (work) => work(noOpExecutor),
    },
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const schedule = createScheduleCommands({
    store: scheduleStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const field = createFieldCommands({
    store: fieldStore,
    eventSink: recorder.sink,
    idempotencyRegistry: fieldRegistry,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
    executor: noOpExecutor,
  });
  const cost = createCostCommands({
    store: costStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const contracts = createContractsCommands({
    store: contractsStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const documents = createDocumentsCommands({
    store: documentsStore,
    eventSink: recorder.sink,
    objectStorage: createInMemoryObjectStorage(),
    idempotencyRegistry: documentRegistry,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
    hashContent: (content: Uint8Array): RevisionHash =>
      createHash('sha256').update(content).digest('hex') as RevisionHash,
  });
  const workflows = createWorkflowCommands({
    store: workflowStore,
    eventSink: recorder.sink,
    idempotencyRegistry: workflowRegistry,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
    executor: noOpExecutor,
  });

  const authorization = worldAuthorization(WORLD_POLICY, WORLD_CAPABILITIES);

  // ---- the generic typed dispatch (name → the landed command surface) ----

  /**
   * The normalized outcome of one command execution through a landed command
   * surface: the committed aggregate state (typed by the caller) plus the
   * replay flag (the field/documents/workflows services replay recorded
   * outcomes for a duplicate idempotency key; the plain-state services never
   * replay in-memory because their registries are per-command-name).
   */
  interface Executed {
    readonly state: unknown;
    readonly replayed: boolean;
  }

  /** Adapt a plain-state CommandResult (organizations/projects/schedule/cost/contracts). */
  const plainExecution = async <S>(
    run: () => Promise<Result<S, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok ? { ok: true, value: { state: result.value, replayed: false } } : result;
  };

  /** Adapt an outcome-shaped CommandResult (field/workflows: { state, replayed }). */
  const outcomeExecution = async <S>(
    run: () => Promise<Result<{ readonly state: S; readonly replayed: boolean }, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok
      ? { ok: true, value: { state: result.value.state, replayed: result.value.replayed } }
      : result;
  };

  /** Adapt an idempotent-execution CommandResult (documents: { value, replayed }). */
  const idempotentExecution = async <S>(
    run: () => Promise<Result<{ readonly value: S; readonly replayed: boolean }, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok
      ? { ok: true, value: { state: result.value.value, replayed: result.value.replayed } }
      : result;
  };

  const dispatch = (
    command: CommandEnvelope<unknown>,
  ): Promise<Result<Executed, DomainError>> => {
    switch (command.commandName) {
      case CREATE_ORGANIZATION_COMMAND:
        return plainExecution(() => organizations.createOrganization(command, authorization));
      case CREATE_PROJECT_COMMAND:
        return plainExecution(() => projects.createProject(command, authorization));
      case CREATE_SCHEDULE_COMMAND:
        return plainExecution(() => schedule.createSchedule(command, authorization));
      case ADD_ACTIVITY_COMMAND:
        return plainExecution(() => schedule.addActivity(command, authorization));
      case ADD_DEPENDENCY_COMMAND:
        return plainExecution(() => schedule.addDependency(command, authorization));
      case SET_BASELINE_COMMAND:
        return plainExecution(() => schedule.setBaseline(command, authorization));
      case CAPTURE_FIELD_EVENT_COMMAND:
        return outcomeExecution(() => field.fieldEvents.captureFieldEvent(command, authorization));
      case CREATE_BUDGET_COMMAND:
        return plainExecution(() => cost.createBudget(command, authorization));
      case RECORD_COST_ITEM_COMMAND:
        return plainExecution(() => cost.recordCostItem(command, authorization));
      case CREATE_COMMITMENT_COMMAND:
        return plainExecution(() => cost.createCommitment(command, authorization));
      case CREATE_CONTRACT_COMMAND:
        return plainExecution(() => contracts.createContract(command, authorization));
      case RAISE_CHANGE_EVENT_COMMAND:
        return plainExecution(() => contracts.raiseChangeEvent(command, authorization));
      case REGISTER_DOCUMENT_COMMAND:
        return idempotentExecution(() => documents.registerDocument(command, authorization));
      case ATTACH_REVISION_COMMAND:
        return idempotentExecution(() => documents.attachRevision(command, authorization));
      case CREATE_DEFINITION_COMMAND:
        return outcomeExecution(() => workflows.definitions.createDefinition(command, authorization));
      case PUBLISH_DEFINITION_COMMAND:
        return outcomeExecution(() => workflows.definitions.publishDefinition(command, authorization));
      case START_INSTANCE_COMMAND:
        return outcomeExecution(() => workflows.instances.startInstance(command, authorization));
      case EXECUTE_TRANSITION_COMMAND:
        return outcomeExecution(() => workflows.instances.executeTransition(command, authorization));
      case SUBMIT_APPROVAL_COMMAND:
        return outcomeExecution(() => workflows.approvals.submitApproval(command, authorization));
      case APPROVE_APPROVAL_COMMAND:
        return outcomeExecution(() => workflows.approvals.approveApproval(command, authorization));
      default: {
        const unbound = domainError(
          'invariant-violation',
          `the web shell has no command surface bound for '${command.commandName}'`,
          [{ code: 'unbound-command', message: command.commandName, path: null }],
          { scope: command.scope, correlationId: command.causality.correlationId },
        );
        return Promise.resolve({ ok: false as const, error: unbound });
      }
    }
  };

  /** Ingest the recorder's new envelopes into the ledger-shaped stream. */
  const ingestNewEnvelopes = async (
    from: number,
  ): Promise<Result<readonly LedgerEvent[], DomainError>> => {
    const appended: LedgerEvent[] = [];
    for (const envelope of recorder.envelopes.slice(from)) {
      const after = envelope.entityRefs.after;
      if (after === null) {
        return {
          ok: false,
          error: invariantViolation(
            {
              name: 'world-ledger-aggregate',
              statement: `the audit event '${envelope.eventName}' carries no after-ref to derive its ledger aggregate from`,
            },
            { scope: envelope.scope, correlationId: envelope.causality.correlationId },
          ),
        };
      }
      const event = await slice.append(envelope, after);
      if (!event.ok) return event;
      appended.push(event.value);
    }
    return { ok: true, value: appended };
  };

  /** The world's ONE typed command execution (journal + ledger ingest). */
  const execute = async <S>(
    command: CommandEnvelope<unknown>,
  ): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  > => {
    const before = recorder.count;
    const result = await dispatch(command);
    if (!result.ok) {
      commandJournal.push({
        commandName: command.commandName,
        idempotencyKey: command.idempotencyKey,
        actor: command.actor,
        issuedAt: command.issuedAt,
        correlationId: command.causality.correlationId,
        outcome: 'rejected',
        rejectionCode: result.error.code,
        eventId: null,
        eventName: null,
      });
      return result;
    }
    const ingested = await ingestNewEnvelopes(before);
    if (!ingested.ok) return ingested;
    const produced = ingested.value[ingested.value.length - 1];
    if (produced === undefined) {
      // No new envelope: the landed service replayed a recorded outcome for
      // this idempotency key — the ORIGINAL event is the command's effect.
      if (result.value.replayed) {
        const prior = [...commandJournal]
          .reverse()
          .find(
            (entry) =>
              entry.idempotencyKey === command.idempotencyKey && entry.eventId !== null,
          );
        const priorEvent =
          prior === undefined || prior.eventId === null
            ? undefined
            : slice.events.find((event) => event.eventId === prior.eventId);
        if (priorEvent !== undefined) {
          return {
            ok: true,
            value: { state: result.value.state as S, replayed: true, event: priorEvent },
          };
        }
      }
      return {
        ok: false,
        error: invariantViolation(
          {
            name: 'world-command-produced-no-event',
            statement: `the command '${command.commandName}' executed without appending an audit event`,
          },
          { scope: command.scope, correlationId: command.causality.correlationId },
        ),
      };
    }
    commandJournal.push({
      commandName: command.commandName,
      idempotencyKey: command.idempotencyKey,
      actor: command.actor,
      issuedAt: command.issuedAt,
      correlationId: command.causality.correlationId,
      outcome: 'executed',
      rejectionCode: null,
      eventId: produced.eventId,
      eventName: produced.envelope.eventName,
    });
    return {
      ok: true,
      value: { state: result.value.state as S, replayed: result.value.replayed, event: produced },
    };
  };

  const composeCommand = (input: {
    readonly commandName: CommandName;
    readonly payload: unknown;
    readonly scope: Scope;
    readonly actor: Actor;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly issuedAt: Timestamp;
  }): Result<CommandEnvelope<unknown>, DomainError> => {
    const key = parseIdempotencyKey(input.idempotencyKey);
    if (!key.ok) {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `invalid idempotency key '${input.idempotencyKey}'`,
          [{ code: 'invalid-idempotency-key', message: input.idempotencyKey, path: 'idempotencyKey' }],
          { scope: input.scope, correlationId: null },
        ),
      };
    }
    const correlation = parseCorrelationId(input.correlationId);
    if (!correlation.ok) {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `invalid correlation id '${input.correlationId}'`,
          [{ code: 'invalid-correlation-id', message: input.correlationId, path: 'correlationId' }],
          { scope: input.scope, correlationId: null },
        ),
      };
    }
    const envelope = parseCommandEnvelope({
      kind: 'command',
      commandName: input.commandName,
      scope: input.scope,
      actor: input.actor,
      idempotencyKey: key.value,
      causality: { correlationId: correlation.value, causationId: null },
      issuedAt: input.issuedAt,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: input.payload,
    });
    if (!envelope.ok) {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `invalid command envelope for '${input.commandName}': ${envelope.error.code} at '${envelope.error.path}'`,
          [
            {
              code: 'invalid-command-envelope',
              message: `${envelope.error.code}: ${envelope.error.received}`,
              path: envelope.error.path,
            },
          ],
          { scope: input.scope, correlationId: null },
        ),
      };
    }
    return { ok: true, value: envelope.value };
  };

  // ---- THE deterministic seed script --------------------------------------
  // Generic fixture vocabulary only: neutral names, fixed identities, no
  // provider vocabulary, no real vendor names.
  let seedTick = 0;
  const nextSeedKey = (): string => `seed-cmd-${String((seedTick += 1)).padStart(4, '0')}`;

  /**
   * The canonical id of one entity a seed command CREATED, read from the
   * command's own appended event payload (the public record of what the
   * command did — the aggregate-root state a mutation returns identifies the
   * ROOT, not the newly created child entity).
   */
  const createdIdOf = (event: LedgerEvent, field: string): EntityId => {
    const payload = event.envelope.payload as Readonly<Record<string, unknown>>;
    const raw = payload[field];
    if (typeof raw !== 'string') {
      throw new TypeError(
        `seed wiring error: event ${event.envelope.eventName} carries no '${field}' in its payload`,
      );
    }
    const id = parseEntityId(raw);
    if (!id.ok) {
      throw new TypeError(
        `seed wiring error: event ${event.envelope.eventName} payload '${field}' is not a canonical entity id`,
      );
    }
    return id.value;
  };

  /** Run one seed command through the world's typed path (loud on failure). */
  const seedCommand = async <S>(
    commandName: CommandName,
    payload: unknown,
    options: { readonly scope?: Scope; readonly key?: string } = {},
  ): Promise<{ readonly state: S; readonly event: LedgerEvent }> => {
    const composed = composeCommand({
      commandName,
      payload,
      scope: options.scope ?? scope,
      actor,
      idempotencyKey: options.key ?? nextSeedKey(),
      correlationId,
      issuedAt: parts.now(),
    });
    if (!composed.ok) {
      throw new TypeError(`seed wiring error (compose ${commandName}): ${composed.error.message}`);
    }
    const executed = await execute<S>(composed.value);
    if (!executed.ok) {
      throw new TypeError(
        `seed wiring error (execute ${commandName}): ${executed.error.code} — ${executed.error.message}`,
      );
    }
    return { state: executed.value.state, event: executed.value.event };
  };

  // The seed executes synchronously in a deterministic fixed order; the
  // async IIFE keeps the world creation await-free for hosts (the world is
  // materialized eagerly — deterministic and single-threaded by design).
  const seed = async (): Promise<SeedIdentities> => {
    const organization = await seedCommand<OrganizationState>(
      CREATE_ORGANIZATION_COMMAND,
      { name: 'Reference Operator Organization' },
      { scope: tenantScope },
    );
    const project = await seedCommand<ProjectState>(CREATE_PROJECT_COMMAND, {
      name: 'Reference Campus Works',
    });
    const scheduleState = await seedCommand<{ readonly entityId: EntityId }>(
      CREATE_SCHEDULE_COMMAND,
      { name: 'Reference master programme' },
    );
    const scheduleId = scheduleState.state.entityId;
    const activityIds: EntityId[] = [];
    for (const activity of [
      { code: 'A-100', name: 'Site establishment', plannedDuration: 20 },
      { code: 'A-200', name: 'Structural frame', plannedDuration: 35 },
      { code: 'A-300', name: 'Envelope and fit-out', plannedDuration: 15 },
    ] as const) {
      const added = await seedCommand<{ readonly entityId: EntityId }>(ADD_ACTIVITY_COMMAND, {
        scheduleId,
        expectedVersion: activityIds.length + 1,
        code: activity.code,
        name: activity.name,
        plannedDuration: activity.plannedDuration,
        plannedStart: null,
        plannedFinish: null,
        parentActivityId: null,
      });
      activityIds.push(createdIdOf(added.event, 'activityId'));
    }
    // The serial reference chain A-100 → A-200 → A-300 (finish-to-start, no
    // lag): the deterministic critical path the workspace's forecast projects
    // over (one chain, 20 + 35 + 15 = 70 days).
    let scheduleVersion = 1 + activityIds.length;
    const firstActivity = activityIds[0];
    const secondActivity = activityIds[1];
    const thirdActivity = activityIds[2];
    if (
      firstActivity === undefined ||
      secondActivity === undefined ||
      thirdActivity === undefined
    ) {
      throw new TypeError(
        `seed wiring error: the reference programme needs exactly three activities (got ${activityIds.length})`,
      );
    }
    for (const link of [
      { predecessorId: firstActivity, successorId: secondActivity },
      { predecessorId: secondActivity, successorId: thirdActivity },
    ] as const) {
      await seedCommand(ADD_DEPENDENCY_COMMAND, {
        scheduleId,
        expectedVersion: scheduleVersion,
        predecessorId: link.predecessorId,
        successorId: link.successorId,
        linkType: 'FS',
      });
      scheduleVersion += 1;
    }
    await seedCommand<{ readonly entityId: EntityId }>(SET_BASELINE_COMMAND, {
      scheduleId,
      expectedVersion: scheduleVersion,
      label: 'Baseline 1',
    });

    const contract = await seedCommand<{ readonly entityId: EntityId }>(CREATE_CONTRACT_COMMAND, {
      title: 'Reference main works contract',
      owner: { entityKind: 'company', entityId: expectOk(parseEntityId('office-ent-v1-a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'), 'owner id') },
      contractor: { entityKind: 'company', entityId: expectOk(parseEntityId('office-ent-v1-b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'), 'contractor id') },
      contractValue: { amount: 1_000_000, currency: 'EUR' },
      executionStatus: 'executed',
    });
    const contractId = contract.state.entityId;

    const budget = await seedCommand<{ readonly entityId: EntityId }>(CREATE_BUDGET_COMMAND, {
      name: 'Reference construction budget',
      currency: 'EUR',
    });
    const budgetId = budget.state.entityId;
    const costItemIds: EntityId[] = [];
    for (const item of [
      { code: 'CONC', description: 'Concrete works', unit: 'm3', quantityMilli: 4_000, unitRateMinor: 100_000 },
      { code: 'STEEL', description: 'Structural steel', unit: 't', quantityMilli: 1_000, unitRateMinor: 600_000 },
    ] as const) {
      const recorded = await seedCommand<{ readonly entityId: EntityId }>(RECORD_COST_ITEM_COMMAND, {
        budgetId,
        expectedVersion: costItemIds.length + 1,
        code: item.code,
        description: item.description,
        unit: item.unit,
        quantityMilli: item.quantityMilli,
        unitRateMinor: item.unitRateMinor,
      });
      costItemIds.push(createdIdOf(recorded.event, 'costItemId'));
    }
    const commitment = await seedCommand<{ readonly entityId: EntityId }>(CREATE_COMMITMENT_COMMAND, {
      budgetId,
      number: 'PO-0001',
      commitmentKind: 'purchase-order',
      description: 'Structural frame package',
      currency: 'EUR',
      lines: [
        {
          costItemId: costItemIds[0] as EntityId,
          description: 'Concrete works package',
          amountMinor: 1_050_000,
        },
      ],
    });

    const document = await seedCommand<{ readonly entityId: EntityId }>(REGISTER_DOCUMENT_COMMAND, {
      projectId,
      title: 'Change evidence pack',
    });
    const documentId = document.state.entityId;
    const revision = await seedCommand<{
      readonly document: { readonly entityId: EntityId };
      readonly revision: { readonly entityId: EntityId };
    }>(ATTACH_REVISION_COMMAND, {
      projectId,
      documentId,
      expectedVersion: 1,
      contentBase64: Buffer.from('reference change evidence pack v1', 'utf8').toString('base64'),
    });

    const changeEvent = await seedCommand<{ readonly entityId: EntityId }>(RAISE_CHANGE_EVENT_COMMAND, {
      contractId,
      title: 'Structural modification at level 3',
      changeType: 'modification',
      evidenceLinks: [{ documentId, revisionId: revision.state.revision.entityId }],
      costImpactLinks: [{ budgetId, costItemId: null }],
    });

    const definition = await seedCommand<{ readonly entityId: EntityId }>(CREATE_DEFINITION_COMMAND, {
      key: 'change-event-approval',
      title: 'Change event approval',
      description: 'The seeded project change-event approval workflow',
      model: {
        states: [
          { name: 'draft', kind: 'initial' },
          { name: 'review', kind: 'normal' },
          { name: 'approved', kind: 'success' },
          { name: 'rejected', kind: 'failure' },
        ],
        transitions: [
          { key: 'submit-for-review', from: 'draft', to: 'review', conditions: [{ kind: 'always' }] },
          {
            key: 'approve-change',
            from: 'review',
            to: 'approved',
            conditions: [
              { kind: 'approval-decision', approval: 'manager', decision: 'approved' },
            ],
          },
          {
            key: 'reject-change',
            from: 'review',
            to: 'rejected',
            conditions: [{ kind: 'approval-decision', approval: 'manager', decision: 'rejected' }],
          },
        ],
        tasks: [
          {
            key: 'verify-docs',
            title: 'Verify change evidence',
            state: 'review',
            assignment: { actorKinds: ['user'], roles: ['reviewer'] },
            slaMinutes: 60,
          },
        ],
        approvals: [
          {
            key: 'manager',
            title: 'Commercial manager approval',
            state: 'review',
            requiredCapability: 'cost.write',
            policyRef: 'policy/change-events@1',
          },
        ],
        retryPolicy: { maxAttempts: 2, backoffBaseSeconds: 60, backoffMaxSeconds: 600 },
        escalationRules: [],
      },
    });
    const definitionId = definition.state.entityId;
    await seedCommand<{ readonly entityId: EntityId }>(PUBLISH_DEFINITION_COMMAND, {
      definitionId,
      expectedVersion: 1,
    });
    const instance = await seedCommand<{ readonly entityId: EntityId }>(START_INSTANCE_COMMAND, {
      definitionId,
      subject: { entityKind: 'change-event', entityId: changeEvent.state.entityId },
    });

    return {
      organizationId: organization.state.entityId,
      projectId: project.state.entityId,
      scheduleId,
      activityIds: [...activityIds],
      contractId,
      budgetId,
      costItemIds: [...costItemIds],
      commitmentId: commitment.state.entityId,
      changeEventId: changeEvent.state.entityId,
      documentId,
      revisionId: revision.state.revision.entityId,
      workflowDefinitionId: definitionId,
      workflowInstanceId: instance.state.entityId,
    };
  };

  // The world itself, with its captured seed identities (a failed seed is a
  // LOUD wiring error — the world is never half-usable; every seed command
  // went through the world's own typed execution path above).
  const world: SeededWorld = {
    kind: 'seeded-world',
    slice,
    get ledgerEvents(): readonly LedgerEvent[] {
      return slice.events;
    },
    broker,
    get commandJournal(): readonly CommandJournalEntry[] {
      return [...commandJournal];
    },
    identities: await seed(),
    scope,
    actor,
    policy: WORLD_POLICY,
    capabilities: [...WORLD_CAPABILITIES],
    stores: {
      projects: projectsRepository,
      organizations: organizationsRepository,
      schedule: scheduleStore,
      field: fieldStore,
      cost: costStore,
      contracts: contractsStore,
      documents: documentsStore,
      workflows: workflowStore,
    },
    services: {
      organizations,
      projects,
      schedule,
      field,
      cost,
      contracts,
      documents,
      workflows,
    },
    recorder,
    registries: { field: fieldRegistry, workflows: workflowRegistry, documents: documentRegistry },
    execute,
    composeCommand,
  };
  return world;
}

const noOpExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
  // The in-memory twin never rolls back (there is no database to roll back);
  // the method exists to satisfy the landed Transaction port structurally.
  rollback: (() => {
    throw new TypeError('the in-memory world executor never rolls back');
  }) as <T>(value: T) => never,
} as const;
