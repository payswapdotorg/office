// Office organization domain — lifecycle command handlers (OFF-007).
//
// THE canonical mutation path of the organization module (freeze "cross-view
// mutation" + the OFF-003 kernel contract), executed for every command:
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
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). The canonical id itself is composed through the contracts format
// helper, so every issued id parses with parseEntityId by construction.
import { formatEntityId, parseCommandName, parseEntityId } from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  EntityId,
  ParseResult,
  Scope,
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
  ORGANIZATION_ARCHIVED_EVENT,
  ORGANIZATION_CREATED_EVENT,
  ORGANIZATION_UPDATED_EVENT,
  organizationEventEnvelope,
  organizationRef,
} from './events';
import type { OrganizationsRepository } from './repository';
import type { OrganizationChanges, OrganizationState } from './state';
import {
  ORGANIZATION_KIND,
  archiveOrganizationState,
  createOrganizationState,
  updateOrganizationState,
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
    throw new TypeError(`invalid organization command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link OrganizationCommands.createOrganization}. */
export const CREATE_ORGANIZATION_COMMAND: CommandName = commandNameOf(
  'organization.createOrganization',
);
/** Command name executed by {@link OrganizationCommands.updateOrganization}. */
export const UPDATE_ORGANIZATION_COMMAND: CommandName = commandNameOf(
  'organization.updateOrganization',
);
/** Command name executed by {@link OrganizationCommands.archiveOrganization}. */
export const ARCHIVE_ORGANIZATION_COMMAND: CommandName = commandNameOf(
  'organization.archiveOrganization',
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
      `organization command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) --------------------------------

const NAME_RULE: StringRule = {
  min: 1,
  max: 200,
  description: 'organization display name',
};

/** Validated payload of `organization.createOrganization`. */
export interface CreateOrganizationPayload {
  readonly name: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

const CREATE_PAYLOAD_KEYS = ['name', 'extensionMetadata'] as const;
const CREATE_PAYLOAD_GRAMMAR =
  'CreateOrganizationPayload: { name: string (1..200), extensionMetadata?: JSON object }';

/** Validated payload of `organization.updateOrganization`. */
export interface UpdateOrganizationPayload {
  readonly organizationId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly changes: OrganizationChanges;
}

const UPDATE_PAYLOAD_KEYS = [
  'organizationId',
  'expectedVersion',
  'name',
  'extensionMetadata',
] as const;
const UPDATE_PAYLOAD_GRAMMAR =
  'UpdateOrganizationPayload: { organizationId: EntityId, expectedVersion: number (>= 1), name?: string (1..200), extensionMetadata?: JSON object } — at least one change field';

/** Validated payload of `organization.archiveOrganization`. */
export interface ArchiveOrganizationPayload {
  readonly organizationId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const ARCHIVE_PAYLOAD_KEYS = ['organizationId', 'expectedVersion'] as const;
const ARCHIVE_PAYLOAD_GRAMMAR =
  'ArchiveOrganizationPayload: { organizationId: EntityId, expectedVersion: number (>= 1) }';

/** Parse the create payload (total, fail-closed, strict keys). */
export function parseCreateOrganizationPayload(
  raw: unknown,
): ParseResult<CreateOrganizationPayload> {
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
export function parseUpdateOrganizationPayload(
  raw: unknown,
): ParseResult<UpdateOrganizationPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UPDATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, UPDATE_PAYLOAD_KEYS, '', UPDATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const organizationId = requireFieldWith(raw, 'organizationId', '', parseEntityId);
  if (!organizationId.ok) return organizationId;
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
  const changes: OrganizationChanges = {
    ...(name.value !== undefined ? { name: name.value } : {}),
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  };
  return parseOk({
    organizationId: organizationId.value,
    expectedVersion: expectedVersion.value,
    changes,
  });
}

/** Parse the archive payload (total, fail-closed, strict keys). */
export function parseArchiveOrganizationPayload(
  raw: unknown,
): ParseResult<ArchiveOrganizationPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ARCHIVE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ARCHIVE_PAYLOAD_KEYS, '', ARCHIVE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const organizationId = requireFieldWith(raw, 'organizationId', '', parseEntityId);
  if (!organizationId.ok) return organizationId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    organizationId: organizationId.value,
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
 * Wiring dependencies of the organization command service. `now` and
 * `newOpaqueId` are the injected suppliers (determinism rule): fixed values
 * in tests, wall clock / crypto randomness in production wiring.
 */
export interface OrganizationCommandDeps {
  readonly repository: OrganizationsRepository;
  readonly eventSink: EventSink;
  readonly transactionRunner: TransactionRunner;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface OrganizationCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The organization lifecycle command surface. */
export interface OrganizationCommands {
  /** Create an organization (tenant-scoped aggregate, status 'active'). */
  createOrganization(
    command: CommandEnvelope<unknown>,
    authorization: OrganizationCommandAuthorization,
  ): Promise<CommandResult<OrganizationState>>;
  /** Update an ACTIVE organization's name and/or extension metadata. */
  updateOrganization(
    command: CommandEnvelope<unknown>,
    authorization: OrganizationCommandAuthorization,
  ): Promise<CommandResult<OrganizationState>>;
  /** Archive an ACTIVE organization — the explicit one-way lifecycle event. */
  archiveOrganization(
    command: CommandEnvelope<unknown>,
    authorization: OrganizationCommandAuthorization,
  ): Promise<CommandResult<OrganizationState>>;
}

/** Create the organization lifecycle command service. */
export function createOrganizationCommands(deps: OrganizationCommandDeps): OrganizationCommands {
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
    authorization: OrganizationCommandAuthorization,
  ): AuthorizationContext =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /** The organization resource being accessed (kind-level for create). */
  const organizationResource = (scope: Scope, organizationId: EntityId | null) =>
    resourceScope({
      scope,
      resourceKind: ORGANIZATION_KIND,
      resourceId: organizationId,
      ownerId: null,
    });

  /** The optimistic-concurrency token the caller presented in its payload. */
  const expectedTokenOf = (
    organizationId: EntityId,
    expectedVersion: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind: ORGANIZATION_KIND,
    entityId: organizationId,
    version: expectedVersion,
  });

  return {
    createOrganization: async (command, authorization) => {
      requireCommandName(command, CREATE_ORGANIZATION_COMMAND);
      const payload = parseCreateOrganizationPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Authorization runs BEFORE any transaction is opened: a denied command
      // must touch nothing at all. The resource is kind-level — the instance
      // does not exist yet; the structural A12 isolation check plus the
      // caller's policy decide.
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        organizationResource({ kind: 'tenant', tenantId: command.scope.tenantId }, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<OrganizationState>> => {
          const now = deps.now();
          const organizationId = formatEntityId({
            version: 'v1',
            opaque: deps.newOpaqueId(),
          });
          const scope: Scope = { kind: 'tenant', tenantId: command.scope.tenantId };
          const context = errorContextOf(command);
          const input = {
            organizationId,
            name: payload.value.name,
            ...(payload.value.extensionMetadata !== undefined
              ? { extensionMetadata: payload.value.extensionMetadata }
              : {}),
            now,
          };

          const initial = createOrganizationState(input, scope, context);
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await deps.repository.insert(tx, command.scope, input);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = organizationEventEnvelope({
            command,
            eventName: ORGANIZATION_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: organizationRef(inserted.value) },
            payload: {
              organizationId: inserted.value.entityId,
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

    updateOrganization: async (command, authorization) => {
      requireCommandName(command, UPDATE_ORGANIZATION_COMMAND);
      const payload = parseUpdateOrganizationPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        organizationResource(
          { kind: 'tenant', tenantId: command.scope.tenantId },
          payload.value.organizationId,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(
        payload.value.organizationId,
        payload.value.expectedVersion,
      );

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<OrganizationState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await deps.repository.findById(
            tx,
            command.scope,
            payload.value.organizationId,
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

          const next = updateOrganizationState(loaded.value, payload.value.changes, now, context);
          if (!next.ok) return tx.rollback(next);

          const written = await deps.repository.update(
            tx,
            command.scope,
            payload.value.organizationId,
            payload.value.expectedVersion,
            payload.value.changes,
            now,
          );
          if (!written.ok) return tx.rollback(written);

          const event = organizationEventEnvelope({
            command,
            eventName: ORGANIZATION_UPDATED_EVENT,
            scope: written.value.scope,
            occurredAt: now,
            entityRefs: {
              before: organizationRef(loaded.value),
              after: organizationRef(written.value),
            },
            payload: {
              organizationId: written.value.entityId,
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

    archiveOrganization: async (command, authorization) => {
      requireCommandName(command, ARCHIVE_ORGANIZATION_COMMAND);
      const payload = parseArchiveOrganizationPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        organizationResource(
          { kind: 'tenant', tenantId: command.scope.tenantId },
          payload.value.organizationId,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(
        payload.value.organizationId,
        payload.value.expectedVersion,
      );

      return deps.transactionRunner.runInTransaction(
        async (tx): Promise<CommandResult<OrganizationState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await deps.repository.findById(
            tx,
            command.scope,
            payload.value.organizationId,
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

          const next = archiveOrganizationState(loaded.value, now, context);
          if (!next.ok) return tx.rollback(next);

          const written = await deps.repository.archive(
            tx,
            command.scope,
            payload.value.organizationId,
            payload.value.expectedVersion,
            now,
          );
          if (!written.ok) return tx.rollback(written);

          if (written.value.archivedAt === null) {
            // Invariant-guaranteed non-null after archive; a violation means
            // the write path is malformed — loud, never silent.
            throw new TypeError(
              `archived organization ${written.value.entityId} carries no archivedAt timestamp`,
            );
          }

          const event = organizationEventEnvelope({
            command,
            eventName: ORGANIZATION_ARCHIVED_EVENT,
            scope: written.value.scope,
            occurredAt: now,
            entityRefs: {
              before: organizationRef(loaded.value),
              after: organizationRef(written.value),
            },
            payload: {
              organizationId: written.value.entityId,
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
