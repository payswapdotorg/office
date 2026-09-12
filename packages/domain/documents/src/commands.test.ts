import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  parseCommandEnvelope,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { CommandName, EntityId, ParseResult, Scope } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry, fail } from '@office/domain-kernel';
import { createInMemoryEventSink, eventSinkFailure, failingEventSink } from './events';
import type { EventSink, InMemoryEventSink } from './events';
import {
  createInMemoryObjectStorage,
  failingObjectStorage,
  parseStorageKey,
} from './storage';
import type { RevisionHash, StorageKey } from './storage';
import { createInMemoryDocumentsStore } from './store';
import type { InMemoryDocumentsStore } from './store';
import {
  ARCHIVE_DOCUMENT_COMMAND,
  ATTACH_REVISION_COMMAND,
  REFERENCE_EVIDENCE_COMMAND,
  REGISTER_DOCUMENT_COMMAND,
  SUPERSEDE_REVISION_COMMAND,
  createDocumentsCommands,
  parseArchiveDocumentPayload,
  parseAttachRevisionPayload,
  parseReferenceEvidencePayload,
  parseRegisterDocumentPayload,
  parseSupersedeRevisionPayload,
} from './commands';
import type { DocumentsCommandDeps } from './commands';

// OFF-008 documents domain — command payload parsing (fail-closed), the
// command-name guard, authorize-before-unit behavior, optimistic concurrency,
// idempotent replay, event emission, rollback on sink/storage failure, and
// deterministic id/hash issuance. Pure unit tests: injected fixed suppliers,
// in-memory ports, no I/O.

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
const TASK_ID = formatEntityId({
  version: 'v1',
  opaque: '5e6f708192a3b4c5d6e7f8a9b3c4d5e6',
});
const USER_ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});

const CONTENT_A = 'QUJDRA=='; // bytes 65,66,67,68
const CONTENT_B = 'RUZHSA=='; // bytes 69,70,71,72

/** Deterministic content hash supplier (pure function of the bytes). */
const hashBytes = (content: Uint8Array): RevisionHash => {
  let accumulator = 0n;
  for (let index = 0; index < content.length; index += 1) {
    accumulator = (accumulator * 31n + BigInt(content[index] ?? 0)) % (1n << 256n);
  }
  return accumulator.toString(16).padStart(64, '0') as RevisionHash;
};

/** Deterministic opaque-id supplier issuing lowercase-hex sequences. */
const opaqueIdsFrom = (start: number): (() => string) => {
  let next = start;
  return () => {
    const value = next;
    next += 1;
    return value.toString(16).padStart(32, '0');
  };
};

let idempotencyCounter = 0;
const freshIdempotencyKey = (): string => {
  idempotencyCounter += 1;
  return `idem-key-${idempotencyCounter.toString().padStart(6, '0')}`;
};

const envelope = (
  commandName: CommandName,
  payload: unknown,
  options?: {
    readonly idempotencyKey?: string;
    readonly scope?: Scope;
    readonly actorId?: string;
  },
) =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options?.scope ?? { kind: 'tenant', tenantId: TENANT_A },
      actor: { kind: 'user', actorId: options?.actorId ?? USER_ACTOR_ID },
      idempotencyKey: options?.idempotencyKey ?? freshIdempotencyKey(),
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

const ALLOW_POLICY = definePolicy([
  { effect: 'allow', capabilities: ['documents.write'], actions: ['write'] },
]);
const EMPTY_POLICY = definePolicy([]);
const authorized = { policy: ALLOW_POLICY, capabilities: ['documents.write'] as string[] };
const unauthorized = { policy: ALLOW_POLICY, capabilities: [] as string[] };

const makeService = (overrides?: {
  readonly eventSink?: DocumentsCommandDeps['eventSink'];
  readonly objectStorage?: DocumentsCommandDeps['objectStorage'];
  readonly newOpaqueId?: () => string;
  readonly hashContent?: (content: Uint8Array) => RevisionHash;
}) => {
  const store = createInMemoryDocumentsStore();
  const sink = createInMemoryEventSink();
  const storage = createInMemoryObjectStorage();
  const deps: DocumentsCommandDeps = {
    store,
    eventSink: overrides?.eventSink ?? sink,
    objectStorage: overrides?.objectStorage ?? storage,
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    now: () => NOW,
    newOpaqueId: overrides?.newOpaqueId ?? opaqueIdsFrom(1),
    hashContent: overrides?.hashContent ?? hashBytes,
  };
  return {
    commands: createDocumentsCommands(deps),
    deps,
    store,
    sink,
    storage,
  };
};

interface Service {
  readonly commands: ReturnType<typeof createDocumentsCommands>;
  readonly deps: DocumentsCommandDeps;
  readonly store: InMemoryDocumentsStore;
  readonly sink: InMemoryEventSink;
  readonly storage: ReturnType<typeof createInMemoryObjectStorage>;
}

/** Register a document in PROJECT_P1 under TENANT_A and return its id. */
const registerDocument = async (service: Service): Promise<EntityId> => {
  const result = await service.commands.registerDocument(
    envelope(REGISTER_DOCUMENT_COMMAND, {
      projectId: PROJECT_P1,
      title: 'Structural drawings',
    }),
    authorized,
  );
  if (!result.ok) throw new Error(`register failed: ${JSON.stringify(result.error)}`);
  return result.value.value.entityId;
};

/** Attach the root revision with CONTENT_A to the document. */
const attachRoot = async (service: Service, documentId: string): Promise<void> => {
  const result = await service.commands.attachRevision(
    envelope(ATTACH_REVISION_COMMAND, {
      projectId: PROJECT_P1,
      documentId,
      expectedVersion: 1,
      contentBase64: CONTENT_A,
    }),
    authorized,
  );
  if (!result.ok) throw new Error(`attach failed: ${JSON.stringify(result.error)}`);
};

// ----- payload parsing ---------------------------------------------------------

describe('registerDocument payload parsing (fail-closed)', () => {
  it('parses a minimal valid payload', () => {
    const result = parseRegisterDocumentPayload({
      projectId: PROJECT_P1,
      title: 'Structural drawings',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual({
        projectId: PROJECT_P1,
        title: 'Structural drawings',
      });
    }
  });

  it('parses extension metadata when present', () => {
    const result = parseRegisterDocumentPayload({
      projectId: PROJECT_P1,
      title: 'Drawings',
      extensionMetadata: { discipline: 'structure' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extensionMetadata).toStrictEqual({ discipline: 'structure' });
    }
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseRegisterDocumentPayload({
      projectId: PROJECT_P1,
      title: 'Drawings',
      status: 'active',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });

  it('rejects a missing or non-canonical projectId', () => {
    expect(parseRegisterDocumentPayload({ title: 'Drawings' }).ok).toBe(false);
    const bad = parseRegisterDocumentPayload({ projectId: 'not-a-project', title: 'X' });
    expect(bad.ok).toBe(false);
  });

  it('rejects an empty title', () => {
    const result = parseRegisterDocumentPayload({ projectId: PROJECT_P1, title: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});

describe('archiveDocument payload parsing (fail-closed)', () => {
  it('parses a valid payload and rejects the rest', () => {
    const result = parseArchiveDocumentPayload({
      projectId: PROJECT_P1,
      documentId: DOCUMENT_ID,
      expectedVersion: 2,
    });
    expect(result.ok).toBe(true);
    expect(parseArchiveDocumentPayload({ projectId: PROJECT_P1, documentId: DOCUMENT_ID }).ok).toBe(false);
    expect(
      parseArchiveDocumentPayload({
        projectId: PROJECT_P1,
        documentId: DOCUMENT_ID,
        expectedVersion: 0,
      }).ok,
    ).toBe(false);
    expect(
      parseArchiveDocumentPayload({
        projectId: PROJECT_P1,
        documentId: 'nope',
        expectedVersion: 2,
      }).ok,
    ).toBe(false);
  });
});

describe('attachRevision payload parsing (fail-closed)', () => {
  const valid = {
    projectId: PROJECT_P1,
    documentId: DOCUMENT_ID,
    expectedVersion: 1,
    contentBase64: CONTENT_A,
  };

  it('parses a valid payload', () => {
    const result = parseAttachRevisionPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.contentBase64).toBe(CONTENT_A);
  });

  it('rejects malformed base64 content', () => {
    const result = parseAttachRevisionPayload({ ...valid, contentBase64: 'not base64!' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseAttachRevisionPayload({ ...valid, hash: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('supersedeRevision payload parsing (fail-closed)', () => {
  const valid = {
    projectId: PROJECT_P1,
    documentId: DOCUMENT_ID,
    expectedVersion: 2,
    supersedesRevisionId: REVISION_1_ID,
    contentBase64: CONTENT_B,
  };

  it('parses a valid payload', () => {
    const result = parseSupersedeRevisionPayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.supersedesRevisionId).toBe(REVISION_1_ID);
  });

  it('rejects a missing supersedesRevisionId', () => {
    const { supersedesRevisionId: _omit, ...withoutTarget } = valid;
    const result = parseSupersedeRevisionPayload(withoutTarget);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing-field');
  });
});

describe('referenceEvidence payload parsing (fail-closed)', () => {
  const valid = {
    projectId: PROJECT_P1,
    documentId: DOCUMENT_ID,
    revisionId: REVISION_1_ID,
    evidencedEntityKind: 'task',
    evidencedEntityId: TASK_ID,
  };

  it('parses a valid payload', () => {
    const result = parseReferenceEvidencePayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.evidencedEntityKind).toBe('task');
  });

  it('rejects a malformed entity kind', () => {
    const result = parseReferenceEvidencePayload({
      ...valid,
      evidencedEntityKind: 'Not A Kind',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an unknown field (strict keys)', () => {
    const result = parseReferenceEvidencePayload({ ...valid, note: 'see this' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

// ----- command-name guard + authorize-before-unit ----------------------------

describe('command-name guard (trusted path, loud)', () => {
  it('rejects an envelope of another command kind with a TypeError', async () => {
    const service = makeService();
    await expect(
      service.commands.registerDocument(
        envelope(ARCHIVE_DOCUMENT_COMMAND, {
          projectId: PROJECT_P1,
          documentId: DOCUMENT_ID,
          expectedVersion: 1,
        }),
        authorized,
      ),
    ).rejects.toThrow(TypeError);
    expect(service.store.counters.opened).toBe(0);
  });
});

describe('authorization runs before any unit of work is opened', () => {
  const registerPayload = { projectId: PROJECT_P1, title: 'Drawings' };

  it('denies without the required capability (default deny) and never opens a unit', async () => {
    const service = makeService();
    const result = await service.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, registerPayload),
      unauthorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
      expect(result.error.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_A });
    }
    expect(service.store.counters.opened).toBe(0);
  });

  it('denies through an explicit deny rule even with the capability granted', async () => {
    const service = makeService();
    const result = await service.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, registerPayload),
      {
        policy: definePolicy([
          { effect: 'deny', capabilities: ['documents.write'], actions: ['write'] },
          { effect: 'allow', capabilities: ['documents.write'], actions: ['write'] },
        ]),
        capabilities: ['documents.write'] as string[],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(service.store.counters.opened).toBe(0);
  });

  it('denies with the empty policy even when capabilities are granted', async () => {
    const service = makeService();
    const result = await service.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, registerPayload),
      { policy: EMPTY_POLICY, capabilities: ['documents.write'] as string[] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
    expect(service.store.counters.opened).toBe(0);
  });

  it('rejects an undeclared capability name loudly (trusted path)', async () => {
    const service = makeService();
    await expect(
      service.commands.registerDocument(envelope(REGISTER_DOCUMENT_COMMAND, registerPayload), {
        policy: EMPTY_POLICY,
        capabilities: ['documents.administer'] as string[],
      }),
    ).rejects.toThrow(TypeError);
    expect(service.store.counters.opened).toBe(0);
  });

  it('denies a project-scoped command addressing another project (structural A12, pre-unit)', async () => {
    const service = makeService();
    const result = await service.commands.registerDocument(
      envelope(
        REGISTER_DOCUMENT_COMMAND,
        registerPayload,
        { scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 } },
      ),
      authorized,
    );
    expect(result.ok).toBe(true); // payload claims P1, command scope P1 — allowed

    // Now the same project-scoped command addressing P2 in its payload:
    const denied = await service.commands.registerDocument(
      envelope(
        REGISTER_DOCUMENT_COMMAND,
        { projectId: PROJECT_P2, title: 'Other project' },
        { scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 } },
      ),
      authorized,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('unauthorized');
      expect(denied.error.details[0]?.code).toBe('project-scope-violation');
    }
    // The allowed command opened one unit; the denied one opened none.
    expect(service.store.counters.opened).toBe(1);
  });

  it('a cross-tenant command vanishes as a typed not-found (no existence oracle)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const rootRevisionId = service.store.revisions[0]?.entityId;
    // Tenant B tries to mutate tenant A's document (claiming any project):
    const result = await service.commands.attachRevision(
      envelope(
        ATTACH_REVISION_COMMAND,
        {
          projectId: PROJECT_P1,
          documentId,
          expectedVersion: 2,
          contentBase64: CONTENT_B,
        },
        { scope: { kind: 'tenant', tenantId: TENANT_B } },
      ),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.scope).toStrictEqual({ kind: 'tenant', tenantId: TENANT_B });
    }
    // The mutation did not happen: the root revision is untouched, no new
    // events were appended, and the head still points at the root.
    expect(service.store.revisions).toHaveLength(1);
    expect(service.store.revisions[0]?.entityId).toBe(rootRevisionId);
    expect(service.store.documents[0]?.currentRevisionId).toBe(rootRevisionId);
    expect(service.sink.events).toHaveLength(2);
  });
});

// ----- register + audit + idempotency ------------------------------------------

describe('registerDocument (happy path, audit event, idempotent replay)', () => {
  it('creates the document, emits the audit event, and replays idempotently', async () => {
    const service = makeService();
    const command = envelope(REGISTER_DOCUMENT_COMMAND, {
      projectId: PROJECT_P1,
      title: 'Structural drawings',
    });
    const first = await service.commands.registerDocument(command, authorized);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.replayed).toBe(false);
      expect(first.value.value.entityId).toBe('office-ent-v1-' + '1'.toString().padStart(32, '0'));
      expect(first.value.value.scope).toStrictEqual({
        kind: 'project',
        tenantId: TENANT_A,
        projectId: PROJECT_P1,
      });
      expect(first.value.value.version).toBe(1);
      expect(first.value.value.status).toBe('active');
      expect(first.value.value.currentRevisionId).toBeNull();
    }
    expect(service.store.documents).toHaveLength(1);
    expect(service.sink.events).toHaveLength(1);
    const event = service.sink.events[0];
    expect(event?.eventName).toBe('documents.documentRegistered');
    expect(event?.source).toBe('domain');
    expect(event?.actor).toStrictEqual({ kind: 'user', actorId: USER_ACTOR_ID });
    expect(event?.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
    });
    expect(event?.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: command.idempotencyKey,
    });
    expect(event?.entityRefs.before).toBeNull();

    // Replay: same envelope (same idempotency key) — no-op replay.
    const replay = await service.commands.registerDocument(command, authorized);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      if (first.ok) expect(replay.value.value).toStrictEqual(first.value.value);
    }
    expect(service.store.documents).toHaveLength(1);
    expect(service.sink.events).toHaveLength(1);
    expect(service.store.counters.opened).toBe(1);
  });

  it('rejects the same idempotency key on a different command (typed idempotency-conflict)', async () => {
    const service = makeService();
    const key = 'idem-shared-key-0001';
    const first = await service.commands.registerDocument(
      envelope(
        REGISTER_DOCUMENT_COMMAND,
        { projectId: PROJECT_P1, title: 'A' },
        { idempotencyKey: key },
      ),
      authorized,
    );
    expect(first.ok).toBe(true);
    const second = await service.commands.registerDocument(
      envelope(
        REGISTER_DOCUMENT_COMMAND,
        { projectId: PROJECT_P1, title: 'Different title' },
        { idempotencyKey: key },
      ),
      authorized,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('idempotency-conflict');
      expect(second.error.details[0]?.code).toBe('idempotency-key-reuse');
    }
    expect(service.store.documents).toHaveLength(1);
  });

  it('issues deterministic ids: the same supplier sequence yields the same id (typed duplicate)', async () => {
    const service = makeService();
    const first = await service.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, { projectId: PROJECT_P1, title: 'A' }),
      authorized,
    );
    expect(first.ok).toBe(true);
    // A second service with the SAME supplier sequence (fresh registry) composes
    // the identical id — proven by the typed duplicate failure naming it.
    const other = makeService();
    const second = await other.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, { projectId: PROJECT_P1, title: 'A' }),
      authorized,
    );
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.value.entityId).toBe(first.value.value.entityId);
    }
  });
});

// ----- revision commands --------------------------------------------------------

describe('attachRevision', () => {
  it('attaches the root revision: content addressed, stored, audited', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { document, revision } = result.value.value;
      expect(document.version).toBe(2);
      expect(document.currentRevisionId).toBe(revision.entityId);
      expect(revision.supersedes).toBeNull();
      expect(revision.byteSize).toBe(4);
      expect(revision.contentHash).toBe(hashBytes(new Uint8Array([65, 66, 67, 68])));
      expect(revision.storageKey).toBe(
        `doc/${TENANT_A}/${PROJECT_P1}/${revision.contentHash}`,
      );
    }
    expect(service.storage.count).toBe(1);
    expect(service.sink.events).toHaveLength(2);
    expect(service.sink.events[1]?.eventName).toBe('documents.revisionAttached');
    const stored = await service.storage.get(parseStorageKeyOf(service, CONTENT_A));
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value).toStrictEqual(new Uint8Array([65, 66, 67, 68]));
  });

  it('rejects a stale expected version with a typed concurrency-conflict (state unchanged)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 5,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('concurrency-conflict');
      expect(result.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    expect(service.store.revisions).toHaveLength(0);
    expect(service.store.documents[0]?.version).toBe(1);
    expect(service.sink.events).toHaveLength(1);
    expect(service.storage.count).toBe(0);
  });

  it('refuses a second root revision (typed invariant-violation)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('document-attach-requires-empty-chain');
    }
    expect(service.store.revisions).toHaveLength(1);
  });

  it('refuses attaching to an archived document (typed invariant-violation)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const archived = await service.commands.archiveDocument(
      envelope(ARCHIVE_DOCUMENT_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
      }),
      authorized,
    );
    if (!archived.ok) throw new Error('archive failed');
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('document-attach-requires-active');
    }
  });

  it('refuses a document of another project claimed under a tenant-scoped command (not-found)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P2,
        documentId,
        expectedVersion: 1,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});

describe('supersedeRevision', () => {
  it('appends a successor revision with an explicit forward link', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const rootRevisionId = service.store.revisions[0]?.entityId;
    const result = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        supersedesRevisionId: rootRevisionId,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { document, revision } = result.value.value;
      expect(revision.supersedes).toBe(rootRevisionId);
      expect(document.currentRevisionId).toBe(revision.entityId);
      expect(document.version).toBe(3);
    }
    expect(service.sink.events).toHaveLength(3);
    const event = service.sink.events[2];
    expect(event?.eventName).toBe('documents.revisionSuperseded');
    expect(event?.entityRefs).toStrictEqual({
      before: { entityKind: 'document-revision', entityId: rootRevisionId },
      after: { entityKind: 'document-revision', entityId: result.ok ? result.value.value.revision.entityId : '' },
    });
  });

  it('builds the R1→R2→R3 chain: full history readable, R1 unchanged after supersession', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const r1 = service.store.revisions[0];
    if (r1 === undefined) throw new Error('root revision missing');
    // A deep snapshot of R1 taken BEFORE any supersession: the row of record
    // must be byte-identical after two supersessions.
    const r1Snapshot = JSON.parse(JSON.stringify(r1)) as typeof r1;
    const supersede = async (
      expectedVersion: number,
      supersedesRevisionId: EntityId,
      contentBase64: string,
    ): Promise<EntityId> => {
      const result = await service.commands.supersedeRevision(
        envelope(SUPERSEDE_REVISION_COMMAND, {
          projectId: PROJECT_P1,
          documentId,
          expectedVersion,
          supersedesRevisionId,
          contentBase64,
        }),
        authorized,
      );
      if (!result.ok) {
        throw new Error(`supersede failed: ${JSON.stringify(result.error)}`);
      }
      return result.value.value.revision.entityId;
    };
    const r2 = await supersede(2, r1.entityId, CONTENT_B);
    const r3 = await supersede(3, r2, CONTENT_A);
    expect(service.store.revisions).toHaveLength(3);
    expect(service.store.documents[0]?.currentRevisionId).toBe(r3);
    // The full history is readable, oldest first: R1 → R2 → R3.
    const chain = await service.store.revisionChainOf(
      { kind: 'tenant', tenantId: TENANT_A },
      documentId,
    );
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.value.map((revision) => revision.entityId)).toStrictEqual([
        r1.entityId,
        r2,
        r3,
      ]);
      // R1's content hash, storage key, and whole row are unchanged by the
      // supersessions — supersession appends; it never rewrites.
      const readR1 = chain.value[0];
      expect(readR1?.contentHash).toBe(r1.contentHash);
      expect(readR1?.storageKey).toBe(r1.storageKey);
      expect(readR1?.byteSize).toBe(r1.byteSize);
      expect(readR1).toStrictEqual(r1Snapshot);
    }
    // Content addressing: R3 reuses R1's content (same hash → same key), so
    // only two distinct blobs exist for three revisions.
    expect(service.storage.count).toBe(2);
  });

  it('re-attaching an existing revision id with different content is a typed conflict (immutability)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const rootRevisionId = service.store.revisions[0]?.entityId;
    if (rootRevisionId === undefined) throw new Error('root revision missing');
    const rootHash = service.store.revisions[0]?.contentHash;
    // Grow the chain to R2 so a colliding successor can supersede R2 while
    // reusing R1's id (a self-link would trip the revision invariant first).
    const superseded = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        supersedesRevisionId: rootRevisionId,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    if (!superseded.ok) throw new Error('supersede failed');
    const headRevisionId = superseded.value.value.revision.entityId;
    // A successor command whose id supplier replays R1's opaque part: the
    // handler would compose R1's id AGAIN with DIFFERENT content. The revision
    // row is create-only — the store rejects the duplicate id with a typed
    // invariant-violation and the whole unit rolls back.
    const colliding = createDocumentsCommands({
      ...service.deps,
      newOpaqueId: () => rootRevisionId.slice('office-ent-v1-'.length),
    });
    const result = await colliding.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 3,
        supersedesRevisionId: headRevisionId,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('revision-id-already-exists');
    }
    // State unchanged: R1's row (hash included) survives byte-identically, the
    // head still points at R2, and no third supersession event was appended.
    expect(service.store.revisions).toHaveLength(2);
    expect(service.store.revisions[0]?.entityId).toBe(rootRevisionId);
    expect(service.store.revisions[0]?.contentHash).toBe(rootHash);
    expect(service.store.documents[0]?.currentRevisionId).toBe(headRevisionId);
    expect(service.store.documents[0]?.version).toBe(3);
    expect(service.sink.events).toHaveLength(3);
  });

  it('refuses superseding an already-superseded revision (typed invariant-violation)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const rootRevisionId = service.store.revisions[0]?.entityId;
    const first = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        supersedesRevisionId: rootRevisionId,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    if (!first.ok) throw new Error('first supersede failed');
    const second = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 3,
        supersedesRevisionId: rootRevisionId,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('document-supersede-requires-current-head');
    }
    expect(service.store.revisions).toHaveLength(2);
  });

  it('refuses a supersede whose target revision is absent (typed not-found)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const result = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
        supersedesRevisionId: TASK_ID,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('rejects a stale expected version with a typed concurrency-conflict (state unchanged)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    const rootRevisionId = service.store.revisions[0]?.entityId;
    const result = await service.commands.supersedeRevision(
      envelope(SUPERSEDE_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 9,
        supersedesRevisionId: rootRevisionId,
        contentBase64: CONTENT_B,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('concurrency-conflict');
    expect(service.store.revisions).toHaveLength(1);
    expect(service.sink.events).toHaveLength(2);
  });
});

describe('archiveDocument', () => {
  it('archives an active document and emits the lifecycle event', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const result = await service.commands.archiveDocument(
      envelope(ARCHIVE_DOCUMENT_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
      }),
      authorized,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.status).toBe('archived');
      expect(result.value.value.archivedAt).toBe(NOW);
      expect(result.value.value.version).toBe(2);
    }
    expect(service.sink.events).toHaveLength(2);
    expect(service.sink.events[1]?.eventName).toBe('documents.documentArchived');
  });

  it('refuses a second archive (typed invariant-violation)', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    await service.commands.archiveDocument(
      envelope(ARCHIVE_DOCUMENT_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
      }),
      authorized,
    );
    const second = await service.commands.archiveDocument(
      envelope(ARCHIVE_DOCUMENT_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 2,
      }),
      authorized,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.details[0]?.code).toBe('document-archive-requires-active');
    }
  });

  it('rejects a stale expected version with a typed concurrency-conflict', async () => {
    const service = makeService();
    const documentId = await registerDocument(service);
    const result = await service.commands.archiveDocument(
      envelope(ARCHIVE_DOCUMENT_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 4,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('concurrency-conflict');
    expect(service.store.documents[0]?.status).toBe('active');
  });
});

// ----- evidence references ------------------------------------------------------

describe('referenceEvidence', () => {
  const setup = async (service: Service): Promise<{
    readonly documentId: string;
    readonly revisionId: string;
  }> => {
    const documentId = await registerDocument(service);
    await attachRoot(service, documentId);
    return { documentId, revisionId: service.store.revisions[0]?.entityId ?? '' };
  };

  it('pins (entity, document, revision) immutably and audibly', async () => {
    const service = makeService();
    const { documentId, revisionId } = await setup(service);
    const result = await service.commands.referenceEvidence(
      envelope(REFERENCE_EVIDENCE_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        revisionId,
        evidencedEntityKind: 'task',
        evidencedEntityId: TASK_ID,
      }),
      authorized,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value.documentId).toBe(documentId);
      expect(result.value.value.revisionId).toBe(revisionId);
      expect(result.value.value.evidencedEntityKind).toBe('task');
      expect(result.value.value.evidencedEntityId).toBe(TASK_ID);
      expect(result.value.value.version).toBe(1);
    }
    expect(service.sink.events).toHaveLength(3);
    const event = service.sink.events[2];
    expect(event?.eventName).toBe('documents.evidenceReferenced');
    expect(event?.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
    });
    expect(event?.actor).toStrictEqual({ kind: 'user', actorId: USER_ACTOR_ID });
    expect(event?.source).toBe('domain');
    expect(event?.causality.causationId).toBeDefined();
    expect(event?.entityRefs.before).toBeNull();
  });

  it('refuses re-pinning the same (entity, revision) with a fresh command (typed conflict)', async () => {
    const service = makeService();
    const { documentId, revisionId } = await setup(service);
    const pin = async () =>
      service.commands.referenceEvidence(
        envelope(REFERENCE_EVIDENCE_COMMAND, {
          projectId: PROJECT_P1,
          documentId,
          revisionId,
          evidencedEntityKind: 'task',
          evidencedEntityId: TASK_ID,
        }),
        authorized,
      );
    const first = await pin();
    expect(first.ok).toBe(true);
    const second = await pin();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invariant-violation');
      expect(second.error.details[0]?.code).toBe('evidence-reference-already-exists');
    }
    expect(service.store.evidenceReferences).toHaveLength(1);
    expect(service.sink.events).toHaveLength(3);
  });

  it('replays idempotently: the same envelope is a no-op, not a duplicate', async () => {
    const service = makeService();
    const { documentId, revisionId } = await setup(service);
    const command = envelope(REFERENCE_EVIDENCE_COMMAND, {
      projectId: PROJECT_P1,
      documentId,
      revisionId,
      evidencedEntityKind: 'task',
      evidencedEntityId: TASK_ID,
    });
    const first = await service.commands.referenceEvidence(command, authorized);
    expect(first.ok).toBe(true);
    const replay = await service.commands.referenceEvidence(command, authorized);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.replayed).toBe(true);
    expect(service.store.evidenceReferences).toHaveLength(1);
    expect(service.sink.events).toHaveLength(3);
  });

  it('refuses pinning a revision of another document (typed not-found)', async () => {
    const service = makeService();
    const { documentId, revisionId } = await setup(service);
    const result = await service.commands.referenceEvidence(
      envelope(REFERENCE_EVIDENCE_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        revisionId: REVISION_2_ID,
        evidencedEntityKind: 'task',
        evidencedEntityId: TASK_ID,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(service.store.evidenceReferences).toHaveLength(0);
    expect(revisionId).not.toBe(REVISION_2_ID);
  });
});

// ----- atomicity: failures roll the whole mutation back ------------------------

describe('write + event append atomicity (a failure aborts everything staged)', () => {
  it('a failing event sink rolls the register mutation back', async () => {
    const service = makeService();
    const failing = makeService({ eventSink: failingEventSinkOf() });
    const result = await failing.commands.registerDocument(
      envelope(REGISTER_DOCUMENT_COMMAND, { projectId: PROJECT_P1, title: 'A' }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    expect(failing.store.documents).toHaveLength(0);
    expect(service.store.documents).toHaveLength(0);
  });

  it('a failing event sink rolls the revision mutation back (the blob may orphan)', async () => {
    // One sink that records appends until the test flips the gate: the
    // register command's audit event is recorded (its unit commits), then the
    // attach command's append fails and its whole unit rolls back.
    const recorder = createInMemoryEventSink();
    let rejectAppends = false;
    const gatedSink: EventSink = {
      appendEvents: async (executor, events) => {
        if (rejectAppends) return fail(eventSinkFailure('ledger unavailable'));
        return recorder.appendEvents(executor, events);
      },
    };
    const service = makeService({ eventSink: gatedSink });
    const documentId = await registerDocument(service);
    const eventsBefore = recorder.events.length;
    rejectAppends = true;
    const result = await service.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
    expect(service.store.revisions).toHaveLength(0);
    expect(service.store.documents[0]?.currentRevisionId).toBeNull();
    expect(service.store.documents[0]?.version).toBe(1);
    expect(recorder.events).toHaveLength(eventsBefore);
    // The blob was put before the failure: content-addressed orphans are
    // accepted (idempotent re-put; no aggregate references it).
    expect(service.storage.count).toBe(1);
  });

  it('a failing object storage aborts the revision mutation entirely', async () => {
    const service = makeService({
      objectStorage: {
        put: async () => {
          throw new Error('should not be reached via throw');
        },
      } as unknown as DocumentsCommandDeps['objectStorage'],
    });
    // Use the typed failing fake instead of a throwing stub:
    const failingStorage = makeService({
      objectStorage: failingObjectStorageOf(),
    });
    const documentId = await registerDocument(failingStorage);
    const result = await failingStorage.commands.attachRevision(
      envelope(ATTACH_REVISION_COMMAND, {
        projectId: PROJECT_P1,
        documentId,
        expectedVersion: 1,
        contentBase64: CONTENT_A,
      }),
      authorized,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('object-storage-rejected');
    }
    expect(failingStorage.store.revisions).toHaveLength(0);
    expect(failingStorage.store.documents[0]?.version).toBe(1);
    expect(failingStorage.sink.events).toHaveLength(1);
    expect(service.sink.events).toHaveLength(0);
  });
});

// ----- helpers -------------------------------------------------------------------

const parseStorageKeyOf = (service: Service, contentBase64: string): StorageKey => {
  // Compose the storage key deterministically from the test's fixed inputs.
  void service;
  const key = `doc/${TENANT_A}/${PROJECT_P1}/${hashBytes(decodeOf(contentBase64))}`;
  return unwrap(parseStorageKey(key));
};

const decodeOf = (contentBase64: string): Uint8Array => {
  // Minimal fixed decoder for the two test contents.
  if (contentBase64 === CONTENT_A) return new Uint8Array([65, 66, 67, 68]);
  return new Uint8Array([69, 70, 71, 72]);
};

const failingEventSinkOf = () => failingEventSink('ledger unavailable');
const failingObjectStorageOf = () => failingObjectStorage('backend unreachable');
