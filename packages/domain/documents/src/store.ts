// Office documents domain — the documents store port + in-memory store (OFF-008).
//
// This package is PURE DOMAIN: no SQL, no migrations, no repository layer.
// Command handlers still need somewhere to read committed aggregate state and
// to apply their staged mutations atomically with the audit-event append, so
// the package owns a minimal STORE PORT in the same spirit as the EventSink
// port: `DocumentsStore.openUnitOfWork` is the transactional boundary the
// handler's logic runs inside, `DocumentsUnitOfWork` is the open unit (staged
// mutations + scope-guarded reads + the executor handed to the EventSink +
// the cooperative rollback escape), and the read methods answer committed
// state for consumers. The persistence/app layers implement this port
// transactionally against PostgreSQL later (their write of the document row,
// the immutable revision row, and the evidence row joins the event-ledger
// append in ONE database transaction); this package ships the deterministic
// in-memory implementation used by every test.
//
// A12 by construction, mirroring the OFF-004/OFF-007 repository conventions:
// every read and write executes under an explicit contracts Scope; a row
// owned by a foreign tenant (or a foreign project, for project-scoped
// execution) is simply not there — a typed not-found, never an existence
// oracle. Writes are guarded by optimistic concurrency (`saveDocument`
// compares the expected version); duplicate canonical ids are typed
// invariant-violations; there is deliberately NO method that updates or
// deletes a revision or an evidence reference — those rows are immutable.
import type { EntityId, EntityKind, Scope } from '@office/contracts';
import {
  checkScopeCovers,
  concurrencyConflict,
  domainError,
  entityNotFound,
  fail,
  ok,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { DocumentRevisionState, DocumentState, EvidenceReferenceState } from './state';
import {
  DOCUMENT_KIND,
  EVIDENCE_REFERENCE_KIND,
  REVISION_KIND,
} from './state';

/** Internal control signal: rollback requested with a value to return. */
class UnitRollbackSignal {
  readonly kind = 'unit-rollback-signal' as const;
  constructor(readonly value: unknown) {}
}

/**
 * One open unit of work over the documents store (the pure-domain mirror of
 * the persistence Transaction): staged mutations + scope-guarded reads that
 * see the staged state, the executor handed to the EventSink (the port's
 * transactional seat), and the cooperative `rollback` escape.
 *
 * Semantics (identical to `TransactionRunner`):
 *  * the work callback RESOLVES  → the staged mutations COMMIT;
 *  * the work callback THROWS     → the staged mutations are discarded and
 *                                   the original error is rethrown;
 *  * `rollback(value)`            → the staged mutations are discarded and
 *                                   `value` becomes the unit's result.
 */
export interface DocumentsUnitOfWork {
  /**
   * The transactional seat of the unit: handed to `EventSink.appendEvents` so
   * a real sink implementation writes its ledger rows inside the same
   * transaction as the state mutations (the in-memory store's executor
   * executes no SQL and fails loudly if used).
   */
  readonly executor: SqlExecutor;
  /** Roll the unit back (discarding every staged mutation) and return `value`. */
  rollback<T>(value: T): never;
  /**
   * Load the addressed document within the scope. A foreign-tenant or
   * foreign-project document is a typed not-found (no existence oracle, A12).
   * Reads see the staged state of this unit.
   */
  findDocumentById(scope: Scope, documentId: EntityId): Promise<Result<DocumentState, DomainError>>;
  /**
   * Load the addressed revision (which must belong to `documentId`) within
   * the scope; typed not-found otherwise. Reads see the staged state.
   */
  findRevisionById(
    scope: Scope,
    documentId: EntityId,
    revisionId: EntityId,
  ): Promise<Result<DocumentRevisionState, DomainError>>;
  /**
   * Stage the insert of a newly registered document. Duplicate canonical id →
   * typed invariant-violation (`document-id-already-exists`).
   */
  insertDocument(document: DocumentState): Promise<Result<true, DomainError>>;
  /**
   * Stage the document head/state update with optimistic concurrency: the
   * staged/current version must equal `expectedVersion`, else a typed
   * concurrency-conflict; a missing (or invisible) document is a typed
   * not-found. Returns the next state on success.
   */
  saveDocument(
    expectedVersion: AggregateVersion,
    next: DocumentState,
  ): Promise<Result<DocumentState, DomainError>>;
  /**
   * Stage the insert of one immutable revision row. Duplicate canonical
   * revision id → typed invariant-violation (`revision-id-already-exists`).
   * There is intentionally NO update/delete for revisions — they are
   * create-only rows of record.
   */
  insertRevision(revision: DocumentRevisionState): Promise<Result<true, DomainError>>;
  /**
   * Stage the insert of one immutable evidence reference. Duplicate canonical
   * id → typed invariant-violation; a duplicate natural key (the same
   * evidenced entity pinned to the same document revision) → typed
   * invariant-violation (`evidence-reference-already-exists`) — the
   * immutability guard. There is intentionally NO update/delete/repoint.
   */
  insertEvidenceReference(
    reference: EvidenceReferenceState,
  ): Promise<Result<true, DomainError>>;
}

/**
 * THE documents store port: the transactional unit-of-work boundary the
 * command handlers orchestrate inside, plus scope-guarded reads over the
 * committed state for consumers. The in-memory implementation below satisfies
 * it deterministically; the persistence/app layers implement it against
 * PostgreSQL (state writes + ledger append in ONE database transaction).
 */
export interface DocumentsStore {
  /**
   * Run `work` as one atomic unit: staged mutations commit only when the work
   * resolves successfully; `rollback(value)` and thrown errors discard them.
   */
  openUnitOfWork<T>(
    work: (uow: DocumentsUnitOfWork) => Promise<Result<T, DomainError>>,
  ): Promise<Result<T, DomainError>>;
  /** Load the addressed document within the scope (typed not-found otherwise). */
  findDocumentById(scope: Scope, documentId: EntityId): Promise<Result<DocumentState, DomainError>>;
  /** Load the addressed revision of `documentId` within the scope. */
  findRevisionById(
    scope: Scope,
    documentId: EntityId,
    revisionId: EntityId,
  ): Promise<Result<DocumentRevisionState, DomainError>>;
  /**
   * Read the document's full revision chain, oldest first: the root revision
   * through every explicit supersession link up to the current head. The full
   * history is always readable; superseded revisions are unchanged rows.
   */
  revisionChainOf(
    scope: Scope,
    documentId: EntityId,
  ): Promise<Result<readonly DocumentRevisionState[], DomainError>>;
  /**
   * Load the evidence reference pinning (evidenced entity, document, revision)
   * within the scope; typed not-found when no such pin exists.
   */
  findEvidenceReferenceByTarget(
    scope: Scope,
    evidenced: { readonly entityKind: EntityKind; readonly entityId: EntityId },
    documentId: EntityId,
    revisionId: EntityId,
  ): Promise<Result<EvidenceReferenceState, DomainError>>;
  /**
   * List every evidence reference of the evidenced entity visible to the
   * scope, in creation order (the entity's evidence trail, A4).
   */
  listEvidenceReferencesOfEntity(
    scope: Scope,
    entityKind: EntityKind,
    entityId: EntityId,
  ): Promise<Result<readonly EvidenceReferenceState[], DomainError>>;
}

/** Counters of the in-memory store (unit introspection for tests). */
export interface InMemoryStoreCounters {
  /** Units opened (committed + rolled back). */
  readonly opened: number;
  readonly committed: number;
  readonly rolledBack: number;
}

/** The in-memory DocumentsStore: deterministic, for tests and pure-domain use. */
export interface InMemoryDocumentsStore extends DocumentsStore {
  /** The executor every unit hands to the EventSink (assertable identity). */
  readonly executor: SqlExecutor;
  /** Every committed document, in commit order. */
  readonly documents: readonly DocumentState[];
  /** Every committed revision, in commit order. */
  readonly revisions: readonly DocumentRevisionState[];
  /** Every committed evidence reference, in commit order. */
  readonly evidenceReferences: readonly EvidenceReferenceState[];
  /** Unit counters (denied commands must open none). */
  readonly counters: InMemoryStoreCounters;
}

const duplicateIdFailure = (
  code: string,
  entityId: EntityId,
  scope: Scope,
  path: string,
): DomainError =>
  domainError(
    'invariant-violation',
    `canonical ${code} already exists: ${entityId}`,
    [{ code: `${code}-already-exists`, message: entityId, path }],
    { scope },
  );

const duplicateEvidenceFailure = (reference: EvidenceReferenceState): DomainError =>
  domainError(
    'invariant-violation',
    `evidence reference already exists: entity ${reference.evidencedEntityKind} ${reference.evidencedEntityId} is already pinned to revision ${reference.revisionId} of document ${reference.documentId}`,
    [
      {
        code: 'evidence-reference-already-exists',
        message: `${reference.evidencedEntityKind} ${reference.evidencedEntityId} -> ${reference.documentId} ${reference.revisionId}`,
        path: null,
      },
    ],
    { scope: reference.scope },
  );

const evidenceTargetKey = (
  entityKind: EntityKind,
  entityId: EntityId,
  documentId: EntityId,
  revisionId: EntityId,
): string => `${entityKind}\u0000${entityId}\u0000${documentId}\u0000${revisionId}`;

const entityKey = (entityKind: EntityKind, entityId: EntityId): string =>
  `${entityKind}\u0000${entityId}`;

/**
 * Create an in-memory DocumentsStore for deterministic tests (and any
 * pure-domain composition). Staged mutations commit atomically per unit;
 * reads are scope-guarded by the kernel's A12 coverage check.
 */
export function createInMemoryDocumentsStore(): InMemoryDocumentsStore {
  const documents = new Map<EntityId, DocumentState>();
  const revisions = new Map<EntityId, DocumentRevisionState>();
  const evidenceById = new Map<EntityId, EvidenceReferenceState>();
  const evidenceByTarget = new Map<string, EvidenceReferenceState>();
  const evidenceByEntity = new Map<string, EvidenceReferenceState[]>();
  const counters = { opened: 0, committed: 0, rolledBack: 0 };

  // The executor every unit hands to the EventSink. The in-memory sink only
  // records it; a real (ledger-backed) sink composed with THIS store would be
  // a wiring error — the executor fails loudly instead of silently writing.
  const executor: SqlExecutor = {
    query: async () => {
      throw new TypeError('the in-memory documents store executes no SQL');
    },
  };

  const indexEvidence = (reference: EvidenceReferenceState): void => {
    evidenceById.set(reference.entityId, reference);
    evidenceByTarget.set(
      evidenceTargetKey(
        reference.evidencedEntityKind,
        reference.evidencedEntityId,
        reference.documentId,
        reference.revisionId,
      ),
      reference,
    );
    const key = entityKey(reference.evidencedEntityKind, reference.evidencedEntityId);
    const existing = evidenceByEntity.get(key);
    if (existing === undefined) {
      evidenceByEntity.set(key, [reference]);
    } else {
      existing.push(reference);
    }
  };

  const documentVisibleTo = (scope: Scope, document: DocumentState): boolean =>
    checkScopeCovers(scope, document.scope).ok;

  const revisionVisibleTo = (scope: Scope, revision: DocumentRevisionState): boolean =>
    checkScopeCovers(scope, revision.scope).ok;

  const referenceVisibleTo = (scope: Scope, reference: EvidenceReferenceState): boolean =>
    checkScopeCovers(scope, reference.scope).ok;

  const findDocumentCommitted = (
    scope: Scope,
    documentId: EntityId,
  ): DocumentState | null => {
    const document = documents.get(documentId);
    if (document === undefined || !documentVisibleTo(scope, document)) return null;
    return document;
  };

  const findRevisionCommitted = (
    scope: Scope,
    documentId: EntityId,
    revisionId: EntityId,
  ): DocumentRevisionState | null => {
    const revision = revisions.get(revisionId);
    if (
      revision === undefined ||
      revision.documentId !== documentId ||
      !revisionVisibleTo(scope, revision)
    ) {
      return null;
    }
    return revision;
  };

  /** Build one unit of work over staged copies of the three row families. */
  const makeUnit = (): {
    readonly uow: DocumentsUnitOfWork;
    readonly commit: () => void;
  } => {
    const stagedDocuments = new Map<EntityId, DocumentState>();
    const stagedRevisions = new Map<EntityId, DocumentRevisionState>();
    const stagedEvidence = new Map<EntityId, EvidenceReferenceState>();

    const visibleDocument = (documentId: EntityId): DocumentState | null => {
      const staged = stagedDocuments.get(documentId);
      if (staged !== undefined) return staged;
      return documents.get(documentId) ?? null;
    };

    const visibleRevision = (revisionId: EntityId): DocumentRevisionState | null => {
      const staged = stagedRevisions.get(revisionId);
      if (staged !== undefined) return staged;
      return revisions.get(revisionId) ?? null;
    };

    const visibleEvidenceByTarget = (
      entityKind: EntityKind,
      entityId: EntityId,
      documentId: EntityId,
      revisionId: EntityId,
    ): EvidenceReferenceState | null => {
      for (const reference of stagedEvidence.values()) {
        if (
          reference.evidencedEntityKind === entityKind &&
          reference.evidencedEntityId === entityId &&
          reference.documentId === documentId &&
          reference.revisionId === revisionId
        ) {
          return reference;
        }
      }
      return (
        evidenceByTarget.get(
          evidenceTargetKey(entityKind, entityId, documentId, revisionId),
        ) ?? null
      );
    };

    const uow: DocumentsUnitOfWork = {
      executor,
      rollback: <T>(value: T): never => {
        throw new UnitRollbackSignal(value);
      },
      findDocumentById: async (scope, documentId) => {
        const document = visibleDocument(documentId);
        if (document === null || !documentVisibleTo(scope, document)) {
          return fail(
            entityNotFound({ entityKind: DOCUMENT_KIND, entityId: documentId }, { scope }),
          );
        }
        return ok(document);
      },
      findRevisionById: async (scope, documentId, revisionId) => {
        const revision = visibleRevision(revisionId);
        if (
          revision === null ||
          revision.documentId !== documentId ||
          !revisionVisibleTo(scope, revision)
        ) {
          return fail(
            entityNotFound({ entityKind: REVISION_KIND, entityId: revisionId }, { scope }),
          );
        }
        return ok(revision);
      },
      insertDocument: async (document) => {
        if (visibleDocument(document.entityId) !== null) {
          return fail(
            duplicateIdFailure('document-id', document.entityId, document.scope, 'documentId'),
          );
        }
        stagedDocuments.set(document.entityId, document);
        return ok(true);
      },
      saveDocument: async (expectedVersion, next) => {
        const current = visibleDocument(next.entityId);
        if (current === null) {
          return fail(
            entityNotFound({ entityKind: DOCUMENT_KIND, entityId: next.entityId }, {
              scope: next.scope,
            }),
          );
        }
        if (current.version !== expectedVersion) {
          return fail(
            concurrencyConflict(
              {
                entityKind: DOCUMENT_KIND,
                entityId: next.entityId,
                expectedVersion,
                actualVersion: current.version,
              },
              { scope: next.scope },
            ),
          );
        }
        stagedDocuments.set(next.entityId, next);
        return ok(next);
      },
      insertRevision: async (revision) => {
        if (visibleRevision(revision.entityId) !== null) {
          return fail(
            duplicateIdFailure('revision-id', revision.entityId, revision.scope, 'revisionId'),
          );
        }
        stagedRevisions.set(revision.entityId, revision);
        return ok(true);
      },
      insertEvidenceReference: async (reference) => {
        if (evidenceById.has(reference.entityId) || stagedEvidence.has(reference.entityId)) {
          return fail(
            duplicateIdFailure(
              'evidence-reference-id',
              reference.entityId,
              reference.scope,
              'evidenceReferenceId',
            ),
          );
        }
        const existing = visibleEvidenceByTarget(
          reference.evidencedEntityKind,
          reference.evidencedEntityId,
          reference.documentId,
          reference.revisionId,
        );
        if (existing !== null) {
          return fail(duplicateEvidenceFailure(reference));
        }
        stagedEvidence.set(reference.entityId, reference);
        return ok(true);
      },
    };

    const commit = (): void => {
      for (const [documentId, document] of stagedDocuments) {
        documents.set(documentId, document);
      }
      for (const [revisionId, revision] of stagedRevisions) {
        revisions.set(revisionId, revision);
      }
      for (const reference of stagedEvidence.values()) {
        indexEvidence(reference);
      }
    };

    return { uow, commit };
  };

  return {
    get executor(): SqlExecutor {
      return executor;
    },
    get documents(): readonly DocumentState[] {
      return [...documents.values()];
    },
    get revisions(): readonly DocumentRevisionState[] {
      return [...revisions.values()];
    },
    get evidenceReferences(): readonly EvidenceReferenceState[] {
      return [...evidenceById.values()];
    },
    get counters(): InMemoryStoreCounters {
      return { ...counters };
    },
    openUnitOfWork: async <T>(work: (uow: DocumentsUnitOfWork) => Promise<Result<T, DomainError>>) => {
      counters.opened += 1;
      const { uow, commit } = makeUnit();
      try {
        const result = await work(uow);
        commit();
        counters.committed += 1;
        return result;
      } catch (error) {
        counters.rolledBack += 1;
        if (error instanceof UnitRollbackSignal) {
          // The signal carries the work callback's own Result<T, DomainError>:
          // the staged mutations are discarded and that value is the unit's
          // result (same convention as TransactionRunner).
          return error.value as Result<T, DomainError>;
        }
        // Unexpected failure: the staged mutations are discarded and the
        // ORIGINAL error is rethrown — never masked.
        throw error;
      }
    },
    findDocumentById: async (scope, documentId) => {
      const document = findDocumentCommitted(scope, documentId);
      if (document === null) {
        return fail(
          entityNotFound({ entityKind: DOCUMENT_KIND, entityId: documentId }, { scope }),
        );
      }
      return ok(document);
    },
    findRevisionById: async (scope, documentId, revisionId) => {
      const revision = findRevisionCommitted(scope, documentId, revisionId);
      if (revision === null) {
        return fail(
          entityNotFound({ entityKind: REVISION_KIND, entityId: revisionId }, { scope }),
        );
      }
      return ok(revision);
    },
    revisionChainOf: async (scope, documentId) => {
      const document = findDocumentCommitted(scope, documentId);
      if (document === null) {
        return fail(
          entityNotFound({ entityKind: DOCUMENT_KIND, entityId: documentId }, { scope }),
        );
      }
      // Walk the forward supersession links backwards from the current head;
      // the walk length is bounded by the revision count, so a corrupt
      // (cyclic) chain fails loudly instead of looping.
      const chain: DocumentRevisionState[] = [];
      let cursor: EntityId | null = document.currentRevisionId;
      while (cursor !== null) {
        const revision = revisions.get(cursor);
        if (revision === undefined) {
          throw new TypeError(
            `revision chain corruption: document ${documentId} head references missing revision ${cursor}`,
          );
        }
        chain.push(revision);
        cursor = revision.supersedes;
        if (chain.length > revisions.size) {
          throw new TypeError(
            `revision chain corruption: document ${documentId} supersession links form a cycle`,
          );
        }
      }
      return ok(chain.reverse());
    },
    findEvidenceReferenceByTarget: async (scope, evidenced, documentId, revisionId) => {
      const reference = evidenceByTarget.get(
        evidenceTargetKey(
          evidenced.entityKind,
          evidenced.entityId,
          documentId,
          revisionId,
        ),
      );
      if (reference === undefined || !referenceVisibleTo(scope, reference)) {
        return fail(
          entityNotFound(
            {
              entityKind: EVIDENCE_REFERENCE_KIND,
              // No canonical id exists for a missing pin; the evidenced
              // entity's id names the query that found nothing.
              entityId: evidenced.entityId,
            },
            { scope },
          ),
        );
      }
      return ok(reference);
    },
    listEvidenceReferencesOfEntity: async (scope, entityKind, entityId) => {
      const references = evidenceByEntity.get(entityKey(entityKind, entityId)) ?? [];
      return ok(references.filter((reference) => referenceVisibleTo(scope, reference)));
    },
  };
}
