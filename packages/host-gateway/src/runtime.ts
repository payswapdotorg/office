// Office host gateway — THE host runtime composition (OFF-DEPLOY).
//
// createHostRuntime composes the deployment's server side out of the landed
// packages' PUBLIC root entry points only:
//
//   - the pg pool (@office/persistence createPersistencePool) over the
//     CALLER-supplied connection string — the package never reads
//     DATABASE_URL itself, so tests boot it against the persistence test
//     harness and the production host passes process.env.DATABASE_URL at
//     the route layer;
//   - the forward-only migrator over the ordered union of every landed
//     migration directory (composeCanonicalMigrations);
//   - the canonical PG world: the tenants repository + the organization and
//     project domain repositories and their own lifecycle command services,
//     with audit events appended to the REAL event ledger + outbox inside
//     the command's own transaction (the ledger-backed sink);
//   - the deterministic seeded reference world + session + online data plane
//     (@office/web seedOfficeWorld / createWebSession / openWebDataPlane,
//     injected now/newOpaqueId — no wall clock, no randomness);
//   - the read surfaces (@office/web projectWorkspace / controlTowerView /
//     the evidence walkers) driven over that world, scope-checked, typed
//     Results;
//   - the typed command bindings of the shell driven server-side, plus the
//     canonical PG project lifecycle through the domain command services;
//   - the REAL A8 action gateway (@office/actions createActionGateway) with
//     the approval-gated workflow decision routed through the
//     workflow-engine-backed approval authority (see approvals.ts).
//
// Determinism: every clock/id supplier is injected; the hosted seed
// identities are fixed literals. Typed Results everywhere: expected domain
// failures are Result values; the landed PersistenceFailure split (typed
// operational faults) is wrapped into typed operational-failure Results at
// migrate() and health(); the trusted-path seed wiring throws LOUD
// TypeErrors only for composition defects, never for request inputs.
import {
  createMigrator,
  createPersistencePool,
  createTenantsRepository,
  createTransactionRunner,
} from '@office/persistence';
import type {
  MigrationRunResult,
  PersistencePool,
  TenantsRepository,
} from '@office/persistence';
import {
  createOrganizationCommands,
  createOrganizationsRepository,
} from '@office/domain-organization';
import type { OrganizationCommands, OrganizationsRepository } from '@office/domain-organization';
import {
  UPDATE_PROJECT_COMMAND,
  createProjectCommands,
  createProjectsDomainRepository,
} from '@office/domain-projects';
import type { ProjectCommands, ProjectState, ProjectsDomainRepository } from '@office/domain-projects';
import {
  advanceWorkflowInstance,
  approveWorkflowApproval,
  captureFieldObservation,
  controlTowerView,
  createWebSession,
  aggregateHistory,
  causalityChainOf,
  correlationChainOf,
  evidenceCommandOf,
  evidenceEventOf,
  evidenceOverview,
  openWebDataPlane,
  projectWorkspace,
  recordCostItem,
  seedOfficeWorld,
  submitWorkflowApproval,
} from '@office/web';
import type {
  CommandOutcomeView,
  ControlTowerScanParts,
  ControlTowerView,
  AggregateHistoryView,
  CausalityChainView,
  CorrelationChainView,
  EvidenceCommandView,
  EvidenceEventView,
  EvidenceOverviewView,
  ProjectWorkspaceView,
  SeededWorld,
  WebDataPlane,
  WebSession,
  WebSessionInput,
  WebSessionRejection,
} from '@office/web';
import {
  createActionGateway,
  createInMemoryActionHandlers,
  createInMemoryActionRegistry,
  createWorkflowApprovalAuthority,
} from '@office/actions';
import type {
  ActionAuthorization,
  ActionDescriptor,
  ActionGateway,
  ActionResult,
  ApprovalReference,
} from '@office/actions';
import { createInMemoryIdempotencyRegistry, domainError } from '@office/domain-kernel';
import type { CommandResult, DomainError, Result } from '@office/domain-kernel';
import type { Policy } from '@office/authz';
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseEntityId,
} from '@office/contracts';
import type { CommandEnvelope, EntityId, Timestamp } from '@office/contracts';
import { composeCanonicalMigrations } from './migrations';
import type { ComposedChainFailure } from './migrations';
import { createLedgerAuditSink } from './ledger-sink';
import {
  APPROVAL_DECISION_DESCRIPTOR,
  composeApprovalDecisionProposal,
  createApprovalDecisionHandler,
  driveRoutedApprovalToApproved,
} from './approvals';
import {
  parseAdvanceWorkflowRequest,
  parseApprovalDecisionRequest,
  parseApproveWorkflowApprovalRequest,
  parseCaptureFieldObservationRequest,
  parseRecordCostItemRequest,
  parseSubmitWorkflowApprovalRequest,
} from './inputs';
import type { HostInputRejection, UpdateProjectRequest } from './inputs';

// ---------------------------------------------------------------------------
// The hosted composition's fixed identities (deterministic, generic).
// ---------------------------------------------------------------------------

/** The hosted composition's tenant (fixed literal, canonical grammar). */
export const HOST_TENANT_ID: string = formatTenantId({
  version: 'v1',
  opaque: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
});

/** The hosted composition's project (fixed literal, canonical grammar). */
export const HOST_PROJECT_ID: string = formatProjectId({
  version: 'v1',
  opaque: '1f2e3d4c5b6a7988776655443322110f',
});

/** The hosted composition's acting operator (fixed literal). */
export const HOST_ACTOR_ID: string = formatEntityId({
  version: 'v1',
  opaque: 'a9b8c7d6e5f4130293847565647382910',
});

/** The hosted composition's causal-chain correlation id (fixed literal). */
export const HOST_CORRELATION_ID = 'host-gw-corr-0001';

/** The default release identity when none is injected (local development). */
export const DEFAULT_RELEASE_ID = 'local-dev';

// ---------------------------------------------------------------------------
// The typed public surface shapes.
// ---------------------------------------------------------------------------

/** Options of {@link createHostRuntime}. */
export interface HostRuntimeOptions {
  /** The canonical database connection string (read by the CALLER, never here). */
  readonly connectionString: string;
  /** Maximum pooled connections (node-postgres default when omitted). */
  readonly max?: number;
  /** Injected clock — the canonical 'now' of every composition (never wall time). */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque-part supplier (deterministic compositions). */
  readonly newOpaqueId: () => string;
  /** The release identity surfaced by health() (e.g. the deployment id). */
  readonly releaseId?: string;
  /** Parent directory for the composed migration chain (default: the OS temp dir). */
  readonly migrationsRoot?: string;
  /** Overrides for the hosted seed identities (defaults: the fixed literals). */
  readonly seed?: {
    readonly tenantId?: string;
    readonly projectId?: string;
    readonly actorId?: string;
    readonly correlationId?: string;
  };
}

/** The typed readiness report of the hosted composition. */
export interface HealthReport {
  readonly kind: 'host-health';
  /** Pool reachability (a cheap migrator-ledger probe; caught, never thrown). */
  readonly database: 'reachable' | 'unreachable';
  /** The applied-migration state (count + latest applied name). */
  readonly migrations: { readonly appliedCount: number; readonly latestName: string | null };
  /** The injected release identity. */
  readonly release: string;
}

/** A typed operational failure (the landed PersistenceFailure, wrapped). */
export interface HostOperationalFailure {
  readonly kind: 'host-operational-failure';
  readonly code: string;
  readonly message: string;
}

/** The canonical command-envelope composition parts (fail-closed parsed). */
export interface CanonicalCommandParts {
  readonly tenantId: string;
  /** The project scope's project id (tenant scope when null/omitted). */
  readonly projectId?: string | null;
  readonly actorId: string;
  readonly correlationId?: string;
  readonly idempotencyKey: string;
  /** ISO instant; defaults to the runtime's injected now. */
  readonly issuedAt?: string;
}

/** The canonical PG path: repositories, command services, and the grant. */
export interface CanonicalPgSurface {
  readonly tenants: TenantsRepository;
  readonly organizations: OrganizationsRepository;
  readonly projects: ProjectsDomainRepository;
  readonly services: {
    readonly organizations: OrganizationCommands;
    readonly projects: ProjectCommands;
  };
  /** The server-side authorization the hosted composition executes with. */
  readonly authorization: { readonly policy: Policy; readonly capabilities: readonly string[] };
  /**
   * Compose ONE canonical command envelope fail-closed (identities, scope,
   * causality, clock through the landed contracts parsers) for the command
   * services above — the envelope the domain services' own payload parsers
   * then validate.
   */
  composeCommand(
    parts: CanonicalCommandParts,
    commandName: string,
    payload: unknown,
  ): Result<CommandEnvelope, HostInputRejection>;
  /** Execute one canonical PG project update (optimistic concurrency). */
  updateProject(request: UpdateProjectRequest): Promise<CommandResult<ProjectState>>;
}

/** The A8 approval-gated action surface. */
export interface ApprovalActionSurface {
  /** THE composed action gateway (raw typed proposals for advanced callers). */
  readonly gateway: ActionGateway;
  /** The registered approval-gated action descriptor (introspection). */
  readonly descriptor: ActionDescriptor;
  /** The ActionAuthorization of a session (defaults to the hosted session). */
  authorizationOf(session?: WebSession): ActionAuthorization;
  /**
   * Propose the approval decision (first entry): routes the
   * approval-required action into the workflow-engine-backed authority and
   * returns the live approval reference awaiting its decision — OR, when the
   * SAME action (its idempotency key) already executed, replays the recorded
   * executed outcome (the landed gateway replay semantics: one action, one
   * final outcome, no duplicate effects).
   */
  proposeApprovalDecision(
    request: unknown,
    session?: WebSession,
  ): Promise<
    Result<
      | { readonly decision: 'routed-to-approval'; readonly approval: ApprovalReference }
      | { readonly decision: 'executed'; readonly replayed: boolean; readonly value: CommandOutcomeView },
      DomainError | HostInputRejection
    >
  >;
  /**
   * Complete the approval decision: drives the routed approval to 'approved'
   * through the shell's OWN approval command path, then re-enters the
   * gateway with the approval evidence — the handler executes the shell's
   * approval command path and the executed audit event lands in the ledger.
   */
  completeApprovalDecision(
    request: unknown,
    approval: ApprovalReference,
    session?: WebSession,
  ): Promise<
    Result<
      { readonly decision: 'executed'; readonly replayed: boolean; readonly value: CommandOutcomeView },
      DomainError | HostInputRejection
    >
  >;
}

/** THE hosted runtime: every surface the browser host's routes drive. */
export interface HostRuntime {
  readonly kind: 'host-runtime';
  /** The composed pg pool (server-only; the caller owns the connection string). */
  readonly pool: PersistencePool;
  /** The injected release identity. */
  readonly releaseId: string;
  /** The hosted composition's fixed identities. */
  readonly identities: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly actorId: string;
    readonly correlationId: string;
  };
  /** Apply every pending migration of the composed canonical chain. */
  migrate(): Promise<Result<MigrationRunResult, HostOperationalFailure | ComposedChainFailure>>;
  /** THE readiness report (never throws; unreachable database → 503 body). */
  health(): Promise<HealthReport>;
  /** Open a shell session (fail-closed identity parsing, typed rejections). */
  openSession(input: WebSessionInput): Result<WebSession, WebSessionRejection>;
  /** The deterministic seeded reference world (the semantic reference). */
  readonly world: SeededWorld;
  /** The hosted operator session over the seeded world. */
  readonly session: WebSession;
  /** The session's online data plane (the shell's command submission path). */
  readonly plane: WebDataPlane;
  /** The canonical PG path (repositories + lifecycle command services). */
  readonly canonical: CanonicalPgSurface;
  /** The read surfaces (view models over the composed world, scope-checked). */
  readonly reads: {
    workspace(session?: WebSession): Promise<Result<ProjectWorkspaceView, DomainError>>;
    controlTower(
      session: WebSession | undefined,
      parts: ControlTowerScanParts,
    ): Result<ControlTowerView, DomainError>;
    evidenceOverview(session?: WebSession): EvidenceOverviewView;
    aggregateHistory(
      session: WebSession | undefined,
      entityKind: string,
      entityId: string,
    ): Result<AggregateHistoryView, DomainError>;
    evidenceEvent(
      session: WebSession | undefined,
      eventId: string,
    ): Result<EvidenceEventView, DomainError>;
    causalityChain(
      session: WebSession | undefined,
      eventId: string,
    ): Result<CausalityChainView, DomainError>;
    correlationChain(
      session: WebSession | undefined,
      correlationId: string,
    ): Result<CorrelationChainView, DomainError>;
    evidenceCommand(
      session: WebSession | undefined,
      idempotencyKey: string,
    ): Result<EvidenceCommandView, DomainError>;
  };
  /** The shell's typed command bindings, driven server-side. */
  readonly commands: {
    captureFieldObservation(
      request: unknown,
      now?: Timestamp,
    ): Promise<CommandOutcomeView | { readonly rejected: HostInputRejection }>;
    recordCostItem(
      request: unknown,
      now?: Timestamp,
    ): Promise<CommandOutcomeView | { readonly rejected: HostInputRejection }>;
    submitWorkflowApproval(
      request: unknown,
      now?: Timestamp,
    ): Promise<CommandOutcomeView | { readonly rejected: HostInputRejection }>;
    approveWorkflowApproval(
      request: unknown,
      now?: Timestamp,
    ): Promise<CommandOutcomeView | { readonly rejected: HostInputRejection }>;
    advanceWorkflowInstance(
      request: unknown,
      now?: Timestamp,
    ): Promise<CommandOutcomeView | { readonly rejected: HostInputRejection }>;
  };
  /** The A8 approval-gated action surface. */
  readonly actions: ApprovalActionSurface;
  /** Shut the pool down (the runtime is unusable afterwards). */
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

const expectOk = <T, E>(result: Result<T, E>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`host runtime wiring error (${what}): ${JSON.stringify(result)}`);
};

// ---------------------------------------------------------------------------
// THE composition.
// ---------------------------------------------------------------------------

/**
 * Create the hosted runtime. The seeded world and its data plane materialize
 * eagerly (deterministic single composition); the pool connects lazily (the
 * node-postgres contract), so creating the runtime never touches the
 * database — migrate()/health()/commands do. Trusted-path seed identities
 * throw LOUD TypeErrors on composition defects only; every request-shaped
 * input is parsed fail-closed into typed rejections downstream.
 */
export async function createHostRuntime(
  options: HostRuntimeOptions,
): Promise<HostRuntime> {
  const tenantId = options.seed?.tenantId ?? HOST_TENANT_ID;
  const projectId = options.seed?.projectId ?? HOST_PROJECT_ID;
  const actorId = options.seed?.actorId ?? HOST_ACTOR_ID;
  const correlationId = options.seed?.correlationId ?? HOST_CORRELATION_ID;
  const releaseId = options.releaseId ?? DEFAULT_RELEASE_ID;

  // ---- the pool + the transaction boundary + the ledger-backed sink -----
  const pool = createPersistencePool({
    connectionString: options.connectionString,
    ...(options.max !== undefined ? { max: options.max } : {}),
  });
  const transactionRunner = createTransactionRunner(pool);
  const ledgerSink = createLedgerAuditSink(pool);

  // ---- the deterministic seeded reference world + session + plane -------
  const world = await seedOfficeWorld({
    tenantId,
    projectId,
    actorId,
    correlationId,
    now: options.now,
    newOpaqueId: options.newOpaqueId,
  });
  const session = expectOk(
    createWebSession({ tenantId, projectId, actorId }),
    'hosted session',
  );
  const plane = await openWebDataPlane(world, session, {
    now: options.now,
    serial: 1,
    ordinal: 1,
  });

  // ---- the canonical PG world -------------------------------------------
  const tenants = createTenantsRepository();
  const organizationsRepository = createOrganizationsRepository();
  const projectsRepository = createProjectsDomainRepository();
  const organizations = createOrganizationCommands({
    repository: organizationsRepository,
    eventSink: ledgerSink,
    transactionRunner,
    now: options.now,
    newOpaqueId: options.newOpaqueId,
  });
  const projects = createProjectCommands({
    repository: projectsRepository,
    eventSink: ledgerSink,
    transactionRunner,
    now: options.now,
    newOpaqueId: options.newOpaqueId,
  });
  const canonicalAuthorization = {
    policy: world.policy,
    capabilities: [...world.capabilities],
  };

  /** Compose one canonical command envelope (fail-closed, typed rejection). */
  const composeCommand = (
    parts: CanonicalCommandParts,
    commandName: string,
    payload: unknown,
  ): Result<CommandEnvelope, HostInputRejection> => {
    const envelope = parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope:
        parts.projectId !== undefined && parts.projectId !== null
          ? { kind: 'project', tenantId: parts.tenantId, projectId: parts.projectId }
          : { kind: 'tenant', tenantId: parts.tenantId },
      actor: { kind: 'user', actorId: parts.actorId },
      idempotencyKey: parts.idempotencyKey,
      causality: {
        correlationId: parts.correlationId ?? correlationId,
        causationId: null,
      },
      issuedAt: parts.issuedAt ?? options.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload,
    });
    if (!envelope.ok) {
      return {
        ok: false,
        error: {
          code: 'invalid-request',
          message: `invalid canonical command '${commandName}': ${envelope.error.code} at '${
            envelope.error.path === '' ? '<root>' : envelope.error.path
          }' — expected ${envelope.error.expected}, received ${envelope.error.received}`,
          details: [
            {
              code: envelope.error.code,
              message: `expected ${envelope.error.expected}, received ${envelope.error.received}`,
              path: envelope.error.path === '' ? null : envelope.error.path,
            },
          ],
        },
      };
    }
    return { ok: true, value: envelope.value };
  };

  /** One canonical project update through the landed lifecycle command service. */
  const updateProject = async (
    request: UpdateProjectRequest,
  ): Promise<CommandResult<ProjectState>> => {
    const composed = composeCommand(
      {
        tenantId,
        projectId,
        actorId,
        idempotencyKey:
          request.idempotencyKey ?? `host-prj-${request.projectId}-v${request.expectedVersion}`,
        ...(request.correlationId !== undefined
          ? { correlationId: request.correlationId }
          : {}),
      },
      UPDATE_PROJECT_COMMAND,
      {
        projectId: request.projectId,
        expectedVersion: request.expectedVersion,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.extensionMetadata !== undefined
          ? { extensionMetadata: request.extensionMetadata }
          : {}),
      },
    );
    if (!composed.ok) {
      // The request fields that could fail here were already parsed fail-closed
      // by parseUpdateProjectRequest; a failure reaching this point is a
      // composition defect — surface it as the typed validation failure of the
      // CommandResult channel (invariant-violation maps to validation_failed).
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `canonical project update rejected at envelope composition: ${composed.error.message}`,
          composed.error.details.map((detail) => ({
            code: detail.code,
            message: detail.message,
            path: detail.path,
          })),
        ),
      };
    }
    return projects.updateProject(composed.value, canonicalAuthorization);
  };

  // ---- the REAL A8 action gateway ----------------------------------------
  const approvalHandler = createApprovalDecisionHandler({ plane, session });
  const actionGateway = createActionGateway({
    registry: createInMemoryActionRegistry([APPROVAL_DECISION_DESCRIPTOR]),
    handlers: createInMemoryActionHandlers({
      [APPROVAL_DECISION_DESCRIPTOR.commandName]: approvalHandler,
    }),
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    eventSink: ledgerSink,
    approvalAuthority: createWorkflowApprovalAuthority({
      commands: world.services.workflows,
      store: world.stores.workflows,
      authorization: {
        policy: world.policy,
        capabilities: [...world.capabilities],
      },
    }),
    now: options.now,
    newEntityId: (): EntityId =>
      expectOk(
        parseEntityId(formatEntityId({ version: 'v1', opaque: options.newOpaqueId() })),
        'action entity id',
      ),
    executor: pool,
  });

  const authorizationOf = (who?: WebSession): ActionAuthorization => ({
    policy: (who ?? session).policy,
    capabilities: [...(who ?? session).capabilities],
  });

  const proposeApprovalDecision = async (
    request: unknown,
    who?: WebSession,
  ): Promise<
    Result<
      | { readonly decision: 'routed-to-approval'; readonly approval: ApprovalReference }
      | { readonly decision: 'executed'; readonly replayed: boolean; readonly value: CommandOutcomeView },
      DomainError | HostInputRejection
    >
  > => {
    const parsed = parseApprovalDecisionRequest(request);
    if (!parsed.ok) return parsed;
    const proposal = composeApprovalDecisionProposal(
      { session: who ?? session, correlationId, now: options.now },
      parsed.value,
      null,
    );
    if (!proposal.ok) return proposal;
    const executed = await actionGateway.executeAction(
      proposal.value,
      authorizationOf(who),
    );
    if (!executed.ok) return executed;
    const outcome: ActionResult = executed.value;
    if (outcome.decision === 'executed') {
      // The SAME action already executed (its idempotency key replays the
      // recorded final outcome — the landed gateway semantics: re-proposing
      // an executed action never re-routes, never duplicates effects).
      return {
        ok: true,
        value: {
          decision: 'executed',
          replayed: outcome.replayed,
          value: outcome.value as CommandOutcomeView,
        },
      };
    }
    // ActionResult's decision union is exactly 'executed' | 'routed-to-approval'
    // — the routing outcome is the only remaining first-entry result.
    return { ok: true, value: { decision: 'routed-to-approval', approval: outcome.approval } };
  };

  const completeApprovalDecision = async (
    request: unknown,
    approval: ApprovalReference,
    who?: WebSession,
  ): Promise<
    Result<
      { readonly decision: 'executed'; readonly replayed: boolean; readonly value: CommandOutcomeView },
      DomainError | HostInputRejection
    >
  > => {
    const parsed = parseApprovalDecisionRequest(request);
    if (!parsed.ok) return parsed;
    const driven = await driveRoutedApprovalToApproved(
      { world, plane, session: who ?? session, now: options.now },
      approval,
    );
    if (!driven.ok) return driven;
    const proposal = composeApprovalDecisionProposal(
      { session: who ?? session, correlationId, now: options.now },
      parsed.value,
      approval,
    );
    if (!proposal.ok) return proposal;
    const executed = await actionGateway.executeAction(
      proposal.value,
      authorizationOf(who),
    );
    if (!executed.ok) return executed;
    const outcome: ActionResult = executed.value;
    if (outcome.decision !== 'executed') {
      return {
        ok: false,
        error: domainError(
          'invariant-violation',
          `the approval-gated action did not execute after its completed approval (decision '${outcome.decision}')`,
          [{ code: 'unexpected-decision', message: outcome.decision, path: null }],
          { scope: (who ?? session).scope, correlationId: null },
        ),
      };
    }
    return {
      ok: true,
      value: {
        decision: 'executed',
        replayed: outcome.replayed,
        value: outcome.value as CommandOutcomeView,
      },
    };
  };

  // ---- the read surfaces ---------------------------------------------------
  const reads = {
    workspace: (who?: WebSession) => projectWorkspace(world, who ?? session),
    controlTower: (who: WebSession | undefined, parts: ControlTowerScanParts) =>
      controlTowerView(world, who ?? session, parts),
    evidenceOverview: (who?: WebSession) => evidenceOverview(world, who ?? session),
    aggregateHistory: (who: WebSession | undefined, entityKind: string, entityId: string) =>
      aggregateHistory(world, who ?? session, entityKind, entityId),
    evidenceEvent: (who: WebSession | undefined, eventId: string) =>
      evidenceEventOf(world, who ?? session, eventId),
    causalityChain: (who: WebSession | undefined, eventId: string) =>
      causalityChainOf(world, who ?? session, eventId),
    correlationChain: (who: WebSession | undefined, correlationIdInput: string) =>
      correlationChainOf(world, who ?? session, correlationIdInput),
    evidenceCommand: (who: WebSession | undefined, idempotencyKey: string) =>
      evidenceCommandOf(world, who ?? session, idempotencyKey),
  };

  // ---- the shell's typed command bindings, driven server-side -------------
  const nowOf = (override?: Timestamp): Timestamp => override ?? options.now();
  const commands = {
    captureFieldObservation: async (request: unknown, now?: Timestamp) => {
      const parsed = parseCaptureFieldObservationRequest(request);
      if (!parsed.ok) return { rejected: parsed.error };
      return captureFieldObservation(plane, session, parsed.value, nowOf(now));
    },
    recordCostItem: async (request: unknown, now?: Timestamp) => {
      const parsed = parseRecordCostItemRequest(request);
      if (!parsed.ok) return { rejected: parsed.error };
      return recordCostItem(plane, session, parsed.value, nowOf(now));
    },
    submitWorkflowApproval: async (request: unknown, now?: Timestamp) => {
      const parsed = parseSubmitWorkflowApprovalRequest(request);
      if (!parsed.ok) return { rejected: parsed.error };
      return submitWorkflowApproval(plane, session, parsed.value, nowOf(now));
    },
    approveWorkflowApproval: async (request: unknown, now?: Timestamp) => {
      const parsed = parseApproveWorkflowApprovalRequest(request);
      if (!parsed.ok) return { rejected: parsed.error };
      return approveWorkflowApproval(plane, session, parsed.value, nowOf(now));
    },
    advanceWorkflowInstance: async (request: unknown, now?: Timestamp) => {
      const parsed = parseAdvanceWorkflowRequest(request);
      if (!parsed.ok) return { rejected: parsed.error };
      return advanceWorkflowInstance(plane, session, parsed.value, nowOf(now));
    },
  };

  // ---- migrate() + health() -------------------------------------------------
  const migrate = async (): Promise<
    Result<MigrationRunResult, HostOperationalFailure | ComposedChainFailure>
  > => {
    const chain = await composeCanonicalMigrations(options.migrationsRoot);
    if (!chain.ok) return chain;
    try {
      const run = await createMigrator(pool, {
        migrationsDir: chain.value.dir,
        now: options.now,
      }).migrate();
      await chain.value.cleanup().catch(() => undefined);
      return { ok: true, value: run };
    } catch (cause) {
      await chain.value.cleanup().catch(() => undefined);
      return {
        ok: false,
        error: {
          kind: 'host-operational-failure',
          code: 'migration-run-failed',
          message: String(cause),
        },
      };
    }
  };

  const health = async (): Promise<HealthReport> => {
    try {
      const applied = await createMigrator(pool, { now: options.now }).appliedMigrations();
      const latest = applied[applied.length - 1];
      return {
        kind: 'host-health',
        database: 'reachable',
        migrations: {
          appliedCount: applied.length,
          latestName: latest === undefined ? null : latest.name,
        },
        release: releaseId,
      };
    } catch {
      return {
        kind: 'host-health',
        database: 'unreachable',
        migrations: { appliedCount: 0, latestName: null },
        release: releaseId,
      };
    }
  };

  return {
    kind: 'host-runtime',
    pool,
    releaseId,
    identities: { tenantId, projectId, actorId, correlationId },
    migrate,
    health,
    openSession: (input) => createWebSession(input),
    world,
    session,
    plane,
    canonical: {
      tenants,
      organizations: organizationsRepository,
      projects: projectsRepository,
      services: { organizations, projects },
      authorization: canonicalAuthorization,
      composeCommand,
      updateProject,
    },
    reads,
    commands,
    actions: {
      gateway: actionGateway,
      descriptor: APPROVAL_DECISION_DESCRIPTOR,
      authorizationOf,
      proposeApprovalDecision,
      completeApprovalDecision,
    },
    end: () => pool.end(),
  };
}
