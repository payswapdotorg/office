// Office desktop client protocol/reference shell — the SEEDED DESKTOP WORLD
// (OFF-032).
//
// THE SAME seeded project the web and field shells operate, scoped to the
// desktop session's canonical world: the landed organization + projects
// identity packages and the SCHEDULE + COST domain packages wired into ONE
// deterministic world, composed ONLY through the packages' public surfaces
// (their command services, their stores, their audit-event sinks) — plus the
// SHARED server-side sync parts of @office/sync + @office/client-sync's
// client protocol (the ledger-shaped slice source, the subscription broker,
// the operation registry, the applied-operation journal, the conflict log,
// and the sync audit sink). Two data planes over ONE world is the
// desktop-host/web-style-client convergence composition: the DESKTOP HOST
// (the reference host's offline captures and online submissions) and the
// WEB-STYLE TWIN CLIENT (the online mutations — the same composition the
// landed web shell drives) share the registry/journal/conflict records, so a
// divergence can always name the committed server-side operation that caused
// it (freeze A12: all clients share ONE project state).
//
// This is the desktop shell's composition layer — its stand-in for the server
// runtime: it NEVER touches a database (structurally database-free — no
// @office/persistence import anywhere, no SQL, no repositories), never
// constructs an action gateway, and never writes canonical state directly
// (every mutation flows through the landed packages' own command handlers
// with their authorization, idempotency, concurrency, and audit-event
// gates). The structurally-required transaction/executor handles of the
// landed ports are satisfied by pure in-memory no-op twins (structural
// typing — the persistence package is never imported, not even TYPE-ONLY).
//
// Every executed command's audit envelope lands in the ledger-shaped
// in-memory project-slice source (@office/sync's reference implementation —
// dense per-aggregate sequences), so the whole world is ONE append-only
// event stream the desktop shell's views project from (A2/A7: the views are
// rebuildable from this stream alone; run-twice identical).
//
// Determinism (the kernel rule): no wall clock, no randomness — the clock
// and the canonical-id supplier are INJECTED (`parts.now`, `parts.newOpaqueId`),
// and every seed identity below is a fixed literal or a deterministic
// derivation, so the same parts always produce the byte-identical world.
//
// Mirrors the landed @office/web and @office/field-client seeded-world
// disciplines (the structural templates — mirrored, never imported: apps do
// not import apps).
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
  domainError,
  entityNotFound,
  invariantViolation,
  ok,
  projectScopeViolation,
} from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import {
  createInMemoryConflictLog,
  createInMemoryOperationJournal,
  createInMemorySyncEventSink,
} from '@office/client-sync';
import type {
  ConflictLog,
  InMemorySyncEventSink,
  OperationJournal,
  SyncAuditSinkExecutor,
} from '@office/client-sync';
import {
  createInMemoryOperationRegistry,
  createInMemorySliceSource,
  createSubscriptionBroker,
} from '@office/sync';
import type {
  InMemorySliceSource,
  OperationRegistry,
  SubscriptionBroker,
} from '@office/sync';
import { CREATE_ORGANIZATION_COMMAND, createOrganizationCommands, createOrganizationState } from '@office/domain-organization';
import type { OrganizationState, OrganizationsRepository } from '@office/domain-organization';
import { CREATE_PROJECT_COMMAND, createProjectCommands, createProjectState } from '@office/domain-projects';
import type { ProjectState, ProjectsDomainRepository } from '@office/domain-projects';
import {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  RECORD_PROGRESS_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  createInMemoryScheduleStore,
  createScheduleCommands,
} from '@office/domain-schedule';
import type { InMemoryScheduleStore, ScheduleCommands } from '@office/domain-schedule';
import {
  AMEND_COMMITMENT_COMMAND,
  CLOSE_COMMITMENT_COMMAND,
  CREATE_BUDGET_COMMAND,
  CREATE_COMMITMENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  createCostCommands,
  createInMemoryCostStore,
} from '@office/domain-cost';
import type { CostCommands, InMemoryCostStore } from '@office/domain-cost';
import { entityRefOf } from './session';

// ---------------------------------------------------------------------------
// Trusted-path assertion helpers (seed wiring errors are loud, never silent).
// ---------------------------------------------------------------------------

const expectOk = <T, E>(result: Result<T, E>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`seed wiring error (${what}): ${JSON.stringify(result)}`);
};

// ---------------------------------------------------------------------------
// The world's deterministic shared audit-event recorder + no-op executor.
// ---------------------------------------------------------------------------

/**
 * The shared EventSink every domain command service appends through
 * (structurally each domain's mirrored EventSink port; the executor handle
 * is accepted opaquely — the desktop shell never inspects it). ONE recorder
 * = ONE audit trail.
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

/**
 * The in-memory no-op executor/transaction handle of the world's sinks and
 * command services (structural twins of the landed ports' handles — the
 * persistence package is never imported, not even TYPE-ONLY). The in-memory
 * world never rolls back: there is no database to roll back; the method
 * exists to satisfy the landed Transaction port structurally.
 */
const noOpExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
  // The in-memory twin never rolls back (there is no database to roll back);
  // the method exists to satisfy the landed Transaction port structurally.
  rollback: (() => {
    throw new TypeError('the in-memory world executor never rolls back');
  }) as <T>(value: T) => never,
} as const;

// ---------------------------------------------------------------------------
// The desktop shell's in-memory identity repositories (the port
// implementations; the landed packages' SQL repositories are their durable
// production twins — the desktop shell wires the pure in-memory engines the
// brief's seeded reference world names, never a database).
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
// The shell's command journal — its own record of every command IT executed.
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

/** The world's shared server-side sync records (the injected client protocol world). */
export interface WorldSyncParts {
  /** The ledger read port (project slices) — the world's stream. */
  readonly slice: InMemorySliceSource;
  /** The in-memory subscription broker (grants, streams, fan-out). */
  readonly broker: SubscriptionBroker;
  /** The protocol-level operation registry (typed dedup by operation id). */
  readonly registry: OperationRegistry;
  /** The applied-operation journal (the conflict model's cause chain). */
  readonly journal: OperationJournal;
  /** The conflict log (surfaced records). */
  readonly conflicts: ConflictLog;
  /** The sync audit discipline (freeze A3) — the shared audit sink. */
  readonly audit: {
    readonly sink: InMemorySyncEventSink;
    readonly executor: SyncAuditSinkExecutor;
  };
}

// ---------------------------------------------------------------------------
// The seeded desktop world itself.
// ---------------------------------------------------------------------------

/** The injected deterministic parts of one seeded desktop world. */
export interface SeededDesktopWorldParts {
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
export interface DesktopSeedIdentities {
  readonly organizationId: EntityId;
  readonly projectId: ProjectId;
  readonly scheduleId: EntityId;
  readonly activityIds: readonly EntityId[];
  readonly budgetId: EntityId;
  readonly costItemIds: readonly EntityId[];
  readonly commitmentId: EntityId;
}

/** The deterministic seeded desktop world: services, stores, ledger, sync parts, journal. */
export interface SeededDesktopWorld {
  readonly kind: 'seeded-desktop-world';
  /** The shared server-side sync parts every data plane wires over. */
  readonly sync: WorldSyncParts;
  /** Every ledger event, in append order (the projection basis of every view). */
  readonly ledgerEvents: readonly LedgerEvent[];
  /** The world's command journal — every command the world executed. */
  readonly commandJournal: readonly CommandJournalEntry[];
  /** The seed's captured identities. */
  readonly identities: DesktopSeedIdentities;
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
    readonly cost: InMemoryCostStore;
  };
  /** The typed command services of the landed domain packages. */
  readonly services: {
    readonly organizations: ReturnType<typeof createOrganizationCommands>;
    readonly projects: ReturnType<typeof createProjectCommands>;
    readonly schedule: ScheduleCommands;
    readonly cost: CostCommands;
  };
  /** The world's audit-event recorder (the shared sink every service uses). */
  readonly recorder: WorldEventRecorder;
  /**
   * Execute ONE command through the landed command surface its name
   * addresses — the generic typed path (the sync engine's command path and
   * the seed both use it). The state is the committed aggregate (typed by
   * the caller); the event is the ledger event the command produced.
   */
  execute<S>(command: CommandEnvelope<unknown>): Promise<
    Result<{ readonly state: S; readonly replayed: boolean; readonly event: LedgerEvent }, DomainError>
  >;
  /** The fail-closed command-envelope composer the world dispatches through. */
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

/** The world's server-side authorization (the full desktop-operator grant). */
const worldAuthorization = (policy: Policy, capabilities: readonly Capability[]) => ({
  policy,
  capabilities: [...capabilities] as string[],
});

const WORLD_CAPABILITIES: readonly Capability[] = [
  capability('organization.write'),
  capability('projects.write'),
  capability('schedule.write'),
  capability('cost.write'),
];

const WORLD_POLICY: Policy = definePolicy([
  { effect: 'allow', capabilities: ['organization.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['projects.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['schedule.write'], actions: ['read', 'write'] },
  { effect: 'allow', capabilities: ['cost.write'], actions: ['read', 'write'] },
]);

/**
 * Create + seed the deterministic desktop world: one tenant, one project, a
 * schedule with three activities on ONE serial critical chain + a baseline,
 * a budget with two cost items, and ONE committed purchase order (the
 * contested commercial aggregate the golden scenario's protected conflict
 * diverges around). Every seed mutation is a REAL command through the landed
 * packages' public command surfaces (authorization, invariants,
 * concurrency, audit events, idempotency keys 'seed-cmd-0001'...). Generic
 * fixture vocabulary only.
 */
export async function seedDesktopWorld(parts: SeededDesktopWorldParts): Promise<SeededDesktopWorld> {
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
  const registry = createInMemoryOperationRegistry();
  const journal = createInMemoryOperationJournal();
  const conflicts = createInMemoryConflictLog();
  const auditSink = createInMemorySyncEventSink();
  const syncAuditExecutor: SyncAuditSinkExecutor = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const sync: WorldSyncParts = {
    slice,
    broker,
    registry,
    journal,
    conflicts,
    audit: { sink: auditSink, executor: syncAuditExecutor },
  };
  const commandJournal: CommandJournalEntry[] = [];

  const organizationsRepository = createInMemoryOrganizationsRepository();
  const projectsRepository = createInMemoryProjectsRepository();
  const scheduleStore = createInMemoryScheduleStore();
  const costStore = createInMemoryCostStore();

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
  const cost = createCostCommands({
    store: costStore,
    eventSink: recorder.sink,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });

  const authorization = worldAuthorization(WORLD_POLICY, WORLD_CAPABILITIES);

  // ---- the generic typed dispatch (name → the landed command surface) ----

  /**
   * The normalized outcome of one command execution through a landed command
   * surface: the committed aggregate state (typed by the caller) plus the
   * replay flag (every wired service here is a plain-state service — the
   * protocol-level operation registry carries the idempotency discipline).
   */
  interface Executed {
    readonly state: unknown;
    readonly replayed: boolean;
  }

  /** Adapt a plain-state CommandResult (organizations/projects/schedule/cost). */
  const plainExecution = async <S>(
    run: () => Promise<Result<S, DomainError>>,
  ): Promise<Result<Executed, DomainError>> => {
    const result = await run();
    return result.ok ? { ok: true, value: { state: result.value, replayed: false } } : result;
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
      case UPDATE_ACTIVITY_COMMAND:
        return plainExecution(() => schedule.updateActivity(command, authorization));
      case RECORD_PROGRESS_COMMAND:
        return plainExecution(() => schedule.recordProgress(command, authorization));
      case CREATE_BUDGET_COMMAND:
        return plainExecution(() => cost.createBudget(command, authorization));
      case RECORD_COST_ITEM_COMMAND:
        return plainExecution(() => cost.recordCostItem(command, authorization));
      case CREATE_COMMITMENT_COMMAND:
        return plainExecution(() => cost.createCommitment(command, authorization));
      case AMEND_COMMITMENT_COMMAND:
        return plainExecution(() => cost.amendCommitment(command, authorization));
      case CLOSE_COMMITMENT_COMMAND:
        return plainExecution(() => cost.closeCommitment(command, authorization));
      default: {
        const unbound = domainError(
          'invariant-violation',
          `the desktop shell has no command surface bound for '${command.commandName}'`,
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
  // Generic fixture vocabulary only: neutral names, deterministic ids, no
  // provider vocabulary, no real vendor names.
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

  const seed = async (): Promise<DesktopSeedIdentities> => {
    const organization = await seedCommand<OrganizationState>(
      CREATE_ORGANIZATION_COMMAND,
      { name: 'Reference Operator Organization' },
      { scope: tenantScope },
    );
    // Under the world's PROJECT scope the command initializes exactly the
    // project its scope addresses (deterministic — no id issued).
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
    // over (one chain, 20 + 35 + 15 = 70 working units).
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
    const concreteCostItemId = costItemIds[0];
    if (concreteCostItemId === undefined) {
      throw new TypeError(
        `seed wiring error: the reference budget needs exactly two cost items (got ${costItemIds.length})`,
      );
    }
    const commitment = await seedCommand<{ readonly entityId: EntityId }>(CREATE_COMMITMENT_COMMAND, {
      budgetId,
      number: 'PO-0001',
      commitmentKind: 'purchase-order',
      description: 'Structural frame package',
      currency: 'EUR',
      lines: [
        {
          costItemId: concreteCostItemId,
          description: 'Concrete works package',
          amountMinor: 1_050_000,
        },
      ],
    });

    return {
      organizationId: organization.state.entityId,
      projectId: project.state.entityId,
      scheduleId,
      activityIds: [...activityIds],
      budgetId,
      costItemIds: [...costItemIds],
      commitmentId: commitment.state.entityId,
    };
  };

  // The world itself, with its captured seed identities (a failed seed is a
  // LOUD wiring error — the world is never half-usable; every seed command
  // went through the world's own typed execution path above).
  const world: SeededDesktopWorld = {
    kind: 'seeded-desktop-world',
    sync,
    get ledgerEvents(): readonly LedgerEvent[] {
      return slice.events;
    },
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
      cost: costStore,
    },
    services: {
      organizations,
      projects,
      schedule,
      cost,
    },
    recorder,
    execute,
    composeCommand,
  };
  return world;
}
