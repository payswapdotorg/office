// Office documents domain — aggregate states, invariants, transitions (OFF-008).
//
// The Documents & Evidence bounded context of the canonical enterprise graph
// (freeze A1), modeled as three immutable-record shapes plus one mutable
// aggregate head:
//
//  * DocumentState — the PROJECT-scoped Document aggregate (the second
//    authorization boundary, freeze A12): a titled working document of one
//    project with an explicit one-way lifecycle (active → archived) and a
//    `currentRevisionId` head pointer into its revision chain. The document
//    row is the only mutable part of the model: registering, archiving, and
//    attaching/superseding revisions bump its version exactly once per
//    mutation, guarded by optimistic concurrency.
//
//  * DocumentRevisionState — an IMMUTABLE row of record: create-only, never
//    updated, never deleted. A revision carries the content-addressed hash
//    and storage key of its bytes and a FORWARD supersession link
//    (`supersedes`: revision R2 names the R1 it supersedes) — supersession
//    links forward without altering the superseded revision, so R1's
//    content/hash/row is byte-identical before and after supersession. Its
//    aggregate version is pinned to the initial version by an invariant: the
//    immutability is structural, not conventional.
//
//  * EvidenceReferenceState — an IMMUTABLE pin binding one entity (a task,
//    an issue, a change order, ...) to ONE SPECIFIC document revision (never
//    "the document"): create-only, never repointed, never edited. The
//    evidence id is Office-issued; the natural key is
//    (evidenced entity, document, revision), so a second attempt to pin the
//    same triple is a typed conflict, which is exactly how immutability is
//    enforced.
//
// State invariants are declarative (kernel Invariant<S>) and checked on every
// state a constructor/transition produces; lifecycle preconditions are checked
// by the pure transition functions below — both layers return typed
// invariant-violation DomainErrors, never bare throws.
import { isEntityId, isEntityKind, parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { fail, invariantViolation } from '@office/domain-kernel';
import { isRevisionHash, isStorageKey } from './storage';
import type { RevisionHash, StorageKey } from './storage';

/** Lifecycle status of a document. `archived` is terminal (one-way). */
export type DocumentStatus = 'active' | 'archived';

/** All document lifecycle statuses, in canonical order. */
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['active', 'archived'];

const parsedDocumentKind = parseEntityKind('document');
if (!parsedDocumentKind.ok) {
  // Trusted-path literal: a violation means this module is malformed.
  throw new TypeError(
    `invalid document entity kind literal: ${JSON.stringify(parsedDocumentKind.error)}`,
  );
}

/** Canonical entity kind of the Document aggregate. */
export const DOCUMENT_KIND: EntityKind = parsedDocumentKind.value;

const parsedRevisionKind = parseEntityKind('document-revision');
if (!parsedRevisionKind.ok) {
  throw new TypeError(
    `invalid document revision entity kind literal: ${JSON.stringify(parsedRevisionKind.error)}`,
  );
}

/** Canonical entity kind of an immutable document revision. */
export const REVISION_KIND: EntityKind = parsedRevisionKind.value;

const parsedEvidenceKind = parseEntityKind('evidence-reference');
if (!parsedEvidenceKind.ok) {
  throw new TypeError(
    `invalid evidence reference entity kind literal: ${JSON.stringify(parsedEvidenceKind.error)}`,
  );
}

/** Canonical entity kind of an immutable evidence reference. */
export const EVIDENCE_REFERENCE_KIND: EntityKind = parsedEvidenceKind.value;

const TITLE_MAX_LENGTH = 200;
const BYTE_SIZE_MAX = 100_000_000;

/**
 * The Document aggregate state. `scope` is always the document's project
 * scope: { kind: 'project', tenantId, projectId } — documents are project-
 * bound entities of the enterprise graph (freeze A1/A12).
 */
export interface DocumentState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** Non-empty display title (1..200 characters). */
  readonly title: string;
  /** Lifecycle status; `archived` is terminal. */
  readonly status: DocumentStatus;
  /** When the document was archived; null while active. */
  readonly archivedAt: Timestamp | null;
  /**
   * Head of the revision chain: the newest attached revision, null until the
   * first revision is attached. Supersession moves the head forward; the
   * superseded revisions stay untouched.
   */
  readonly currentRevisionId: EntityId | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  /** Extension metadata (A2: JSONB reserved for extension metadata only). */
  readonly extensionMetadata: Readonly<Record<string, unknown>>;
}

/**
 * Declarative invariants over any DocumentState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const DOCUMENT_INVARIANTS = [
  defineInvariant<DocumentState>(
    'document-title-nonempty',
    'a document title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= TITLE_MAX_LENGTH,
  ),
  defineInvariant<DocumentState>(
    'document-status-vocabulary',
    "a document status is 'active' or 'archived'",
    (state) => (DOCUMENT_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<DocumentState>(
    'document-archive-timestamp-pairs-with-status',
    "archivedAt is null exactly while status is 'active' (archive is explicit and timestamped)",
    (state) =>
      (state.status === 'active' && state.archivedAt === null) ||
      (state.status === 'archived' && state.archivedAt !== null),
  ),
  defineInvariant<DocumentState>(
    'document-is-project-scoped',
    'a document is owned by exactly one project (project scope, never tenant scope)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<DocumentState>(
    'document-current-revision-is-canonical',
    'the current revision head is null or a canonical EntityId',
    (state) => state.currentRevisionId === null || isEntityId(state.currentRevisionId),
  ),
  defineInvariant<DocumentState>(
    'document-version-is-monotonic',
    'a document version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/**
 * An immutable document revision: one attached version of a document's
 * content. `scope` is the owning document's project scope; `version` is
 * pinned to the initial aggregate version by an invariant below (revisions
 * are rows of record — they are never mutated, so their version never
 * advances).
 */
export interface DocumentRevisionState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The document this revision belongs to. */
  readonly documentId: EntityId;
  /**
   * FORWARD supersession link: the prior revision THIS revision supersedes,
   * null for the chain's root. R1 itself is never altered by supersession —
   * the link lives on the successor.
   */
  readonly supersedes: EntityId | null;
  /** Content-addressed hash of the revision's bytes (injected supplier). */
  readonly contentHash: RevisionHash;
  /** Provider-neutral, content-addressed object-storage key of the bytes. */
  readonly storageKey: StorageKey;
  /** Size of the decoded content in bytes (1..100000000). */
  readonly byteSize: number;
  readonly createdAt: Timestamp;
  /** Extension metadata frozen at attach time (create-only, A2). */
  readonly extensionMetadata: Readonly<Record<string, unknown>>;
}

/**
 * Declarative invariants over any DocumentRevisionState, in declaration
 * order. Together they state the immutability model: a revision is a
 * canonical, project-scoped, content-addressed row of record whose version
 * can never advance.
 */
export const REVISION_INVARIANTS = [
  defineInvariant<DocumentRevisionState>(
    'revision-belongs-to-a-canonical-document',
    'a revision names the canonical document it belongs to',
    (state) => isEntityId(state.documentId),
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-supersedes-canonical-or-root',
    'a revision supersedes a canonical prior revision or is the chain root (null), and never itself',
    (state) =>
      state.supersedes === null ||
      (isEntityId(state.supersedes) && state.supersedes !== state.entityId),
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-is-project-scoped',
    'a revision is owned by its document project scope (project scope, never tenant scope)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-content-hash-is-canonical',
    'a revision content hash is a canonical lowercase hex hash (16..128 characters)',
    (state) => isRevisionHash(state.contentHash),
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-storage-key-is-canonical',
    'a revision storage key is a canonical provider-neutral content-addressed key',
    (state) => isStorageKey(state.storageKey),
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-version-is-create-only-initial',
    'a revision is an immutable row of record: its aggregate version is pinned to the initial version (create-only, never mutated)',
    (state) => state.version === INITIAL_AGGREGATE_VERSION,
  ),
  defineInvariant<DocumentRevisionState>(
    'revision-byte-size-is-bounded',
    'a revision byte size is an integer in 1..100000000',
    (state) =>
      Number.isInteger(state.byteSize) &&
      state.byteSize >= 1 &&
      state.byteSize <= BYTE_SIZE_MAX,
  ),
] as const;

/**
 * An immutable evidence reference: one entity (a task, an issue, a change
 * order, ...) pinned to ONE SPECIFIC document revision. `scope` is the
 * owning document's project scope; `version` is pinned to the initial
 * aggregate version by an invariant below (create-only, never repointed,
 * never edited — there is no transition that touches an existing reference).
 */
export interface EvidenceReferenceState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The document whose revision is pinned. */
  readonly documentId: EntityId;
  /** The SPECIFIC pinned revision (never just "the document"). */
  readonly revisionId: EntityId;
  /** The evidenced entity's canonical kind, e.g. 'task', 'issue', 'change-order'. */
  readonly evidencedEntityKind: EntityKind;
  /** The evidenced entity's canonical id. */
  readonly evidencedEntityId: EntityId;
  readonly createdAt: Timestamp;
}

/**
 * Declarative invariants over any EvidenceReferenceState, in declaration
 * order: a reference binds canonical ids, lives in the document's project
 * scope, and is create-only (version pinned to the initial version).
 */
export const EVIDENCE_REFERENCE_INVARIANTS = [
  defineInvariant<EvidenceReferenceState>(
    'evidence-reference-binds-canonical-document-and-revision',
    'an evidence reference names the canonical document AND the canonical revision it pins',
    (state) => isEntityId(state.documentId) && isEntityId(state.revisionId),
  ),
  defineInvariant<EvidenceReferenceState>(
    'evidence-reference-binds-a-canonical-entity',
    'an evidence reference names the evidenced entity by canonical kind and id',
    (state) => isEntityKind(state.evidencedEntityKind) && isEntityId(state.evidencedEntityId),
  ),
  defineInvariant<EvidenceReferenceState>(
    'evidence-reference-is-project-scoped',
    'an evidence reference is owned by its document project scope (project scope, never tenant scope)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<EvidenceReferenceState>(
    'evidence-reference-version-is-create-only-initial',
    'an evidence reference is immutable: its aggregate version is pinned to the initial version (create-only, never repointed or edited)',
    (state) => state.version === INITIAL_AGGREGATE_VERSION,
  ),
] as const;

// ----- constructors (trusted path, invariant-checked) ---------------------------

/** Parts of a newly registered document (the canonical id is issued inside the handler). */
export interface NewDocument {
  readonly documentId: EntityId;
  readonly title: string;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly registered document (trusted path — the
 * payload was validated fail-closed upstream). The owning scope is derived
 * from the creating command's tenant and the addressed project. A new
 * document carries no revision yet (currentRevisionId null).
 */
export function createDocumentState(
  input: NewDocument,
  scope: { readonly tenantId: TenantId; readonly projectId: ProjectId },
  context?: DomainErrorContext,
): Result<DocumentState, DomainError> {
  const state: DocumentState = {
    entityKind: DOCUMENT_KIND,
    entityId: input.documentId,
    scope: { kind: 'project', tenantId: scope.tenantId, projectId: scope.projectId },
    version: INITIAL_AGGREGATE_VERSION,
    title: input.title,
    status: 'active',
    archivedAt: null,
    currentRevisionId: null,
    createdAt: input.now,
    updatedAt: input.now,
    extensionMetadata: input.extensionMetadata ?? {},
  };
  return checkInvariants(state, DOCUMENT_INVARIANTS, context);
}

/** Parts of a new immutable revision (the canonical id is issued inside the handler). */
export interface NewDocumentRevision {
  readonly revisionId: EntityId;
  readonly documentId: EntityId;
  readonly scope: Scope;
  readonly supersedes: EntityId | null;
  readonly contentHash: RevisionHash;
  readonly storageKey: StorageKey;
  readonly byteSize: number;
  readonly now: Timestamp;
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build one immutable revision row (trusted path — hash, key, and size come
 * from the injected suppliers and the content the handler decoded). The
 * revision is checked against every revision invariant; its version is the
 * initial aggregate version by construction.
 */
export function createDocumentRevisionState(
  input: NewDocumentRevision,
  context?: DomainErrorContext,
): Result<DocumentRevisionState, DomainError> {
  const revision: DocumentRevisionState = {
    entityKind: REVISION_KIND,
    entityId: input.revisionId,
    scope: input.scope,
    version: INITIAL_AGGREGATE_VERSION,
    documentId: input.documentId,
    supersedes: input.supersedes,
    contentHash: input.contentHash,
    storageKey: input.storageKey,
    byteSize: input.byteSize,
    createdAt: input.now,
    extensionMetadata: input.extensionMetadata ?? {},
  };
  return checkInvariants(revision, REVISION_INVARIANTS, context);
}

/** Parts of a new immutable evidence reference (the id is issued inside the handler). */
export interface NewEvidenceReference {
  readonly evidenceReferenceId: EntityId;
  readonly scope: Scope;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
  readonly evidencedEntityKind: EntityKind;
  readonly evidencedEntityId: EntityId;
  readonly now: Timestamp;
}

/**
 * Build one immutable evidence reference (trusted path). The reference pins
 * (evidenced entity, document, revision) at creation time and can never be
 * repointed or edited afterwards — no transition below accepts one.
 */
export function createEvidenceReferenceState(
  input: NewEvidenceReference,
  context?: DomainErrorContext,
): Result<EvidenceReferenceState, DomainError> {
  const reference: EvidenceReferenceState = {
    entityKind: EVIDENCE_REFERENCE_KIND,
    entityId: input.evidenceReferenceId,
    scope: input.scope,
    version: INITIAL_AGGREGATE_VERSION,
    documentId: input.documentId,
    revisionId: input.revisionId,
    evidencedEntityKind: input.evidencedEntityKind,
    evidencedEntityId: input.evidencedEntityId,
    createdAt: input.now,
  };
  return checkInvariants(reference, EVIDENCE_REFERENCE_INVARIANTS, context);
}

// ----- pure lifecycle transitions (typed failures, never silent) -----------------

/**
 * Pure transition: archive an ACTIVE document — the explicit, one-way
 * lifecycle event (freeze: archive is never a delete and never silent; the
 * revision rows and evidence references stay exactly as they were). The next
 * state carries status 'archived', archivedAt = now, version + 1.
 */
export function archiveDocumentState(
  current: DocumentState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<DocumentState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'document-archive-requires-active',
          statement: `document ${current.entityId} is already '${current.status}'; archive is a one-way transition from 'active'`,
        },
        context,
      ),
    );
  }
  const next: DocumentState = {
    ...current,
    status: 'archived',
    archivedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, DOCUMENT_INVARIANTS, context);
}

/**
 * Pure transition: attach `revision` as the document's FIRST revision. Only
 * an ACTIVE document with no current revision accepts an attach — later
 * content arrives exclusively through explicit supersession
 * ({@link supersedeRevisionState}), so every revision after the root carries
 * a forward supersession link and the chain stays linear. The next document
 * state carries currentRevisionId = the revision id, version + 1.
 */
export function attachRevisionState(
  current: DocumentState,
  revision: DocumentRevisionState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<DocumentState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'document-attach-requires-active',
          statement: `document ${current.entityId} is '${current.status}'; only an active document accepts revision mutations`,
        },
        context,
      ),
    );
  }
  if (current.currentRevisionId !== null) {
    return fail(
      invariantViolation(
        {
          name: 'document-attach-requires-empty-chain',
          statement: `document ${current.entityId} already has revision ${current.currentRevisionId}; later content must arrive through an explicit supersession, never a second root`,
        },
        context,
      ),
    );
  }
  if (revision.documentId !== current.entityId) {
    return fail(
      invariantViolation(
        {
          name: 'document-attach-revision-belongs-to-document',
          statement: `revision ${revision.entityId} belongs to document ${revision.documentId}, not to ${current.entityId}`,
        },
        context,
      ),
    );
  }
  if (revision.supersedes !== null) {
    return fail(
      invariantViolation(
        {
          name: 'document-attach-revision-is-chain-root',
          statement: `the attached revision ${revision.entityId} must be the chain root (supersedes null); use the supersede transition to link a successor`,
        },
        context,
      ),
    );
  }
  const next: DocumentState = {
    ...current,
    currentRevisionId: revision.entityId,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, DOCUMENT_INVARIANTS, context);
}

/**
 * Pure transition: attach `revision` as a successor that EXPLICITLY supersedes
 * the document's current head revision. Supersession is an auditable
 * append-only event: the successor row records the forward link
 * (`supersedes` = the prior head) and the document's head pointer moves; the
 * superseded revision's own row is never read-modified. The next document
 * state carries currentRevisionId = the successor id, version + 1.
 */
export function supersedeRevisionState(
  current: DocumentState,
  revision: DocumentRevisionState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<DocumentState, DomainError> {
  if (current.status !== 'active') {
    return fail(
      invariantViolation(
        {
          name: 'document-supersede-requires-active',
          statement: `document ${current.entityId} is '${current.status}'; only an active document accepts revision mutations`,
        },
        context,
      ),
    );
  }
  if (current.currentRevisionId === null) {
    return fail(
      invariantViolation(
        {
          name: 'document-supersede-requires-existing-chain',
          statement: `document ${current.entityId} has no revision yet; its first revision is attached, not superseded`,
        },
        context,
      ),
    );
  }
  if (revision.documentId !== current.entityId) {
    return fail(
      invariantViolation(
        {
          name: 'document-supersede-revision-belongs-to-document',
          statement: `revision ${revision.entityId} belongs to document ${revision.documentId}, not to ${current.entityId}`,
        },
        context,
      ),
    );
  }
  if (revision.supersedes === null) {
    return fail(
      invariantViolation(
        {
          name: 'document-supersede-revision-carries-forward-link',
          statement: `the successor revision ${revision.entityId} must name the prior revision it supersedes (supersedes null is reserved for the chain root)`,
        },
        context,
      ),
    );
  }
  if (revision.supersedes !== current.currentRevisionId) {
    return fail(
      invariantViolation(
        {
          name: 'document-supersede-requires-current-head',
          statement: `revision ${revision.supersedes} is not the current head (head is ${current.currentRevisionId}); supersession chains are linear — an already superseded revision cannot be superseded again`,
        },
        context,
      ),
    );
  }
  const next: DocumentState = {
    ...current,
    currentRevisionId: revision.entityId,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, DOCUMENT_INVARIANTS, context);
}
