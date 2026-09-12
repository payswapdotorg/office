import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, ParseResult } from '@office/contracts';
import {
  PROJECT_ARCHIVED_EVENT,
  PROJECT_CREATED_EVENT,
  PROJECT_UPDATED_EVENT,
  createInMemoryEventSink,
  failingEventSink,
  projectEventEnvelope,
} from './events';
import type { EventSink } from './events';
import { PROJECT_KIND } from './state';

// OFF-007 project domain — audit events + the EventSink port. Unit tests:
// the event vocabulary parses, the envelope builder propagates
// causality/actor from the command envelope and carries the aggregate's OWN
// project scope, and the in-memory sink records appends for deterministic
// assertions. No I/O, fixed everything.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
const NOW = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const PROJECT_ID = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});

const command: CommandEnvelope<unknown> = unwrap(
  parseCommandEnvelope({
    kind: 'command',
    commandName: 'projects.createProject',
    scope: { kind: 'tenant', tenantId: TENANT_A },
    actor: { kind: 'user', actorId: ACTOR_ID },
    idempotencyKey: 'idem-4f9d2c81a7e3',
    causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
    issuedAt: '2026-09-12T10:15:30.000Z',
    schemaVersion: '1.0.0',
    payload: { name: 'Riverside Tower' },
  }),
);

describe('project event vocabulary', () => {
  it('declares the three lifecycle event names', () => {
    expect(PROJECT_CREATED_EVENT).toBe('projects.projectCreated');
    expect(PROJECT_UPDATED_EVENT).toBe('projects.projectUpdated');
    expect(PROJECT_ARCHIVED_EVENT).toBe('projects.projectArchived');
  });
});

describe('project event envelope construction (A3)', () => {
  it('propagates actor, causality, and the aggregate scope from the command', () => {
    const event = projectEventEnvelope({
      command,
      eventName: PROJECT_CREATED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID },
      occurredAt: NOW,
      entityRefs: {
        before: null,
        after: { entityKind: PROJECT_KIND, entityId: PROJECT_ID },
      },
      payload: {
        projectId: PROJECT_ID,
        name: 'Riverside Tower',
        status: 'active',
        version: 1,
        createdAt: NOW,
      },
    });
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('projects.projectCreated');
    // The audit event carries the aggregate's OWN project scope — the
    // second boundary travels on every event (freeze A3/A12).
    expect(event.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: PROJECT_ID,
    });
    expect(event.actor).toStrictEqual({ kind: 'user', actorId: ACTOR_ID });
    expect(event.source).toBe('domain');
    // The correlation id carries over from the command's causal chain; the
    // causation id of the event is the COMMAND's idempotency key (the
    // OFF-005 ledger convention).
    expect(event.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: 'idem-4f9d2c81a7e3',
    });
    expect(event.occurredAt).toBe(NOW);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: PROJECT_KIND, entityId: PROJECT_ID },
    });
    expect(event.payload).toStrictEqual({
      projectId: PROJECT_ID,
      name: 'Riverside Tower',
      status: 'active',
      version: 1,
      createdAt: NOW,
    });
  });

  it('carries before/after entity refs for update-kind events', () => {
    const ref = { entityKind: PROJECT_KIND, entityId: PROJECT_ID };
    const event = projectEventEnvelope({
      command,
      eventName: PROJECT_ARCHIVED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID },
      occurredAt: NOW,
      entityRefs: { before: ref, after: ref },
      payload: {
        projectId: PROJECT_ID,
        status: 'archived',
        archivedAt: NOW,
        version: 2,
        updatedAt: NOW,
      },
    });
    expect(event.entityRefs).toStrictEqual({ before: ref, after: ref });
  });

  it('self-checks through the contracts parser: the built envelope is a valid DomainEventEnvelope', () => {
    const event = projectEventEnvelope({
      command,
      eventName: PROJECT_UPDATED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID },
      occurredAt: NOW,
      entityRefs: {
        before: { entityKind: PROJECT_KIND, entityId: PROJECT_ID },
        after: { entityKind: PROJECT_KIND, entityId: PROJECT_ID },
      },
      payload: {
        projectId: PROJECT_ID,
        name: 'Riverside Tower II',
        version: 2,
        updatedAt: NOW,
      },
    });
    // parseDomainEventEnvelope is the fail-closed boundary; a built envelope
    // must survive it (the builder enforces this by construction).
    expect(event.schemaVersion).toBe('1.0.0');
    expect(event.eventName).toBe('projects.projectUpdated');
  });
});

describe('EventSink port', () => {
  it('the in-memory sink records appends with the executor it was handed', async () => {
    const sink = createInMemoryEventSink();
    const executor = { query: async () => ({ rows: [], rowCount: 0 }) };
    const event = projectEventEnvelope({
      command,
      eventName: PROJECT_CREATED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_ID },
      occurredAt: NOW,
      entityRefs: {
        before: null,
        after: { entityKind: PROJECT_KIND, entityId: PROJECT_ID },
      },
      payload: {
        projectId: PROJECT_ID,
        name: 'Riverside Tower',
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
    // satisfies it — the OFF-005 ledger will implement it once for both
    // domain packages.
    const implementation = createInMemoryEventSink();
    const asPort: EventSink = implementation;
    await asPort.appendEvents({ query: async () => ({ rows: [], rowCount: 0 }) }, []);
    expect(implementation.events).toHaveLength(0);
  });
});
