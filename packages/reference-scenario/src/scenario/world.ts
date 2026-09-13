// Office reference-scenario — THE seeded construction world (OFF-037).
//
// The deterministic in-memory world the golden chain runs over: ONE tenant,
// ONE organization, ONE project, and the four canonical command services
// (organization / projects / cost / schedule) plus the workflows approval
// surface, all composed ONLY through the landed packages' public surfaces —
// their command services, their in-memory stores, their audit-event sinks —
// with every executed command's audit envelope landing in ONE append-only
// in-memory ledger whose event identity derives through @office/events' own
// deterministic ledger-identity helpers (ledgerEventIdOf over dense
// per-aggregate sequences — the ledger identity semantics, never a second
// source of truth: the ledger IS the events package's record shape).
//
// This is the scenario host's stand-in for the server runtime: it NEVER
// touches a database (structurally database-free — no @office/persistence
// import anywhere, not even type-only; no SQL; no repositories), never
// constructs an action gateway, and never writes canonical state directly —
// every mutation flows through a landed package's own command handler with
// its authorization, concurrency, invariant, and audit gates. The
// structurally-required executor handle of the workflows EventSink port is
// satisfied by a pure in-memory no-op twin (structural typing).
//
// Determinism (the kernel rule): no wall clock, no randomness — the clock and
// the canonical-id opaque supplier are INJECTED (`parts.now`,
// `parts.newOpaqueId`), and every seed identity is a fixed literal or a
// deterministic derivation, so the same parts always produce the
// byte-identical world (the run-twice named acceptance).
//
// Mirrors the landed apps'field seeded-world discipline (the structural
// template — mirrored, never imported: packages never import apps), scoped
// to the reference scenario's canonical world: organization + project + the
// cost / schedule / workflow aggregates the golden chain mutates.
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
  createInMemoryIdempotencyRegistry,
  domainError,
  invariantViolation,
  ok,
} from '@office/domain-kernel';
import type { DomainError, IdempotencyRegistry, Result } from '@office/domain-kernel';
import { causationIdOf, ledgerEventIdOf, parseLedgerSequence } from '@office/events';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  CREATE_ORGANIZATION_COMMAND,
  createOrganizationCommands,
  createOrganizationState,
} from '@office/domain-organization';
import type { OrganizationState, OrganizationsRepository } from '@office/domain-organization';
import { CREATE_PROJECT_COMMAND, createProjectCommands, createProjectState } from '@office/domain-projects';
import type { ProjectState, ProjectsDomainRepository } from '@office/domain-projects';
import {
  AMEND_COMMITMENT_COMMAND,
  CLOSE_COMMITMENT_COMMAND,
  CREATE_BUDGET_COMMAND,
  CREATE_COMMITMENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  RECORD_INVOICE_COMMAND,
  REFERENCE_PAYMENT_COMMAND,
  REVISE_BUDGET_COMMAND,
  createCostCommands,
  createInMemoryCostStore,
} from '@office/domain-cost';
import type { CostCommands, InMemoryCostStore } from '@office/domain-cost';
import {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  ADD_MILESTONE_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  RECORD_PROGRESS_COMMAND,
  REMOVE_DEPENDENCY_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  createScheduleCommands,
  createInMemoryScheduleStore,
} from '@office/domain-schedule';
import type { InMemoryScheduleStore, ScheduleCommands } from '@office/domain-schedule';
import {
  APPROVE_APPROVAL_COMMAND,
  CREATE_DEFINITION_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  START_INSTANCE_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  createWorkflowCommands,
  createInMemoryWorkflowStore,
} from '@office/workflows';
import type { WorkflowCommands, WorkflowStore } from '@office/workflows';

// ---------------------------------------------------------------------------
// Trusted-path assertion helpers (seed wiring errors are loud, never silent).
// ---------------------------------------------------------------------------

const expectOk = <T, E>(result: Result<T, E>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`world wiring error (${what}): ${JSON.stringify(result)}`);
};

// ---------------------------------------------------------------------------
// The world's ledger: ONE append-only stream of LedgerEvents (the @office/events
// record shape + its deterministic identity semantics).
// ---------------------------------------------------------------------------

/**
 * The scenario's in-memory event ledger: every executed command's audit
 * envelope becomes exactly ONE `LedgerEvent` — the events package's own
 * record shape, with the event id derived deterministically through its
// exported `ledgerEventIdOf` (sha over tenant|aggregate-kind|aggregate-id|
// dense-sequence) and the per-aggregate sequence dense and strictly
 * monotonic. Appending the SAME (tenant, aggregate, sequence) identity twice
 * is an idempotent no-op returning the existing record — the structural
 * no-duplicate discipline of the ledger itself.
 */
export interface WorldLedger {
  /** Every ledger event, in append order (the projection basis of every view). */
  readonly events: readonly LedgerEvent[];
  /** The number of ledger events appended so far. */
  readonly count: number;
  /** The ledger event with this id, or null (the read surface of the walk). */
  eventOf(eventId: LedgerEventId): LedgerEvent | null;
  /** Append one envelope as a ledger event of its after-aggregate (idempotent by id). */
  append(envelope: DomainEventEnvelope): Result<LedgerEvent, DomainError>;
}

const createWorldLedger = (): WorldLedger => {
  const events: LedgerEvent[] = [];
  const byId = new Map<string, LedgerEvent>();
  const sequences = new Map<string, number>();
  return {
    get events(): readonly LedgerEvent[] {
      return [...events];
    },
    get count(): number {
      return events.length;
    },
    eventOf(eventId) {
      return byId.get(eventId) ?? null;
    },
    append(envelope) {
      const aggregate = envelope.entityRefs.after;
      if (aggregate === null) {
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
      const tenantId = envelope.scope.tenantId;
      const streamKey = `${tenantId}|${aggregate.entityKind}|${aggregate.entityId}`;
      const nextSequence = (sequences.get(streamKey) ?? 0) + 1;
      const sequence = parseLedgerSequence(nextSequence);
      if (!sequence.ok) {
        return {
          ok: false,
          error: invariantViolation(
            {
              name: 'world-ledger-sequence',
              statement: `the ledger sequence '${String(nextSequence)}' of stream ${streamKey} is not canonical`,
            },
            { scope: envelope.scope, correlationId: envelope.causality.correlationId },
          ),
        };
      }
      const eventId = ledgerEventIdOf({ tenantId, aggregate, sequence: sequence.value });
      const existing = byId.get(eventId);
      if (existing !== undefined) {
        // The canonical no-duplicate discipline: the SAME ledger identity is
        // never appended twice — the original record stands.
        return { ok: true, value: existing };
      }
      const event: LedgerEvent = {
        eventId,
        sequence: sequence.value,
        aggregate,
        envelope,
      };
      events.push(event);
      byId.set(eventId, event);
      sequences.set(streamKey, nextSequence);
      return { ok: true, value: event };
    },
  };
};

// ---------------------------------------------------------------------------
// The shared audit-event recorder + no-op executor (the landed ports'
// in-memory structural twins — the persistence package is never imported).
// ---------------------------------------------------------------------------

/**
 * The shared EventSink every domain command service appends through (each
 * landed domain's mirrored EventSink port; the executor handle is accepted
 * opaquely). ONE recorder = ONE audit trail = the ledger's input stream.
 */
export interface WorldEventRecorder {
  /** Every appended envelope, in append order (the world's audit trail). */
  readonly envelopes: readonly DomainEventEnvelope[];
  /** The port shape every landed domain's command deps accept. */
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

/**
 * The in-memory no-op executor/transaction handle of the workflows sink
 * (structural twin of the landed port's handle — @office/persistence is
 * never imported, not even TYPE-ONLY). The in-memory world never rolls back.
 */
const noOpExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
  rollback: (_value: unknown): never => {
    throw new TypeError('the in-memory reference world never rolls back');
  },
} as const;

// ---------------------------------------------------------------------------
// The world's in-memory identity repositories (the landed packages' port
// implementations — pure in-memory engines, never a database).
// ---------------------------------------------------------------------------

const notFound = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  domainError('not-found', `canonical ${entityKind} ${entityId} not found`, [
    { code: 'entity-not-found', message: entityId, path: null },
  ], { scope, correlationId: null });

const duplicateId = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  invariantViolation(
    {
      name: 'seed-entity-id-already-exists',
      statement: `canonical ${entityKind} id already exists: ${entityId}`,
    },
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
        ...(changes.extensionMetadata !== undefined ? { extensionMetadata: changes.extensionMetadata } : {}),
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

const staleVersion = (entityKind: string, entityId: EntityId, scope: Scope): DomainError =>
  domainError(
    'concurrency-conflict',
    `canonical ${entityKind} ${entityId} changed since read`,
    [{ code: 'stale-version', message: entityId, path: null }],
    { scope, correlationId: null },
  );

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
        ...(changes.extensionMetadata !== undefined ? { extensionMetadata: changes.extensionMetadata } : {}),
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
// The command journal + the session scope gate.
// ---------------------------------------------------------------------------

/** One entry of the world's command journal (the world's dispatch log). */
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

/**
 * ONE acting session of the world: the scope every submission is gated
 * against (freeze A12 — the session covers its own project, nothing else),
 * the acting user, the deny-by-default policy, and the capabilities granted
 * to that actor for every request.
 */
export interface ScenarioSession {
  readonly kind: 'reference-scenario-session';
  readonly scope: ProjectScope;
  readonly actor: Actor;
  readonly policy: Policy;
  readonly capabilities: readonly Capability[];
  readonly correlationId: CorrelationId;
}

/** Does the session's scope cover the addressed scope (the A12 gate)? */
export const sessionCoversScope = (session: ScenarioSession, scope: Scope): boolean =>
  session.scope.tenantId === scope.tenantId &&
  (scope.kind === 'tenant' || scope.projectId === session.scope.projectId);

const scopeRejection = (session: ScenarioSession, scope: Scope): DomainError =>
  domainError(
    'forbidden',
    'the session does not cover the addressed scope (A12)',
    [
      {
        code: 'session-scope-violation',
        message: `session project ${session.scope.projectId} does not cover ${
          scope.kind === 'project' ? `project ${scope.projectId}` : `tenant ${scope.tenantId}`
        }`,
        path: 'scope',
      },
    ],
    { scope: session.scope, correlationId: session.correlationId },
  );

// ---------------------------------------------------------------------------
// The seeded world itself.
// ---------------------------------------------------------------------------

/** The injected deterministic parts of one seeded reference world. */
export interface SeededWorldParts {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly correlationId: string;
  /** Injected clock — the canonical 'now' of every command (never wall time). */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier. */
  readonly newOpaqueId: () => string;
}

/** The fixed identities the seed script captured (for tests and hosts). */
export interface WorldSeedIdentities {
  readonly organizationId: EntityId;
  readonly projectId: ProjectId;
}

/** The deterministic seeded reference world: services, stores, ledger, journal. */
export interface SeededWorld {
  readonly kind: 'seeded-reference-world';
  /** Every ledger event, in append order (the projection basis of every view). */
  readonly ledgerEvents: readonly LedgerEvent[];
  /** The world's command journal — every command the world executed. */
  readonly commandJournal: readonly CommandJournalEntry[];
  /** The seed's captured identities. */
  readonly identities: WorldSeedIdentities;
  /** The world's tenant/project scope + tenant scope. */
  readonly scope: ProjectScope;
  readonly tenantScope: Scope;
  /** The world's seeded session (the submitter of the chain's own commands). */
  readonly session: ScenarioSession;
  /** The world's deny-by-default policy (the domain-command grant). */
  readonly policy: Policy;
  /** The capabilities the world's domain-command authorizations hold. */
  readonly capabilities: readonly Capability[];
  /** The in-memory reference stores (the read surfaces of the projections). */
  readonly stores: {
    readonly projects: ProjectsDomainRepository;
    readonly organizations: OrganizationsRepository;
    readonly cost: InMemoryCostStore;
    readonly schedule: InMemoryScheduleStore;
    readonly workflows: WorkflowStore;
  };
  /** The typed command services of the landed domain + workflow packages. */
  readonly services: {
    readonly organizations: ReturnType<typeof createOrganizationCommands>;
    readonly projects: ReturnType<typeof createProjectCommands>;
    readonly cost: CostCommands;
    readonly schedule: ScheduleCommands;
    readonly workflows: WorkflowCommands;
  };
  /** The world's audit-event recorder (the shared sink every service uses). */
  readonly recorder: WorldEventRecorder;
  /** The world's ledger (the events package record shape + identity). */
  readonly ledger: WorldLedger;
  /** The idempotency registry the wired workflow command service shares. */
  readonly registries: { readonly workflows: IdempotencyRegistry };
  /**
   * The canonical aggregate version of one entity, or null when the world
   * has no committed aggregate under that id (the adapters' runtime-owns-
   * the-graph lookup port, fed from the world's own command journal).
   */
  canonicalVersionOf(entityId: EntityId): number | null;
  /**
   * Compose ONE fail-closed command envelope (the trusted path every
   * submission and every adapter proposal execution goes through).
   */
  composeCommand(parts: {
    readonly commandName: CommandName;
    readonly payload: unknown;
    readonly scope: Scope;
    readonly actor: Actor;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly issuedAt: Timestamp;
  }): Result<CommandEnvelope<unknown>, DomainError>;
  /**
   * Execute ONE command through the landed command surface its name
   * addresses — the generic typed path (session-gated at submission time by
   * `submit`; `execute` itself is the world's internal dispatch).
   */
  execute<S>(command: CommandEnvelope<unknown>): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  >;
  /**
   * Submit ONE command as a session: the A12 scope gate FIRST (a session
   * that does not cover the addressed scope is typed-rejected before any
   * command surface is touched), then compose + execute.
   */
  submit<S>(session: ScenarioSession, parts: {
    readonly commandName: CommandName;
    readonly payload: unknown;
    readonly scope: Scope;
    readonly actor?: Actor;
    readonly idempotencyKey: string;
    readonly correlationId?: string;
    readonly causationId?: string | null;
  }): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  >;
  /** The world's read gate (A12 direction 2): a foreign session reads nothing. */
  readGuard(session: ScenarioSession): Result<true, DomainError>;
}

const WORLD_CAPABILITIES: readonly Capability[] = [
  capability('organization.write'),
  capability('projects.write'),
  capability('cost.write'),
  capability('schedule.write'),
  capability('workflows.write'),
];

const WORLD_POLICY: Policy = definePolicy([
  { effect: 'allow', capabilities: ['organization.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['projects.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['cost.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['schedule.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['workflows.write'], actions: ['read', 'write'] },
]);

/**
 * The deterministic opaque-part sequence the world's cost command service
 * issues (one per created cost-area entity, in command order — the finance
 * fixture's canonical references are derived from it, so the adapter's
 * proposed commands and the executed aggregates agree on identity by
 * construction). Trusted path: composed through formatEntityId.
 */
export const costOpaqueId = (n: number): string => `cst${String(n).padStart(13, '0')}`;

/** A deterministic prefixed opaque-id supplier (one per command service). */
const sequenceSupplier = (prefix: string): (() => string) => {
  let tick = 0;
  return () => `${prefix}${String((tick += 1)).padStart(13, '0')}`;
};

/**
 * Create + seed the deterministic reference world: one tenant, one
 * organization, one project. Every seed mutation is a REAL command through
 * the landed packages' public command surfaces (authorization, invariants,
 * concurrency, audit events, idempotency keys 'seed-cmd-0001'...). Generic
 * fixture vocabulary only.
 */
export async function seedWorld(parts: SeededWorldParts): Promise<SeededWorld> {
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
  const ledger = createWorldLedger();
  const commandJournal: CommandJournalEntry[] = [];
  const versions = new Map<string, number>();

  const organizationsRepository = createInMemoryOrganizationsRepository();
  const projectsRepository = createInMemoryProjectsRepository();
  const workflowRegistry = createInMemoryIdempotencyRegistry();

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
  const costStore = createInMemoryCostStore();
  const cost = createCostCommands({
    store: costStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: sequenceSupplier('cst'),
  });
  const scheduleStore = createInMemoryScheduleStore();
  const schedule = createScheduleCommands({
    store: scheduleStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: sequenceSupplier('sch'),
  });
  const workflowStore = createInMemoryWorkflowStore();
  const workflows = createWorkflowCommands({
    store: workflowStore,
    eventSink: recorder.sink,
    idempotencyRegistry: workflowRegistry,
    now: parts.now,
    newOpaqueId: sequenceSupplier('wfl'),
    executor: noOpExecutor,
  });

  const session: ScenarioSession = {
    kind: 'reference-scenario-session',
    scope,
    actor,
    policy: WORLD_POLICY,
    capabilities: [...WORLD_CAPABILITIES],
    correlationId,
  };

  // ---- the generic typed dispatch (name → the landed command surface) ----

  interface Executed {
    readonly state: unknown;
    readonly replayed: boolean;
  }

  /** Adapt a plain-state CommandResult (organizations/projects/cost/schedule). */
  const plainExecution = async <S>(
    run: () => Promise<Result<S, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok ? { ok: true, value: { state: result.value, replayed: false } } : result;
  };

  /** Adapt an outcome-shaped CommandResult (workflows: { state, replayed }). */
  const outcomeExecution = async <S>(
    run: () => Promise<Result<{ readonly state: S; readonly replayed: boolean }, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok
      ? { ok: true, value: { state: result.value.state, replayed: result.value.replayed } }
      : result;
  };

  const dispatch = (
    command: CommandEnvelope<unknown>,
  ): Promise<Result<Executed, DomainError>> => {
    const worldAuthorization = { policy: WORLD_POLICY, capabilities: [...WORLD_CAPABILITIES] as string[] };
    switch (command.commandName) {
      case CREATE_ORGANIZATION_COMMAND:
        return plainExecution(() => organizations.createOrganization(command, worldAuthorization));
      case CREATE_PROJECT_COMMAND:
        return plainExecution(() => projects.createProject(command, worldAuthorization));
      case CREATE_BUDGET_COMMAND:
        return plainExecution(() => cost.createBudget(command, worldAuthorization));
      case RECORD_COST_ITEM_COMMAND:
        return plainExecution(() => cost.recordCostItem(command, worldAuthorization));
      case REVISE_BUDGET_COMMAND:
        return plainExecution(() => cost.reviseBudget(command, worldAuthorization));
      case CREATE_COMMITMENT_COMMAND:
        return plainExecution(() => cost.createCommitment(command, worldAuthorization));
      case AMEND_COMMITMENT_COMMAND:
        return plainExecution(() => cost.amendCommitment(command, worldAuthorization));
      case CLOSE_COMMITMENT_COMMAND:
        return plainExecution(() => cost.closeCommitment(command, worldAuthorization));
      case RECORD_INVOICE_COMMAND:
        return plainExecution(() => cost.recordInvoice(command, worldAuthorization));
      case REFERENCE_PAYMENT_COMMAND:
        return plainExecution(() => cost.referencePayment(command, worldAuthorization));
      case CREATE_SCHEDULE_COMMAND:
        return plainExecution(() => schedule.createSchedule(command, worldAuthorization));
      case ADD_ACTIVITY_COMMAND:
        return plainExecution(() => schedule.addActivity(command, worldAuthorization));
      case UPDATE_ACTIVITY_COMMAND:
        return plainExecution(() => schedule.updateActivity(command, worldAuthorization));
      case ADD_DEPENDENCY_COMMAND:
        return plainExecution(() => schedule.addDependency(command, worldAuthorization));
      case REMOVE_DEPENDENCY_COMMAND:
        return plainExecution(() => schedule.removeDependency(command, worldAuthorization));
      case ADD_MILESTONE_COMMAND:
        return plainExecution(() => schedule.addMilestone(command, worldAuthorization));
      case SET_BASELINE_COMMAND:
        return plainExecution(() => schedule.setBaseline(command, worldAuthorization));
      case RECORD_PROGRESS_COMMAND:
        return plainExecution(() => schedule.recordProgress(command, worldAuthorization));
      case CREATE_DEFINITION_COMMAND:
        return outcomeExecution(() => workflows.definitions.createDefinition(command, worldAuthorization));
      case PUBLISH_DEFINITION_COMMAND:
        return outcomeExecution(() => workflows.definitions.publishDefinition(command, worldAuthorization));
      case START_INSTANCE_COMMAND:
        return outcomeExecution(() => workflows.instances.startInstance(command, worldAuthorization));
      case EXECUTE_TRANSITION_COMMAND:
        return outcomeExecution(() => workflows.instances.executeTransition(command, worldAuthorization));
      case SUBMIT_APPROVAL_COMMAND:
        return outcomeExecution(() => workflows.approvals.submitApproval(command, worldAuthorization));
      case APPROVE_APPROVAL_COMMAND:
        return outcomeExecution(() => workflows.approvals.approveApproval(command, worldAuthorization));
      default: {
        const unbound = domainError(
          'invariant-violation',
          `the reference world has no command surface bound for '${command.commandName}'`,
          [{ code: 'unbound-command', message: command.commandName, path: null }],
          { scope: command.scope, correlationId: command.causality.correlationId },
        );
        return Promise.resolve({ ok: false as const, error: unbound });
      }
    }
  };

  /** Ingest the recorder's new envelopes into the ledger. */
  const ingestNewEnvelopes = (from: number): Result<readonly LedgerEvent[], DomainError> => {
    const appended: LedgerEvent[] = [];
    for (const envelope of recorder.envelopes.slice(from)) {
      const event = ledger.append(envelope);
      if (!event.ok) return event;
      appended.push(event.value);
    }
    return { ok: true, value: appended };
  };

  /** Record the committed aggregate's version (the adapters' graph lookup). */
  const recordVersion = (state: unknown): void => {
    const versioned = state as { readonly entityId?: unknown; readonly version?: unknown };
    if (
      typeof versioned?.entityId === 'string' &&
      typeof versioned?.version === 'number' &&
      Number.isInteger(versioned.version)
    ) {
      versions.set(versioned.entityId, versioned.version);
    }
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
    recordVersion(result.value.state);
    const ingested = ingestNewEnvelopes(before);
    if (!ingested.ok) return ingested;
    const produced = ingested.value[ingested.value.length - 1];
    if (produced === undefined) {
      // No new envelope: the landed service replayed a recorded outcome for
      // this idempotency key — the ORIGINAL event is the command's effect.
      if (result.value.replayed) {
        const prior = [...commandJournal]
          .reverse()
          .find((entry) => entry.idempotencyKey === command.idempotencyKey && entry.eventId !== null);
        const priorEvent =
          prior === undefined || prior.eventId === null
            ? undefined
            : ledger.eventOf(prior.eventId) ?? undefined;
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
    readonly causationId: string | null;
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
      causality: input.causationId === null
        ? { correlationId: correlation.value, causationId: null }
        : { correlationId: correlation.value, causationId: parseCausation(input.causationId) },
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

  /** Parse a causation token through the events package's trusted helper. */
  const parseCausation = (token: string) => causationIdOf(token);

  const submit = async <S>(
    submitSession: ScenarioSession,
    input: {
      readonly commandName: CommandName;
      readonly payload: unknown;
      readonly scope: Scope;
      readonly actor?: Actor;
      readonly idempotencyKey: string;
      readonly correlationId?: string;
      readonly causationId?: string | null;
    },
  ): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  > => {
    // THE A12 gate: the session must cover the addressed scope — BEFORE any
    // command surface is touched (a foreign session submits nothing).
    if (!sessionCoversScope(submitSession, input.scope)) {
      return { ok: false, error: scopeRejection(submitSession, input.scope) };
    }
    const composed = composeCommand({
      commandName: input.commandName,
      payload: input.payload,
      scope: input.scope,
      actor: input.actor ?? submitSession.actor,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId ?? submitSession.correlationId,
      causationId: input.causationId ?? null,
      issuedAt: parts.now(),
    });
    if (!composed.ok) return composed;
    return execute<S>(composed.value);
  };

  const readGuard = (readSession: ScenarioSession): Result<true, DomainError> =>
    sessionCoversScope(readSession, scope)
      ? { ok: true, value: true }
      : { ok: false, error: scopeRejection(readSession, scope) };

  // ---- THE deterministic seed script --------------------------------------
  let seedTick = 0;
  const nextSeedKey = (): string => `seed-cmd-${String((seedTick += 1)).padStart(4, '0')}`;

  /** Run one seed command through the world's typed path (loud on failure). */
  const seedCommand = async <S>(
    commandName: CommandName,
    payload: unknown,
    options: { readonly scope?: Scope } = {},
  ): Promise<{ readonly state: S; readonly event: LedgerEvent }> => {
    const composed = composeCommand({
      commandName,
      payload,
      scope: options.scope ?? scope,
      actor,
      idempotencyKey: nextSeedKey(),
      correlationId,
      causationId: null,
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

  const seed = async (): Promise<WorldSeedIdentities> => {
    const organization = await seedCommand<OrganizationState>(
      CREATE_ORGANIZATION_COMMAND,
      { name: 'Reference Works Organization' },
      { scope: tenantScope },
    );
    // Under the world's PROJECT scope the command initializes exactly the
    // project its scope addresses (deterministic — no id issued).
    const project = await seedCommand<ProjectState>(CREATE_PROJECT_COMMAND, {
      name: 'Reference Tower Works',
    });
    return { organizationId: organization.state.entityId, projectId: project.state.entityId };
  };

  // The world itself, with its captured seed identities (a failed seed is a
  // LOUD wiring error — the world is never half-usable).
  const world: SeededWorld = {
    kind: 'seeded-reference-world',
    get ledgerEvents(): readonly LedgerEvent[] {
      return ledger.events;
    },
    get commandJournal(): readonly CommandJournalEntry[] {
      return [...commandJournal];
    },
    identities: await seed(),
    scope,
    tenantScope,
    session,
    policy: WORLD_POLICY,
    capabilities: [...WORLD_CAPABILITIES],
    stores: {
      projects: projectsRepository,
      organizations: organizationsRepository,
      cost: costStore,
      schedule: scheduleStore,
      workflows: workflowStore,
    },
    services: {
      organizations,
      projects,
      cost,
      schedule,
      workflows,
    },
    recorder,
    ledger,
    registries: { workflows: workflowRegistry },
    canonicalVersionOf: (entityId: EntityId): number | null => {
      const direct = versions.get(entityId) ?? null;
      if (direct !== null) return direct;
      // An ACTIVITY (or dependency/baseline/milestone) entity is an element
      // of its OWNING schedule aggregate: the world's journal records the
      // schedule's version, never a per-activity one. The adapters' graph
      // lookup resolves the element's version through the owning schedule —
      // the same aggregate the sync engine's canonicalVersionOf port must
      // see, so a moved provider version reconciles against the schedule's
      // CURRENT version (an update proposal, never a phantom re-create).
      for (const schedule of scheduleStore.schedules) {
        if (
          schedule.activities[entityId] !== undefined ||
          schedule.dependencies[entityId] !== undefined ||
          (schedule.baselines ?? {})[entityId] !== undefined ||
          (schedule.milestones ?? {})[entityId] !== undefined
        ) {
          return schedule.version;
        }
      }
      return null;
    },
    composeCommand,
    execute,
    submit,
    readGuard,
  };
  return world;
}
