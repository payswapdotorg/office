import { describe, expect, it } from 'vitest';
import type { ParseResult } from '@office/contracts';
import {
  parseAppendDailyLogEntryPayload,
  parseAssignIssuePayload,
  parseAttachFieldEventEvidencePayload,
  parseCaptureFieldEventPayload,
  parseChecklistItem,
  parseCloseDailyLogDayPayload,
  parseCommentOnIssuePayload,
  parseConductInspectionPayload,
  parseDailyLogEntryPayload,
  parseEvidenceReference,
  parseInspectionFinding,
  parseInspectionResult,
  parseMeasurement,
  parseRaiseIssuePayload,
  parseRecordInspectionOutcomePayload,
  parseReopenIssuePayload,
  parseResolveFieldEventPayload,
  parseResolveIssuePayload,
  parseScheduleInspectionPayload,
} from './commands';
import { isLogDay, parseLogDay } from './parse';

// OFF-009 field domain — fail-closed payload parsing. Every parser is total:
// a malformed payload is a typed ContractParseError (code / path / expected /
// received), never a silent default, never a throw. Strict keys: anything the
// shape does not know is rejected.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const FIELD_EVENT_ID = 'office-ent-v1-1a2b3c4d5e6f708192a3b4c5d6e7f8a9';
const ISSUE_ID = 'office-ent-v1-2b3c4d5e6f708192a3b4c5d6e7f8a9b';
const INSPECTION_ID = 'office-ent-v1-3c4d5e6f708192a3b4c5d6e7f8a9b1';
const PARTY = 'office-ent-v1-4d5e6f708192a3b4c5d6e7f8a9b1c2';
const TIMESTAMP = '2026-09-12T09:00:00.000Z';

const capturePayload = () => ({
  category: 'delivery-arrival',
  summary: 'Concrete pour started at level 3',
  location: 'Level 3, north face',
  observedAt: TIMESTAMP,
  observedBy: PARTY,
});

// ----- calendar days (daily-log scoping) ------------------------------------------

describe('parseLogDay (canonical calendar day)', () => {
  it('accepts a calendar-exact day', () => {
    expect(unwrap(parseLogDay('2026-09-12'))).toBe('2026-09-12');
    expect(isLogDay('2026-01-31')).toBe(true);
  });

  it('accepts February 29 on a leap year and rejects it otherwise', () => {
    expect(unwrap(parseLogDay('2024-02-29'))).toBe('2024-02-29');
    const result = parseLogDay('2026-02-29');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects impossible month/day combinations', () => {
    for (const day of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-00-10', '2026-09-00']) {
      const result = parseLogDay(day);
      expect(result.ok, day).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-value');
    }
  });

  it('rejects non-canonical shapes and non-strings', () => {
    for (const raw of ['2026-9-12', '26-09-12', '2026/09/12', '2026-09-12T00:00:00Z', 20260912, null, []]) {
      const result = parseLogDay(raw);
      expect(result.ok, String(raw)).toBe(false);
    }
    expect(isLogDay('2026-09-12')).toBe(true);
    expect(isLogDay('nope')).toBe(false);
  });
});

// ----- value objects --------------------------------------------------------------

describe('parseMeasurement', () => {
  it('parses a finite measurement', () => {
    expect(unwrap(parseMeasurement({ value: 42.5, unit: 'm3' }))).toStrictEqual({
      value: 42.5,
      unit: 'm3',
    });
  });

  it('rejects a non-number value, a non-finite value, and bad units', () => {
    const notNumber = parseMeasurement({ value: '42', unit: 'm3' });
    expect(notNumber.ok).toBe(false);
    if (!notNumber.ok) expect(notNumber.error.code).toBe('invalid-type');

    const notFinite = parseMeasurement({ value: Number.POSITIVE_INFINITY, unit: 'm3' });
    expect(notFinite.ok).toBe(false);
    if (!notFinite.ok) expect(notFinite.error.code).toBe('invalid-value');

    const badUnit = parseMeasurement({ value: 1, unit: '' });
    expect(badUnit.ok).toBe(false);
    if (!badUnit.ok) expect(badUnit.error.code).toBe('invalid-value');
  });

  it('rejects unknown keys and non-object roots', () => {
    const unknownKey = parseMeasurement({ value: 1, unit: 'm3', tolerance: 2 });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe('unknown-field');

    const notObject = parseMeasurement('42 m3');
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error.code).toBe('invalid-type');
  });
});

describe('parseEvidenceReference', () => {
  it('parses a typed revision link', () => {
    const result = parseEvidenceReference({
      entityKind: 'document',
      entityId: FIELD_EVENT_ID,
      revisionId: ISSUE_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.entityKind).toBe('document');
  });

  it('rejects an unknown key and a malformed canonical id', () => {
    const unknownKey = parseEvidenceReference({
      entityKind: 'document',
      entityId: FIELD_EVENT_ID,
      revisionId: ISSUE_ID,
      copy: true,
    });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe('unknown-field');

    const badId = parseEvidenceReference({
      entityKind: 'document',
      entityId: 'not-canonical',
      revisionId: ISSUE_ID,
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe('invalid-value');
  });
});

describe('parseChecklistItem / parseInspectionResult / parseInspectionFinding', () => {
  it('parses a checklist item and rejects an invalid key grammar', () => {
    expect(unwrap(parseChecklistItem({ key: 'rebar-cover', requirement: 'Meets spec' }))).toStrictEqual({
      key: 'rebar-cover',
      requirement: 'Meets spec',
    });
    const badKey = parseChecklistItem({ key: 'Rebar Cover', requirement: 'Meets spec' });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.error.code).toBe('invalid-value');
  });

  it('parses a checklist result and rejects an off-vocabulary result', () => {
    expect(unwrap(parseInspectionResult({ key: 'rebar-cover', result: 'fail', note: 'below spec' }))).toStrictEqual({
      key: 'rebar-cover',
      result: 'fail',
      note: 'below spec',
    });
    const badResult = parseInspectionResult({ key: 'rebar-cover', result: 'skip' });
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.error.code).toBe('invalid-value');
  });

  it('parses a finding and defaults its note to null', () => {
    expect(unwrap(parseInspectionFinding({ issueId: ISSUE_ID }))).toStrictEqual({
      issueId: ISSUE_ID,
      note: null,
    });
    const badIssue = parseInspectionFinding({ issueId: 'nope' });
    expect(badIssue.ok).toBe(false);
    if (!badIssue.ok) expect(badIssue.error.code).toBe('invalid-value');
  });
});

// ----- command payloads (strict keys, fail-closed) -------------------------------

describe('parseCaptureFieldEventPayload', () => {
  it('parses a full payload and a minimal one', () => {
    const full = parseCaptureFieldEventPayload({
      ...capturePayload(),
      detail: 'Pump truck positioned on the north face.',
      quantity: { value: 42.5, unit: 'm3' },
      evidence: [
        { entityKind: 'document', entityId: FIELD_EVENT_ID, revisionId: ISSUE_ID },
      ],
    });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.value.quantity).toStrictEqual({ value: 42.5, unit: 'm3' });
      expect(full.value.evidence).toHaveLength(1);
    }

    const minimal = parseCaptureFieldEventPayload(capturePayload());
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.value.detail).toBeUndefined();
  });

  it('rejects an unknown key (strict keys)', () => {
    const result = parseCaptureFieldEventPayload({ ...capturePayload(), title: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-field');
      expect(result.error.path).toBe('title');
    }
  });

  it('rejects a missing required field with its dotted path', () => {
    const { observedAt: _omitted, ...withoutObservedAt } = capturePayload();
    const result = parseCaptureFieldEventPayload(withoutObservedAt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing-field');
      expect(result.error.path).toBe('observedAt');
    }
  });

  it('rejects an explicit null optional field (null is not absent)', () => {
    const result = parseCaptureFieldEventPayload({ ...capturePayload(), detail: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });

  it('rejects a malformed timestamp and a malformed actor id', () => {
    const badTime = parseCaptureFieldEventPayload({ ...capturePayload(), observedAt: 'today' });
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) {
      expect(badTime.error.code).toBe('invalid-value');
      expect(badTime.error.path).toBe('observedAt');
    }

    const badActor = parseCaptureFieldEventPayload({ ...capturePayload(), observedBy: 'me' });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.code).toBe('invalid-value');
  });

  it('rejects an off-grammar category and duplicate evidence triples', () => {
    const badCategory = parseCaptureFieldEventPayload({ ...capturePayload(), category: 'Delivery' });
    expect(badCategory.ok).toBe(false);
    if (!badCategory.ok) expect(badCategory.error.code).toBe('invalid-value');

    const duplicate = parseEvidenceReference({
      entityKind: 'document',
      entityId: FIELD_EVENT_ID,
      revisionId: ISSUE_ID,
    });
    expect(duplicate.ok).toBe(true);
    const dup = parseCaptureFieldEventPayload({
      ...capturePayload(),
      evidence: [unwrap(duplicate), unwrap(duplicate)],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe('invalid-value');
      expect(dup.error.path).toBe('evidence[1]');
    }
  });

  it('rejects a non-object root', () => {
    const result = parseCaptureFieldEventPayload('capture');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-type');
  });
});

describe('parseAttachFieldEventEvidencePayload / parseResolveFieldEventPayload', () => {
  const evidenceLink = () => ({
    entityKind: 'document',
    entityId: FIELD_EVENT_ID,
    revisionId: ISSUE_ID,
  });

  it('parses an attach payload and requires at least one link', () => {
    const ok = parseAttachFieldEventEvidencePayload({
      fieldEventId: FIELD_EVENT_ID,
      expectedVersion: 1,
      evidence: [evidenceLink()],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.evidence).toHaveLength(1);

    const empty = parseAttachFieldEventEvidencePayload({
      fieldEventId: FIELD_EVENT_ID,
      expectedVersion: 1,
      evidence: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('invalid-value');
      expect(empty.error.path).toBe('evidence');
    }
  });

  it('rejects an attach payload with a non-positive expected version', () => {
    const result = parseAttachFieldEventEvidencePayload({
      fieldEventId: FIELD_EVENT_ID,
      expectedVersion: 0,
      evidence: [evidenceLink()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('rejects an attach payload whose field event id is malformed', () => {
    const result = parseAttachFieldEventEvidencePayload({
      fieldEventId: 'the-event',
      expectedVersion: 1,
      evidence: [evidenceLink()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('fieldEventId');
    }
  });

  it('parses a resolve payload with an optional note', () => {
    const withNote = parseResolveFieldEventPayload({
      fieldEventId: FIELD_EVENT_ID,
      expectedVersion: 2,
      resolutionNote: 'accepted',
    });
    expect(withNote.ok).toBe(true);
    const withoutNote = parseResolveFieldEventPayload({
      fieldEventId: FIELD_EVENT_ID,
      expectedVersion: 2,
    });
    expect(withoutNote.ok).toBe(true);
    if (withoutNote.ok) expect(withoutNote.value.resolutionNote).toBeUndefined();
  });
});

describe('parseDailyLogEntryPayload / parseAppendDailyLogEntryPayload', () => {
  const entry = () => ({ summary: 'Shift started, crane inspected', observedAt: TIMESTAMP });

  it('parses an append payload that creates the log (no expectedVersion)', () => {
    const result = parseAppendDailyLogEntryPayload({
      day: '2026-09-12',
      party: PARTY,
      entry: entry(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expectedVersion).toBeUndefined();
  });

  it('parses an append payload that appends to the existing log', () => {
    const result = parseAppendDailyLogEntryPayload({
      day: '2026-09-12',
      party: PARTY,
      entry: entry(),
      expectedVersion: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expectedVersion).toBe(3);
  });

  it('rejects an impossible calendar day', () => {
    const result = parseAppendDailyLogEntryPayload({
      day: '2026-02-30',
      party: PARTY,
      entry: entry(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('day');
    }
  });

  it('rejects a malformed nested entry field with a nested path', () => {
    const result = parseAppendDailyLogEntryPayload({
      day: '2026-09-12',
      party: PARTY,
      entry: { summary: '', observedAt: TIMESTAMP },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('entry.summary');
  });

  it('rejects an entry referencing a non-canonical field event', () => {
    const result = parseAppendDailyLogEntryPayload({
      day: '2026-09-12',
      party: PARTY,
      entry: { ...entry(), fieldEventId: 'yesterday' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('entry.fieldEventId');
  });

  it('rejects an unknown key on the entry shape', () => {
    const result = parseDailyLogEntryPayload({ ...entry(), author: 'me' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('parseCloseDailyLogDayPayload', () => {
  it('parses a close payload and requires the expected version', () => {
    const ok = parseCloseDailyLogDayPayload({
      day: '2026-09-12',
      party: PARTY,
      expectedVersion: 4,
    });
    expect(ok.ok).toBe(true);

    const missing = parseCloseDailyLogDayPayload({ day: '2026-09-12', party: PARTY });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('missing-field');
  });
});

describe('parseRaiseIssuePayload', () => {
  const raisePayload = () => ({
    title: 'Cracked formwork on column C-12',
    category: 'structural-defect',
    severity: 'high',
    reportedAt: TIMESTAMP,
    reportedBy: PARTY,
  });

  it('parses a full payload (description optional)', () => {
    const full = parseRaiseIssuePayload({ ...raisePayload(), description: 'Hairline crack.' });
    expect(full.ok).toBe(true);
    const minimal = parseRaiseIssuePayload(raisePayload());
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.value.description).toBeUndefined();
  });

  it('rejects an off-vocabulary severity', () => {
    const result = parseRaiseIssuePayload({ ...raisePayload(), severity: 'blocker' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('severity');
    }
  });

  it('rejects an unknown key (strict keys)', () => {
    const result = parseRaiseIssuePayload({ ...raisePayload(), priority: 'high' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('issue mutation payload parsers (assign / comment / resolve / reopen)', () => {
  it('parses an assign payload and rejects a malformed assignee', () => {
    const ok = parseAssignIssuePayload({
      issueId: ISSUE_ID,
      expectedVersion: 1,
      assignee: PARTY,
    });
    expect(ok.ok).toBe(true);
    const bad = parseAssignIssuePayload({ issueId: ISSUE_ID, expectedVersion: 1, assignee: 'them' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid-value');
  });

  it('parses a comment payload with an optional correction reference', () => {
    const ok = parseCommentOnIssuePayload({
      issueId: ISSUE_ID,
      expectedVersion: 2,
      body: 'Escalated to the structural engineer',
      correctsCommentId: FIELD_EVENT_ID,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.correctsCommentId).toBe(FIELD_EVENT_ID);
  });

  it('requires the resolution note and the reopen reason', () => {
    const resolveMissing = parseResolveIssuePayload({ issueId: ISSUE_ID, expectedVersion: 3 });
    expect(resolveMissing.ok).toBe(false);
    if (!resolveMissing.ok) expect(resolveMissing.error.code).toBe('missing-field');

    const reopenMissing = parseReopenIssuePayload({ issueId: ISSUE_ID, expectedVersion: 3 });
    expect(reopenMissing.ok).toBe(false);
    if (!reopenMissing.ok) expect(reopenMissing.error.code).toBe('missing-field');
  });

  it('rejects an unknown key on the comment shape', () => {
    const result = parseCommentOnIssuePayload({
      issueId: ISSUE_ID,
      expectedVersion: 2,
      body: 'note',
      edited: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown-field');
  });
});

describe('inspection payload parsers (schedule / conduct / outcome)', () => {
  const schedulePayload = () => ({
    title: 'Level 3 pour pre-check',
    scheduledFor: TIMESTAMP,
    checklist: [
      { key: 'formwork-alignment', requirement: 'Formwork within tolerance' },
      { key: 'rebar-cover', requirement: 'Rebar cover meets spec' },
    ],
  });

  it('parses a schedule payload and rejects an empty checklist', () => {
    const ok = parseScheduleInspectionPayload(schedulePayload());
    expect(ok.ok).toBe(true);
    const empty = parseScheduleInspectionPayload({ ...schedulePayload(), checklist: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('invalid-value');
      expect(empty.error.path).toBe('checklist');
    }
  });

  it('rejects a checklist with duplicate keys', () => {
    const result = parseScheduleInspectionPayload({
      ...schedulePayload(),
      checklist: [
        { key: 'rebar-cover', requirement: 'First' },
        { key: 'rebar-cover', requirement: 'Duplicate' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe('checklist[1]');
  });

  it('parses a conduct payload and rejects duplicate result keys', () => {
    const ok = parseConductInspectionPayload({
      inspectionId: INSPECTION_ID,
      expectedVersion: 1,
      conductedAt: TIMESTAMP,
      results: [
        { key: 'formwork-alignment', result: 'pass' },
        { key: 'rebar-cover', result: 'fail', note: 'below spec' },
      ],
    });
    expect(ok.ok).toBe(true);

    const duplicate = parseConductInspectionPayload({
      inspectionId: INSPECTION_ID,
      expectedVersion: 1,
      conductedAt: TIMESTAMP,
      results: [
        { key: 'rebar-cover', result: 'pass' },
        { key: 'rebar-cover', result: 'fail' },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.path).toBe('results[1]');
  });

  it('parses an outcome payload and rejects duplicate findings for one issue', () => {
    const ok = parseRecordInspectionOutcomePayload({
      inspectionId: INSPECTION_ID,
      expectedVersion: 2,
      outcome: 'failed',
      findings: [{ issueId: ISSUE_ID, note: 'linked' }],
      summary: 'rebar cover failed',
    });
    expect(ok.ok).toBe(true);

    const duplicate = parseRecordInspectionOutcomePayload({
      inspectionId: INSPECTION_ID,
      expectedVersion: 2,
      outcome: 'failed',
      findings: [{ issueId: ISSUE_ID }, { issueId: ISSUE_ID }],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.path).toBe('findings[1]');
  });

  it('rejects an off-vocabulary outcome', () => {
    const result = parseRecordInspectionOutcomePayload({
      inspectionId: INSPECTION_ID,
      expectedVersion: 2,
      outcome: 'cancelled',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('outcome');
    }
  });
});
