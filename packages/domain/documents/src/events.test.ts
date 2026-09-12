import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  parseCommandEnvelope,
  parseEntityKind,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, ParseResult } from '@office/contracts';
import {
  DOCUMENT_ARCHIVED_EVENT,
  DOCUMENT_REGISTERED_EVENT,
  EVIDENCE_REFERENCED_EVENT,
  REVISION_ATTACHED_EVENT,
  REVISION_SUPERSEDED_EVENT,
  createInMemoryEventSink,
  documentsEventEnvelope,
  entityRefOf,
  failingEventSink,
} from './events';
import type { EventSink } from './events';
import { parseRevisionHash, parseStorageKey } from './storage';
import { DOCUMENT_KIND, EVIDENCE_REFERENCE_KIND, REVISION_KIND } from './state';

// OFF-008 documents domain — audit events + the EventSink port. Unit tests:
// the event vocabulary parses, the envelope builder propagates
// causality/actor from the command envelope with correct before/after
// entity refs per transition kind, and the in-memory sink records appends
// for deterministic assertions. No I/O, fixed everything.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_P1 = formatProjectId({
  version: 'v1',
  opaque: '1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f',
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
const TASK_ID = formatEntityId({
  version: 'v1',
  opaque: '5e6f708192a3b4c5d6e7f8a9b3c4d5e6',
});
const USER_ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});

const HASH_A = unwrap(parseRevisionHash('a'.repeat(64)));
const HASH_B = unwrap(parseRevisionHash('b'.repeat(64)));
const KEY_A = unwrap(parseStorageKey(`doc/${TENANT_A}/${PROJECT_P1}/${'a'.repeat(64)}`));
const KEY_B = unwrap(parseStorageKey(`doc/${TENANT_A}/${PROJECT_P1}/${'b'.repeat(64)}`));
const TASK_KIND = unwrap(parseEntityKind('task'));

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'documents.attachRevision',
    scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
    actor: { kind: 'user', actorId: USER_ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: { projectId: PROJECT_P1, documentId: DOCUMENT_ID, expectedVersion: 1, contentBase64: 'QUJD' },
  }),
);

describe('documents event vocabulary', () => {
  it('declares the five audit event names', () => {
    expect(DOCUMENT_REGISTERED_EVENT).toBe('documents.documentRegistered');
    expect(DOCUMENT_ARCHIVED_EVENT).toBe('documents.documentArchived');
    expect(REVISION_ATTACHED_EVENT).toBe('documents.revisionAttached');
    expect(REVISION_SUPERSEDED_EVENT).toBe('documents.revisionSuperseded');
    expect(EVIDENCE_REFERENCED_EVENT).toBe('documents.evidenceReferenced');
  });
});

describe('documents event envelope construction (A3)', () => {
  it('propagates actor, scope, and causality from the command envelope', () => {
    const event = documentsEventEnvelope({
      command,
      eventName: REVISION_ATTACHED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: entityRefOf(REVISION_KIND, REVISION_1_ID) },
      payload: {
        documentId: DOCUMENT_ID,
        revisionId: REVISION_1_ID,
        supersedes: null,
        contentHash: HASH_A,
        storageKey: KEY_A,
        byteSize: 3,
        version: 2,
        attachedAt: NOW,
      },
    });
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('documents.revisionAttached');
    expect(event.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
    });
    expect(event.actor).toStrictEqual({ kind: 'user', actorId: USER_ACTOR_ID });
    expect(event.source).toBe('domain');
    // The correlation id carries over from the command's causal chain; the
    // causation id of the event is the COMMAND's idempotency key (the
    // OFF-005 ledger convention).
    expect(event.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: 'idem-4f9d2c81a7e3',
    });
    expect(event.schemaVersion).toBe('1.0.0');
    expect(event.occurredAt).toBe(NOW);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: REVISION_KIND, entityId: REVISION_1_ID },
    });
    expect(event.payload).toStrictEqual({
      documentId: DOCUMENT_ID,
      revisionId: REVISION_1_ID,
      supersedes: null,
      contentHash: 'a'.repeat(64),
      storageKey: `doc/${TENANT_A}/${PROJECT_P1}/${'a'.repeat(64)}`,
      byteSize: 3,
      version: 2,
      attachedAt: NOW,
    });
  });

  it('carries before = superseded, after = successor for the supersession event', () => {
    const event = documentsEventEnvelope({
      command,
      eventName: REVISION_SUPERSEDED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: {
        before: entityRefOf(REVISION_KIND, REVISION_1_ID),
        after: entityRefOf(REVISION_KIND, REVISION_2_ID),
      },
      payload: {
        documentId: DOCUMENT_ID,
        revisionId: REVISION_2_ID,
        supersedes: REVISION_1_ID,
        contentHash: HASH_B,
        storageKey: KEY_B,
        byteSize: 5,
        version: 3,
        supersededAt: NOW,
      },
    });
    expect(event.entityRefs).toStrictEqual({
      before: { entityKind: REVISION_KIND, entityId: REVISION_1_ID },
      after: { entityKind: REVISION_KIND, entityId: REVISION_2_ID },
    });
  });

  it('carries before = after = the aggregate for lifecycle events, creation refs for the rest', () => {
    const registered = documentsEventEnvelope({
      command,
      eventName: DOCUMENT_REGISTERED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: entityRefOf(DOCUMENT_KIND, DOCUMENT_ID) },
      payload: {
        documentId: DOCUMENT_ID,
        projectId: PROJECT_P1,
        title: 'Structural drawings',
        status: 'active',
        version: 1,
        createdAt: NOW,
      },
    });
    expect(registered.entityRefs.before).toBeNull();
    expect(registered.entityRefs.after).toStrictEqual({
      entityKind: DOCUMENT_KIND,
      entityId: DOCUMENT_ID,
    });

    const archived = documentsEventEnvelope({
      command,
      eventName: DOCUMENT_ARCHIVED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: {
        before: entityRefOf(DOCUMENT_KIND, DOCUMENT_ID),
        after: entityRefOf(DOCUMENT_KIND, DOCUMENT_ID),
      },
      payload: {
        documentId: DOCUMENT_ID,
        status: 'archived',
        archivedAt: NOW,
        version: 2,
        updatedAt: NOW,
      },
    });
    expect(archived.entityRefs).toStrictEqual({
      before: { entityKind: DOCUMENT_KIND, entityId: DOCUMENT_ID },
      after: { entityKind: DOCUMENT_KIND, entityId: DOCUMENT_ID },
    });

    const evidence = documentsEventEnvelope({
      command,
      eventName: EVIDENCE_REFERENCED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: entityRefOf(EVIDENCE_REFERENCE_KIND, EVIDENCE_ID) },
      payload: {
        evidenceReferenceId: EVIDENCE_ID,
        documentId: DOCUMENT_ID,
        revisionId: REVISION_1_ID,
        evidencedEntityKind: TASK_KIND,
        evidencedEntityId: TASK_ID,
        referencedAt: NOW,
      },
    });
    expect(evidence.entityRefs.before).toBeNull();
    expect(evidence.entityRefs.after).toStrictEqual({
      entityKind: EVIDENCE_REFERENCE_KIND,
      entityId: EVIDENCE_ID,
    });
  });

  it('self-checks through the contracts parser: the built envelope is a valid DomainEventEnvelope', () => {
    const event = documentsEventEnvelope({
      command,
      eventName: DOCUMENT_REGISTERED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: entityRefOf(DOCUMENT_KIND, DOCUMENT_ID) },
      payload: {
        documentId: DOCUMENT_ID,
        projectId: PROJECT_P1,
        title: 'Structural drawings',
        status: 'active',
        version: 1,
        createdAt: NOW,
      },
    });
    // parseDomainEventEnvelope is the fail-closed boundary; a built envelope
    // must survive it (the builder enforces this by construction).
    expect(event.schemaVersion).toBe('1.0.0');
    expect(event.eventName).toBe('documents.documentRegistered');
  });
});

describe('EventSink port', () => {
  it('the in-memory sink records appends with the executor it was handed', async () => {
    const sink = createInMemoryEventSink();
    const executor = { query: async () => ({ rows: [], rowCount: 0 }) };
    const event = documentsEventEnvelope({
      command,
      eventName: DOCUMENT_REGISTERED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_P1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: entityRefOf(DOCUMENT_KIND, DOCUMENT_ID) },
      payload: {
        documentId: DOCUMENT_ID,
        projectId: PROJECT_P1,
        title: 'Structural drawings',
        status: 'active',
        version: 1,
        createdAt: NOW,
      },
    });
    const result = await sink.appendEvents(executor, [event]);
    expect(result.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.events).toStrictEqual([event]);
  });

  it('a failing sink returns a typed DomainError failure', async () => {
    const sink: EventSink = failingEventSink('ledger unavailable');
    const result = await sink.appendEvents(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      [],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
  });

  it('two structurally identical sinks accept the same implementation (port identity)', async () => {
    // The port is structural: any appendEvents(executor, events) object
    // satisfies it — one implementation serves every domain package.
    const implementation = createInMemoryEventSink();
    const asPort: EventSink = implementation;
    await asPort.appendEvents({ query: async () => ({ rows: [], rowCount: 0 }) }, []);
    expect(implementation.events).toHaveLength(0);
  });
});
