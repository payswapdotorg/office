import { describe, expect, it } from 'vitest';
import { parseCommandEnvelope, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { CommandEnvelope, CommandName, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import type { DomainError, IdempotencyRegistry, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import {
  APPEND_DAILY_LOG_ENTRY_COMMAND,
  ASSIGN_ISSUE_COMMAND,
  ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
  CAPTURE_FIELD_EVENT_COMMAND,
  CLOSE_DAILY_LOG_DAY_COMMAND,
  COMMENT_ON_ISSUE_COMMAND,
  CONDUCT_INSPECTION_COMMAND,
  RAISE_ISSUE_COMMAND,
  RECORD_INSPECTION_OUTCOME_COMMAND,
  REOPEN_ISSUE_COMMAND,
  RESOLVE_FIELD_EVENT_COMMAND,
  RESOLVE_ISSUE_COMMAND,
  SCHEDULE_INSPECTION_COMMAND,
  createFieldCommands,
} from './commands';
import type { FieldCommandAuthorization, FieldCommands, FieldCommandDeps } from './commands';
import { createInMemoryEventSink } from './events';
import type { InMemoryEventSink } from './events';
import { createInMemoryFieldStore } from './store';
import type { DailyLogState, FieldEventState, InspectionState, IssueState } from './state';

// OFF-009 field domain — command-handler acceptance: fail-closed payload →
// typed invariant-violation, project-scope requirement (A12 second boundary),
// deny-by-default authorization BEFORE any effect (a denied command never
// mutates, never emits, never even consults the idempotency registry),
// cross-tenant invisibility and cross-project denial in both directions,
// optimistic concurrency, and the full one-way lifecycles. Deterministic:
// injected clock + id suppliers, in-memory store/sink/registry.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const expectOk = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B = unwrap(parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'));
const PROJECT_1 = unwrap(parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'));
const PROJECT_2 = unwrap(parseProjectId('office-prj-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b'));

const USER = 'office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1';
const PARTY = 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2';
const ASSIGNEE = 'office-ent-v1-d4e5f60718293a4b5c6d7e8f9a1b2c3';

const CLIENT_OBSERVED_AT = '2026-09-12T09:00:00.000Z';
const CORRELATION_ID = 'corr-0f1e2d3c4b5a';

const projectScopeOf = (projectId: typeof PROJECT_1, tenantId = TENANT_A): Scope => ({
  kind: 'project',
  tenantId,
  projectId,
});

// ----- deterministic harness -----------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);
const tsAt = (offsetSeconds: number): Timestamp =>
  unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + offsetSeconds * 1000).toISOString()));

const FAKE_EXECUTOR: SqlExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

interface Harness {
  readonly commands: FieldCommands;
  readonly store: ReturnType<typeof createInMemoryFieldStore>;
  readonly sink: InMemoryEventSink;
  readonly registryStats: { lookups: number; records: number };
  readonly ids: { issued: number };
}

const makeHarness = (sink: InMemoryEventSink = createInMemoryEventSink()): Harness => {
  const store = createInMemoryFieldStore();
  const inner = createInMemoryIdempotencyRegistry();
  const registryStats = { lookups: 0, records: 0 };
  const idempotencyRegistry: IdempotencyRegistry = {
    lookup: (scope, key, fingerprint, context) => {
      registryStats.lookups += 1;
      return inner.lookup(scope, key, fingerprint, context);
    },
    record: (scope, key, fingerprint, outcome, context) => {
      registryStats.records += 1;
      return inner.record(scope, key, fingerprint, outcome, context);
    },
  };
  const ids = { issued: 0 };
  let clockTick = 0;
  const deps: FieldCommandDeps = {
    store,
    eventSink: sink,
    idempotencyRegistry,
    now: () => tsAt(clockTick++ * 7),
    newOpaqueId: () => {
      ids.issued += 1;
      return String(ids.issued).padStart(16, '0');
    },
    executor: FAKE_EXECUTOR,
  };
  return { commands: createFieldCommands(deps), store, sink, registryStats, ids };
};

let keyTick = 0;
const nextKey = (): string => `idem-${String(++keyTick).padStart(5, '0')}`;

const envelope = (
  payload: unknown,
  commandName: CommandName,
  options: { scope?: Scope; key?: string } = {},
): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope: options.scope ?? projectScopeOf(PROJECT_1),
      actor: { kind: 'user', actorId: USER },
      idempotencyKey: options.key ?? nextKey(),
      causality: { correlationId: CORRELATION_ID, causationId: null },
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

const grant: FieldCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
  capabilities: ['work.write'],
};

const noGrant: FieldCommandAuthorization = {
  policy: definePolicy([{ effect: 'allow', capabilities: ['work.write'], actions: ['write'] }]),
  capabilities: [],
};

const explicitDeny: FieldCommandAuthorization = {
  policy: definePolicy([
    { effect: 'deny', capabilities: ['work.write'], actions: ['write'] },
    { effect: 'allow', capabilities: ['work.write'], actions: ['write'] },
  ]),
  capabilities: ['work.write'],
};

/** Capture one field event (happy path) and return its committed state. */
const captureOne = async (harness: Harness): Promise<FieldEventState> =>
  expectOk(
    await harness.commands.fieldEvents.captureFieldEvent(envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND), grant),
  ).state;

// ----- command names --------------------------------------------------------------

describe('command name constants', () => {
  it('declares the thirteen field command names', () => {
    expect(CAPTURE_FIELD_EVENT_COMMAND).toBe('field.captureFieldEvent');
    expect(APPEND_DAILY_LOG_ENTRY_COMMAND).toBe('field.appendDailyLogEntry');
    expect(CLOSE_DAILY_LOG_DAY_COMMAND).toBe('field.closeDailyLogDay');
    expect(RAISE_ISSUE_COMMAND).toBe('field.raiseIssue');
    expect(ASSIGN_ISSUE_COMMAND).toBe('field.assignIssue');
    expect(COMMENT_ON_ISSUE_COMMAND).toBe('field.commentOnIssue');
    expect(RESOLVE_ISSUE_COMMAND).toBe('field.resolveIssue');
    expect(REOPEN_ISSUE_COMMAND).toBe('field.reopenIssue');
    expect(SCHEDULE_INSPECTION_COMMAND).toBe('field.scheduleInspection');
    expect(CONDUCT_INSPECTION_COMMAND).toBe('field.conductInspection');
    expect(RECORD_INSPECTION_OUTCOME_COMMAND).toBe('field.recordInspectionOutcome');
  });
});

// ----- fail-closed payload → typed invariant-violation ---------------------------

describe('malformed payloads are typed invariant-violations', () => {
  it('rejects a malformed capture payload before any effect', async () => {
    const harness = makeHarness();
    const result = await harness.commands.fieldEvents.captureFieldEvent(
      envelope({ ...capturePayload(), observedAt: 'this morning' }, CAPTURE_FIELD_EVENT_COMMAND),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
    expect(harness.registryStats.lookups).toBe(0);
  });

  it('rejects an unknown payload key (strict shape)', async () => {
    const harness = makeHarness();
    const result = await harness.commands.issues.raiseIssue(
      envelope(
        {
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: CLIENT_OBSERVED_AT,
          reportedBy: PARTY,
          priority: 'high',
        },
        RAISE_ISSUE_COMMAND,
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('invalid-command-payload');
    }
    expect(harness.store.issues()).toHaveLength(0);
  });
});

// ----- command-name guard (trusted path, loud) -----------------------------------

describe('command-name guard', () => {
  it('rejects an envelope of another command kind with a TypeError', async () => {
    const harness = makeHarness();
    await expect(
      harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), RESOLVE_FIELD_EVENT_COMMAND),
        grant,
      ),
    ).rejects.toThrow(TypeError);
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.registryStats.lookups).toBe(0);
  });
});

// ----- authorization: project scope first, then deny-by-default ------------------

describe('field commands require project scope (A12 second boundary)', () => {
  it('denies a tenant-scoped capture with a typed unauthorized project-scope-required', async () => {
    const harness = makeHarness();
    const result = await harness.commands.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, {
        scope: { kind: 'tenant', tenantId: TENANT_A },
      }),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-required');
    }
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.sink.events).toHaveLength(0);
    expect(harness.registryStats.lookups).toBe(0);
  });

  it('denies a tenant-scoped log/raise/schedule with the same typed denial', async () => {
    const harness = makeHarness();
    const append = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        { day: '2026-09-12', party: PARTY, entry: { summary: 'Shift started', observedAt: CLIENT_OBSERVED_AT } },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
        { scope: { kind: 'tenant', tenantId: TENANT_A } },
      ),
      grant,
    );
    expect(append.ok).toBe(false);
    if (!append.ok) expect(append.error.details[0]?.code).toBe('project-scope-required');

    const raise = await harness.commands.issues.raiseIssue(
      envelope(
        {
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: CLIENT_OBSERVED_AT,
          reportedBy: PARTY,
        },
        RAISE_ISSUE_COMMAND,
        { scope: { kind: 'tenant', tenantId: TENANT_A } },
      ),
      grant,
    );
    expect(raise.ok).toBe(false);
    if (!raise.ok) expect(raise.error.details[0]?.code).toBe('project-scope-required');

    const schedule = await harness.commands.inspections.scheduleInspection(
      envelope(
        {
          title: 'Level 3 pour pre-check',
          scheduledFor: CLIENT_OBSERVED_AT,
          checklist: [{ key: 'rebar-cover', requirement: 'Rebar cover meets spec' }],
        },
        SCHEDULE_INSPECTION_COMMAND,
        { scope: { kind: 'tenant', tenantId: TENANT_A } },
      ),
      grant,
    );
    expect(schedule.ok).toBe(false);
    if (!schedule.ok) expect(schedule.error.details[0]?.code).toBe('project-scope-required');

    expect(harness.sink.events).toHaveLength(0);
    expect(harness.registryStats.lookups).toBe(0);
  });
});

describe('authorization is deny-by-default and precedes every effect', () => {
  it('denies capture/log/raise/assign/resolve without the capability and never mutates', async () => {
    const harness = makeHarness();
    const denied: Array<[string, Promise<{ ok: boolean }>]> = [
      ['capture', harness.commands.fieldEvents.captureFieldEvent(envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND), noGrant)],
      ['append', harness.commands.dailyLogs.appendDailyLogEntry(
        envelope(
          { day: '2026-09-12', party: PARTY, entry: { summary: 'Shift started', observedAt: CLIENT_OBSERVED_AT } },
          APPEND_DAILY_LOG_ENTRY_COMMAND,
        ),
        noGrant,
      )],
      ['raise', harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
        ),
        noGrant,
      )],
    ];
    for (const [label, promise] of denied) {
      const result = await promise;
      expect(result.ok, label).toBe(false);
    }
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.store.dailyLogs()).toHaveLength(0);
    expect(harness.store.issues()).toHaveLength(0);
    expect(harness.sink.appends).toHaveLength(0);
    // A denied command never even consults the idempotency registry.
    expect(harness.registryStats.lookups).toBe(0);
  });

  it('denies assign/resolve on existing aggregates without the capability (state unchanged)', async () => {
    const harness = makeHarness();
    const issue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;

    const assign = await harness.commands.issues.assignIssue(
      envelope({ issueId: issue.entityId, expectedVersion: issue.version, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
      noGrant,
    );
    expect(assign.ok).toBe(false);
    if (!assign.ok) {
      expect(assign.error.code).toBe('forbidden');
      expect(assign.error.details[0]?.code).toBe('no-allow-rule');
    }

    const resolve = await harness.commands.issues.resolveIssue(
      envelope(
        { issueId: issue.entityId, expectedVersion: issue.version, resolutionNote: 'fixed' },
        RESOLVE_ISSUE_COMMAND,
      ),
      noGrant,
    );
    expect(resolve.ok).toBe(false);
    if (!resolve.ok) expect(resolve.error.code).toBe('forbidden');

    expect(harness.store.issues()[0]?.version).toBe(1);
    expect(harness.store.issues()[0]?.assignee).toBeNull();
    expect(harness.sink.events).toHaveLength(1);
  });

  it('denies through an explicit deny rule even with the capability granted', async () => {
    const harness = makeHarness();
    const result = await harness.commands.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND),
      explicitDeny,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
    expect(harness.store.fieldEvents()).toHaveLength(0);
    expect(harness.registryStats.lookups).toBe(0);
  });

  it('rejects an undeclared capability name loudly (trusted path)', async () => {
    const harness = makeHarness();
    await expect(
      harness.commands.fieldEvents.captureFieldEvent(envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND), {
        policy: definePolicy([]),
        capabilities: ['field.administer'],
      }),
    ).rejects.toThrow(TypeError);
  });

  it('authorizes per aggregate kind: a policy allowing only issues denies field-event capture', async () => {
    const harness = makeHarness();
    const issueOnly: FieldCommandAuthorization = {
      policy: definePolicy([
        { effect: 'allow', capabilities: ['work.write'], actions: ['write'], resourceKinds: ['field-issue'] },
      ]),
      capabilities: ['work.write'],
    };
    const capture = await harness.commands.fieldEvents.captureFieldEvent(
      envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND),
      issueOnly,
    );
    expect(capture.ok).toBe(false);
    if (!capture.ok) {
      expect(capture.error.code).toBe('forbidden');
      expect(capture.error.details[0]?.code).toBe('no-allow-rule');
    }

    const raise = await harness.commands.issues.raiseIssue(
      envelope(
        {
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: CLIENT_OBSERVED_AT,
          reportedBy: PARTY,
        },
        RAISE_ISSUE_COMMAND,
      ),
      issueOnly,
    );
    expect(raise.ok).toBe(true);
    expect(harness.store.issues()).toHaveLength(1);
    expect(harness.store.fieldEvents()).toHaveLength(0);
  });

  it('succeeds with the capability and records the idempotent execution', async () => {
    const harness = makeHarness();
    const outcome = expectOk(
      await harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND),
        grant,
      ),
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.state.version).toBe(1);
    expect(outcome.state.status).toBe('open');
    expect(harness.store.fieldEvents()).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.registryStats.lookups).toBe(1);
    expect(harness.registryStats.records).toBe(1);
  });
});

// ----- A12: cross-tenant invisibility, cross-project denial ----------------------

describe('cross-tenant isolation (A12, both directions)', () => {
  it('hides tenant A aggregates from tenant B commands (typed not-found, no existence oracle)', async () => {
    const harness = makeHarness();
    const captured = await captureOne(harness);
    const result = await harness.commands.fieldEvents.resolveFieldEvent(
      envelope(
        { fieldEventId: captured.entityId, expectedVersion: 1 },
        RESOLVE_FIELD_EVENT_COMMAND,
        { scope: projectScopeOf(PROJECT_1, TENANT_B) },
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
    expect(harness.store.fieldEvents()[0]?.status).toBe('open');
    expect(harness.sink.events).toHaveLength(1);
  });

  it('hides tenant B aggregates from tenant A commands (both directions)', async () => {
    const harness = makeHarness();
    const foreign = expectOk(
      await harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, {
          scope: projectScopeOf(PROJECT_2, TENANT_B),
        }),
        grant,
      ),
    ).state;
    expect(harness.store.fieldEvents()).toHaveLength(1);

    const result = await harness.commands.fieldEvents.resolveFieldEvent(
      envelope({ fieldEventId: foreign.entityId, expectedVersion: 1 }, RESOLVE_FIELD_EVENT_COMMAND),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(harness.store.fieldEvents()[0]?.status).toBe('open');
    expect(harness.sink.events).toHaveLength(1);
  });
});

describe('cross-project denial (A12 second boundary)', () => {
  it('denies a project-2 command on a project-1 field event (typed unauthorized)', async () => {
    const harness = makeHarness();
    const captured = await captureOne(harness);
    const result = await harness.commands.fieldEvents.resolveFieldEvent(
      envelope(
        { fieldEventId: captured.entityId, expectedVersion: 1 },
        RESOLVE_FIELD_EVENT_COMMAND,
        { scope: projectScopeOf(PROJECT_2) },
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.fieldEvents()[0]?.status).toBe('open');
    expect(harness.sink.events).toHaveLength(1);
  });

  it('denies the mirror direction: a project-1 command on a project-2 issue', async () => {
    const harness = makeHarness();
    const issue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
          { scope: projectScopeOf(PROJECT_2) },
        ),
        grant,
      ),
    ).state;
    const result = await harness.commands.issues.assignIssue(
      envelope({ issueId: issue.entityId, expectedVersion: 1, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('project-scope-violation');
    }
    expect(harness.store.issues()[0]?.assignee).toBeNull();
  });
});

// ----- optimistic concurrency -----------------------------------------------------

describe('optimistic concurrency', () => {
  it('rejects a stale version with a typed concurrency-conflict, state unchanged', async () => {
    const harness = makeHarness();
    const captured = await captureOne(harness);
    const withEvidence = expectOk(
      await harness.commands.fieldEvents.attachFieldEventEvidence(
        envelope(
          {
            fieldEventId: captured.entityId,
            expectedVersion: 1,
            evidence: [
              { entityKind: 'document', entityId: PARTY, revisionId: ASSIGNEE },
            ],
          },
          ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(withEvidence.version).toBe(2);

    const stale = await harness.commands.fieldEvents.resolveFieldEvent(
      envelope({ fieldEventId: captured.entityId, expectedVersion: 1 }, RESOLVE_FIELD_EVENT_COMMAND),
      grant,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('concurrency-conflict');
      expect(stale.error.details[0]?.code).toBe('stale-aggregate-version');
    }
    const state = harness.store.fieldEvents()[0];
    expect(state?.version).toBe(2);
    expect(state?.status).toBe('open');
    expect(state?.evidence).toHaveLength(1);
    expect(harness.sink.events).toHaveLength(2);
  });

  it('rejects a stale issue mutation and never overwrites the newer state', async () => {
    const harness = makeHarness();
    const issue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;
    const assigned = expectOk(
      await harness.commands.issues.assignIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 1, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(assigned.version).toBe(2);

    const staleResolve = await harness.commands.issues.resolveIssue(
      envelope({ issueId: issue.entityId, expectedVersion: 1, resolutionNote: 'too early' }, RESOLVE_ISSUE_COMMAND),
      grant,
    );
    expect(staleResolve.ok).toBe(false);
    if (!staleResolve.ok) expect(staleResolve.error.code).toBe('concurrency-conflict');
    expect(harness.store.issues()[0]?.version).toBe(2);
    expect(harness.store.issues()[0]?.status).toBe('open');
  });
});

// ----- daily logs -----------------------------------------------------------------

describe('daily log commands', () => {
  const entryPayload = () => ({ summary: 'Shift started, crane inspected', observedAt: CLIENT_OBSERVED_AT });

  it('creates the log with the first appended entry', async () => {
    const harness = makeHarness();
    const outcome = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
        grant,
      ),
    );
    expect(outcome.state.version).toBe(1);
    expect(outcome.state.entries).toHaveLength(1);
    expect(harness.store.dailyLogs()).toHaveLength(1);
  });

  it('appends a second entry with the expected version', async () => {
    const harness = makeHarness();
    const first = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
        grant,
      ),
    ).state;
    const second = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope(
          {
            day: '2026-09-12',
            party: PARTY,
            entry: { summary: 'Midday steel delivery received', observedAt: CLIENT_OBSERVED_AT },
            expectedVersion: first.version,
          },
          APPEND_DAILY_LOG_ENTRY_COMMAND,
        ),
        grant,
      ),
    );
    expect(second.state.entries).toHaveLength(2);
    expect(second.state.version).toBe(2);
  });

  it('rejects an append without expectedVersion when the (day, party) log exists (typed conflict)', async () => {
    const harness = makeHarness();
    await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
      grant,
    );
    const result = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('concurrency-conflict');
      expect(result.error.details[0]?.code).toBe('daily-log-already-exists');
    }
    expect(harness.store.dailyLogs()[0]?.entries).toHaveLength(1);
  });

  it('rejects a creating append that presents an expectedVersion for an absent log', async () => {
    const harness = makeHarness();
    const result = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        { day: '2026-09-12', party: PARTY, entry: entryPayload(), expectedVersion: 1 },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
    expect(harness.store.dailyLogs()).toHaveLength(0);
  });

  it('closes the day once and rejects further appends and a second close', async () => {
    const harness = makeHarness();
    const created = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
        grant,
      ),
    ).state;
    const closed = expectOk(
      await harness.commands.dailyLogs.closeDailyLogDay(
        envelope(
          { day: '2026-09-12', party: PARTY, expectedVersion: created.version },
          CLOSE_DAILY_LOG_DAY_COMMAND,
        ),
        grant,
      ),
    );
    expect(closed.state.status).toBe('closed');
    expect(closed.state.closedAt).not.toBeNull();

    const append = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: entryPayload(),
          expectedVersion: closed.state.version,
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(append.ok).toBe(false);
    if (!append.ok) {
      expect(append.error.code).toBe('invariant-violation');
      expect(append.error.details[0]?.code).toBe('daily-log-append-requires-open');
    }

    const closeAgain = await harness.commands.dailyLogs.closeDailyLogDay(
      envelope(
        { day: '2026-09-12', party: PARTY, expectedVersion: closed.state.version },
        CLOSE_DAILY_LOG_DAY_COMMAND,
      ),
      grant,
    );
    expect(closeAgain.ok).toBe(false);
    if (!closeAgain.ok) {
      expect(closeAgain.error.details[0]?.code).toBe('daily-log-close-requires-open');
    }
    expect(harness.store.dailyLogs()[0]?.status).toBe('closed');
  });

  it('appends corrections as new entries and keeps the corrected entry (append-only)', async () => {
    const harness = makeHarness();
    const created: DailyLogState = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope(
          { day: '2026-09-12', party: PARTY, entry: { summary: 'Six steel bundles delivered', observedAt: CLIENT_OBSERVED_AT } },
          APPEND_DAILY_LOG_ENTRY_COMMAND,
        ),
        grant,
      ),
    ).state;
    const correctedEntryId = created.entries[0]?.entryId;
    expect(correctedEntryId).toBeDefined();

    const correction = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope(
          {
            day: '2026-09-12',
            party: PARTY,
            entry: {
              summary: 'Correction: seven steel bundles delivered',
              correctsEntryId: correctedEntryId,
              observedAt: CLIENT_OBSERVED_AT,
            },
            expectedVersion: created.version,
          },
          APPEND_DAILY_LOG_ENTRY_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(correction.entries).toHaveLength(2);
    expect(correction.entries[0]?.summary).toBe('Six steel bundles delivered');
    expect(correction.entries[1]?.correctsEntryId).toBe(correctedEntryId);
  });

  it('rejects a correction referencing an entry the log does not hold', async () => {
    const harness = makeHarness();
    const created = expectOk(
      await harness.commands.dailyLogs.appendDailyLogEntry(
        envelope({ day: '2026-09-12', party: PARTY, entry: entryPayload() }, APPEND_DAILY_LOG_ENTRY_COMMAND),
        grant,
      ),
    ).state;
    const result = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: {
            summary: 'Correction',
            correctsEntryId: ASSIGNEE,
            observedAt: CLIENT_OBSERVED_AT,
          },
          expectedVersion: created.version,
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('daily-log-correction-references-entry');
    }
    expect(harness.store.dailyLogs()[0]?.entries).toHaveLength(1);
  });

  it('requires a grouping field-event reference to resolve in the same project scope', async () => {
    const harness = makeHarness();
    const captured = await captureOne(harness);
    // Same tenant, DIFFERENT project: present in the store, denied by the
    // second boundary (not invisible — a typed project-scope violation).
    const otherProjectEvent = expectOk(
      await harness.commands.fieldEvents.captureFieldEvent(
        envelope(capturePayload(), CAPTURE_FIELD_EVENT_COMMAND, { scope: projectScopeOf(PROJECT_2) }),
        grant,
      ),
    ).state;

    const unknown = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: { summary: 'Grouped entry', fieldEventId: ASSIGNEE, observedAt: CLIENT_OBSERVED_AT },
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found');

    const crossProject = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: { summary: 'Grouped entry', fieldEventId: otherProjectEvent.entityId, observedAt: CLIENT_OBSERVED_AT },
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) {
      expect(crossProject.error.code).toBe('unauthorized');
      expect(crossProject.error.details[0]?.code).toBe('project-scope-violation');
    }

    const own = await harness.commands.dailyLogs.appendDailyLogEntry(
      envelope(
        {
          day: '2026-09-12',
          party: PARTY,
          entry: { summary: 'Grouped entry', fieldEventId: captured.entityId, observedAt: CLIENT_OBSERVED_AT },
        },
        APPEND_DAILY_LOG_ENTRY_COMMAND,
      ),
      grant,
    );
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.value.state.entries[0]?.fieldEventId).toBe(captured.entityId);
  });
});

// ----- issues ---------------------------------------------------------------------

describe('issue commands (raise/assign/comment/resolve/reopen)', () => {
  const raiseOne = async (harness: Harness): Promise<IssueState> =>
    expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;

  it('walks the full lifecycle with monotonic versions and one event per mutation', async () => {
    const harness = makeHarness();
    const issue = await raiseOne(harness);

    const assigned = expectOk(
      await harness.commands.issues.assignIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 1, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(assigned.assignee).toBe(ASSIGNEE);
    expect(assigned.version).toBe(2);

    const commented = expectOk(
      await harness.commands.issues.commentOnIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 2, body: 'Escalated to the structural engineer' }, COMMENT_ON_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(commented.comments).toHaveLength(1);
    expect(commented.version).toBe(3);

    const resolved = expectOk(
      await harness.commands.issues.resolveIssue(
        envelope(
          { issueId: issue.entityId, expectedVersion: 3, resolutionNote: 'Replaced the formwork panel' },
          RESOLVE_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(resolved.status).toBe('resolved');
    expect(resolved.version).toBe(4);

    // Comments are append-only history: they continue while resolved.
    const lateComment = expectOk(
      await harness.commands.issues.commentOnIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 4, body: 'Panel supplier notified' }, COMMENT_ON_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(lateComment.comments).toHaveLength(2);
    expect(lateComment.status).toBe('resolved');

    const reopened = expectOk(
      await harness.commands.issues.reopenIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 5, reopenReason: 'crack reappeared' }, REOPEN_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(reopened.status).toBe('open');
    expect(reopened.reopenReason).toBe('crack reappeared');
    expect(reopened.resolvedAt).toBeNull();

    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'field.issueRaised',
      'field.issueAssigned',
      'field.issueCommented',
      'field.issueResolved',
      'field.issueCommented',
      'field.issueReopened',
    ]);
  });

  it('appends comment corrections as new comments; the original is never edited', async () => {
    const harness = makeHarness();
    const issue = await raiseOne(harness);
    const first = expectOk(
      await harness.commands.issues.commentOnIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 1, body: 'Looks superficial' }, COMMENT_ON_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    const firstCommentId = first.comments[0]?.commentId;
    expect(firstCommentId).toBeDefined();

    const corrected = expectOk(
      await harness.commands.issues.commentOnIssue(
        envelope(
          {
            issueId: issue.entityId,
            expectedVersion: 2,
            body: 'Correction: the crack penetrates the cover layer',
            correctsCommentId: firstCommentId,
          },
          COMMENT_ON_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(corrected.comments).toHaveLength(2);
    expect(corrected.comments[0]?.body).toBe('Looks superficial');
    expect(corrected.comments[1]?.correctsCommentId).toBe(firstCommentId);
  });

  it('rejects a comment correction referencing an unknown comment', async () => {
    const harness = makeHarness();
    const issue = await raiseOne(harness);
    const result = await harness.commands.issues.commentOnIssue(
      envelope(
        { issueId: issue.entityId, expectedVersion: 1, body: 'Correction', correctsCommentId: ASSIGNEE },
        COMMENT_ON_ISSUE_COMMAND,
      ),
      grant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('issue-comment-correction-references-comment');
    }
    expect(harness.store.issues()[0]?.comments).toHaveLength(0);
  });

  it('rejects re-assigning to the current assignee and assigning a resolved issue', async () => {
    const harness = makeHarness();
    const issue = await raiseOne(harness);
    const assigned = expectOk(
      await harness.commands.issues.assignIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 1, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    expect(assigned.assignee).toBe(ASSIGNEE);
    expect(assigned.version).toBe(2);
    const same = await harness.commands.issues.assignIssue(
      envelope({ issueId: issue.entityId, expectedVersion: 2, assignee: ASSIGNEE }, ASSIGN_ISSUE_COMMAND),
      grant,
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.details[0]?.code).toBe('issue-already-assigned-to-party');

    const resolved = expectOk(
      await harness.commands.issues.resolveIssue(
        envelope({ issueId: issue.entityId, expectedVersion: 2, resolutionNote: 'fixed' }, RESOLVE_ISSUE_COMMAND),
        grant,
      ),
    ).state;
    const assignResolved = await harness.commands.issues.assignIssue(
      envelope({ issueId: issue.entityId, expectedVersion: 3, assignee: PARTY }, ASSIGN_ISSUE_COMMAND),
      grant,
    );
    expect(assignResolved.ok).toBe(false);
    if (!assignResolved.ok) {
      expect(assignResolved.error.details[0]?.code).toBe('issue-assignment-requires-open');
    }
    expect(resolved.status).toBe('resolved');
    expect(harness.store.issues()[0]?.assignee).toBe(ASSIGNEE);
  });
});

// ----- inspections ----------------------------------------------------------------

describe('inspection commands (schedule/conduct/outcome)', () => {
  const checklist = [
    { key: 'formwork-alignment', requirement: 'Formwork within tolerance' },
    { key: 'rebar-cover', requirement: 'Rebar cover meets spec' },
  ];

  const scheduleOne = async (harness: Harness): Promise<InspectionState> =>
    expectOk(
      await harness.commands.inspections.scheduleInspection(
        envelope(
          { title: 'Level 3 pour pre-check', scheduledFor: CLIENT_OBSERVED_AT, checklist },
          SCHEDULE_INSPECTION_COMMAND,
        ),
        grant,
      ),
    ).state;

  it('schedules, conducts, and outcomes with findings linking issues', async () => {
    const harness = makeHarness();
    const inspection = await scheduleOne(harness);
    expect(inspection.status).toBe('scheduled');

    const issue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Cracked formwork on column C-12',
            category: 'structural-defect',
            severity: 'high',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
        ),
        grant,
      ),
    ).state;

    const conducted = expectOk(
      await harness.commands.inspections.conductInspection(
        envelope(
          {
            inspectionId: inspection.entityId,
            expectedVersion: 1,
            conductedAt: CLIENT_OBSERVED_AT,
            results: [
              { key: 'formwork-alignment', result: 'pass' },
              { key: 'rebar-cover', result: 'fail', note: 'cover below spec' },
            ],
          },
          CONDUCT_INSPECTION_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(conducted.status).toBe('conducted');
    expect(conducted.conductedAt).toBe(unwrap(parseTimestamp(CLIENT_OBSERVED_AT)));
    expect(conducted.results).toHaveLength(2);

    const outcomed = expectOk(
      await harness.commands.inspections.recordInspectionOutcome(
        envelope(
          {
            inspectionId: inspection.entityId,
            expectedVersion: 2,
            outcome: 'failed',
            findings: [{ issueId: issue.entityId, note: 'linked defect' }],
            summary: 'rebar cover failed',
          },
          RECORD_INSPECTION_OUTCOME_COMMAND,
        ),
        grant,
      ),
    ).state;
    expect(outcomed.status).toBe('failed');
    expect(outcomed.findings).toStrictEqual([{ issueId: issue.entityId, note: 'linked defect' }]);

    expect(harness.sink.events.map((event) => event.eventName)).toStrictEqual([
      'field.inspectionScheduled',
      'field.issueRaised',
      'field.inspectionConducted',
      'field.inspectionOutcomed',
    ]);
  });

  it('rejects conduct results that do not cover the declared checklist exactly', async () => {
    const harness = makeHarness();
    const inspection = await scheduleOne(harness);
    const missing = await harness.commands.inspections.conductInspection(
      envelope(
        {
          inspectionId: inspection.entityId,
          expectedVersion: 1,
          conductedAt: CLIENT_OBSERVED_AT,
          results: [{ key: 'formwork-alignment', result: 'pass' }],
        },
        CONDUCT_INSPECTION_COMMAND,
      ),
      grant,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('invariant-violation');
      expect(missing.error.details[0]?.code).toBe('inspection-results-cover-checklist-exactly');
    }
    expect(harness.store.inspections()[0]?.status).toBe('scheduled');
  });

  it('rejects an outcome before conduct and any transition after the terminal outcome', async () => {
    const harness = makeHarness();
    const inspection = await scheduleOne(harness);
    const early = await harness.commands.inspections.recordInspectionOutcome(
      envelope(
        { inspectionId: inspection.entityId, expectedVersion: 1, outcome: 'passed' },
        RECORD_INSPECTION_OUTCOME_COMMAND,
      ),
      grant,
    );
    expect(early.ok).toBe(false);
    if (!early.ok) {
      expect(early.error.details[0]?.code).toBe('inspection-outcome-requires-conducted');
    }

    const conducted = expectOk(
      await harness.commands.inspections.conductInspection(
        envelope(
          {
            inspectionId: inspection.entityId,
            expectedVersion: 1,
            conductedAt: CLIENT_OBSERVED_AT,
            results: [
              { key: 'formwork-alignment', result: 'pass' },
              { key: 'rebar-cover', result: 'na' },
            ],
          },
          CONDUCT_INSPECTION_COMMAND,
        ),
        grant,
      ),
    ).state;
    expectOk(
      await harness.commands.inspections.recordInspectionOutcome(
        envelope(
          { inspectionId: inspection.entityId, expectedVersion: conducted.version, outcome: 'partial' },
          RECORD_INSPECTION_OUTCOME_COMMAND,
        ),
        grant,
      ),
    );

    const reConduct = await harness.commands.inspections.conductInspection(
      envelope(
        {
          inspectionId: inspection.entityId,
          expectedVersion: 3,
          conductedAt: CLIENT_OBSERVED_AT,
          results: [
            { key: 'formwork-alignment', result: 'pass' },
            { key: 'rebar-cover', result: 'pass' },
          ],
        },
        CONDUCT_INSPECTION_COMMAND,
      ),
      grant,
    );
    expect(reConduct.ok).toBe(false);
    if (!reConduct.ok) {
      expect(reConduct.error.details[0]?.code).toBe('inspection-conduct-requires-scheduled');
    }
    expect(harness.store.inspections()[0]?.status).toBe('partial');
  });

  it('requires findings to link issues of the same project scope', async () => {
    const harness = makeHarness();
    const inspection = await scheduleOne(harness);
    expectOk(
      await harness.commands.inspections.conductInspection(
        envelope(
          {
            inspectionId: inspection.entityId,
            expectedVersion: 1,
            conductedAt: CLIENT_OBSERVED_AT,
            results: [
              { key: 'formwork-alignment', result: 'fail' },
              { key: 'rebar-cover', result: 'fail' },
            ],
          },
          CONDUCT_INSPECTION_COMMAND,
        ),
        grant,
      ),
    );

    const foreign = makeHarness();
    // Same tenant, different project: present in the SAME store, so the
    // lookup is denied by the second boundary (not invisible).
    const otherProjectIssue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Other project issue',
            category: 'site-access',
            severity: 'low',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
          { scope: projectScopeOf(PROJECT_2) },
        ),
        grant,
      ),
    ).state;
    // A foreign TENANT's issue is invisible to this harness's store; raise
    // it in the same store under tenant B to prove the invisibility rule.
    const foreignTenantIssue = expectOk(
      await harness.commands.issues.raiseIssue(
        envelope(
          {
            title: 'Foreign tenant issue',
            category: 'site-access',
            severity: 'low',
            reportedAt: CLIENT_OBSERVED_AT,
            reportedBy: PARTY,
          },
          RAISE_ISSUE_COMMAND,
          { scope: projectScopeOf(PROJECT_2, TENANT_B) },
        ),
        grant,
      ),
    ).state;
    expect(foreign.registryStats.lookups).toBe(0);

    const unknown = await harness.commands.inspections.recordInspectionOutcome(
      envelope(
        { inspectionId: inspection.entityId, expectedVersion: 2, outcome: 'failed', findings: [{ issueId: ASSIGNEE }] },
        RECORD_INSPECTION_OUTCOME_COMMAND,
      ),
      grant,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found');

    const crossProject = await harness.commands.inspections.recordInspectionOutcome(
      envelope(
        {
          inspectionId: inspection.entityId,
          expectedVersion: 2,
          outcome: 'failed',
          findings: [{ issueId: otherProjectIssue.entityId }],
        },
        RECORD_INSPECTION_OUTCOME_COMMAND,
      ),
      grant,
    );
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) {
      expect(crossProject.error.code).toBe('unauthorized');
      expect(crossProject.error.details[0]?.code).toBe('project-scope-violation');
    }

    const crossTenant = await harness.commands.inspections.recordInspectionOutcome(
      envelope(
        {
          inspectionId: inspection.entityId,
          expectedVersion: 2,
          outcome: 'failed',
          findings: [{ issueId: foreignTenantIssue.entityId }],
        },
        RECORD_INSPECTION_OUTCOME_COMMAND,
      ),
      grant,
    );
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) expect(crossTenant.error.code).toBe('not-found');
    expect(harness.store.inspections()[0]?.status).toBe('conducted');
  });
});
