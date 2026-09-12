import { describe, expect, it } from 'vitest';
import { parseEntityId, parseEntityKind, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityId, EntityKind, ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import { parseLogDay } from './parse';
import type { LogDay } from './parse';
import {
  appendDailyLogEntryState,
  assignIssueState,
  attachFieldEventEvidenceState,
  closeDailyLogDayState,
  commentOnIssueState,
  conductInspectionState,
  createDailyLogState,
  createFieldEventState,
  createInspectionState,
  createIssueState,
  recordInspectionOutcomeState,
  reopenIssueState,
  resolveFieldEventState,
  resolveIssueState,
} from './state';
import type {
  DailyLogEntryInput,
  DailyLogState,
  EvidenceReference,
  FieldEventState,
  InspectionState,
  IssueComment,
  IssueState,
} from './state';

// OFF-009 field domain — pure aggregate transitions and declarative
// invariants. Same discipline as the OFF-007 identity modules: deterministic
// (fixed literals, no clock, no randomness), typed Result assertions (an
// invariant violation is a DomainError value, never a throw), and explicit
// one-way lifecycles with append-only histories.

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_1: ProjectId = unwrap(
  parseProjectId('office-prj-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
);

const ent = (opaque: string): EntityId => unwrap(parseEntityId(`office-ent-v1-${opaque}`));
const kind = (literal: string): EntityKind => unwrap(parseEntityKind(literal));
const DOCUMENT_KIND: EntityKind = kind('document');
const DAY: LogDay = unwrap(parseLogDay('2026-09-12'));

const FIELD_EVENT_ID = ent('a1a2a3a4a5a6a7a8');
const DAILY_LOG_ID = ent('b1b2b3b4b5b6b7b8');
const ISSUE_ID = ent('c1c2c3c4c5c6c7c8');
const INSPECTION_ID = ent('d1d2d3d4d5d6d7d8');
const PARTY = ent('e1e2e3e4e5e6e7e8');
const ASSIGNEE = ent('f1f2f3f4f5f6f7f8');

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-12T10:16:07.000Z'));

const scopeOf = (projectId: ProjectId): Scope => ({ kind: 'project', tenantId: TENANT_A, projectId });
const PROJECT_1_SCOPE = scopeOf(PROJECT_1);
const TENANT_SCOPE: Scope = { kind: 'tenant', tenantId: TENANT_A };

const evidence = (n: number): EvidenceReference => ({
  entityKind: DOCUMENT_KIND,
  entityId: ent(`111111111111111${n}`),
  revisionId: ent(`222222222222222${n}`),
});

// ----- FieldEvent ----------------------------------------------------------------

describe('field event state creation', () => {
  it('creates an open, project-scoped field event at version 1', () => {
    const result = createFieldEventState(
      {
        fieldEventId: FIELD_EVENT_ID,
        category: 'delivery-arrival',
        summary: 'Concrete pour started at level 3',
        detail: 'Pump truck positioned on the north face.',
        location: 'Level 3, north face',
        observedAt: NOW_1,
        observedBy: PARTY,
        quantity: { value: 42.5, unit: 'm3' },
        evidence: [evidence(1)],
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;
    expect(state.entityKind).toBe('field-event');
    expect(state.entityId).toBe(FIELD_EVENT_ID);
    expect(state.scope).toStrictEqual(PROJECT_1_SCOPE);
    expect(state.version).toBe(1);
    expect(state.status).toBe('open');
    expect(state.resolvedAt).toBeNull();
    expect(state.resolutionNote).toBeNull();
    expect(state.quantity).toStrictEqual({ value: 42.5, unit: 'm3' });
    expect(state.evidence).toStrictEqual([evidence(1)]);
    expect(state.createdAt).toBe(NOW_2);
    expect(state.updatedAt).toBe(NOW_2);
  });

  it('defaults detail and quantity to null and evidence to empty', () => {
    const result = createFieldEventState(
      {
        fieldEventId: FIELD_EVENT_ID,
        category: 'visit',
        summary: 'Site walk notes',
        location: 'Site office',
        observedAt: NOW_1,
        observedBy: PARTY,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.detail).toBeNull();
    expect(result.value.quantity).toBeNull();
    expect(result.value.evidence).toStrictEqual([]);
  });

  it('rejects a tenant scope (a field event is project-bound, A12)', () => {
    const result = createFieldEventState(
      {
        fieldEventId: FIELD_EVENT_ID,
        category: 'visit',
        summary: 'Site walk notes',
        location: 'Site office',
        observedAt: NOW_1,
        observedBy: PARTY,
        now: NOW_2,
      },
      TENANT_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('field-event-is-project-scoped');
  });

  it('rejects an empty summary through the declarative invariants', () => {
    const result = createFieldEventState(
      {
        fieldEventId: FIELD_EVENT_ID,
        category: 'visit',
        summary: '',
        location: 'Site office',
        observedAt: NOW_1,
        observedBy: PARTY,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('field-event-summary-nonempty');
    }
  });

  it('rejects duplicate evidence links through the declarative invariants', () => {
    const result = createFieldEventState(
      {
        fieldEventId: FIELD_EVENT_ID,
        category: 'visit',
        summary: 'Site walk notes',
        location: 'Site office',
        observedAt: NOW_1,
        observedBy: PARTY,
        evidence: [evidence(1), evidence(1)],
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('field-event-evidence-links-unique');
  });
});

describe('field event evidence attachment (append-only)', () => {
  const openEvent = (): FieldEventState =>
    unwrap(
      createFieldEventState(
        {
          fieldEventId: FIELD_EVENT_ID,
          category: 'delivery-arrival',
          summary: 'Concrete pour started at level 3',
          location: 'Level 3, north face',
          observedAt: NOW_1,
          observedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('appends evidence with version + 1 and a fresh updatedAt', () => {
    const next = unwrap(attachFieldEventEvidenceState(openEvent(), [evidence(2)], NOW_2));
    expect(next.evidence).toStrictEqual([evidence(2)]);
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(NOW_2);
    // The prior state is untouched (pure transition).
    expect(openEvent().evidence).toStrictEqual([]);
  });

  it('rejects attaching a link that is already attached (never silently skipped)', () => {
    const withEvidence = unwrap(attachFieldEventEvidenceState(openEvent(), [evidence(1)], NOW_2));
    const again = attachFieldEventEvidenceState(withEvidence, [evidence(1)], NOW_2);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('invariant-violation');
      expect(again.error.details[0]?.code).toBe('field-event-evidence-already-attached');
    }
  });

  it('rejects attaching evidence to a resolved field event (one-way lifecycle)', () => {
    const resolved = unwrap(resolveFieldEventState(openEvent(), NOW_2, 'done'));
    const result = attachFieldEventEvidenceState(resolved, [evidence(1)], NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('field-event-evidence-requires-open');
  });
});

describe('field event resolution (one-way)', () => {
  const openEvent = (): FieldEventState =>
    unwrap(
      createFieldEventState(
        {
          fieldEventId: FIELD_EVENT_ID,
          category: 'visit',
          summary: 'Site walk notes',
          location: 'Site office',
          observedAt: NOW_1,
          observedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('resolves an open field event with a timestamp and note, version + 1', () => {
    const next = unwrap(resolveFieldEventState(openEvent(), NOW_2, 'accepted by engineer'));
    expect(next.status).toBe('resolved');
    expect(next.resolvedAt).toBe(NOW_2);
    expect(next.resolutionNote).toBe('accepted by engineer');
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(NOW_2);
  });

  it('rejects resolving an already resolved field event', () => {
    const resolved = unwrap(resolveFieldEventState(openEvent(), NOW_2));
    const again = resolveFieldEventState(resolved, NOW_2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details[0]?.code).toBe('field-event-resolve-requires-open');
  });

  it('pairs resolvedAt with the resolved status through the invariants', () => {
    const resolved = unwrap(resolveFieldEventState(openEvent(), NOW_2));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();
  });
});

// ----- DailyLog ------------------------------------------------------------------

const firstEntry = (entryId: EntityId): DailyLogEntryInput => ({
  entryId,
  summary: 'Shift started, crane inspected',
  observedAt: NOW_1,
});

describe('daily log state creation', () => {
  it('creates an open daily log holding exactly the first entry, at version 1', () => {
    const result = createDailyLogState(
      {
        dailyLogId: DAILY_LOG_ID,
        day: DAY,
        party: PARTY,
        firstEntry: firstEntry(ent('3132333435363738')),
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;
    expect(state.entityKind).toBe('daily-log');
    expect(state.day).toBe('2026-09-12');
    expect(state.party).toBe(PARTY);
    expect(state.status).toBe('open');
    expect(state.closedAt).toBeNull();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.recordedAt).toBe(NOW_2);
    expect(state.entries[0]?.observedAt).toBe(NOW_1);
    expect(state.version).toBe(1);
  });

  it('rejects a tenant scope (a daily log is project-bound, A12)', () => {
    const result = createDailyLogState(
      {
        dailyLogId: DAILY_LOG_ID,
        day: DAY,
        party: PARTY,
        firstEntry: firstEntry(ent('3132333435363738')),
        now: NOW_2,
      },
      TENANT_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('daily-log-is-project-scoped');
  });
});

describe('daily log entry appends (append-only history)', () => {
  const openLog = (): DailyLogState =>
    unwrap(
      createDailyLogState(
        {
          dailyLogId: DAILY_LOG_ID,
          day: DAY,
          party: PARTY,
          firstEntry: firstEntry(ent('3132333435363738')),
          now: NOW_1,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('appends an entry with version + 1, keeping the original untouched', () => {
    const original = openLog();
    const next = unwrap(
      appendDailyLogEntryState(
        original,
        {
          entryId: ent('4142434445464748'),
          summary: 'Midday steel delivery received',
          observedAt: NOW_1,
        },
        NOW_2,
      ),
    );
    expect(next.entries).toHaveLength(2);
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(NOW_2);
    // Append-only: the first entry is still present, unchanged.
    expect(next.entries[0]).toStrictEqual(original.entries[0]);
    // And the original state object itself was not mutated (pure transition).
    expect(original.entries).toHaveLength(1);
  });

  it('appends a correction as a NEW entry referencing the corrected one', () => {
    const original = openLog();
    const correctedEntryId = original.entries[0]?.entryId;
    expect(correctedEntryId).toBeDefined();
    const next = unwrap(
      appendDailyLogEntryState(
        original,
        {
          entryId: ent('5152535455565758'),
          summary: 'Correction: crane inspection deferred to afternoon',
          correctsEntryId: correctedEntryId,
          observedAt: NOW_1,
        },
        NOW_2,
      ),
    );
    expect(next.entries).toHaveLength(2);
    expect(next.entries[1]?.correctsEntryId).toBe(correctedEntryId);
    expect(next.entries[0]?.summary).toBe('Shift started, crane inspected');
  });

  it('rejects a correction referencing an entry the log does not hold', () => {
    const result = appendDailyLogEntryState(
      openLog(),
      {
        entryId: ent('5152535455565758'),
        summary: 'Correction',
        correctsEntryId: ent('9192939495969798'),
        observedAt: NOW_1,
      },
      NOW_2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('daily-log-correction-references-entry');
    }
  });

  it('rejects appends to a closed day (the day closes once)', () => {
    const closed = unwrap(closeDailyLogDayState(openLog(), NOW_2));
    const result = appendDailyLogEntryState(
      closed,
      { entryId: ent('4142434445464748'), summary: 'Late entry', observedAt: NOW_1 },
      NOW_2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('daily-log-append-requires-open');
  });
});

describe('daily log day close (once-only)', () => {
  const openLog = (): DailyLogState =>
    unwrap(
      createDailyLogState(
        {
          dailyLogId: DAILY_LOG_ID,
          day: DAY,
          party: PARTY,
          firstEntry: firstEntry(ent('3132333435363738')),
          now: NOW_1,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('closes the day with a timestamp, version + 1, entries retained', () => {
    const next = unwrap(closeDailyLogDayState(openLog(), NOW_2));
    expect(next.status).toBe('closed');
    expect(next.closedAt).toBe(NOW_2);
    expect(next.version).toBe(2);
    expect(next.entries).toHaveLength(1);
  });

  it('rejects closing an already closed day', () => {
    const closed = unwrap(closeDailyLogDayState(openLog(), NOW_2));
    const again = closeDailyLogDayState(closed, NOW_2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details[0]?.code).toBe('daily-log-close-requires-open');
  });
});

// ----- Issue ---------------------------------------------------------------------

describe('issue state creation', () => {
  it('creates an open, unassigned issue at version 1', () => {
    const result = createIssueState(
      {
        issueId: ISSUE_ID,
        title: 'Cracked formwork on column C-12',
        description: 'Hairline crack observed during pour.',
        category: 'structural-defect',
        severity: 'high',
        reportedAt: NOW_1,
        reportedBy: PARTY,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;
    expect(state.entityKind).toBe('field-issue');
    expect(state.status).toBe('open');
    expect(state.assignee).toBeNull();
    expect(state.assignedAt).toBeNull();
    expect(state.comments).toStrictEqual([]);
    expect(state.resolvedAt).toBeNull();
    expect(state.reopenedAt).toBeNull();
    expect(state.version).toBe(1);
  });

  it('rejects a tenant scope (an issue is project-bound, A12)', () => {
    const result = createIssueState(
      {
        issueId: ISSUE_ID,
        title: 'Cracked formwork on column C-12',
        category: 'structural-defect',
        severity: 'high',
        reportedAt: NOW_1,
        reportedBy: PARTY,
        now: NOW_2,
      },
      TENANT_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('issue-is-project-scoped');
  });

  it('rejects an unknown severity through the declarative invariants', () => {
    const result = createIssueState(
      {
        issueId: ISSUE_ID,
        title: 'Cracked formwork on column C-12',
        category: 'structural-defect',
        severity: 'blocker' as 'high',
        reportedAt: NOW_1,
        reportedBy: PARTY,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('issue-severity-vocabulary');
  });
});

describe('issue assignment', () => {
  const openIssue = (): IssueState =>
    unwrap(
      createIssueState(
        {
          issueId: ISSUE_ID,
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: NOW_1,
          reportedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('assigns an open issue with a timestamp, version + 1', () => {
    const next = unwrap(assignIssueState(openIssue(), ASSIGNEE, NOW_2));
    expect(next.assignee).toBe(ASSIGNEE);
    expect(next.assignedAt).toBe(NOW_2);
    expect(next.version).toBe(2);
  });

  it('rejects re-assigning to the current assignee (assignment changes the assignee)', () => {
    const assigned = unwrap(assignIssueState(openIssue(), ASSIGNEE, NOW_2));
    const again = assignIssueState(assigned, ASSIGNEE, NOW_2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details[0]?.code).toBe('issue-already-assigned-to-party');
  });

  it('allows reassignment to a different party', () => {
    const assigned = unwrap(assignIssueState(openIssue(), ASSIGNEE, NOW_2));
    const reassigned = unwrap(assignIssueState(assigned, PARTY, NOW_2));
    expect(reassigned.assignee).toBe(PARTY);
    expect(reassigned.version).toBe(3);
  });

  it('rejects assigning a resolved issue (reopen it first)', () => {
    const resolved = unwrap(resolveIssueState(openIssue(), NOW_2, 'fixed'));
    const result = assignIssueState(resolved, ASSIGNEE, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('issue-assignment-requires-open');
  });
});

describe('issue comments (append-only)', () => {
  const openIssue = (): IssueState =>
    unwrap(
      createIssueState(
        {
          issueId: ISSUE_ID,
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: NOW_1,
          reportedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  const comment = (n: number, corrects: EntityId | null = null): IssueComment => ({
    commentId: ent(`${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`),
    body: `Comment ${n}`,
    correctsCommentId: corrects,
    recordedAt: NOW_2,
  });

  it('appends comments while the issue is open AND while it is resolved', () => {
    const withOne = unwrap(commentOnIssueState(openIssue(), comment(1), NOW_2));
    expect(withOne.comments).toHaveLength(1);
    expect(withOne.version).toBe(2);
    const resolved = unwrap(resolveIssueState(withOne, NOW_2, 'fixed'));
    const withTwo = unwrap(commentOnIssueState(resolved, comment(2), NOW_2));
    expect(withTwo.comments).toHaveLength(2);
    expect(withTwo.status).toBe('resolved');
    expect(withTwo.version).toBe(4);
  });

  it('appends a correction as a NEW comment referencing the corrected one; the original stays', () => {
    const withOne = unwrap(commentOnIssueState(openIssue(), comment(1), NOW_2));
    const correctedId = withOne.comments[0]?.commentId;
    expect(correctedId).toBeDefined();
    const withTwo = unwrap(commentOnIssueState(withOne, comment(2, correctedId ?? null), NOW_2));
    expect(withTwo.comments).toHaveLength(2);
    expect(withTwo.comments[1]?.correctsCommentId).toBe(correctedId);
    expect(withTwo.comments[0]?.body).toBe('Comment 1');
    expect(withOne.comments).toHaveLength(1);
  });

  it('rejects a correction referencing a comment the issue does not hold', () => {
    const result = commentOnIssueState(
      openIssue(),
      comment(2, ent('9192939495969798')),
      NOW_2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('issue-comment-correction-references-comment');
    }
  });
});

describe('issue resolve / reopen (with reasons)', () => {
  const openIssue = (): IssueState =>
    unwrap(
      createIssueState(
        {
          issueId: ISSUE_ID,
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: NOW_1,
          reportedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  it('resolves an open issue with a required note, version + 1', () => {
    const next = unwrap(resolveIssueState(openIssue(), NOW_2, 'Replaced formwork panel'));
    expect(next.status).toBe('resolved');
    expect(next.resolvedAt).toBe(NOW_2);
    expect(next.resolutionNote).toBe('Replaced formwork panel');
    expect(next.version).toBe(2);
  });

  it('rejects resolving an already resolved issue', () => {
    const resolved = unwrap(resolveIssueState(openIssue(), NOW_2, 'Replaced formwork panel'));
    const again = resolveIssueState(resolved, NOW_2, 'again');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details[0]?.code).toBe('issue-resolve-requires-open');
  });

  it('reopens a resolved issue with a reason, clearing the resolution pair', () => {
    const resolved = unwrap(resolveIssueState(openIssue(), NOW_2, 'Replaced formwork panel'));
    const reopened = unwrap(reopenIssueState(resolved, NOW_2, 'crack reappeared'));
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolutionNote).toBeNull();
    expect(reopened.reopenedAt).toBe(NOW_2);
    expect(reopened.reopenReason).toBe('crack reappeared');
    expect(reopened.version).toBe(3);
  });

  it('rejects reopening an open issue', () => {
    const result = reopenIssueState(openIssue(), NOW_2, 'not resolved yet');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('issue-reopen-requires-resolved');
  });
});

// ----- Inspection ----------------------------------------------------------------

const checklist = [
  { key: 'formwork-alignment', requirement: 'Formwork within tolerance' },
  { key: 'rebar-cover', requirement: 'Rebar cover meets spec' },
];

describe('inspection state creation', () => {
  it('creates a scheduled inspection with an empty result record, at version 1', () => {
    const result = createInspectionState(
      {
        inspectionId: INSPECTION_ID,
        title: 'Level 3 pour pre-check',
        description: 'Pre-pour checklist walk',
        checklist,
        scheduledFor: NOW_1,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value;
    expect(state.entityKind).toBe('inspection');
    expect(state.status).toBe('scheduled');
    expect(state.results).toStrictEqual([]);
    expect(state.conductedAt).toBeNull();
    expect(state.findings).toStrictEqual([]);
    expect(state.outcomeAt).toBeNull();
    expect(state.version).toBe(1);
  });

  it('rejects a tenant scope (an inspection is project-bound, A12)', () => {
    const result = createInspectionState(
      {
        inspectionId: INSPECTION_ID,
        title: 'Level 3 pour pre-check',
        checklist,
        scheduledFor: NOW_1,
        now: NOW_2,
      },
      TENANT_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('inspection-is-project-scoped');
  });

  it('rejects a checklist with duplicate keys through the declarative invariants', () => {
    const result = createInspectionState(
      {
        inspectionId: INSPECTION_ID,
        title: 'Level 3 pour pre-check',
        checklist: [...checklist, { key: 'rebar-cover', requirement: 'Duplicate' }],
        scheduledFor: NOW_1,
        now: NOW_2,
      },
      PROJECT_1_SCOPE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('inspection-checklist-keys-unique');
    }
  });
});

describe('inspection conduct (immutable checklist results)', () => {
  const scheduled = (): InspectionState =>
    unwrap(
      createInspectionState(
        {
          inspectionId: INSPECTION_ID,
          title: 'Level 3 pour pre-check',
          checklist,
          scheduledFor: NOW_1,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );

  const results = (keys: readonly string[]) =>
    keys.map((key) => ({ key, result: 'pass' as const, note: null }));

  it('conducts a scheduled inspection: status, client-observed instant, version + 1', () => {
    const next = unwrap(
      conductInspectionState(scheduled(), NOW_1, results(['formwork-alignment', 'rebar-cover']), NOW_2),
    );
    expect(next.status).toBe('conducted');
    expect(next.conductedAt).toBe(NOW_1);
    expect(next.results).toHaveLength(2);
    expect(next.version).toBe(2);
  });

  it('rejects results missing a declared checklist item', () => {
    const result = conductInspectionState(scheduled(), NOW_1, results(['formwork-alignment']), NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('inspection-results-cover-checklist-exactly');
    }
  });

  it('rejects results with an extra key outside the declared checklist', () => {
    const result = conductInspectionState(
      scheduled(),
      NOW_1,
      results(['formwork-alignment', 'rebar-cover', 'site-hygiene']),
      NOW_2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('inspection-results-cover-checklist-exactly');
  });

  it('rejects conducting a non-scheduled inspection', () => {
    const conducted = unwrap(
      conductInspectionState(scheduled(), NOW_1, results(['formwork-alignment', 'rebar-cover']), NOW_2),
    );
    const again = conductInspectionState(conducted, NOW_1, results(['formwork-alignment', 'rebar-cover']), NOW_2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.details[0]?.code).toBe('inspection-conduct-requires-scheduled');
  });
});

describe('inspection outcome (terminal, with findings)', () => {
  const conducted = (): InspectionState =>
    unwrap(
      conductInspectionState(
        unwrap(
          createInspectionState(
            {
              inspectionId: INSPECTION_ID,
              title: 'Level 3 pour pre-check',
              checklist,
              scheduledFor: NOW_1,
              now: NOW_2,
            },
            PROJECT_1_SCOPE,
          ),
        ),
        NOW_1,
        [
          { key: 'formwork-alignment', result: 'pass' as const, note: null },
          { key: 'rebar-cover', result: 'fail' as const, note: 'cover below spec' },
        ],
        NOW_2,
      ),
    );

  it('records a terminal outcome with findings, version + 1', () => {
    const next = unwrap(
      recordInspectionOutcomeState(
        conducted(),
        'failed',
        [{ issueId: ISSUE_ID, note: 'linked to raised defect' }],
        'rebar cover failed',
        NOW_2,
      ),
    );
    expect(next.status).toBe('failed');
    expect(next.outcomeAt).toBe(NOW_2);
    expect(next.outcomeSummary).toBe('rebar cover failed');
    expect(next.findings).toStrictEqual([{ issueId: ISSUE_ID, note: 'linked to raised defect' }]);
    expect(next.version).toBe(3);
  });

  it('rejects an outcome on a merely scheduled inspection', () => {
    const scheduledOnly = unwrap(
      createInspectionState(
        {
          inspectionId: INSPECTION_ID,
          title: 'Level 3 pour pre-check',
          checklist,
          scheduledFor: NOW_1,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );
    const result = recordInspectionOutcomeState(scheduledOnly, 'passed', [], null, NOW_2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('inspection-outcome-requires-conducted');
  });

  it('rejects any further transition after a terminal outcome', () => {
    const terminal = unwrap(
      recordInspectionOutcomeState(conducted(), 'partial', [], 'mixed results', NOW_2),
    );
    const conduct = conductInspectionState(
      terminal,
      NOW_1,
      [
        { key: 'formwork-alignment', result: 'pass' as const, note: null },
        { key: 'rebar-cover', result: 'na' as const, note: null },
      ],
      NOW_2,
    );
    expect(conduct.ok).toBe(false);
    if (!conduct.ok) expect(conduct.error.details[0]?.code).toBe('inspection-conduct-requires-scheduled');

    const outcome = recordInspectionOutcomeState(terminal, 'passed', [], null, NOW_2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.details[0]?.code).toBe('inspection-outcome-requires-conducted');
  });
});

// ----- determinism ---------------------------------------------------------------

describe('pure transition determinism', () => {
  it('replays the same inputs into the same next state', () => {
    const current = unwrap(
      createIssueState(
        {
          issueId: ISSUE_ID,
          title: 'Cracked formwork on column C-12',
          category: 'structural-defect',
          severity: 'high',
          reportedAt: NOW_1,
          reportedBy: PARTY,
          now: NOW_2,
        },
        PROJECT_1_SCOPE,
      ),
    );
    const first = assignIssueState(current, ASSIGNEE, NOW_2);
    const second = assignIssueState(current, ASSIGNEE, NOW_2);
    expect(first).toStrictEqual(second);
  });
});
