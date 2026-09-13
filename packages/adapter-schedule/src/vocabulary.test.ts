import { describe, expect, it } from 'vitest';
import { parseCommandName, parseEventName } from '@office/contracts';
import {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  CREATE_SCHEDULE_COMMAND,
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  REMOVE_DEPENDENCY_COMMAND,
  SCHEDULE_ADAPTER_CAPABILITIES,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_CREATED_EVENT,
  SCHEDULE_EVENT_NAMES,
  SCHEDULE_OBJECT_FAMILY,
  SCHEDULE_SYNC_CAPABILITY_NAME,
  SCHEDULE_SYSTEM_ID,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  canonicalKindOfScheduleObjectKind,
  isScheduleDate,
  isScheduleEventName,
  isScheduleLinkType,
  isScheduleObjectKind,
  parseScheduleDate,
  parseScheduleEventName,
  parseScheduleLinkType,
  parseScheduleObjectKind,
  parseProviderDependencyPair,
  parseProviderIdField,
  parseNullableProviderId,
} from './vocabulary';

// OFF-023 adapter-schedule — the typed vocabularies: the generic family
// identity, the object family and its canonical-kind table, the declared
// capability block, the schedules-area command/event names (validated by the
// frozen contracts grammar), the CPM link types, the ISO calendar dates
// (pure arithmetic, leap years honored), and the provider cross-reference
// parses. Every parse is total + fail-closed.

const expectFail = (
  result: { ok: true } | { ok: false; error: { code: string; path: string; expected: string; received: string } },
  code: string,
): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
};

describe('the schedule adapter family identity (generic vocabulary)', () => {
  it('declares the generic family kind and fixture provider system', () => {
    expect(SCHEDULE_ADAPTER_KIND).toBe('schedule-pm');
    expect(SCHEDULE_SYSTEM_ID).toBe('schedule-instance-01');
  });

  it('declares the four object-kind surfaces over the schedule area capability', () => {
    expect(SCHEDULE_ADAPTER_CAPABILITIES.objectKinds).toStrictEqual([
      {
        objectKind: 'project-schedule',
        canonicalKind: 'schedule',
        capability: SCHEDULE_SYNC_CAPABILITY_NAME,
      },
      {
        objectKind: 'activity',
        canonicalKind: 'activity',
        capability: SCHEDULE_SYNC_CAPABILITY_NAME,
      },
      {
        objectKind: 'activity-dependency',
        canonicalKind: 'dependency',
        capability: SCHEDULE_SYNC_CAPABILITY_NAME,
      },
      {
        objectKind: 'baseline',
        canonicalKind: 'baseline',
        capability: SCHEDULE_SYNC_CAPABILITY_NAME,
      },
    ]);
    expect(SCHEDULE_SYNC_CAPABILITY_NAME).toBe('schedule.write');
  });

  it('orders the object family in the schedule hierarchy (parents first)', () => {
    expect(SCHEDULE_OBJECT_FAMILY).toStrictEqual([
      'project-schedule',
      'activity',
      'activity-dependency',
      'baseline',
    ]);
  });
});

describe('the schedule object-family kind vocabulary (fail-closed)', () => {
  it('parses each family kind and rejects everything else', () => {
    for (const kind of SCHEDULE_OBJECT_FAMILY) {
      expect(parseScheduleObjectKind(kind).ok).toBe(true);
      expect(isScheduleObjectKind(kind)).toBe(true);
    }
    expectFail(parseScheduleObjectKind('model'), 'invalid-value');
    expectFail(parseScheduleObjectKind('document'), 'invalid-value');
    expectFail(parseScheduleObjectKind(''), 'invalid-value');
    expectFail(parseScheduleObjectKind(42), 'invalid-value');
    expectFail(parseScheduleObjectKind(null), 'invalid-value');
  });

  it('maps each object kind onto its declared canonical kind (trusted table)', () => {
    expect(canonicalKindOfScheduleObjectKind(PROJECT_SCHEDULE_OBJECT_KIND)).toBe('schedule');
    expect(canonicalKindOfScheduleObjectKind(ACTIVITY_OBJECT_KIND)).toBe('activity');
    expect(canonicalKindOfScheduleObjectKind(ACTIVITY_DEPENDENCY_OBJECT_KIND)).toBe('dependency');
    expect(canonicalKindOfScheduleObjectKind(BASELINE_OBJECT_KIND)).toBe('baseline');
    expect(() =>
      canonicalKindOfScheduleObjectKind('model' as never),
    ).toThrow(/not a schedule object family kind/u);
  });
});

describe('the schedules-area command and event names (frozen contracts grammar)', () => {
  it('composes only contracts-valid canonical command names', () => {
    for (const command of [
      CREATE_SCHEDULE_COMMAND,
      ADD_ACTIVITY_COMMAND,
      UPDATE_ACTIVITY_COMMAND,
      ADD_DEPENDENCY_COMMAND,
      REMOVE_DEPENDENCY_COMMAND,
      SET_BASELINE_COMMAND,
    ]) {
      expect(parseCommandName(command).ok).toBe(true);
    }
    expect(CREATE_SCHEDULE_COMMAND).toBe('schedule.createSchedule');
    expect(ADD_ACTIVITY_COMMAND).toBe('schedule.addActivity');
    expect(UPDATE_ACTIVITY_COMMAND).toBe('schedule.updateActivity');
    expect(ADD_DEPENDENCY_COMMAND).toBe('schedule.addDependency');
    expect(REMOVE_DEPENDENCY_COMMAND).toBe('schedule.removeDependency');
    expect(SET_BASELINE_COMMAND).toBe('schedule.setBaseline');
  });

  it('recognizes exactly the six schedules-area event names', () => {
    expect(SCHEDULE_EVENT_NAMES).toStrictEqual([
      'schedule.scheduleCreated',
      'schedule.activityAdded',
      'schedule.activityUpdated',
      'schedule.dependencyAdded',
      'schedule.dependencyRemoved',
      'schedule.baselineSet',
    ]);
    for (const name of SCHEDULE_EVENT_NAMES) {
      expect(parseEventName(name).ok).toBe(true);
      expect(isScheduleEventName(name)).toBe(true);
    }
    expect(SCHEDULE_CREATED_EVENT).toBe('schedule.scheduleCreated');
    expect(ACTIVITY_ADDED_EVENT).toBe('schedule.activityAdded');
    expect(ACTIVITY_UPDATED_EVENT).toBe('schedule.activityUpdated');
    expect(DEPENDENCY_ADDED_EVENT).toBe('schedule.dependencyAdded');
    expect(DEPENDENCY_REMOVED_EVENT).toBe('schedule.dependencyRemoved');
    expect(BASELINE_SET_EVENT).toBe('schedule.baselineSet');
    expectFail(parseScheduleEventName('schedule.activityDeleted'), 'invalid-value');
    expectFail(parseScheduleEventName('models.elementChanged'), 'invalid-value');
    expectFail(parseScheduleEventName(''), 'invalid-value');
  });
});

describe('the CPM link-type vocabulary (typed CPM data: FS/SS/FF/SF + lag)', () => {
  it('parses the four CPM link types and rejects everything else', () => {
    for (const link of ['fs', 'ss', 'ff', 'sf'] as const) {
      expect(parseScheduleLinkType(link).ok).toBe(true);
      expect(isScheduleLinkType(link)).toBe(true);
    }
    expectFail(parseScheduleLinkType('sf '), 'invalid-value');
    expectFail(parseScheduleLinkType('FS'), 'invalid-value');
    expectFail(parseScheduleLinkType('ff-sf'), 'invalid-value');
    expectFail(parseScheduleLinkType(null), 'invalid-value');
  });
});

describe('the ISO calendar date vocabulary (pure arithmetic, no Date)', () => {
  it('parses valid calendar dates including leap years', () => {
    for (const date of [
      '2026-09-01',
      '2026-12-31',
      '2026-02-28',
      '2024-02-29', // leap year (divisible by 4, not by 100)
      '2000-02-29', // leap year (divisible by 400)
      '2999-12-31',
      '2000-01-01',
    ]) {
      expect(parseScheduleDate(date).ok).toBe(true);
      expect(isScheduleDate(date)).toBe(true);
    }
  });

  it('rejects malformed dates, impossible months, and impossible days (fail-closed)', () => {
    expectFail(parseScheduleDate('2026-9-1'), 'invalid-value');
    expectFail(parseScheduleDate('2026-09-31'), 'invalid-value'); // September has 30 days
    expectFail(parseScheduleDate('2026-02-29'), 'invalid-value'); // 2026 is not a leap year
    expectFail(parseScheduleDate('1900-02-29'), 'invalid-value'); // 1900: divisible by 100, not 400
    expectFail(parseScheduleDate('2026-13-01'), 'invalid-value');
    expectFail(parseScheduleDate('2026-00-01'), 'invalid-value');
    expectFail(parseScheduleDate('2026-04-31'), 'invalid-value'); // April has 30 days
    expectFail(parseScheduleDate('1999-12-31'), 'invalid-value'); // before the year floor
    expectFail(parseScheduleDate('3000-01-01'), 'invalid-value'); // past the year ceiling
    expectFail(parseScheduleDate('2026-09-1x'), 'invalid-value');
    expectFail(parseScheduleDate(20260901), 'invalid-value');
    expectFail(parseScheduleDate(null), 'invalid-value');
  });
});

describe('the provider cross-reference parses (fail-closed, strict)', () => {
  it('parses printable-ASCII provider ids and rejects whitespace or overlong ids', () => {
    expect(parseProviderIdField('act-401').ok).toBe(true);
    expect(parseProviderIdField('A/Z+1').ok).toBe(true);
    expectFail(parseProviderIdField('act 401'), 'invalid-value');
    expectFail(parseProviderIdField(''), 'invalid-value');
    expectFail(parseProviderIdField('x'.repeat(129)), 'invalid-value');
    expectFail(parseProviderIdField(42), 'invalid-value');
  });

  it('parses nullable provider ids (the parent/supersedes cross-reference shape)', () => {
    expect(parseNullableProviderId(null).ok).toBe(true);
    expect(parseNullableProviderId('bl-2026-09').ok).toBe(true);
    expectFail(parseNullableProviderId(undefined), 'invalid-value');
    expectFail(parseNullableProviderId('has space'), 'invalid-value');
  });

  it('parses provider dependency pairs with strict keys', () => {
    expect(parseProviderDependencyPair({ predecessorId: 'act-401', successorId: 'act-402' }).ok).toBe(true);
    expectFail(parseProviderDependencyPair({ predecessorId: 'act-401' }), 'missing-field');
    expectFail(parseProviderDependencyPair(null), 'invalid-type');
    expectFail(
      parseProviderDependencyPair({ predecessorId: 'act-401', successorId: 'act-402', extra: 1 }),
      'unknown-field',
    );
  });
});
