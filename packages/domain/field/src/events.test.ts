import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseEntityId, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, EntityId, ParseResult, Timestamp } from '@office/contracts';
import { CURRENT_SCHEMA_VERSION } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  ASSIGN_ISSUE_COMMAND,
  CAPTURE_FIELD_EVENT_COMMAND,
  COMMENT_ON_ISSUE_COMMAND,
  RAISE_ISSUE_COMMAND,
  RESOLVE_FIELD_EVENT_COMMAND,
  createFieldCommands,
} from './commands';
import type { FieldCommandAuthorization, FieldCommandDeps } from './commands';
import {
  DAILY_LOG_DAY_CLOSED_EVENT,
  DAILY_LOG_ENTRY_APPENDED_EVENT,
  FIELD_EVENT_CAPTURED_EVENT,
  FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
  FIELD_EVENT_NAMES,
  FIELD_EVENT_RESOLVED_EVENT,
  INSPECTION_CONDUCTED_EVENT,
  INSPECTION_OUTCOMED_EVENT,
  INSPECTION_SCHEDULED_EVENT,
  ISSUE_ASSIGNED_EVENT,
  ISSUE_COMMENTED_EVENT,
  ISSUE_RAISED_EVENT,
  ISSUE_REOPENED_EVENT,
  ISSUE_RESOLVED_EVENT,
  createInMemoryEventSink,
  failingEventSink,
  fieldEventEnvelope,
} from './events';
import type { DomainEventEnvelope } from '@office/contracts';
import { createInMemoryFieldStore } from './store';
import { FIELD_EVENT_KIND, ISSUE_KIND } from './state';

// OFF-009 field domain — audit events (freeze A3): every mutation emits one
// DomainEventEnvelope through the injected EventSink with scope, actor,
// source 'domain', correlation/causation propagated from the command envelope
// (causationId = the command's idempotency key, the OFF-005 ledger
// convention), before/after EntityRefs, and the invariant-checked next state
// mirrored into the payload. A FAILING sink aborts the whole mutation.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const expectOk = async <T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<T> => {
  const result = await promise;
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
const PARTY: EntityId = unwrap(parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'));

const CLIENT_OBSERVED_AT = '2026-09-12T09:00:00.000Z';
const NOW: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const LATER: Timestamp = unwrap(parseTimestamp('2026-09-12T11:02:00.000Z'));

const FAKE_EXECUTOR: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

const grant: FieldCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
  capabilities: ['work.write'],
};

const envelope = (
  payload: unknown,
  commandName: typeof CAPTURE_FIELD_EVENT_COMMAND,
  key: string,
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
      actor: { kind: 'user', actorId: USER },
      idempotencyKey: key,
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

const capturePayload = () => ({
  category: 'delivery-arrival',
  summary: 'Concrete pour started at level 3',
  location: 'Level 3, north face',
  observedAt: CLIENT_OBSERVED_AT,
  observedBy: PARTY,
});

const makeDeps = (sink: FieldCommandDeps['eventSink']): FieldCommandDeps => ({
  store: createInMemoryFieldStore(),
  eventSink: sink,
  idempotencyRegistry: createInMemoryIdempotencyRegistry(),
  now: () => NOW,
  newOpaqueId: () => '0000000000000001',
  executor: FAKE_EXECUTOR,
});

// ----- event vocabulary ----------------------------------------------------------

describe('field event vocabulary', () => {
  it('declares the thirteen audit event names', () => {
    expect(FIELD_EVENT_CAPTURED_EVENT).toBe('field.fieldEventCaptured');
    expect(FIELD_EVENT_EVIDENCE_ATTACHED_EVENT).toBe('field.fieldEventEvidenceAttached');
    expect(FIELD_EVENT_RESOLVED_EVENT).toBe('field.fieldEventResolved');
    expect(DAILY_LOG_ENTRY_APPENDED_EVENT).toBe('field.dailyLogEntryAppended');
    expect(DAILY_LOG_DAY_CLOSED_EVENT).toBe('field.dailyLogDayClosed');
    expect(ISSUE_RAISED_EVENT).toBe('field.issueRaised');
    expect(ISSUE_ASSIGNED_EVENT).toBe('field.issueAssigned');
    expect(ISSUE_COMMENTED_EVENT).toBe('field.issueCommented');
    expect(ISSUE_RESOLVED_EVENT).toBe('field.issueResolved');
    expect(ISSUE_REOPENED_EVENT).toBe('field.issueReopened');
    expect(INSPECTION_SCHEDULED_EVENT).toBe('field.inspectionScheduled');
    expect(INSPECTION_CONDUCTED_EVENT).toBe('field.inspectionConducted');
    expect(INSPECTION_OUTCOMED_EVENT).toBe('field.inspectionOutcomed');
    expect(FIELD_EVENT_NAMES).toHaveLength(13);
    expect(new Set(FIELD_EVENT_NAMES).size).toBe(13);
  });
});

// ----- envelope construction through the command path ----------------------------

describe('capture emits a full audit envelope through the sink (A3)', () => {
  it('carries scope, actor, source, causality, refs, and the captured state', async () => {
    const sink = createInMemoryEventSink();
    const commands = createFieldCommands(makeDeps(sink));
    const captured = await expectOk(
      commands.fieldEvents.captureFieldEvent(envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-capture-1'), grant),
    );

    expect(sink.appends).toHaveLength(1);
    // The sink is handed the handler's executor (the open transaction).
    expect(sink.appends[0]?.executor).toBe(FAKE_EXECUTOR);
    expect(sink.events).toHaveLength(1);

    const event = sink.events[0] as DomainEventEnvelope<{
      readonly fieldEventId: string;
      readonly status: string;
      readonly version: number;
    }>;
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('field.fieldEventCaptured');
    expect(event.scope).toStrictEqual({ kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 });
    expect(event.actor).toStrictEqual({ kind: 'user', actorId: USER });
    expect(event.source).toBe('domain');
    // Correlation carries over from the command's causal chain; the event's
    // causation id IS the command's idempotency key (the ledger convention).
    expect(event.causality).toStrictEqual({
      correlationId: 'corr-0f1e2d3c4b5a',
      causationId: 'idem-capture-1',
    });
    expect(event.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(event.occurredAt).toBe(NOW);
    // A creation carries before = null and after = the created aggregate.
    expect(event.entityRefs.before).toBeNull();
    expect(event.entityRefs.after).toStrictEqual({
      entityKind: 'field-event',
      entityId: captured.state.entityId,
    });
    expect(event.payload.fieldEventId).toBe(captured.state.entityId);
    expect(event.payload.status).toBe('open');
    expect(event.payload.version).toBe(1);
  });

  it('update events carry before/after entity refs of the same aggregate', async () => {
    const sink = createInMemoryEventSink();
    const commands = createFieldCommands(makeDeps(sink));
    const captured = await expectOk(
      commands.fieldEvents.captureFieldEvent(envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-capture-2'), grant),
    );
    await expectOk(
      commands.fieldEvents.resolveFieldEvent(
        envelope(
          { fieldEventId: captured.state.entityId, expectedVersion: 1, resolutionNote: 'accepted' },
          RESOLVE_FIELD_EVENT_COMMAND,
          'idem-resolve-2',
        ),
        grant,
      ),
    );

    expect(sink.events).toHaveLength(2);
    const resolved = sink.events[1];
    expect(resolved?.eventName).toBe('field.fieldEventResolved');
    expect(resolved?.entityRefs.before).toStrictEqual({
      entityKind: 'field-event',
      entityId: captured.state.entityId,
    });
    expect(resolved?.entityRefs.after).toStrictEqual({
      entityKind: 'field-event',
      entityId: captured.state.entityId,
    });
    expect(resolved?.occurredAt).toBe(NOW);
  });
});

// ----- direct envelope builder ----------------------------------------------------

describe('fieldEventEnvelope (trusted builder, self-checked)', () => {
  const command = envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-builder-1');

  it('propagates the command causality and validates through the contracts parser', () => {
    const event = fieldEventEnvelope({
      command,
      eventName: ISSUE_RAISED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
      occurredAt: LATER,
      entityRefs: { before: null, after: { entityKind: ISSUE_KIND, entityId: PARTY } },
      payload: {
        issueId: PARTY,
        title: 'Cracked formwork on column C-12',
        description: null,
        category: 'structural-defect',
        severity: 'high',
        status: 'open',
        reportedAt: LATER,
        reportedBy: PARTY,
        version: 1,
        createdAt: LATER,
      },
    });
    expect(event.eventName).toBe('field.issueRaised');
    expect(event.causality.correlationId).toBe('corr-0f1e2d3c4b5a');
    expect(event.causality.causationId).toBe('idem-builder-1');
    expect(event.source).toBe('domain');
    expect(event.occurredAt).toBe(LATER);
  });
});

// ----- EventSink port -------------------------------------------------------------

describe('EventSink port implementations', () => {
  it('the in-memory sink records appends with the executor it was handed', async () => {
    const sink = createInMemoryEventSink();
    const executor: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
    const command = envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-sink-1');
    const event = fieldEventEnvelope({
      command,
      eventName: FIELD_EVENT_CAPTURED_EVENT,
      scope: { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 },
      occurredAt: NOW,
      entityRefs: { before: null, after: { entityKind: FIELD_EVENT_KIND, entityId: PARTY } },
      payload: {
        fieldEventId: PARTY,
        category: 'delivery-arrival',
        summary: 'Concrete pour started at level 3',
        detail: null,
        location: 'Level 3, north face',
        observedAt: NOW,
        observedBy: PARTY,
        quantity: null,
        evidence: [],
        status: 'open',
        version: 1,
        createdAt: NOW,
      },
    });
    const result = await sink.appendEvents(executor, [event]);
    expect(result.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(executor);
    expect(sink.appends[0]?.events).toStrictEqual([event]);
    expect(sink.events).toStrictEqual([event]);
  });

  it('the failing sink returns a typed invariant-violation', async () => {
    const sink = failingEventSink('ledger unavailable');
    const result = await sink.appendEvents(FAKE_EXECUTOR, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    }
  });
});

// ----- the sink failure aborts the whole mutation ---------------------------------

describe('a failing EventSink aborts the mutation (atomicity at the port)', () => {
  it('rolls back a capture: no state, no event, nothing recorded', async () => {
    const sink = failingEventSink('ledger unavailable');
    const deps = makeDeps(sink);
    const commands = createFieldCommands(deps);
    const result = await commands.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-failing-1'),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('event-sink-rejected');
    expect(deps.store.fieldEvents()).toHaveLength(0);
  });

  it('rolls back an update: the aggregate is left exactly as it was', async () => {
    const sink = createInMemoryEventSink();
    const deps = makeDeps(sink);
    const commands = createFieldCommands(deps);
    const captured = await expectOk(
      commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, 'idem-failing-2'),
        grant,
      ),
    );

    // A second service over the SAME store, but with a failing sink: the
    // resolve aborts after the sink rejects — version and status unchanged.
    const failingCommands = createFieldCommands({ ...deps, eventSink: failingEventSink('outage') });
    const failed = await failingCommands.fieldEvents.resolveFieldEvent(
      envelope(
        { fieldEventId: captured.state.entityId, expectedVersion: 1 },
        RESOLVE_FIELD_EVENT_COMMAND,
        'idem-failing-3',
      ),
      grant,
    );
    expect(failed.ok).toBe(false);
    const state = deps.store.fieldEvents()[0];
    expect(state?.version).toBe(1);
    expect(state?.status).toBe('open');
    // Only the capture event was ever emitted.
    expect(sink.events).toHaveLength(1);

    // And because failures are never recorded, the retry over the healthy
    // sink with the same key now succeeds.
    const retried = await expectOk(
      commands.fieldEvents.resolveFieldEvent(
        envelope(
          { fieldEventId: captured.state.entityId, expectedVersion: 1 },
          RESOLVE_FIELD_EVENT_COMMAND,
          'idem-failing-3',
        ),
        grant,
      ),
    );
    expect(retried.state.status).toBe('resolved');
  });
});

// ----- one event per mutation -----------------------------------------------------

describe('every mutation emits exactly one envelope', () => {
  it('walks the issue lifecycle emitting one event per mutation', async () => {
    const sink = createInMemoryEventSink();
    const commands = createFieldCommands(makeDeps(sink));
    const issue = await expectOk(
      commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
          'idem-walk-1',
        ),
        grant,
      ),
    );
    await expectOk(
      commands.issues.assignIssue(
        envelope(
          { issueId: issue.state.entityId, expectedVersion: 1, assignee: PARTY },
          ASSIGN_ISSUE_COMMAND,
          'idem-walk-2',
        ),
        grant,
      ),
    );
    await expectOk(
      commands.issues.commentOnIssue(
        envelope(
          { issueId: issue.state.entityId, expectedVersion: 2, body: 'Escalated' },
          COMMENT_ON_ISSUE_COMMAND,
          'idem-walk-3',
        ),
        grant,
      ),
    );

    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      'field.issueRaised',
      'field.issueAssigned',
      'field.issueCommented',
    ]);
    for (const event of sink.events) {
      expect(event.source).toBe('domain');
      expect(event.scope).toStrictEqual({ kind: 'project', tenantId: TENANT_A, projectId: PROJECT_1 });
      expect(event.actor).toStrictEqual({ kind: 'user', actorId: USER });
    }
  });
});
