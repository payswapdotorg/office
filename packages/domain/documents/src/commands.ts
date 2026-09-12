// Office documents domain — command handlers (OFF-008).
//
// THE canonical mutation path of the documents & evidence module (freeze
// "cross-view mutation" + the OFF-003 kernel contract), executed for every
// command — structurally the identity modules' pattern (OFF-007):
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never even opens a unit of work;
//   3. deduplicate through the kernel's withIdempotency over the injected
//      IdempotencyRegistry (A8/ADR-005): replaying the same command with the
//      same idempotency key is a no-op replay of the recorded outcome, never
//      a duplicate effect; the same key on a different command is a typed
//      idempotency-conflict;
//   4. inside ONE store unit of work: load the aggregate through the
//      scope-guarded store (a foreign tenant's/project's row is invisible —
//      typed not-found, no existence oracle), verify the claimed project,
//      re-check scope coverage (kernel A12 backstop), and check optimistic
//      concurrency (stale version → typed concurrency-conflict, state is
//      never silently overwritten);
//   5. apply the invariant-checked pure transition (revisions are created
//      ONLY — attaching the chain root, or appending an explicit successor
//      that supersedes the current head; evidence references are created
//      ONLY — never repointed, never edited);
//   6. store the content-addressed blob through the ObjectStorage port,
//      stage the state mutations, and append the audit event through the
//      injected EventSink — all inside the SAME unit: a failure anywhere
//      (uow.rollback) discards every staged mutation, so a partially-applied
//      mutation can never commit. An orphaned content blob after a late
//      failure is accepted by design: content-addressed keys are idempotent
//      to re-put and address no aggregate until a revision row commits;
//   7. return the committed result as a typed Result.
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now`, the canonical-id opaque parts, and the content hash come from the
// injected suppliers (fixed values in tests; wall clock / crypto hashing in
// production wiring). Canonical ids are composed through the contracts format
// helper, so every issued id parses with parseEntityId by construction.
import {
  formatEntityId,
  parseCommandName,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  EntityId,
  EntityKind,
  ParseResult,
  ProjectId,
  Scope,
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
  fail,
  ok,
  parseAggregateVersion,
  withIdempotency,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  IdempotentExecution,
  IdempotencyRegistry,
  Result,
} from '@office/domain-kernel';
import type { EventSink } from './events';
import {
  DOCUMENT_ARCHIVED_EVENT,
  DOCUMENT_REGISTERED_EVENT,
  EVIDENCE_REFERENCED_EVENT,
  REVISION_ATTACHED_EVENT,
  REVISION_SUPERSEDED_EVENT,
  documentsEventEnvelope,
  entityRefOf,
} from './events';
import type { ObjectStorage, RevisionHash } from './storage';
import { CONTENT_BASE64_RULE, decodeBase64, formatStorageKey } from './storage';
import type { DocumentsStore, DocumentsUnitOfWork } from './store';
import type {
  DocumentRevisionState,
  DocumentState,
  EvidenceReferenceState,
} from './state';
import {
  DOCUMENT_KIND,
  EVIDENCE_REFERENCE_KIND,
  REVISION_KIND,
  archiveDocumentState,
  attachRevisionState,
  createDocumentRevisionState,
  createDocumentState,
  createEvidenceReferenceState,
  supersedeRevisionState,
} from './state';
import {
  isPlainObject,
  optionalFieldWith,
  parseJsonObject,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';

// ----- command names ----------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid documents command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link DocumentsCommands.registerDocument}. */
export const REGISTER_DOCUMENT_COMMAND: CommandName = commandNameOf(
  'documents.registerDocument',
);
/** Command name executed by {@link DocumentsCommands.archiveDocument}. */
export const ARCHIVE_DOCUMENT_COMMAND: CommandName = commandNameOf(
  'documents.archiveDocument',
);
/** Command name executed by {@link DocumentsCommands.attachRevision}. */
export const ATTACH_REVISION_COMMAND: CommandName = commandNameOf(
  'documents.attachRevision',
);
/** Command name executed by {@link DocumentsCommands.supersedeRevision}. */
export const SUPERSEDE_REVISION_COMMAND: CommandName = commandNameOf(
  'documents.supersedeRevision',
);
/** Command name executed by {@link DocumentsCommands.referenceEvidence}. */
export const REFERENCE_EVIDENCE_COMMAND: CommandName = commandNameOf(
  'documents.referenceEvidence',
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
      `documents command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) --------------------------------

const TITLE_RULE: StringRule = {
  min: 1,
  max: 200,
  description: 'document display title',
};

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

/** Validated payload of `documents.registerDocument`. */
export interface RegisterDocumentPayload {
  /** The project the document is registered in (its second boundary, A12). */
  readonly projectId: ProjectId;
  readonly title: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

const REGISTER_PAYLOAD_KEYS = ['projectId', 'title', 'extensionMetadata'] as const;
const REGISTER_PAYLOAD_GRAMMAR =
  'RegisterDocumentPayload: { projectId: ProjectId, title: string (1..200), extensionMetadata?: JSON object }';

/** Validated payload of `documents.archiveDocument`. */
export interface ArchiveDocumentPayload {
  readonly projectId: ProjectId;
  readonly documentId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const ARCHIVE_PAYLOAD_KEYS = ['projectId', 'documentId', 'expectedVersion'] as const;
const ARCHIVE_PAYLOAD_GRAMMAR =
  'ArchiveDocumentPayload: { projectId: ProjectId, documentId: EntityId, expectedVersion: number (>= 1) }';

/** Content fields shared by the two revision-attaching commands. */
interface RevisionContentPayload {
  readonly projectId: ProjectId;
  readonly documentId: EntityId;
  readonly expectedVersion: AggregateVersion;
  /** The revision's content bytes as canonical base64 (JSON-safe carrier). */
  readonly contentBase64: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Validated payload of `documents.attachRevision` (the chain root revision):
 * the shared revision-content fields exactly — the root supersedes nothing, so
 * it carries no `supersedesRevisionId` field (that field belongs to the
 * supersede payload alone).
 */
export type AttachRevisionPayload = RevisionContentPayload;

const ATTACH_PAYLOAD_KEYS = [
  'projectId',
  'documentId',
  'expectedVersion',
  'contentBase64',
  'extensionMetadata',
] as const;
const ATTACH_PAYLOAD_GRAMMAR =
  'AttachRevisionPayload: { projectId: ProjectId, documentId: EntityId, expectedVersion: number (>= 1), contentBase64: string (canonical base64), extensionMetadata?: JSON object }';

/** Validated payload of `documents.supersedeRevision` (an explicit successor). */
export interface SupersedeRevisionPayload extends RevisionContentPayload {
  /** The current head revision the new revision supersedes (forward link). */
  readonly supersedesRevisionId: EntityId;
}

const SUPERSEDE_PAYLOAD_KEYS = [
  'projectId',
  'documentId',
  'expectedVersion',
  'supersedesRevisionId',
  'contentBase64',
  'extensionMetadata',
] as const;
const SUPERSEDE_PAYLOAD_GRAMMAR =
  'SupersedeRevisionPayload: { projectId: ProjectId, documentId: EntityId, expectedVersion: number (>= 1), supersedesRevisionId: EntityId, contentBase64: string (canonical base64), extensionMetadata?: JSON object }';

/** Validated payload of `documents.referenceEvidence`. */
export interface ReferenceEvidencePayload {
  readonly projectId: ProjectId;
  readonly documentId: EntityId;
  /** The SPECIFIC revision the evidence pins (never just the document). */
  readonly revisionId: EntityId;
  /** The evidenced entity's canonical kind, e.g. 'task', 'issue', 'change-order'. */
  readonly evidencedEntityKind: EntityKind;
  /** The evidenced entity's canonical id. */
  readonly evidencedEntityId: EntityId;
}

const REFERENCE_PAYLOAD_KEYS = [
  'projectId',
  'documentId',
  'revisionId',
  'evidencedEntityKind',
  'evidencedEntityId',
] as const;
const REFERENCE_PAYLOAD_GRAMMAR =
  "ReferenceEvidencePayload: { projectId: ProjectId, documentId: EntityId, revisionId: EntityId, evidencedEntityKind: EntityKind (kebab-case), evidencedEntityId: EntityId }";

/** Parse the register payload (total, fail-closed, strict keys). */
export function parseRegisterDocumentPayload(
  raw: unknown,
): ParseResult<RegisterDocumentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REGISTER_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REGISTER_PAYLOAD_KEYS, '', REGISTER_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const extensionMetadata = optionalFieldWith(raw, 'extensionMetadata', '', parseJsonObject);
  if (!extensionMetadata.ok) return extensionMetadata;
  return parseOk({
    projectId: projectId.value,
    title: title.value,
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  });
}

/** Parse the archive payload (total, fail-closed, strict keys). */
export function parseArchiveDocumentPayload(
  raw: unknown,
): ParseResult<ArchiveDocumentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ARCHIVE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ARCHIVE_PAYLOAD_KEYS, '', ARCHIVE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    projectId: projectId.value,
    documentId: documentId.value,
    expectedVersion: expectedVersion.value,
  });
}

/** Parse the attach-revision payload (total, fail-closed, strict keys). */
export function parseAttachRevisionPayload(
  raw: unknown,
): ParseResult<AttachRevisionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ATTACH_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ATTACH_PAYLOAD_KEYS, '', ATTACH_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const contentBase64 = requireString(raw, 'contentBase64', '', CONTENT_BASE64_RULE);
  if (!contentBase64.ok) return contentBase64;
  const extensionMetadata = optionalFieldWith(raw, 'extensionMetadata', '', parseJsonObject);
  if (!extensionMetadata.ok) return extensionMetadata;
  return parseOk({
    projectId: projectId.value,
    documentId: documentId.value,
    expectedVersion: expectedVersion.value,
    contentBase64: contentBase64.value,
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  });
}

/** Parse the supersede-revision payload (total, fail-closed, strict keys). */
export function parseSupersedeRevisionPayload(
  raw: unknown,
): ParseResult<SupersedeRevisionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUPERSEDE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUPERSEDE_PAYLOAD_KEYS, '', SUPERSEDE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const supersedesRevisionId = requireFieldWith(raw, 'supersedesRevisionId', '', parseEntityId);
  if (!supersedesRevisionId.ok) return supersedesRevisionId;
  const contentBase64 = requireString(raw, 'contentBase64', '', CONTENT_BASE64_RULE);
  if (!contentBase64.ok) return contentBase64;
  const extensionMetadata = optionalFieldWith(raw, 'extensionMetadata', '', parseJsonObject);
  if (!extensionMetadata.ok) return extensionMetadata;
  return parseOk({
    projectId: projectId.value,
    documentId: documentId.value,
    expectedVersion: expectedVersion.value,
    supersedesRevisionId: supersedesRevisionId.value,
    contentBase64: contentBase64.value,
    ...(extensionMetadata.value !== undefined
      ? { extensionMetadata: extensionMetadata.value }
      : {}),
  });
}

/** Parse the reference-evidence payload (total, fail-closed, strict keys). */
export function parseReferenceEvidencePayload(
  raw: unknown,
): ParseResult<ReferenceEvidencePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REFERENCE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REFERENCE_PAYLOAD_KEYS, '', REFERENCE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const revisionId = requireFieldWith(raw, 'revisionId', '', parseEntityId);
  if (!revisionId.ok) return revisionId;
  const evidencedEntityKind = requireFieldWith(raw, 'evidencedEntityKind', '', parseEntityKind);
  if (!evidencedEntityKind.ok) return evidencedEntityKind;
  const evidencedEntityId = requireFieldWith(raw, 'evidencedEntityId', '', parseEntityId);
  if (!evidencedEntityId.ok) return evidencedEntityId;
  return parseOk({
    projectId: projectId.value,
    documentId: documentId.value,
    revisionId: revisionId.value,
    evidencedEntityKind: evidencedEntityKind.value,
    evidencedEntityId: evidencedEntityId.value,
  });
}

// ----- command service -----------------------------------------------------------

/** Result of a revision-attaching command: the mutated document + the new immutable revision. */
export interface RevisionMutationResult {
  readonly document: DocumentState;
  readonly revision: DocumentRevisionState;
}

/**
 * Wiring dependencies of the documents command service. `now`, `newOpaqueId`,
 * and `hashContent` are the injected suppliers (determinism rule): fixed
 * values in tests, wall clock / crypto randomness / real content hashing in
 * production wiring. The store, event sink, object storage, and idempotency
 * registry are the ports the persistence/app layers implement.
 */
export interface DocumentsCommandDeps {
  readonly store: DocumentsStore;
  readonly eventSink: EventSink;
  readonly objectStorage: ObjectStorage;
  readonly idempotencyRegistry: IdempotencyRegistry;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
  /** Injected content-hash supplier: the content-addressed hash of the bytes. */
  readonly hashContent: (content: Uint8Array) => RevisionHash;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 * The documents area's declared capability pair is documents.read/write.
 */
export interface DocumentsCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The documents & evidence command surface. */
export interface DocumentsCommands {
  /** Register a document (project-scoped aggregate, status 'active', no revision yet). */
  registerDocument(
    command: CommandEnvelope<unknown>,
    authorization: DocumentsCommandAuthorization,
  ): Promise<CommandResult<IdempotentExecution<DocumentState>>>;
  /** Archive an ACTIVE document — the explicit one-way lifecycle event. */
  archiveDocument(
    command: CommandEnvelope<unknown>,
    authorization: DocumentsCommandAuthorization,
  ): Promise<CommandResult<IdempotentExecution<DocumentState>>>;
  /** Attach the document's FIRST (root) immutable revision. */
  attachRevision(
    command: CommandEnvelope<unknown>,
    authorization: DocumentsCommandAuthorization,
  ): Promise<CommandResult<IdempotentExecution<RevisionMutationResult>>>;
  /** Append a NEW revision that explicitly supersedes the current head. */
  supersedeRevision(
    command: CommandEnvelope<unknown>,
    authorization: DocumentsCommandAuthorization,
  ): Promise<CommandResult<IdempotentExecution<RevisionMutationResult>>>;
  /** Pin (entity, document, revision) as an immutable evidence reference. */
  referenceEvidence(
    command: CommandEnvelope<unknown>,
    authorization: DocumentsCommandAuthorization,
  ): Promise<CommandResult<IdempotentExecution<EvidenceReferenceState>>>;
}

/** Create the documents & evidence command service. */
export function createDocumentsCommands(deps: DocumentsCommandDeps): DocumentsCommands {
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
    authorization: DocumentsCommandAuthorization,
  ): AuthorizationContext =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /**
   * The documents-area resource being accessed, addressed within the COMMAND's
   * tenant and the payload's project (never the aggregate's real tenant —
   * that is the store's scope-guarded question; a cross-tenant attempt passes
   * authorization and vanishes as a typed not-found, freeze A12
   * invisibility). A project-scoped command addressing a different project is
   * denied structurally (typed unauthorized) BEFORE any unit of work opens.
   */
  const documentsResource = (
    tenantId: TenantId,
    projectId: ProjectId,
    resourceKind: EntityKind,
    resourceId: EntityId | null,
  ) =>
    resourceScope({
      scope: { kind: 'project', tenantId, projectId },
      resourceKind,
      resourceId,
      ownerId: null,
    });

  /** The optimistic-concurrency token the caller presented in its payload. */
  const expectedTokenOf = (
    documentId: EntityId,
    expectedVersion: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind: DOCUMENT_KIND,
    entityId: documentId,
    version: expectedVersion,
  });

  /**
   * Load the addressed document for a mutation: scope-guarded store read
   * (foreign rows are typed not-found), claimed-project verification (the
   * document must live in the project the command addressed — a mismatch is
   * invisible), and the kernel's A12 coverage backstop.
   */
  const loadDocumentForMutation = async (
    uow: DocumentsUnitOfWork,
    command: CommandEnvelope<unknown>,
    addressed: { readonly projectId: ProjectId; readonly documentId: EntityId },
  ): Promise<Result<DocumentState, DomainError>> => {
    const context = errorContextOf(command);
    const loaded = await uow.findDocumentById(command.scope, addressed.documentId);
    if (!loaded.ok) return loaded;
    const document = loaded.value;
    if (document.scope.kind !== 'project' || document.scope.projectId !== addressed.projectId) {
      // The claimed project does not own the document: invisible (typed
      // not-found), never a cross-project oracle.
      return fail(
        domainError(
          'not-found',
          `document ${addressed.documentId} not found`,
          [
            {
              code: 'entity-not-found',
              message: `${DOCUMENT_KIND} ${addressed.documentId}`,
              path: null,
            },
          ],
          context,
        ),
      );
    }
    // A12 backstop (kernel): the command scope must cover the loaded
    // aggregate's owning scope — with the scoped store this cannot fire, and
    // it is checked anyway (defense in depth).
    const coverage = checkScopeCovers(command.scope, document.scope, context);
    if (!coverage.ok) return coverage;
    return loaded;
  };

  return {
    registerDocument: async (command, authorization) => {
      requireCommandName(command, REGISTER_DOCUMENT_COMMAND);
      const payload = parseRegisterDocumentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Authorization runs BEFORE any unit of work is opened: a denied
      // command must touch nothing at all. The resource is kind-level — the
      // instance does not exist yet.
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        documentsResource(command.scope.tenantId, payload.value.projectId, DOCUMENT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return withIdempotency(deps.idempotencyRegistry, command, () =>
        deps.store.openUnitOfWork(async (uow) => {
          const now = deps.now();
          const context = errorContextOf(command);
          const documentId = formatEntityId({
            version: 'v1',
            opaque: deps.newOpaqueId(),
          });
          const scope: Scope = {
            kind: 'project',
            tenantId: command.scope.tenantId,
            projectId: payload.value.projectId,
          };
          const initial = createDocumentState(
            {
              documentId,
              title: payload.value.title,
              ...(payload.value.extensionMetadata !== undefined
                ? { extensionMetadata: payload.value.extensionMetadata }
                : {}),
              now,
            },
            { tenantId: command.scope.tenantId, projectId: payload.value.projectId },
            context,
          );
          if (!initial.ok) return uow.rollback(initial);

          const inserted = await uow.insertDocument(initial.value);
          if (!inserted.ok) return uow.rollback(inserted);

          const event = documentsEventEnvelope({
            command,
            eventName: DOCUMENT_REGISTERED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: { before: null, after: entityRefOf(DOCUMENT_KIND, documentId) },
            payload: {
              documentId,
              projectId: payload.value.projectId,
              title: initial.value.title,
              status: initial.value.status,
              version: initial.value.version,
              createdAt: initial.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(uow.executor, [event]);
          if (!appended.ok) return uow.rollback(appended);

          return initial;
        }),
      );
    },

    archiveDocument: async (command, authorization) => {
      requireCommandName(command, ARCHIVE_DOCUMENT_COMMAND);
      const payload = parseArchiveDocumentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        documentsResource(
          command.scope.tenantId,
          payload.value.projectId,
          DOCUMENT_KIND,
          payload.value.documentId,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(payload.value.documentId, payload.value.expectedVersion);

      return withIdempotency(deps.idempotencyRegistry, command, () =>
        deps.store.openUnitOfWork(async (uow) => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await loadDocumentForMutation(uow, command, payload.value);
          if (!loaded.ok) return uow.rollback(loaded);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return uow.rollback(concurrency);

          const next = archiveDocumentState(loaded.value, now, context);
          if (!next.ok) return uow.rollback(next);

          const written = await uow.saveDocument(payload.value.expectedVersion, next.value);
          if (!written.ok) return uow.rollback(written);

          if (written.value.archivedAt === null) {
            // Invariant-guaranteed non-null after archive; a violation means
            // the write path is malformed — loud, never silent.
            throw new TypeError(
              `archived document ${written.value.entityId} carries no archivedAt timestamp`,
            );
          }

          const event = documentsEventEnvelope({
            command,
            eventName: DOCUMENT_ARCHIVED_EVENT,
            scope: written.value.scope,
            occurredAt: now,
            entityRefs: {
              before: entityRefOf(DOCUMENT_KIND, loaded.value.entityId),
              after: entityRefOf(DOCUMENT_KIND, written.value.entityId),
            },
            payload: {
              documentId: written.value.entityId,
              status: written.value.status,
              archivedAt: written.value.archivedAt,
              version: written.value.version,
              updatedAt: written.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(uow.executor, [event]);
          if (!appended.ok) return uow.rollback(appended);

          return written;
        }),
      );
    },

    attachRevision: async (command, authorization) => {
      requireCommandName(command, ATTACH_REVISION_COMMAND);
      const payload = parseAttachRevisionPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        documentsResource(
          command.scope.tenantId,
          payload.value.projectId,
          DOCUMENT_KIND,
          payload.value.documentId,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(payload.value.documentId, payload.value.expectedVersion);

      return withIdempotency(deps.idempotencyRegistry, command, () =>
        deps.store.openUnitOfWork(async (uow) => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await loadDocumentForMutation(uow, command, payload.value);
          if (!loaded.ok) return uow.rollback(loaded);
          const document = loaded.value;

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(document),
            context,
          );
          if (!concurrency.ok) return uow.rollback(concurrency);

          if (document.scope.kind !== 'project') {
            // Invariant-guaranteed project scope; a violation means the write
            // path is malformed — loud, never silent.
            throw new TypeError(`document ${document.entityId} is not project-scoped`);
          }

          // Content addressing: decode the payload bytes, hash them with the
          // injected supplier, and compose the provider-neutral storage key.
          const bytes = decodeBase64(payload.value.contentBase64);
          const hash = deps.hashContent(bytes);
          const storageKey = formatStorageKey({
            tenantId: document.scope.tenantId,
            projectId: document.scope.projectId,
            hash,
          });
          const revisionId = formatEntityId({
            version: 'v1',
            opaque: deps.newOpaqueId(),
          });
          const revision = createDocumentRevisionState(
            {
              revisionId,
              documentId: document.entityId,
              scope: document.scope,
              supersedes: null,
              contentHash: hash,
              storageKey,
              byteSize: bytes.byteLength,
              now,
              ...(payload.value.extensionMetadata !== undefined
                ? { extensionMetadata: payload.value.extensionMetadata }
                : {}),
            },
            context,
          );
          if (!revision.ok) return uow.rollback(revision);

          const nextDocument = attachRevisionState(document, revision.value, now, context);
          if (!nextDocument.ok) return uow.rollback(nextDocument);

          // The blob is stored through the port BEFORE the state mutations
          // commit: a failing put aborts the unit with nothing staged. A late
          // failure (sink) may orphan the blob — accepted by design: the key
          // is content-addressed (a retry re-puts identically) and no
          // aggregate references an uncommitted revision.
          const put = await deps.objectStorage.put(storageKey, bytes);
          if (!put.ok) return uow.rollback(put);

          const saved = await uow.saveDocument(payload.value.expectedVersion, nextDocument.value);
          if (!saved.ok) return uow.rollback(saved);

          const inserted = await uow.insertRevision(revision.value);
          if (!inserted.ok) return uow.rollback(inserted);

          const event = documentsEventEnvelope({
            command,
            eventName: REVISION_ATTACHED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: entityRefOf(REVISION_KIND, revisionId) },
            payload: {
              documentId: saved.value.entityId,
              revisionId,
              supersedes: null,
              contentHash: hash,
              storageKey,
              byteSize: bytes.byteLength,
              version: saved.value.version,
              attachedAt: now,
            },
          });
          const appended = await deps.eventSink.appendEvents(uow.executor, [event]);
          if (!appended.ok) return uow.rollback(appended);

          return ok({ document: saved.value, revision: revision.value });
        }),
      );
    },

    supersedeRevision: async (command, authorization) => {
      requireCommandName(command, SUPERSEDE_REVISION_COMMAND);
      const payload = parseSupersedeRevisionPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        documentsResource(
          command.scope.tenantId,
          payload.value.projectId,
          DOCUMENT_KIND,
          payload.value.documentId,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected = expectedTokenOf(payload.value.documentId, payload.value.expectedVersion);

      return withIdempotency(deps.idempotencyRegistry, command, () =>
        deps.store.openUnitOfWork(async (uow) => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await loadDocumentForMutation(uow, command, payload.value);
          if (!loaded.ok) return uow.rollback(loaded);
          const document = loaded.value;

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(document),
            context,
          );
          if (!concurrency.ok) return uow.rollback(concurrency);

          // The superseded target must be a revision of THIS document,
          // visible to the command scope (typed not-found otherwise).
          const target = await uow.findRevisionById(
            command.scope,
            payload.value.documentId,
            payload.value.supersedesRevisionId,
          );
          if (!target.ok) return uow.rollback(target);

          if (document.scope.kind !== 'project') {
            // Invariant-guaranteed project scope; a violation means the write
            // path is malformed — loud, never silent.
            throw new TypeError(`document ${document.entityId} is not project-scoped`);
          }

          // Content addressing of the successor's bytes.
          const bytes = decodeBase64(payload.value.contentBase64);
          const hash = deps.hashContent(bytes);
          const storageKey = formatStorageKey({
            tenantId: document.scope.tenantId,
            projectId: document.scope.projectId,
            hash,
          });
          const revisionId = formatEntityId({
            version: 'v1',
            opaque: deps.newOpaqueId(),
          });
          const revision = createDocumentRevisionState(
            {
              revisionId,
              documentId: document.entityId,
              scope: document.scope,
              supersedes: payload.value.supersedesRevisionId,
              contentHash: hash,
              storageKey,
              byteSize: bytes.byteLength,
              now,
              ...(payload.value.extensionMetadata !== undefined
                ? { extensionMetadata: payload.value.extensionMetadata }
                : {}),
            },
            context,
          );
          if (!revision.ok) return uow.rollback(revision);

          // The transition enforces the explicit, linear supersession chain:
          // the successor must supersede the CURRENT head, and the superseded
          // revision's own row is never altered.
          const nextDocument = supersedeRevisionState(document, revision.value, now, context);
          if (!nextDocument.ok) return uow.rollback(nextDocument);

          const put = await deps.objectStorage.put(storageKey, bytes);
          if (!put.ok) return uow.rollback(put);

          const saved = await uow.saveDocument(payload.value.expectedVersion, nextDocument.value);
          if (!saved.ok) return uow.rollback(saved);

          const inserted = await uow.insertRevision(revision.value);
          if (!inserted.ok) return uow.rollback(inserted);

          const event = documentsEventEnvelope({
            command,
            eventName: REVISION_SUPERSEDED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: {
              before: entityRefOf(REVISION_KIND, payload.value.supersedesRevisionId),
              after: entityRefOf(REVISION_KIND, revisionId),
            },
            payload: {
              documentId: saved.value.entityId,
              revisionId,
              supersedes: payload.value.supersedesRevisionId,
              contentHash: hash,
              storageKey,
              byteSize: bytes.byteLength,
              version: saved.value.version,
              supersededAt: now,
            },
          });
          const appended = await deps.eventSink.appendEvents(uow.executor, [event]);
          if (!appended.ok) return uow.rollback(appended);

          return ok({ document: saved.value, revision: revision.value });
        }),
      );
    },

    referenceEvidence: async (command, authorization) => {
      requireCommandName(command, REFERENCE_EVIDENCE_COMMAND);
      const payload = parseReferenceEvidencePayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        documentsResource(
          command.scope.tenantId,
          payload.value.projectId,
          EVIDENCE_REFERENCE_KIND,
          null,
        ),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return withIdempotency(deps.idempotencyRegistry, command, () =>
        deps.store.openUnitOfWork(async (uow) => {
          const now = deps.now();
          const context = errorContextOf(command);

          // The pinned revision must belong to a document of the claimed
          // project, visible to the command scope. Pinning evidence on an
          // archived document is legal — evidence is history (freeze A4), and
          // creating a reference mutates neither the document nor any
          // revision.
          const loaded = await loadDocumentForMutation(uow, command, payload.value);
          if (!loaded.ok) return uow.rollback(loaded);
          const document = loaded.value;

          const revision = await uow.findRevisionById(
            command.scope,
            payload.value.documentId,
            payload.value.revisionId,
          );
          if (!revision.ok) return uow.rollback(revision);

          const evidenceReferenceId = formatEntityId({
            version: 'v1',
            opaque: deps.newOpaqueId(),
          });
          const reference = createEvidenceReferenceState(
            {
              evidenceReferenceId,
              scope: document.scope,
              documentId: payload.value.documentId,
              revisionId: payload.value.revisionId,
              evidencedEntityKind: payload.value.evidencedEntityKind,
              evidencedEntityId: payload.value.evidencedEntityId,
              now,
            },
            context,
          );
          if (!reference.ok) return uow.rollback(reference);

          // Create-only: a duplicate natural key (the same entity already
          // pinned to the same revision) is a typed conflict — the
          // immutability guard. There is no path that repoints or edits a
          // committed reference.
          const inserted = await uow.insertEvidenceReference(reference.value);
          if (!inserted.ok) return uow.rollback(inserted);

          const event = documentsEventEnvelope({
            command,
            eventName: EVIDENCE_REFERENCED_EVENT,
            scope: reference.value.scope,
            occurredAt: now,
            entityRefs: {
              before: null,
              after: entityRefOf(EVIDENCE_REFERENCE_KIND, evidenceReferenceId),
            },
            payload: {
              evidenceReferenceId,
              documentId: payload.value.documentId,
              revisionId: payload.value.revisionId,
              evidencedEntityKind: payload.value.evidencedEntityKind,
              evidencedEntityId: payload.value.evidencedEntityId,
              referencedAt: now,
            },
          });
          const appended = await deps.eventSink.appendEvents(uow.executor, [event]);
          if (!appended.ok) return uow.rollback(appended);

          return reference;
        }),
      );
    },
  };
}
