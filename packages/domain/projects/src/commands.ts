// Office project domain — lifecycle command handlers (OFF-007).
//
// THE canonical mutation path of the project module (freeze "cross-view
// mutation" + the OFF-003 kernel contract), executed for every command —
// the exact flow of the sibling organization module:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never even opens a transaction;
//   3. load the aggregate through the tenant-scoped repository (a foreign
//      tenant's row is invisible — typed not-found, no existence oracle) and
//      re-check scope coverage (kernel A12 backstop);
//   4. check optimistic concurrency (stale version → typed
//      concurrency-conflict, the state is NEVER silently overwritten);
//   5. apply the invariant-checked pure transition (active-only mutations;
//      archive is an explicit one-way lifecycle transition);
//   6. write through the repository AND append the audit event through the
//      injected EventSink inside ONE runInTransaction — a failure anywhere
//      rolls everything back (tx.rollback carries the typed DomainError out);
//   7. return the committed aggregate state as a typed Result.
//
// Project-specific wiring (vs. the organization module): the aggregate's
// owning scope is its OWN project scope — the second authorization boundary.
// A tenant-scoped create command gets a fresh canonical ProjectId from the
// injected supplier; a project-scoped create command initializes exactly the
// project its scope addresses (deterministic — no id issued), which the
// repository's second-boundary guard enforces. The authorization resource for
// update/archive is the addressed project bound to the COMMAND's tenant: a
// project-scoped command addressing a different project is denied by the
// structural check BEFORE any transaction, while a cross-tenant attempt
// passes authorization and vanishes at the tenant-scoped repository (typed
// not-found, freeze A12 invisibility).
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). The canonical id itself is composed through the contracts format
// helper, so every issued id parses with parseProjectId by construction.
import { formatProjectId, parseCommandName, parseProjectId } from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  ParseResult,
  ProjectId,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import { authorize, authorizationContext, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy } from '@office/authz';
import {
  checkConcurrency,
  checkScopeCovers,
  concurrencyTokenOf,
  domainError,
  parseAggregateVersion,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
} from '@office/domain-kernel';
import type { TransactionRunner } from '@office/persistence';
import type { EventSink } from './events';
import {
  PROJECT_ARCHIVED_EVENT,
  PROJECT_CREATED_EVENT,
  PROJECT_UPDATED_EVENT,
  projectEventEnvelope,
  projectRef,
} from './events';
import type { ProjectsDomainRepository } from './repository';
import type { ProjectChanges, ProjectState } from './state';
import {
  PROJECT_KIND,
  archiveProjectState,
  createProjectState,
  updateProjectState,
} from './state';
import {
  optionalFieldWith,
  parseJsonObject,
  parseStringLike,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';
import { isPlainObject } from './parse';

// ----- command names ----------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid project command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link ProjectCommands.createProject}. */
export const CREATE_PROJECT_COMMAND: CommandName = commandNameOf(
  'projects.createProject',
);
/** Command name executed by {@link ProjectCommands.updateProject}. */
export const UPDATE_PROJECT_COMMAND: CommandName = commandNameOf(
  'projects.updateProject',
);
/** Command name executed by {@link ProjectCommands.archiveProject}. */
export const ARCHIVE_PROJECT_COMMAND: CommandName = commandNameOf(
  'projects.archiveProject',
);

/**
 * Guard: a handler executes exactly its own command kind. Handing another
 * command's envelope to a handler is a trusted-path wiring error — loud.
 */
const requireCommandName = (
  command: CommandEnvelope<unknown>,
  expected: CommandName,
): void => {
  if (command.commandName !== expected) {
    throw new TypeError(
      `project command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) --------------------------------

const NAME_RULE: StringRule = {
  min: 1,
  max: 200,
  description: 'project display name',
};

/** Validated payload of `projects.createProject`. */
export interface CreateProjectPayload {
  readonly name: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

const CREATE_PAYLOAD_KEYS = ['name', 'extensionMetadata'] as const;
const CREATE_PAYLOAD_GRAMMAR =
  'CreateProjectPayload: { name: string (1..200), extensionMetadata?: JSON object }';

/** Validated payload of `projects.updateProject`. */
export interface UpdateProjectPayload {
  readonly projectId: ProjectId;
  readonly expectedVersion: AggregateVersion;
  readonly changes: ProjectChanges;
}

const UPDATE_PAYLOAD_KEYS = [
  'projectId',
  'expectedVersion',
  'name',
  'extensionMetadata',
] as const;
const UPDATE_PAYLOAD_GRAMMAR =
  'UpdateProjectPayload: { projectId: ProjectId, expectedVersion: number (>= 1), name?: string (1..200), extensionMetadata?: JSON object } — at least one change field';

/** Validated payload of `projects.archiveProject`. */
export interface ArchiveProjectPayload {
  readonly projectId: ProjectId;
  readonly expectedVersion: AggregateVersion;
}

const ARCHIVE_PAYLOAD_KEYS = ['projectId', 'expectedVersion'] as const;
const ARCHIVE_PAYLOAD_GRAMMAR =
  'ArchiveProjectPayload: { projectId: ProjectId, expectedVersion: number (>= 1) }';

/** Parse the create payload (total, fail-closed, strict keys). */
export function parseCreateProjectPayload(
  raw: unknown,
): ParseResult<CreateProjectPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CREATE_PAYLOAD_KEYS, '', CREATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const extensionMetadata = optionalFieldWith(raw, 'extensionMetadata', '', parseJsonObject);
  if (!extensionMetadata.ok) return extensionMetadata;
  return parseOk({
    name: name.value,
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  });
}

/** Parse the update payload (total, fail-closed, strict keys). */
export function parseUpdateProjectPayload(
  raw: unknown,
): ParseResult<UpdateProjectPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UPDATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, UPDATE_PAYLOAD_KEYS, '', UPDATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const name = optionalFieldWith(raw, 'name', '', (value) => parseStringLike(value, NAME_RULE));
  if (!name.ok) return name;
  const extensionMetadata = optionalFieldWith(raw, 'extensionMetadata', '', parseJsonObject);
  if (!extensionMetadata.ok) return extensionMetadata;
  if (name.value === undefined && extensionMetadata.value === undefined) {
    return parseFail(
      'invalid-value',
      '',
      UPDATE_PAYLOAD_GRAMMAR,
      'no change field present (name/extensionMetadata)',
    );
  }
  const changes: ProjectChanges = {
    ...(name.value !== undefined ? { name: name.value } : {}),
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  };
  return parseOk({
    projectId: projectId.value,
    expectedVersion: expectedVersion.value,
    changes,
  });
}

/** Parse the archive payload (total, fail-closed, strict keys). */
export function parseArchiveProjectPayload(
  raw: unknown,
): ParseResult<ArchiveProjectPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ARCHIVE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ARCHIVE_PAYLOAD_KEYS, '', ARCHIVE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    projectId: projectId.value,
    expectedVersion: expectedVersion.value,
  });
}

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

// ----- command service -----------------------------------------------------------

/**
 * Wiring dependencies of the project command service. `now` and
 * `newOpaqueId` are the injected suppliers (determinism rule): fixed values
 * in tests, wall clock / crypto randomness in production wiring.
 */
export interface ProjectCommandDeps {
  readonly repository: ProjectsDomainRepository;
  readonly eventSink: EventSink;
  readonly transactionRunner: TransactionRunner;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatProjectId). */
  readonly newOpaqueId: () => string;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface ProjectCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The project lifecycle command surface. */
export interface ProjectCommands {
  /** Create a project (tenant scope issues a fresh id; project scope initializes its own project). */
  createProject(
    command: CommandEnvelope<unknown>,
    authorization: ProjectCommandAuthorization,
  ): Promise<CommandResult<ProjectState>>;
  /** Update an ACTIVE project's name and/or extension metadata. */
  updateProject(
    command: CommandEnvelope<unknown>,
    authorization: ProjectCommandAuthorization,
  ): Promise<CommandResult<ProjectState>>;
  /** Archive an ACTIVE project — the explicit one-way lifecycle event. */
  archiveProject(
    command: CommandEnvelope<unknown>,
    authorization: ProjectCommandAuthorization,
  ): Promise<CommandResult<ProjectState>>;
}

/** Create the project lifecycle command service. */
export function createProjectCommands(deps: ProjectCommandDeps): ProjectCommands {
  const errorContextOf = (command: CommandEnvelope<unknown>): DomainErrorContext => ({
    scope: command.scope,
    correlationId: command.causality.correlationId,
  });

  /** Translate a payload parse failure into the typed domain failure. */
  const invalidPayload = (
    error: ContractParseError,
    command: CommandEnvelope<unknown>,
  ): DomainError =>
    domainError(
      'invariant-violation',
      `invalid command payload for '${command.commandName}': ${error.code} at '${
        error.path === '' ? '<root>' : error.path
      }' — expected ${error.expected}, received ${error.received}`,
      [
        {
          code: 'invalid-command-payload',
          message: `${error.code}: expected ${error.expected}, received ${error.received}`,
          path: error.path === '' ? null : error.path,
        },
      ],
      errorContextOf(command),
    );

  /** Build the request's AuthorizationContext from the command envelope. */
  const contextOf = (
    command: CommandEnvelope<unknown>,
    authorization: ProjectCommandAuthorization,
  ): AuthorizationContext =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /**
   * The project resource being accessed, addressed within the COMMAND's
   * tenant (never the aggregate's real tenant — that is the repository's
   * tenant-scoped question; a cross-tenant attempt passes authorization and
   * vanishes as a typed not-found, freeze A12 invisibility). For a
   * project-scoped command the addressed project is bound to its own project
   * scope, so the structural check denies second-boundary violations (a
   * project-scoped command addressing a different project) BEFORE any
   * transaction opens.
   */
  const projectResource = (tenantId: TenantId, projectId: ProjectId | null) =>
    resourceScope({
      scope:
        projectId === null
          ? { kind: 'tenant', tenantId }
          : { kind: 'project', tenantId, projectId },
      resourceKind: PROJECT_KIND,
      resourceId: projectId,
      ownerId: null,
    });

  /** The optimistic-concurrency token the caller presented in its payload. */
  const expectedTokenOf = (
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind: PROJECT_KIND,
    entityId: projectId,
    version: expectedVersion,
  });

  return {
    createProject: async (command, authorization) => {
      requireCommandName(command, CREATE_PROJECT_COMMAND);
      const payload = parseCreateProjectPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Authorization runs BEFORE any transaction is opened: a denied command
      // must touch nothing at all. The resource is kind-level (tenant scope
      // issues a new id; a project-scoped command initializes its own
      // project); the structural A12 isolation check plus the caller's
      // policy decide.
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        projectResource(command.scope.tenantId, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<ProjectState>> => {
          const now = deps.now();
          // The new project's canonical id: issued from the injected supplier
          // under tenant scope; under project scope the command initializes
          // EXACTLY the project its scope addresses (deterministic — no id
          // issued). The repository's second-boundary guard enforces the
          // project-scoped case.
          const projectId: ProjectId =
            command.scope.kind === 'project'
              ? command.scope.projectId
              : formatProjectId({
                  version: 'v1',
                  opaque: deps.newOpaqueId(),
                });
          const context = errorContextOf(command);
          const input = {
            projectId,
            name: payload.value.name,
            ...(payload.value.extensionMetadata !== undefined
              ? { extensionMetadata: payload.value.extensionMetadata }
              : {}),
            now,
          };

          const initial = createProjectState(input, command.scope.tenantId, context);
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await deps.repository.insert(tx, command.scope, input);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = projectEventEnvelope({
            command,
            eventName: PROJECT_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: projectRef(inserted.value) },
            payload: {
              projectId: inserted.value.entityId,
              name: inserted.value.name,
              status: inserted.value.status,
              version: inserted.value.version,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return inserted;
        },
      );
    },

    updateProject: async (command, authorization) => {
      requireCommandName(command, UPDATE_PROJECT_COMMAND);
      const payload = parseUpdateProjectPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        projectResource(command.scope.tenantId, payload.value.projectId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(
        payload.value.projectId,
        payload.value.expectedVersion,
      );

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<ProjectState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await deps.repository.findById(
            tx,
            command.scope,
            payload.value.projectId,
          );
          if (!loaded.ok) return tx.rollback(loaded);

          // A12 backstop (kernel): the command scope must cover the loaded
          // aggregate's owning scope — with the scoped repository this cannot
          // fire, and it is checked anyway (defense in depth).
          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const next = updateProjectState(loaded.value, payload.value.changes, now, context);
          if (!next.ok) return tx.rollback(next);

          const written = await deps.repository.update(
            tx,
            command.scope,
            payload.value.projectId,
            payload.value.expectedVersion,
            payload.value.changes,
            now,
          );
          if (!written.ok) return tx.rollback(written);

          const event = projectEventEnvelope({
            command,
            eventName: PROJECT_UPDATED_EVENT,
            scope: written.value.scope,
            occurredAt: now,
            entityRefs: {
              before: projectRef(loaded.value),
              after: projectRef(written.value),
            },
            payload: {
              projectId: written.value.entityId,
              name: written.value.name,
              version: written.value.version,
              updatedAt: written.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return written;
        },
      );
    },

    archiveProject: async (command, authorization) => {
      requireCommandName(command, ARCHIVE_PROJECT_COMMAND);
      const payload = parseArchiveProjectPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        projectResource(command.scope.tenantId, payload.value.projectId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(
        payload.value.projectId,
        payload.value.expectedVersion,
      );

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<ProjectState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await deps.repository.findById(
            tx,
            command.scope,
            payload.value.projectId,
          );
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const next = archiveProjectState(loaded.value, now, context);
          if (!next.ok) return tx.rollback(next);

          const written = await deps.repository.archive(
            tx,
            command.scope,
            payload.value.projectId,
            payload.value.expectedVersion,
            now,
          );
          if (!written.ok) return tx.rollback(written);

          if (written.value.archivedAt === null) {
            // Invariant-guaranteed non-null after archive; a violation means
            // the write path is malformed — loud, never silent.
            throw new TypeError(
              `archived project ${written.value.entityId} carries no archivedAt timestamp`,
            );
          }

          const event = projectEventEnvelope({
            command,
            eventName: PROJECT_ARCHIVED_EVENT,
            scope: written.value.scope,
            occurredAt: now,
            entityRefs: {
              before: projectRef(loaded.value),
              after: projectRef(written.value),
            },
            payload: {
              projectId: written.value.entityId,
              status: written.value.status,
              archivedAt: written.value.archivedAt,
              version: written.value.version,
              updatedAt: written.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return written;
        },
      );
    },
  };
}
