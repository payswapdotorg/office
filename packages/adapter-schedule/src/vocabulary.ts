// Office adapter-schedule — the schedule vocabulary (OFF-023).
//
// The typed vocabularies of the Primavera-CLASS schedule adapter, in strictly
// GENERIC terms (freeze A5 + the OFF-023 vocabulary rule): the adapter
// family kind and the fixture's provider system are generic names
// ('schedule-pm' / 'schedule-instance-01'), the provider's object kinds are
// the schedule object family (project-schedule, activity,
// activity-dependency, baseline), and the canonical kinds they map into are
// the schedules-area entity kinds of the frozen schedule domain (schedule,
// activity, dependency, baseline). No real vendor name appears anywhere in
// this package: all provider-specific shapes live INSIDE it (that IS the
// acceptance discipline), and no vendor SDK is imported.
//
// Local closed vocabularies (each fail-closed parsed):
//   - the four schedule object kinds (provider-side) and their canonical kinds;
//   - the CPM dependency link-type vocabulary (FS/SS/FF/SF) and the lag/duration
//     bounds (typed CPM data: durations, dependencies + lag);
//   - the ISO calendar date vocabulary (planned start/finish dates), validated
//     by pure arithmetic (no Date construction anywhere).
import { parseCommandName, parseEntityKind, parseEventName } from '@office/contracts';
import type { CommandName, EntityKind, EventName, ParseResult } from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import {
  adapterKind,
  parseAdapterCapabilities,
  providerObjectKind,
  providerSystemId,
} from '@office/adapters-sdk';
import type { AdapterCapabilities, AdapterKind, ProviderObjectKind, ProviderSystemId } from '@office/adapters-sdk';
import { describeValue, isPlainObject, requireFieldWith, unknownKeyFailure } from './parse';

// ---------------------------------------------------------------------------
// Adapter family identity (generic vocabulary — no real provider names).
// ---------------------------------------------------------------------------

/** The schedule adapter family kind (the Primavera-class family, generically named). */
export const SCHEDULE_ADAPTER_KIND: AdapterKind = adapterKind('schedule-pm');

/** The fixture provider system the schedule adapter syncs against. */
export const SCHEDULE_SYSTEM_ID: ProviderSystemId = providerSystemId('schedule-instance-01');

// ---------------------------------------------------------------------------
// The schedule object family: provider object kinds and their canonical kinds.
// ---------------------------------------------------------------------------

/** The provider object kind of a project schedule (the CPM container). */
export const PROJECT_SCHEDULE_OBJECT_KIND: ProviderObjectKind = providerObjectKind('project-schedule');
/** The provider object kind of a schedule activity. */
export const ACTIVITY_OBJECT_KIND: ProviderObjectKind = providerObjectKind('activity');
/** The provider object kind of an activity dependency link. */
export const ACTIVITY_DEPENDENCY_OBJECT_KIND: ProviderObjectKind = providerObjectKind('activity-dependency');
/** The provider object kind of a schedule baseline. */
export const BASELINE_OBJECT_KIND: ProviderObjectKind = providerObjectKind('baseline');

const trustedEntityKind = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical kind literal: ${raw}`);
  }
  return parsed.value;
};

/** The canonical entity kind a provider project schedule maps into (the frozen schedules-area root). */
export const SCHEDULE_CANONICAL_KIND: EntityKind = trustedEntityKind('schedule');
/** The canonical entity kind a provider activity maps into. */
export const ACTIVITY_CANONICAL_KIND: EntityKind = trustedEntityKind('activity');
/** The canonical entity kind a provider activity-dependency maps into. */
export const DEPENDENCY_CANONICAL_KIND: EntityKind = trustedEntityKind('dependency');
/**
 * The canonical entity kind a provider baseline maps into — the IMMUTABLE
 * baseline discipline: a baseline is set once (possibly superseding a prior
 * baseline), and a re-baseline is a NEW canonical baseline record, never a
 * mutation of a registered one.
 */
export const BASELINE_CANONICAL_KIND: EntityKind = trustedEntityKind('baseline');

/**
 * The schedule object-family kinds in canonical order — the sync stream order
 * (the schedule hierarchy: the container first, then its activities, then the
 * dependency links between them, then the baselines over the whole network).
 */
export const SCHEDULE_OBJECT_FAMILY: readonly ProviderObjectKind[] = [
  PROJECT_SCHEDULE_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
];

/** Grammar description used in parse failures. */
export const SCHEDULE_OBJECT_KIND_GRAMMAR =
  "schedule object family kind: 'project-schedule' | 'activity' | 'activity-dependency' | 'baseline'";

const SCHEDULE_OBJECT_KINDS: readonly string[] = [
  PROJECT_SCHEDULE_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
];

/**
 * Parse an untrusted value as one of the four schedule object-family kinds
 * (total, fail-closed — anything else, including another adapter's object
 * kind, is a typed rejection).
 */
export function parseScheduleObjectKind(raw: unknown): ParseResult<ProviderObjectKind> {
  if (typeof raw !== 'string' || !SCHEDULE_OBJECT_KINDS.includes(raw)) {
    return parseFail('invalid-value', '', SCHEDULE_OBJECT_KIND_GRAMMAR, describeValue(raw));
  }
  return parseOk(providerObjectKind(raw));
}

/** Type guard for the four schedule object-family kinds. */
export function isScheduleObjectKind(raw: unknown): raw is ProviderObjectKind {
  return parseScheduleObjectKind(raw).ok;
}

/** The canonical entity kind one schedule object kind maps into (trusted table). */
export function canonicalKindOfScheduleObjectKind(objectKind: ProviderObjectKind): EntityKind {
  if (objectKind === PROJECT_SCHEDULE_OBJECT_KIND) return SCHEDULE_CANONICAL_KIND;
  if (objectKind === ACTIVITY_OBJECT_KIND) return ACTIVITY_CANONICAL_KIND;
  if (objectKind === ACTIVITY_DEPENDENCY_OBJECT_KIND) return DEPENDENCY_CANONICAL_KIND;
  if (objectKind === BASELINE_OBJECT_KIND) return BASELINE_CANONICAL_KIND;
  throw new TypeError(`not a schedule object family kind: ${String(objectKind)}`);
}

// ---------------------------------------------------------------------------
// Capability (authz's declared schedule area, deny-by-default at sync time).
//
// The typed Capability value is obtained through the SDK's own fail-closed
// capability parse (parseAdapterCapabilities) — the SDK is THE contract and
// this package never imports @office/authz directly: the declared capability
// name must pass the SDK's closed-vocabulary check, so an undeclared area
// can never enter this adapter's capabilities through this path.
// ---------------------------------------------------------------------------

/** The capability every schedule object kind requires to sync (schedule area write). */
export const SCHEDULE_SYNC_CAPABILITY_NAME = 'schedule.write' as const;

const trustedCapabilities = (raw: unknown): AdapterCapabilities => {
  const parsed = parseAdapterCapabilities(raw);
  if (!parsed.ok) {
    // Pure literals over the declared vocabulary — a violation is a module defect.
    throw new TypeError(`invalid schedule adapter capabilities: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
};

/** The declared object-kind surfaces of the schedule adapter (THE contract's capability block). */
export const SCHEDULE_ADAPTER_CAPABILITIES: AdapterCapabilities = trustedCapabilities({
  objectKinds: [
    {
      objectKind: PROJECT_SCHEDULE_OBJECT_KIND,
      canonicalKind: SCHEDULE_CANONICAL_KIND,
      capability: SCHEDULE_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: ACTIVITY_OBJECT_KIND,
      canonicalKind: ACTIVITY_CANONICAL_KIND,
      capability: SCHEDULE_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: ACTIVITY_DEPENDENCY_OBJECT_KIND,
      canonicalKind: DEPENDENCY_CANONICAL_KIND,
      capability: SCHEDULE_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: BASELINE_OBJECT_KIND,
      canonicalKind: BASELINE_CANONICAL_KIND,
      capability: SCHEDULE_SYNC_CAPABILITY_NAME,
    },
  ],
});

// ---------------------------------------------------------------------------
// Canonical schedules-area command names (what the adapter proposes).
// ---------------------------------------------------------------------------

const trustedCommandName = (raw: string): CommandName => {
  const parsed = parseCommandName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical command name literal: ${raw}`);
  }
  return parsed.value;
};

/** Canonical command proposed for a provider project-schedule creation. */
export const CREATE_SCHEDULE_COMMAND: CommandName = trustedCommandName('schedule.createSchedule');
/** Canonical command proposed for a provider activity creation. */
export const ADD_ACTIVITY_COMMAND: CommandName = trustedCommandName('schedule.addActivity');
/** Canonical command proposed for a provider activity update (dates, duration, identity). */
export const UPDATE_ACTIVITY_COMMAND: CommandName = trustedCommandName('schedule.updateActivity');
/** Canonical command proposed for a provider dependency-link creation. */
export const ADD_DEPENDENCY_COMMAND: CommandName = trustedCommandName('schedule.addDependency');
/** Canonical command proposed for a provider dependency-link removal. */
export const REMOVE_DEPENDENCY_COMMAND: CommandName = trustedCommandName('schedule.removeDependency');
/**
 * Canonical command proposed for a provider baseline creation — the
 * immutable-baseline discipline: every newly observed provider baseline
 * object (including a re-baseline superseding a prior one) proposes a NEW
 * canonical baseline record; a registered baseline is never mutated.
 */
export const SET_BASELINE_COMMAND: CommandName = trustedCommandName('schedule.setBaseline');

// ---------------------------------------------------------------------------
// Canonical schedules-area event names (what executing a proposed command emits).
// ---------------------------------------------------------------------------

const trustedEventName = (raw: string): EventName => {
  const parsed = parseEventName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical event name literal: ${raw}`);
  }
  return parsed.value;
};

/** Event name of the schedule-created lifecycle event. */
export const SCHEDULE_CREATED_EVENT: EventName = trustedEventName('schedule.scheduleCreated');
/** Event name of the activity-added lifecycle event. */
export const ACTIVITY_ADDED_EVENT: EventName = trustedEventName('schedule.activityAdded');
/** Event name of THE activity-mutation event (dates/duration updated). */
export const ACTIVITY_UPDATED_EVENT: EventName = trustedEventName('schedule.activityUpdated');
/** Event name of the dependency-link-added event. */
export const DEPENDENCY_ADDED_EVENT: EventName = trustedEventName('schedule.dependencyAdded');
/** Event name of the dependency-link-removed event. */
export const DEPENDENCY_REMOVED_EVENT: EventName = trustedEventName('schedule.dependencyRemoved');
/** Event name of the immutable baseline-registration event (a baseline was set). */
export const BASELINE_SET_EVENT: EventName = trustedEventName('schedule.baselineSet');

/** Every schedules-area event name this package recognizes (canonical order). */
export const SCHEDULE_EVENT_NAMES: readonly EventName[] = [
  SCHEDULE_CREATED_EVENT,
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  BASELINE_SET_EVENT,
];

/** Grammar description used in parse failures. */
export const SCHEDULE_EVENT_NAME_GRAMMAR =
  'a schedules-area event name (schedule.scheduleCreated, schedule.activityAdded, schedule.activityUpdated, schedule.dependencyAdded, schedule.dependencyRemoved, schedule.baselineSet)';

/**
 * Parse an untrusted value as a schedules-area event name (total, fail-closed).
 */
export function parseScheduleEventName(raw: unknown): ParseResult<EventName> {
  if (
    typeof raw !== 'string' ||
    !(SCHEDULE_EVENT_NAMES as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', SCHEDULE_EVENT_NAME_GRAMMAR, describeValue(raw));
  }
  return parseOk(trustedEventName(raw));
}

/** Type guard for schedules-area event names. */
export function isScheduleEventName(raw: unknown): raw is EventName {
  return parseScheduleEventName(raw).ok;
}

// ---------------------------------------------------------------------------
// The CPM dependency link-type vocabulary (typed CPM data: FS/SS/FF/SF + lag).
// ---------------------------------------------------------------------------

/**
 * One dependency link type from the closed CPM vocabulary:
 * finish-to-start ('fs'), start-to-start ('ss'), finish-to-finish ('ff'),
 * start-to-finish ('sf').
 */
export type ScheduleLinkType = 'fs' | 'ss' | 'ff' | 'sf';

/** Grammar description used in parse failures. */
export const SCHEDULE_LINK_TYPE_GRAMMAR =
  "CPM dependency link type: 'fs' (finish-to-start) | 'ss' (start-to-start) | 'ff' (finish-to-finish) | 'sf' (start-to-finish)";

const SCHEDULE_LINK_TYPES: readonly ScheduleLinkType[] = ['fs', 'ss', 'ff', 'sf'];

/** Parse an untrusted value as a ScheduleLinkType (total, fail-closed). */
export function parseScheduleLinkType(raw: unknown): ParseResult<ScheduleLinkType> {
  if (typeof raw !== 'string' || !SCHEDULE_LINK_TYPES.includes(raw as ScheduleLinkType)) {
    return parseFail('invalid-value', '', SCHEDULE_LINK_TYPE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ScheduleLinkType);
}

/** Type guard for structurally valid ScheduleLinkType values. */
export function isScheduleLinkType(raw: unknown): raw is ScheduleLinkType {
  return parseScheduleLinkType(raw).ok;
}

/** The inclusive bounds of a dependency lag in days (typed CPM data). */
export const LAG_DAYS_BOUNDS = { min: 0, max: 999 } as const;

/** The inclusive bounds of a planned activity duration in days. */
export const PLANNED_DURATION_BOUNDS = { min: 1, max: 3650 } as const;

/** Descriptions used in parse failures. */
export const LAG_DAYS_DESCRIPTION =
  'a dependency lag in whole days (integer 0..999 — typed CPM data)';
export const PLANNED_DURATION_DESCRIPTION =
  'a planned duration in whole days (integer 1..3650)';

// ---------------------------------------------------------------------------
// The ISO calendar date vocabulary (planned start/finish, pure arithmetic).
// ---------------------------------------------------------------------------

declare const scheduleDateBrand: unique symbol;

/** One ISO calendar date (YYYY-MM-DD) from the closed typed vocabulary. */
export type ScheduleDate = string & {
  readonly [scheduleDateBrand]: 'ScheduleDate';
};

/** Grammar description used in parse failures. */
export const SCHEDULE_DATE_GRAMMAR =
  'an ISO calendar date YYYY-MM-DD (year 2000..2999, valid month and day — leap years honored)';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_YEAR_MIN = 2000;
const DATE_YEAR_MAX = 2999;

/** Is `year` a leap year (pure Gregorian arithmetic)? */
const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The number of days in one month of one year (pure arithmetic, no Date). */
const daysInMonth = (year: number, month: number): number => {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
};

/** Parse an untrusted value as a ScheduleDate (total, fail-closed, arithmetic). */
export function parseScheduleDate(raw: unknown): ParseResult<ScheduleDate> {
  if (typeof raw !== 'string' || !DATE_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', SCHEDULE_DATE_GRAMMAR, describeValue(raw));
  }
  const parts = DATE_PATTERN.exec(raw);
  // The pattern anchored above — a non-null match is structural; keep the
  // check loud for future pattern edits.
  if (parts === null) {
    return parseFail('invalid-value', '', SCHEDULE_DATE_GRAMMAR, describeValue(raw));
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (year < DATE_YEAR_MIN || year > DATE_YEAR_MAX) {
    return parseFail('invalid-value', '', SCHEDULE_DATE_GRAMMAR, `year ${String(year)} outside 2000..2999`);
  }
  if (month < 1 || month > 12) {
    return parseFail('invalid-value', '', SCHEDULE_DATE_GRAMMAR, `month ${String(month)}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return parseFail(
      'invalid-value',
      '',
      SCHEDULE_DATE_GRAMMAR,
      `day ${String(day)} of ${String(year)}-${String(month).padStart(2, '0')}`,
    );
  }
  return parseOk(raw as ScheduleDate);
}

/** Type guard for structurally valid ScheduleDate values. */
export function isScheduleDate(raw: unknown): raw is ScheduleDate {
  return parseScheduleDate(raw).ok;
}

// ---------------------------------------------------------------------------
// Typed provider payload parses (the extension bag's schedule-family fields).
// ---------------------------------------------------------------------------

/** The provider id rule shared by every schedule-family cross-reference. */
export const PROVIDER_ID_RULE = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]+$/,
  description: 'opaque printable-ASCII provider object id (no whitespace)',
} as const;

/** The provider activity-code rule. */
export const ACTIVITY_CODE_RULE = {
  min: 1,
  max: 64,
  pattern: /^[\x21-\x7e]+$/,
  description: 'opaque printable-ASCII activity code (no whitespace)',
} as const;

/** The display-name rule of schedule-family objects. */
export const SCHEDULE_NAME_RULE = {
  min: 1,
  max: 512,
  description: 'schedule-family display name (1..512 characters)',
} as const;

/** The baseline-label rule. */
export const BASELINE_LABEL_RULE = {
  min: 1,
  max: 200,
  description: 'baseline label (1..200 characters)',
} as const;

/**
 * Parse an untrusted provider payload's named field as a provider object id
 * (the shared cross-reference parse every schedule payload parse runs).
 */
export const parseProviderIdField = (raw: unknown): ParseResult<string> => {
  if (typeof raw !== 'string' || !PROVIDER_ID_RULE.pattern.test(raw) || raw.length < PROVIDER_ID_RULE.min || raw.length > PROVIDER_ID_RULE.max) {
    return parseFail('invalid-value', '', PROVIDER_ID_RULE.description, describeValue(raw));
  }
  return parseOk(raw);
};

/**
 * Parse an untrusted value as a nullable provider object id (the parent
 * activity / superseded baseline cross-reference shape).
 */
export const parseNullableProviderId = (raw: unknown): ParseResult<string | null> => {
  if (raw === null) return parseOk(null);
  return parseProviderIdField(raw);
};

/**
 * Parse one provider link-entry: { predecessorId, successorId } in provider
 * activity ids — the shape the divergence view's dependency edges carry.
 * Kept local to the vocabulary so conflict-rules and the fixture share ONE
 * fail-closed parse of the provider's cross-reference pair.
 */
export interface ProviderDependencyPair {
  readonly predecessorId: string;
  readonly successorId: string;
}

/** Grammar description used in parse failures. */
export const PROVIDER_DEPENDENCY_PAIR_GRAMMAR =
  'ProviderDependencyPair: { predecessorId, successorId } (provider activity ids)';

/** Parse an untrusted value as a ProviderDependencyPair (strict keys). */
export function parseProviderDependencyPair(raw: unknown): ParseResult<ProviderDependencyPair> {
  if (!isPlainObject(raw)) {
    return parseFail(
      'invalid-type',
      '',
      PROVIDER_DEPENDENCY_PAIR_GRAMMAR,
      describeValue(raw),
    );
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ['predecessorId', 'successorId'],
    '',
    PROVIDER_DEPENDENCY_PAIR_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const predecessorId = requireFieldWith(raw, 'predecessorId', '', parseProviderIdField);
  if (!predecessorId.ok) return predecessorId;
  const successorId = requireFieldWith(raw, 'successorId', '', parseProviderIdField);
  if (!successorId.ok) return successorId;
  return parseOk(
    { predecessorId: predecessorId.value, successorId: successorId.value } satisfies ProviderDependencyPair,
  );
}
