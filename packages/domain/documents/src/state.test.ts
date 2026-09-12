import { describe, expect, it } from 'vitest';
import {
  parseTenantId,
  parseTimestamp,
  formatEntityId,
  parseProjectId,
  parseEntityKind,
} from '@office/contracts';
import type { ParseResult, ProjectId, TenantId } from '@office/contracts';
import { formatStorageKey, parseRevisionHash } from './storage';
import type { RevisionHash } from './storage';
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
import type { DocumentRevisionState, DocumentState } from './state';

// OFF-008 documents domain — aggregate states, invariants, and pure
// transitions. Pure unit tests: fixed everything, no I/O.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_P1 = unwrap(
  parseProjectId('office-prj-v1-1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f'),
);
const NOW = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const LATER = unwrap(parseTimestamp('2026-09-13T08:00:00.000Z'));

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
const TASK_ID = formatEntityId({
  version: 'v1',
  opaque: '5e6f708192a3b4c5d6e7f8a9b3c4d5e6',
});
const TASK_KIND = unwrap(parseEntityKind('task'));

const HASH_1 = unwrap(parseRevisionHash('a'.repeat(64))) as RevisionHash;
const HASH_2 = unwrap(parseRevisionHash('b'.repeat(64))) as RevisionHash;
const STORAGE_KEY_1 = formatStorageKey({
  tenantId: TENANT_A,
  projectId: PROJECT_P1,
  hash: HASH_1,
});
const STORAGE_KEY_2 = formatStorageKey({
  tenantId: TENANT_A,
  projectId: PROJECT_P1,
  hash: HASH_2,
});

const projectScope = (
  tenantId: TenantId,
  projectId: ProjectId,
): { kind: 'project'; tenantId: TenantId; projectId: ProjectId } => ({
  kind: 'project',
  tenantId,
  projectId,
});

const makeDocument = (): DocumentState => {
  const result = createDocumentState(
    { documentId: DOCUMENT_ID, title: 'Structural drawings', now: NOW },
    projectScope(TENANT_A, PROJECT_P1),
  );
  if (!result.ok) throw new Error('document construction failed');
  return result.value;
};

const makeRevision = (overrides?: {
  readonly revisionId?: typeof REVISION_1_ID;
  readonly supersedes?: typeof REVISION_1_ID | null;
  readonly contentHash?: RevisionHash;
}): DocumentRevisionState => {
  const result = createDocumentRevisionState({
    revisionId: overrides?.revisionId ?? REVISION_1_ID,
    documentId: DOCUMENT_ID,
    scope: projectScope(TENANT_A, PROJECT_P1),
    supersedes: overrides?.supersedes ?? null,
    contentHash: overrides?.contentHash ?? HASH_1,
    storageKey:
      overrides?.contentHash === undefined || overrides.contentHash === HASH_1
        ? STORAGE_KEY_1
        : STORAGE_KEY_2,
    byteSize: 128,
    now: NOW,
  });
  if (!result.ok) throw new Error('revision construction failed');
  return result.value;
};

describe('entity kind vocabulary', () => {
  it('declares the documents-domain entity kinds', () => {
    expect(DOCUMENT_KIND).toBe('document');
    expect(REVISION_KIND).toBe('document-revision');
    expect(EVIDENCE_REFERENCE_KIND).toBe('evidence-reference');
  });
});

describe('document state', () => {
  it('creates an active project-scoped document with no revision yet', () => {
    const document = makeDocument();
    expect(document.entityKind).toBe(DOCUMENT_KIND);
    expect(document.entityId).toBe(DOCUMENT_ID);
    expect(document.scope).toStrictEqual(projectScope(TENANT_A, PROJECT_P1));
    expect(document.version).toBe(1);
    expect(document.title).toBe('Structural drawings');
    expect(document.status).toBe('active');
    expect(document.archivedAt).toBeNull();
    expect(document.currentRevisionId).toBeNull();
    expect(document.createdAt).toBe(NOW);
    expect(document.extensionMetadata).toStrictEqual({});
  });

  it('rejects an empty title through the invariant layer', () => {
    const result = createDocumentState(
      { documentId: DOCUMENT_ID, title: '', now: NOW },
      projectScope(TENANT_A, PROJECT_P1),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('document-title-nonempty');
    }
  });

  it('archives an active document as the one-way lifecycle transition', () => {
    const result = archiveDocumentState(makeDocument(), LATER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('archived');
      expect(result.value.archivedAt).toBe(LATER);
      expect(result.value.version).toBe(2);
      expect(result.value.updatedAt).toBe(LATER);
    }
  });

  it('refuses to archive an already archived document (typed failure)', () => {
    const archived = archiveDocumentState(makeDocument(), LATER);
    if (!archived.ok) throw new Error('first archive failed');
    const second = archiveDocumentState(archived.value, LATER);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('document-archive-requires-active');
    }
  });
});

describe('revision state', () => {
  it('creates the chain root revision (immutable row of record)', () => {
    const revision = makeRevision();
    expect(revision.entityKind).toBe(REVISION_KIND);
    expect(revision.entityId).toBe(REVISION_1_ID);
    expect(revision.documentId).toBe(DOCUMENT_ID);
    expect(revision.supersedes).toBeNull();
    expect(revision.contentHash).toBe(HASH_1);
    expect(revision.storageKey).toBe(STORAGE_KEY_1);
    expect(revision.byteSize).toBe(128);
    expect(revision.version).toBe(1);
  });

  it('rejects a revision that supersedes itself (typed failure)', () => {
    const result = createDocumentRevisionState({
      revisionId: REVISION_1_ID,
      documentId: DOCUMENT_ID,
      scope: projectScope(TENANT_A, PROJECT_P1),
      supersedes: REVISION_1_ID,
      contentHash: HASH_1,
      storageKey: STORAGE_KEY_1,
      byteSize: 128,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('revision-supersedes-canonical-or-root');
    }
  });

  it('rejects a tenant-scoped revision (documents own project scope)', () => {
    const result = createDocumentRevisionState({
      revisionId: REVISION_1_ID,
      documentId: DOCUMENT_ID,
      scope: { kind: 'tenant', tenantId: TENANT_A },
      supersedes: null,
      contentHash: HASH_1,
      storageKey: STORAGE_KEY_1,
      byteSize: 128,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('revision-is-project-scoped');
    }
  });

  it('rejects a non-hex content hash through the invariant layer (typed failure)', () => {
    const badHash = 'NOT-A-HEX-HASH-AT-ALL' as unknown as RevisionHash;
    const result = createDocumentRevisionState({
      revisionId: REVISION_1_ID,
      documentId: DOCUMENT_ID,
      scope: projectScope(TENANT_A, PROJECT_P1),
      supersedes: null,
      contentHash: badHash,
      storageKey: STORAGE_KEY_1,
      byteSize: 128,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('revision-content-hash-is-canonical');
    }
  });
});

describe('attach transition (the chain root)', () => {
  it('moves the document head to the attached revision and bumps the version', () => {
    const document = makeDocument();
    const revision = makeRevision();
    const result = attachRevisionState(document, revision, LATER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.currentRevisionId).toBe(REVISION_1_ID);
      expect(result.value.version).toBe(2);
      expect(result.value.updatedAt).toBe(LATER);
      expect(result.value.status).toBe('active');
    }
  });

  it('refuses a second root (typed failure — later content must supersede)', () => {
    const document = makeDocument();
    const revision = makeRevision();
    const attached = attachRevisionState(document, revision, LATER);
    if (!attached.ok) throw new Error('attach failed');
    const anotherRoot = makeRevision({ revisionId: REVISION_2_ID });
    const second = attachRevisionState(attached.value, anotherRoot, LATER);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('document-attach-requires-empty-chain');
    }
  });

  it('refuses to attach to an archived document (typed failure)', () => {
    const archived = archiveDocumentState(makeDocument(), LATER);
    if (!archived.ok) throw new Error('archive failed');
    const result = attachRevisionState(archived.value, makeRevision(), LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('document-attach-requires-active');
    }
  });

  it('refuses a revision belonging to another document (typed failure)', () => {
    const result = attachRevisionState(makeDocument(), makeRevision(), LATER);
    // sanity: the happy path works; now prove the guard with a foreign document id
    expect(result.ok).toBe(true);
    const foreignRevision = createDocumentRevisionState({
      revisionId: REVISION_2_ID,
      documentId: TASK_ID,
      scope: projectScope(TENANT_A, PROJECT_P1),
      supersedes: null,
      contentHash: HASH_1,
      storageKey: STORAGE_KEY_1,
      byteSize: 128,
      now: NOW,
    });
    if (!foreignRevision.ok) throw new Error('foreign revision construction failed');
    const second = attachRevisionState(makeDocument(), foreignRevision.value, LATER);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('document-attach-revision-belongs-to-document');
    }
  });
});

describe('supersede transition (explicit forward links)', () => {
  const documentWithRoot = (): DocumentState => {
    const attached = attachRevisionState(makeDocument(), makeRevision(), LATER);
    if (!attached.ok) throw new Error('attach failed');
    return attached.value;
  };

  it('appends a successor that supersedes the current head', () => {
    const successor = makeRevision({
      revisionId: REVISION_2_ID,
      supersedes: REVISION_1_ID,
      contentHash: HASH_2,
    });
    const result = supersedeRevisionState(documentWithRoot(), successor, LATER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.currentRevisionId).toBe(REVISION_2_ID);
      expect(result.value.version).toBe(3);
    }
  });

  it('refuses a successor without a forward link (typed failure)', () => {
    const root = makeRevision();
    const result = supersedeRevisionState(documentWithRoot(), root, LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('document-supersede-revision-carries-forward-link');
    }
  });

  it('refuses superseding an already-superseded revision (chains are linear)', () => {
    const successor = makeRevision({
      revisionId: REVISION_2_ID,
      supersedes: REVISION_1_ID,
      contentHash: HASH_2,
    });
    const superseded = supersedeRevisionState(documentWithRoot(), successor, LATER);
    if (!superseded.ok) throw new Error('first supersede failed');
    // A second revision also claiming to supersede R1 (the OLD head, no
    // longer current) is a typed invariant failure — no branching.
    const branch = makeRevision({
      revisionId: EVIDENCE_ID,
      supersedes: REVISION_1_ID,
      contentHash: HASH_1,
    });
    const second = supersedeRevisionState(superseded.value, branch, LATER);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('document-supersede-requires-current-head');
    }
  });

  it('refuses superseding when the document has no revision yet (typed failure)', () => {
    const successor = makeRevision({
      revisionId: REVISION_2_ID,
      supersedes: REVISION_1_ID,
      contentHash: HASH_2,
    });
    const result = supersedeRevisionState(makeDocument(), successor, LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('document-supersede-requires-existing-chain');
    }
  });
});

describe('evidence reference state', () => {
  it('creates an immutable pin of (entity, document, revision)', () => {
    const result = createEvidenceReferenceState({
      evidenceReferenceId: EVIDENCE_ID,
      scope: projectScope(TENANT_A, PROJECT_P1),
      documentId: DOCUMENT_ID,
      revisionId: REVISION_1_ID,
      evidencedEntityKind: TASK_KIND,
      evidencedEntityId: TASK_ID,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entityKind).toBe(EVIDENCE_REFERENCE_KIND);
      expect(result.value.entityId).toBe(EVIDENCE_ID);
      expect(result.value.documentId).toBe(DOCUMENT_ID);
      expect(result.value.revisionId).toBe(REVISION_1_ID);
      expect(result.value.evidencedEntityKind).toBe('task');
      expect(result.value.evidencedEntityId).toBe(TASK_ID);
      expect(result.value.version).toBe(1);
    }
  });

  it('rejects a tenant-scoped evidence reference (typed failure)', () => {
    const result = createEvidenceReferenceState({
      evidenceReferenceId: EVIDENCE_ID,
      scope: { kind: 'tenant', tenantId: TENANT_A },
      documentId: DOCUMENT_ID,
      revisionId: REVISION_1_ID,
      evidencedEntityKind: TASK_KIND,
      evidencedEntityId: TASK_ID,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('evidence-reference-is-project-scoped');
    }
  });
});
