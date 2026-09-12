import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseEntityId, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  EntityId,
  EventName,
  ParseResult,
  ProjectId,
  Scope,
} from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  APPEND_DAILY_LOG_ENTRY_COMMAND,
  ASSIGN_ISSUE_COMMAND,
  CAPTURE_FIELD_EVENT_COMMAND,
  CLOSE_DAILY_LOG_DAY_COMMAND,
  COMMENT_ON_ISSUE_COMMAND,
  CONDUCT_INSPECTION_COMMAND,
  RAISE_ISSUE_COMMAND,
  RECORD_INSPECTION_OUTCOME_COMMAND,
  RESOLVE_FIELD_EVENT_COMMAND,
  RESOLVE_ISSUE_COMMAND,
  SCHEDULE_INSPECTION_COMMAND,
  createFieldCommands,
} from './commands';
import type { FieldCommandAuthorization, FieldCommands, FieldCommandDeps } from './commands';
import { FIELD_EVENT_CAPTURED_EVENT, createInMemoryEventSink, fieldEventEnvelope } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryFieldStore } from './store';
import { FIELD_EVENT_KIND } from './state';
import { createProjectReadModel } from './projection';
import type { ProjectReadModel } from './projection';

// OFF-009 field domain — the project read model (freeze A2/A6): an in-memory
// projection REBUILT FROM THE EMITTED EVENT ENVELOPES answers the three
// per-project reads (recent field events, open issues, inspection outcomes)
// IDENTICALLY to the aggregate states in the store — which proves the event
// shapes are sufficient to derive the views. Fail-closed: foreign event
// names, tenant-scoped envelopes, and out-of-order events are typed
// invariant-violations.

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
const PROJECT_1: ProjectId = unwrap(
  parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
);
const PROJECT_2: ProjectId = unwrap(
  parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'),
);

const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
const PARTY: EntityId = unwrap(parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'));
const ASSIGNEE = 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3';

const CLIENT_OBSERVED_AT = '2026-09-12T09:00:00.000Z';

const FAKE_EXECUTOR: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };

const grant: FieldCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
  capabilities: ['work.write'],
};

interface Harness {
  readonly commands: FieldCommands;
  readonly store: ReturnType<typeof createInMemoryFieldStore>;
  readonly sink: InMemoryEventSink;
  readonly readModel: ProjectReadModel;
}

const makeHarness = (): Harness => {
  const store = createInMemoryFieldStore();
  const sink = createInMemoryEventSink();
  const harnessIds = { issued: 0 };
  const deps: FieldCommandDeps = {
    store,
    eventSink: sink,
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    now: () => unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
    newOpaqueId: () => {
      harnessIds.issued += 1;
      return String(harnessIds.issued).padStart(16, '0');
    },
    executor: FAKE_EXECUTOR,
  };
  return {
    commands: createFieldCommands(deps),
    store,
    sink,
    readModel: createProjectReadModel(),
  };
};

let keyTick = 0;
const nextKey = (): string => `idem-${String(++keyTick).padStart(5, '0')}`;

const envelope = (payload: unknown, commandName: CommandName, scope: Scope): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: { kind: 'user', actorId: USER },
      idempotencyKey: nextKey(),
      causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

const scopeOf = (projectId: ProjectId, tenantId = TENANT_A): Scope => ({
  kind: 'project',
  tenantId,
  projectId,
});

/** Apply every emitted envelope to the read model (ledger order = sink order). */
const rebuildFromEvents = (harness: Harness): void => {
  for (const event of harness.sink.events) {
    const applied = harness.readModel.apply(event);
    if (!applied.ok) {
      throw new Error(`read model rejected an emitted event: ${JSON.stringify(applied.error)}`);
    }
  }
};

// ----- the scenario ----------------------------------------------------------------

interface Scenario {
  readonly harness: Harness;
  readonly captured: readonly { id: string; summary: string; status: 'open' | 'resolved' }[];
  readonly issues: readonly { id: string; open: boolean; assignee: string | null }[];
  readonly inspections: readonly { id: string; outcome: string | null; findings: readonly string[] }[];
}

/**
 * Project 1: three captured field events (the first later resolved), three
 * raised issues (one assigned, one resolved, one commented then resolved), a
 * daily log with two entries and a closed day, and two inspections (one
 * conducted + failed outcome linking the resolved issue, one merely
 * scheduled). Project 2: one capture and one issue (isolation proof).
 */
const runScenario = async (): Promise<Scenario> => {
  const harness = makeHarness();
  const scope1 = scopeOf(PROJECT_1);
  const scope2 = scopeOf(PROJECT_2);
  const { commands } = harness;

  const capture = (summary: string, scope: Scope) =>
    expectOk(
      commands.fieldEvents.captureFieldEvent(
        envelope(
          {
            category: 'delivery-arrival',
            summary,
            location: 'Level 3, north face',
            observedAt: CLIENT_OBSERVED_AT,
            observedBy: PARTY,
          },
          CAPTURE_FIELD_EVENT_COMMAND,
          scope,
        ),
        grant,
      ),
    ).then((outcome) => outcome.state);

  const fe1 = await capture('Concrete pour started at level 3', scope1);
  const fe2 = await capture('Steel delivery counted at gate', scope1);
  const fe3 = await capture('Crane repositioned over core', scope1);
  const feOther = await capture('Other project observation', scope2);

  const resolvedEvent = await expectOk(
    commands.fieldEvents.resolveFieldEvent(
      envelope(
        { fieldEventId: fe1.entityId, expectedVersion: 1, resolutionNote: 'accepted' },
        RESOLVE_FIELD_EVENT_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  expect(resolvedEvent.state.status).toBe('resolved');

  const raise = (title: string, scope: Scope) =>
    expectOk(
      commands.issues.raiseIssue(
        envelope(
          {
            title,
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
          scope,
        ),
        grant,
      ),
    ).then((outcome) => outcome.state);

  const issue1 = await raise('Cracked formwork on column C-12', scope1);
  const issue2 = await raise('Rebar cover below spec on deck 2', scope1);
  const issue3 = await raise('Site access blocked by staging', scope1);
  const issueOther = await raise('Other project issue', scope2);

  await expectOk(
    commands.issues.assignIssue(
      envelope(
        { issueId: issue1.entityId, expectedVersion: 1, assignee: ASSIGNEE },
        ASSIGN_ISSUE_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.issues.commentOnIssue(
      envelope(
        { issueId: issue2.entityId, expectedVersion: 1, body: 'Confirmed during pour walkthrough' },
        COMMENT_ON_ISSUE_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.issues.resolveIssue(
      envelope(
        { issueId: issue2.entityId, expectedVersion: 2, resolutionNote: 'Cover restored' },
        RESOLVE_ISSUE_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.issues.resolveIssue(
      envelope(
        { issueId: issue3.entityId, expectedVersion: 1, resolutionNote: 'Staging rearranged' },
        RESOLVE_ISSUE_COMMAND,
        scope1,
      ),
      grant,
    ),
  );

  const schedule = (title: string, scope: Scope) =>
    expectOk(
      commands.inspections.scheduleInspection(
        envelope(
          {
            title,
            scheduledFor: CLIENT_OBSERVED_AT,
            checklist: [
              { key: 'formwork-alignment', requirement: 'Formwork within tolerance' },
              { key: 'rebar-cover', requirement: 'Rebar cover meets spec' },
            ],
          },
          SCHEDULE_INSPECTION_COMMAND,
          scope,
        ),
        grant,
      ),
    ).then((outcome) => outcome.state);

  const inspection1 = await schedule('Level 3 pour pre-check', scope1);
  await schedule('Level 4 pour pre-check', scope1);

  await expectOk(
    commands.inspections.conductInspection(
      envelope(
        {
          inspectionId: inspection1.entityId,
          expectedVersion: 1,
          conductedAt: CLIENT_OBSERVED_AT,
          results: [
            { key: 'formwork-alignment', result: 'pass' },
            { key: 'rebar-cover', result: 'fail', note: 'cover below spec' },
          ],
        },
        CONDUCT_INSPECTION_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.inspections.recordInspectionOutcome(
      envelope(
        {
          inspectionId: inspection1.entityId,
          expectedVersion: 2,
          outcome: 'failed',
          findings: [{ issueId: issue2.entityId, note: 'linked defect' }],
          summary: 'rebar cover failed',
        },
        RECORD_INSPECTION_OUTCOME_COMMAND,
        scope1,
      ),
      grant,
    ),
  );

  await expectOk(
    commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: { summary: 'Shift started, crane inspected', observedAt: CLIENT_OBSERVED_AT },
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: {
            summary: 'Midday steel delivery received',
            fieldEventId: fe2.entityId,
            observedAt: CLIENT_OBSERVED_AT,
          },
          expectedVersion: 1,
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
        scope1,
      ),
      grant,
    ),
  );
  await expectOk(
    commands.dailyLogs.closeDailyLogDay(
      envelope(
        { day: '2026-09-12', party: PARTY, expectedVersion: 2 },
        CLOSE_DAILY_LOG_DAY_COMMAND,
        scope1,
      ),
      grant,
    ),
  );

  return {
    harness,
    captured: [
      { id: fe1.entityId, summary: 'Concrete pour started at level 3', status: 'resolved' },
      { id: fe2.entityId, summary: 'Steel delivery counted at gate', status: 'open' },
      { id: fe3.entityId, summary: 'Crane repositioned over core', status: 'open' },
      { id: feOther.entityId, summary: 'Other project observation', status: 'open' },
    ],
    issues: [
      { id: issue1.entityId, open: true, assignee: ASSIGNEE },
      { id: issue2.entityId, open: false, assignee: null },
      { id: issue3.entityId, open: false, assignee: null },
      { id: issueOther.entityId, open: true, assignee: null },
    ],
    inspections: [
      { id: inspection1.entityId, outcome: 'failed', findings: [issue2.entityId] },
    ],
  };
};

// ----- the reads -------------------------------------------------------------------

describe('project read model rebuilt from emitted events', () => {
  it('answers recent field events (newest first) with live statuses', async () => {
    const scenario = await runScenario();
    rebuildFromEvents(scenario.harness);

    const recent = scenario.harness.readModel.recentFieldEvents(PROJECT_1, 2);
    expect(recent.map((event) => event.summary)).toStrictEqual([
      'Crane repositioned over core',
      'Steel delivery counted at gate',
    ]);

    const all = scenario.harness.readModel.recentFieldEvents(PROJECT_1, 100);
    expect(all).toHaveLength(3);
    expect(all.map((event) => event.summary)).toStrictEqual([
      'Crane repositioned over core',
      'Steel delivery counted at gate',
      'Concrete pour started at level 3',
    ]);
    // The resolved capture shows its terminal status in the view.
    expect(all.find((event) => event.summary === 'Concrete pour started at level 3')?.status).toBe('resolved');
    expect(all.every((event) => event.status === 'open' || event.status === 'resolved')).toBe(true);
    // Client-observed timestamps are payload DATA carried into the view.
    expect(all[0]?.observedAt).toBe(unwrap(parseTimestamp(CLIENT_OBSERVED_AT)));
    expect(all[0]?.observedBy).toBe(PARTY);
  });

  it('answers the currently-open issues with their assignees', async () => {
    const scenario = await runScenario();
    rebuildFromEvents(scenario.harness);

    const open = scenario.harness.readModel.openIssues(PROJECT_1);
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe('Cracked formwork on column C-12');
    expect(open[0]?.assignee).toBe(ASSIGNEE);
    expect(open[0]?.category).toBe('structural-defect');
    expect(open[0]?.severity).toBe('high');
  });

  it('answers the recorded inspection outcomes with their findings', async () => {
    const scenario = await runScenario();
    rebuildFromEvents(scenario.harness);

    const outcomes = scenario.harness.readModel.inspectionOutcomes(PROJECT_1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.title).toBe('Level 3 pour pre-check');
    expect(outcomes[0]?.outcome).toBe('failed');
    expect(outcomes[0]?.findings).toHaveLength(1);
    const linkedIssue = scenario.issues.find((issue) => !issue.open && issue.id === outcomes[0]?.findings[0]);
    expect(linkedIssue).toBeDefined();
  });

  it('isolates projects (A12 second boundary at the read surface)', async () => {
    const scenario = await runScenario();
    rebuildFromEvents(scenario.harness);

    const other = scenario.harness.readModel.recentFieldEvents(PROJECT_2, 100);
    expect(other.map((event) => event.summary)).toStrictEqual(['Other project observation']);
    expect(scenario.harness.readModel.openIssues(PROJECT_2)).toHaveLength(1);
    expect(scenario.harness.readModel.inspectionOutcomes(PROJECT_2)).toHaveLength(0);
    // A project with no events at all answers empty views.
    const empty = scenario.harness.readModel.recentFieldEvents(
      unwrap(parseProjectId('office-prj-v1-9a9b9c9d9e9f9a9b9c9d9e9f9a9b9c9d9e9f')),
      10,
    );
    expect(empty).toStrictEqual([]);
  });
});

// ----- equivalence with the aggregate store ---------------------------------------

describe('read model answers identical to the aggregate state', () => {
  it('the projection matches the store for every read', async () => {
    const scenario = await runScenario();
    rebuildFromEvents(scenario.harness);
    const { harness } = scenario;

    // Field events: every store state of project 1 appears with the same
    // identity, summary, and status in the projection — and vice versa.
    const storeEvents = harness.store.fieldEvents().filter((state) => state.scope.kind === 'project' && state.scope.projectId === PROJECT_1);
    const viewEvents = harness.readModel.recentFieldEvents(PROJECT_1, 1000);
    expect(viewEvents).toHaveLength(storeEvents.length);
    for (const state of storeEvents) {
      const view = viewEvents.find((candidate) => candidate.fieldEventId === state.entityId);
      expect(view, state.entityId).toBeDefined();
      expect(view?.summary).toBe(state.summary);
      expect(view?.status).toBe(state.status);
      expect(view?.category).toBe(state.category);
      expect(view?.location).toBe(state.location);
      expect(view?.observedAt).toBe(state.observedAt);
      expect(view?.observedBy).toBe(state.observedBy);
    }

    // Open issues: the projection's open set equals the store's open set.
    const storeOpen = harness.store
      .issues()
      .filter((state) => state.scope.kind === 'project' && state.scope.projectId === PROJECT_1 && state.status === 'open')
      .map((state) => state.entityId)
      .sort();
    const viewOpen = harness.readModel.openIssues(PROJECT_1).map((record) => record.issueId).sort();
    expect(viewOpen).toStrictEqual(storeOpen);
    for (const state of harness.store.issues()) {
      if (state.scope.kind !== 'project' || state.scope.projectId !== PROJECT_1) continue;
      const view = viewOpen.includes(state.entityId)
        ? harness.readModel.openIssues(PROJECT_1).find((record) => record.issueId === state.entityId)
        : undefined;
      if (state.status === 'open') {
        expect(view?.assignee).toBe(state.assignee);
      } else {
        expect(view).toBeUndefined();
      }
    }

    // Inspection outcomes: the projection's outcomed set equals the store's.
    const storeOutcomed = harness.store
      .inspections()
      .filter(
        (state) =>
          state.scope.kind === 'project' &&
          state.scope.projectId === PROJECT_1 &&
          state.status !== 'scheduled' &&
          state.status !== 'conducted',
      )
      .map((state) => ({ id: state.entityId, outcome: state.status, findings: state.findings.map((f) => f.issueId) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const viewOutcomed = harness
      .readModel.inspectionOutcomes(PROJECT_1)
      .map((record) => ({ id: record.inspectionId, outcome: record.outcome, findings: [...record.findings] }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(viewOutcomed).toStrictEqual(storeOutcomed);
  });
});

// ----- fail-closed inputs ----------------------------------------------------------

describe('read model rejects what it cannot derive (fail-closed)', () => {
  const OCCURRED_AT = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));

  const command = (scope: Scope): CommandEnvelope =>
    unwrap(
      parseCommandEnvelope({
        kind: 'command',
        commandName: CAPTURE_FIELD_EVENT_COMMAND,
        scope,
        actor: { kind: 'user', actorId: USER },
        idempotencyKey: 'idem-envelope-1',
        causality: { correlationId: 'corr-0f1e2d3c4b5a', causationId: null },
        issuedAt: '2026-09-12T10:15:30.000Z',
        schemaVersion: '1.0.0',
        payload: {},
      }),
    );

  const captureEnvelopeOf = (scope: Scope, eventName: EventName) =>
    fieldEventEnvelope({
      command: command(scope),
      eventName,
      scope,
      occurredAt: OCCURRED_AT,
      entityRefs: { before: null, after: { entityKind: FIELD_EVENT_KIND, entityId: PARTY } },
      payload: {
        fieldEventId: PARTY,
        category: 'visit',
        summary: 'Site walk notes',
        detail: null,
        location: 'Site office',
        observedAt: unwrap(parseTimestamp(CLIENT_OBSERVED_AT)),
        observedBy: PARTY,
        quantity: null,
        evidence: [],
        status: 'open',
        version: 1,
        createdAt: OCCURRED_AT,
      },
    });

  it('rejects a foreign event name with a typed invariant-violation', () => {
    const readModel = createProjectReadModel();
    const envelopeWithForeignName = captureEnvelopeOf(scopeOf(PROJECT_1), 'other.thingHappened' as EventName);
    const result = readModel.apply(envelopeWithForeignName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('unknown-field-event');
    }
  });

  it('rejects a tenant-scoped envelope (field events are project-bound)', () => {
    const readModel = createProjectReadModel();
    const result = readModel.apply(
      captureEnvelopeOf({ kind: 'tenant', tenantId: TENANT_A }, FIELD_EVENT_CAPTURED_EVENT),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('read-model-requires-project-scope');
    }
  });

  it('rejects a resolution applied before its capture (ledger order is mandatory)', async () => {
    const harness = makeHarness();
    await expectOk(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(
          {
            category: 'delivery-arrival',
            summary: 'Concrete pour started at level 3',
            location: 'Level 3, north face',
            observedAt: CLIENT_OBSERVED_AT,
            observedBy: PARTY,
          },
          CAPTURE_FIELD_EVENT_COMMAND,
          scopeOf(PROJECT_1),
        ),
        grant,
      ),
    );
    await expectOk(
      harness.commands.fieldEvents.resolveFieldEvent(
        envelope(
          {
            fieldEventId: harness.store.fieldEvents()[0]?.entityId,
            expectedVersion: 1,
          },
          RESOLVE_FIELD_EVENT_COMMAND,
          scopeOf(PROJECT_1),
        ),
        grant,
      ),
    );
    // Apply ONLY the resolved event — the capture never reached the model.
    const resolvedEvent = harness.sink.events.find(
      (event) => event.eventName === 'field.fieldEventResolved',
    );
    expect(resolvedEvent).toBeDefined();
    const result = harness.readModel.apply(resolvedEvent as Parameters<ProjectReadModel['apply']>[0]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('read-model-resolves-field-event');
    }
  });
});
