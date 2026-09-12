import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  parseEntityKind,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { ParseResult, ProjectId, TenantId } from '@office/contracts';
import { domainError, fail, ok, parseAggregateVersion } from '@office/domain-kernel';
import { formatStorageKey, parseRevisionHash } from './storage';
import type { RevisionHash } from './storage';
import {
  createDocumentRevisionState,
  createDocumentState,
  createEvidenceReferenceState,
} from './state';
import type { DocumentRevisionState, DocumentState } from './state';
import { createInMemoryDocumentsStore } from './store';
import type {
  DocumentsUnitOfWork,
  InMemoryDocumentsStore,
} from './store';

// OFF-008 documents domain — the in-memory documents store: unit-of-work
// semantics (commit/rollback/throw), A12 scope-guarded reads (typed
// not-found for foreign tenants/projects), create-only guards for revisions
// and evidence references, and optimistic-concurrency CAS on documents.
// Pure unit tests: fixed everything, no I/O.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B = unwrap(parseTenantId('office-tnt-v1-b0b1b2b3b4b5b6b7b8b9babbbcbdbeb0'));
const PROJECT_P1 = formatProjectId({
  version: 'v1',
  opaque: '1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f',
});
const PROJECT_P2 = formatProjectId({
  version: 'v1',
  opaque: '2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a',
});
const NOW = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

const DOCUMENT_ID = formatEntityId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const REVISION_1_ID = formatEntityId({
  version: 'v1',
  opaque: '2b3c4d5e6f708192a3b4c5d6e7f8a9b1',
});
const REVISION_2_ID = formatEntityId({
  version: 'v1',
  opaque: '3c4d5e6f708192a3b4c5d6e7f8a9b2c3',
});
const EVIDENCE_ID = formatEntityId({
  version: 'v1',
  opaque: '4d5e6f708192a3b4c5d6e7f8a9b3c4d5',
});
const EVIDENCE_ID_2 = formatEntityId({
  version: 'v1',
  opaque: '7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3',
});
const EVIDENCE_ID_3 = formatEntityId({
  version: 'v1',
  opaque: '8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4',
});
const TASK_ID = formatEntityId({
  version: 'v1',
  opaque: '5e6f708192a3b4c5d6e7f8a9b3c4d5e6',
});
const ISSUE_ID = formatEntityId({
  version: 'v1',
  opaque: '6f708192a3b4c5d6e7f8a9b3c4d5e6f7',
});

const HASH_1 = unwrap(parseRevisionHash('a'.repeat(64))) as RevisionHash;
const HASH_2 = unwrap(parseRevisionHash('b'.repeat(64))) as RevisionHash;

const TASK_KIND = unwrap(parseEntityKind('task'));

const VERSION_1 = unwrap(parseAggregateVersion(1));
const VERSION_2 = unwrap(parseAggregateVersion(2));
const VERSION_3 = unwrap(parseAggregateVersion(3));

const projectScope = (tenantId: TenantId, projectId: ProjectId) => ({
  kind: 'project' as const,
  tenantId,
  projectId,
});

const tenantScope = (tenantId: TenantId) => ({ kind: 'tenant' as const, tenantId });

const makeDocument = (
  overrides?: { readonly tenantId?: TenantId; readonly projectId?: ProjectId },
): DocumentState => {
  const result = createDocumentState(
    { documentId: DOCUMENT_ID, title: 'Structural drawings', now: NOW },
    projectScope(overrides?.tenantId ?? TENANT_A, overrides?.projectId ?? PROJECT_P1),
  );
  if (!result.ok) throw new Error('document construction failed');
  return result.value;
};

const makeRevision = (overrides?: {
  readonly revisionId?: typeof REVISION_1_ID;
  readonly supersedes?: typeof REVISION_1_ID | null;
}): DocumentRevisionState => {
  const hash = overrides?.supersedes ? HASH_2 : HASH_1;
  const result = createDocumentRevisionState({
    revisionId: overrides?.revisionId ?? REVISION_1_ID,
    documentId: DOCUMENT_ID,
    scope: projectScope(TENANT_A, PROJECT_P1),
    supersedes: overrides?.supersedes ?? null,
    contentHash: hash,
    storageKey: formatStorageKey({ tenantId: TENANT_A, projectId: PROJECT_P1, hash }),
    byteSize: 64,
    now: NOW,
  });
  if (!result.ok) throw new Error('revision construction failed');
  return result.value;
};

const makeEvidence = (overrides?: {
  readonly evidenceReferenceId?: typeof EVIDENCE_ID;
  readonly evidencedEntityKind?: string;
  readonly evidencedEntityId?: typeof TASK_ID;
  readonly revisionId?: typeof REVISION_1_ID;
}) => {
  const evidencedEntityKind = unwrap(
    parseEntityKind(overrides?.evidencedEntityKind ?? 'task'),
  );
  const result = createEvidenceReferenceState({
    evidenceReferenceId: overrides?.evidenceReferenceId ?? EVIDENCE_ID,
    scope: projectScope(TENANT_A, PROJECT_P1),
    documentId: DOCUMENT_ID,
    revisionId: overrides?.revisionId ?? REVISION_1_ID,
    evidencedEntityKind,
    evidencedEntityId: overrides?.evidencedEntityId ?? TASK_ID,
    now: NOW,
  });
  if (!result.ok) throw new Error('evidence construction failed');
  return result.value;
};

/** Insert one document + its root revision (committed) and return the store. */
const seededStore = async (): Promise<InMemoryDocumentsStore> => {
  const store = createInMemoryDocumentsStore();
  const result = await store.openUnitOfWork(async (uow) => {
    const inserted = await uow.insertDocument(makeDocument());
    if (!inserted.ok) return inserted;
    const revision = await uow.insertRevision(makeRevision());
    if (!revision.ok) return revision;
    return ok(true);
  });
  if (!result.ok) throw new Error('seeding failed');
  return store;
};

describe('unit-of-work semantics', () => {
  it('commits staged mutations when the work resolves successfully', async () => {
    const store = createInMemoryDocumentsStore();
    const result = await store.openUnitOfWork(async (uow) => {
      const inserted = await uow.insertDocument(makeDocument());
      if (!inserted.ok) return inserted;
      return ok(true);
    });
    expect(result.ok).toBe(true);
    expect(store.documents).toHaveLength(1);
    expect(store.counters).toStrictEqual({ opened: 1, committed: 1, rolledBack: 0 });
  });

  it('discards staged mutations on rollback(value) and returns the value', async () => {
    const store = createInMemoryDocumentsStore();
    const rolledBackError = domainError(
      'invariant-violation',
      'rolled back by the test',
      [],
    );
    const result = await store.openUnitOfWork(async (uow) => {
      const inserted = await uow.insertDocument(makeDocument());
      if (!inserted.ok) return inserted;
      // Roll back with a failure-shaped value: everything staged above is
      // discarded and the value becomes the unit's result.
      return uow.rollback(fail(rolledBackError));
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toStrictEqual(rolledBackError);
    expect(store.documents).toHaveLength(0);
    expect(store.counters).toStrictEqual({ opened: 1, committed: 0, rolledBack: 1 });
  });

  it('discards staged mutations and rethrows when the work throws', async () => {
    const store = createInMemoryDocumentsStore();
    await expect(
      store.openUnitOfWork(async (uow) => {
        await uow.insertDocument(makeDocument());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.documents).toHaveLength(0);
    expect(store.counters).toStrictEqual({ opened: 1, committed: 0, rolledBack: 1 });
  });

  it('reads inside a unit see the staged state', async () => {
    const store = createInMemoryDocumentsStore();
    const result = await store.openUnitOfWork(async (uow) => {
      await uow.insertDocument(makeDocument());
      const visible = await uow.findDocumentById(tenantScope(TENANT_A), DOCUMENT_ID);
      expect(visible.ok).toBe(true);
      return ok(true);
    });
    expect(result.ok).toBe(true);
    expect(store.documents).toHaveLength(1);
  });
});

describe('A12 scope-guarded reads (no existence oracle)', () => {
  it('hides a foreign tenant document behind a typed not-found', async () => {
    const store = await seededStore();
    const foreign = await store.findDocumentById(tenantScope(TENANT_B), DOCUMENT_ID);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(foreign.error.scope).toStrictEqual(tenantScope(TENANT_B));
    }
    // The store itself holds the row — invisibility, not absence.
    expect(store.documents).toHaveLength(1);
  });

  it('hides a same-tenant foreign-project document from a project-scoped read', async () => {
    const store = await seededStore();
    const foreign = await store.findDocumentById(
      projectScope(TENANT_A, PROJECT_P2),
      DOCUMENT_ID,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('not-found');
  });

  it('shows the document to tenant scope and to its own project scope', async () => {
    const store = await seededStore();
    expect((await store.findDocumentById(tenantScope(TENANT_A), DOCUMENT_ID)).ok).toBe(true);
    expect(
      (await store.findDocumentById(projectScope(TENANT_A, PROJECT_P1), DOCUMENT_ID)).ok,
    ).toBe(true);
  });

  it('revision reads enforce the document binding and the scope', async () => {
    const store = await seededStore();
    expect(
      (await store.findRevisionById(tenantScope(TENANT_A), DOCUMENT_ID, REVISION_1_ID)).ok,
    ).toBe(true);
    // Wrong document id: the revision is not there.
    expect(
      (await store.findRevisionById(tenantScope(TENANT_A), TASK_ID, REVISION_1_ID)).ok,
    ).toBe(false);
    // Foreign tenant: invisible.
    expect(
      (await store.findRevisionById(tenantScope(TENANT_B), DOCUMENT_ID, REVISION_1_ID)).ok,
    ).toBe(false);
  });
});

describe('create-only guards (immutability)', () => {
  it('rejects a duplicate document id with a typed conflict naming the id', async () => {
    const store = createInMemoryDocumentsStore();
    const first = await store.openUnitOfWork(async (uow) => {
      const inserted = await uow.insertDocument(makeDocument());
      if (!inserted.ok) return inserted;
      return ok(true);
    });
    if (!first.ok) throw new Error('first insert failed');
    const second = await store.openUnitOfWork((uow) => uow.insertDocument(makeDocument()));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('document-id-already-exists');
      expect(second.error.details[0]?.message).toBe(DOCUMENT_ID);
    }
    expect(store.documents).toHaveLength(1);
  });

  it('rejects a duplicate revision id with a typed conflict naming the id', async () => {
    const store = await seededStore();
    const second = await store.openUnitOfWork((uow) => uow.insertRevision(makeRevision()));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('revision-id-already-exists');
      expect(second.error.details[0]?.message).toBe(REVISION_1_ID);
    }
    expect(store.revisions).toHaveLength(1);
  });

  it('rejects a duplicate evidence natural key (same entity pinned to the same revision)', async () => {
    const store = await seededStore();
    const first = await store.openUnitOfWork(async (uow) => {
      const inserted = await uow.insertEvidenceReference(makeEvidence());
      if (!inserted.ok) return inserted;
      return ok(true);
    });
    if (!first.ok) throw new Error('first evidence insert failed');
    // Same (task, document, revision) triple with a FRESH evidence id:
    // still the same pin — immutability is keyed by the natural triple.
    const second = await store.openUnitOfWork((uow) =>
      uow.insertEvidenceReference(makeEvidence({ evidenceReferenceId: REVISION_2_ID })),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('evidence-reference-already-exists');
    }
    expect(store.evidenceReferences).toHaveLength(1);
  });

  it('accepts a different entity pinned to the same revision, and the same entity on a different revision', async () => {
    const store = await seededStore();
    const result = await store.openUnitOfWork(async (uow) => {
      const successor = await uow.insertRevision(
        makeRevision({ revisionId: REVISION_2_ID, supersedes: REVISION_1_ID }),
      );
      if (!successor.ok) return successor;
      const taskPin = await uow.insertEvidenceReference(makeEvidence());
      if (!taskPin.ok) return taskPin;
      // Different entity, same revision:
      const issuePin = await uow.insertEvidenceReference(
        makeEvidence({
          evidenceReferenceId: EVIDENCE_ID_2,
          evidencedEntityKind: 'issue',
          evidencedEntityId: ISSUE_ID,
        }),
      );
      if (!issuePin.ok) return issuePin;
      // Same entity, different revision:
      const taskOnR2 = await uow.insertEvidenceReference(
        makeEvidence({ evidenceReferenceId: EVIDENCE_ID_3, revisionId: REVISION_2_ID }),
      );
      if (!taskOnR2.ok) return taskOnR2;
      return ok(true);
    });
    if (!result.ok) throw new Error('evidence inserts failed');
    expect(store.evidenceReferences).toHaveLength(3);
  });

  it('ships no mutation or deletion path for revisions and evidence (structural immutability)', () => {
    const store = createInMemoryDocumentsStore();
    const forbidden = [
      'updateRevision',
      'deleteRevision',
      'saveRevision',
      'updateEvidenceReference',
      'deleteEvidenceReference',
      'repointEvidenceReference',
    ];
    for (const method of forbidden) {
      expect(Object.keys(store), `store must not expose ${method}`).not.toContain(method);
    }
  });
});

describe('optimistic concurrency on document saves', () => {
  it('saves the next document state when the expected version matches', async () => {
    const store = await seededStore();
    const next: DocumentState = { ...makeDocument(), version: VERSION_2, title: 'v2' };
    const saved = await store.openUnitOfWork((uow) => uow.saveDocument(VERSION_1, next));
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.version).toBe(2);
    expect(store.documents[0]?.title).toBe('v2');
  });

  it('rejects a stale expected version with a typed concurrency-conflict', async () => {
    const store = await seededStore();
    const next: DocumentState = { ...makeDocument(), version: VERSION_3 };
    const saved = await store.openUnitOfWork((uow) => uow.saveDocument(VERSION_2, next));
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe('concurrency-conflict');
      expect(saved.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    expect(store.documents[0]?.version).toBe(1);
  });

  it('rejects saving a document that does not exist (typed not-found)', async () => {
    const store = createInMemoryDocumentsStore();
    const saved = await store.openUnitOfWork((uow) =>
      uow.saveDocument(VERSION_1, { ...makeDocument(), entityId: TASK_ID }),
    );
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.error.code).toBe('not-found');
  });
});

describe('revision chain reads', () => {
  it('reads the full chain oldest-first across explicit supersessions', async () => {
    const store = await seededStore();
    // The head pointer is part of the committed document state: advance it
    // exactly as the attach/supersede transitions do (R1 attached, then R2
    // superseding R1), each save guarded by optimistic concurrency.
    const result = await store.openUnitOfWork(async (uow) => {
      const withRoot = await uow.saveDocument(VERSION_1, {
        ...makeDocument(),
        currentRevisionId: REVISION_1_ID,
        version: VERSION_2,
      });
      if (!withRoot.ok) return withRoot;
      const successor = await uow.insertRevision(
        makeRevision({ revisionId: REVISION_2_ID, supersedes: REVISION_1_ID }),
      );
      if (!successor.ok) return successor;
      const withSuccessor = await uow.saveDocument(VERSION_2, {
        ...withRoot.value,
        currentRevisionId: REVISION_2_ID,
        version: VERSION_3,
      });
      if (!withSuccessor.ok) return withSuccessor;
      return ok(true);
    });
    if (!result.ok) throw new Error('successor insert failed');
    const chain = await store.revisionChainOf(tenantScope(TENANT_A), DOCUMENT_ID);
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.value.map((revision) => revision.entityId)).toStrictEqual([
        REVISION_1_ID,
        REVISION_2_ID,
      ]);
    }
  });

  it('revision chain reads are scope-guarded (typed not-found for foreign tenants)', async () => {
    const store = await seededStore();
    const chain = await store.revisionChainOf(tenantScope(TENANT_B), DOCUMENT_ID);
    expect(chain.ok).toBe(false);
    if (!chain.ok) expect(chain.error.code).toBe('not-found');
  });
});

describe('evidence reference queries', () => {
  it('finds a reference by target and lists an entity evidence trail in creation order', async () => {
    const store = await seededStore();
    const result = await store.openUnitOfWork(async (uow) => {
      const successor = await uow.insertRevision(
        makeRevision({ revisionId: REVISION_2_ID, supersedes: REVISION_1_ID }),
      );
      if (!successor.ok) return successor;
      const taskPin = await uow.insertEvidenceReference(
        makeEvidence({ revisionId: REVISION_1_ID }),
      );
      if (!taskPin.ok) return taskPin;
      const issuePin = await uow.insertEvidenceReference(
        makeEvidence({
          evidenceReferenceId: EVIDENCE_ID_2,
          revisionId: REVISION_2_ID,
          evidencedEntityKind: 'issue',
          evidencedEntityId: ISSUE_ID,
        }),
      );
      if (!issuePin.ok) return issuePin;
      return ok(true);
    });
    if (!result.ok) throw new Error('seeding evidence failed');

    const byTarget = await store.findEvidenceReferenceByTarget(
      tenantScope(TENANT_A),
      { entityKind: TASK_KIND, entityId: TASK_ID },
      DOCUMENT_ID,
      REVISION_1_ID,
    );
    expect(byTarget.ok).toBe(true);
    if (byTarget.ok) expect(byTarget.value.revisionId).toBe(REVISION_1_ID);

    const missing = await store.findEvidenceReferenceByTarget(
      tenantScope(TENANT_A),
      { entityKind: TASK_KIND, entityId: TASK_ID },
      DOCUMENT_ID,
      REVISION_2_ID,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');

    const trail = await store.listEvidenceReferencesOfEntity(
      projectScope(TENANT_A, PROJECT_P1),
      TASK_KIND,
      TASK_ID,
    );
    expect(trail.ok).toBe(true);
    if (trail.ok) expect(trail.value).toHaveLength(1);

    // Foreign tenant sees nothing.
    const foreignTrail = await store.listEvidenceReferencesOfEntity(
      tenantScope(TENANT_B),
      TASK_KIND,
      TASK_ID,
    );
    expect(foreignTrail.ok).toBe(true);
    if (foreignTrail.ok) expect(foreignTrail.value).toHaveLength(0);
  });
});

describe('the store executor (the EventSink transactional seat)', () => {
  it('exposes one stable executor identity and executes no SQL', async () => {
    const store = createInMemoryDocumentsStore();
    let captured: DocumentsUnitOfWork | undefined;
    await store.openUnitOfWork(async (uow) => {
      captured = uow;
      return ok(true);
    });
    expect(captured?.executor).toBe(store.executor);
    await expect(store.executor.query('SELECT 1')).rejects.toThrow(TypeError);
  });
});
