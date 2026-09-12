// Office schedule domain — mutation command handlers (OFF-010).
//
// THE canonical mutation path of the schedule module (freeze "cross-view
// mutation" + the OFF-003 kernel contract), executed for every command —
// the exact flow of the sibling identity modules:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never even opens a transaction. Baseline creation runs a
//      SECOND, distinct gate (see below);
//   3. load the aggregate through the scope-guarded store (a foreign
//      tenant's or foreign project's schedule is invisible — typed
//      not-found, no existence oracle) and re-check scope coverage (kernel
//      A12 backstop);
//   4. check optimistic concurrency (stale version → typed
//      concurrency-conflict; the network is NEVER silently overwritten);
//   5. apply the invariant-checked pure transition — including the
//      dependency-graph validation gate (cycles/self/missing/duplicate
//      links are typed invariant-violations BEFORE any write lands);
//   6. write through the store AND append the audit event through the
//      injected EventSink inside ONE runInTransaction — a failure anywhere
//      rolls everything back (tx.rollback carries the typed DomainError out,
//      and pending writes are discarded);
//   7. return the committed aggregate state as a typed Result.
//
// BASELINE AUTHORIZATION (acceptance: a distinct stronger capability):
// every schedule mutation passes the schedule-area write gate (the policy's
// `schedule.write` capability); setting a baseline ADDITIONALLY passes a
// project-area write gate (the policy's `projects.write` capability) —
// re-anchoring a project's whole program of work is a high-impact decision
// (freeze A8 names schedule-baseline actions among them), so it demands a
// capability distinct from and stronger than the one progress updates
// require: an actor holding only `schedule.write` can record progress but
// is denied baselining with a typed forbidden.
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). Every canonical id is composed through the contracts format
// helper, so every issued id parses with parseEntityId by construction.
import {
  formatEntityId,
  parseCommandName,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  EntityId,
  EntityKind,
  EntityRefs,
  EventName,
  ParseResult,
  ProjectId,
  Timestamp,
} from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import { authorize, authorizationContext, resourceScope } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  checkConcurrency,
  checkScopeCovers,
  concurrencyTokenOf,
  domainError,
  entityNotFound,
  ok,
  parseAggregateVersion,
  projectScopeViolation,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  Result,
} from '@office/domain-kernel';
import type { EventSink } from './events';
import {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_UPDATED_EVENT,
  BASELINE_SET_EVENT,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  MILESTONE_ADDED_EVENT,
  PROGRESS_RECORDED_EVENT,
  SCHEDULE_CREATED_EVENT,
  scheduleEventEnvelope,
} from './events';
import type { ScheduleEventPayloads } from './events';
import { scheduleRef } from './events';
import type { ScheduleStore, ScheduleStoreTransaction } from './store';
import type { ActivityChanges, ScheduleState } from './state';
import {
  ACTIVITY_KIND,
  BASELINE_KIND,
  DEPENDENCY_KIND,
  MILESTONE_KIND,
  SCHEDULE_KIND,
  addActivityState,
  addDependencyState,
  addMilestoneState,
  createScheduleState,
  recordProgressState,
  removeDependencyState,
  setBaselineState,
  updateActivityState,
} from './state';
import {
  optionalFieldWith,
  optionalNullableFieldWith,
  parseIntegerLike,
  parseStringLike,
  parseDependencyLinkType,
  requireFieldWith,
  requireInteger,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { IntegerRule, StringRule } from './parse';
import { isPlainObject } from './parse';

// ----- command names ------------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid schedule command name literal: ${name}`);
  }
  return parsed.value;
};

const entityKindOf = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid schedule-domain entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Command name executed by {@link ScheduleCommands.createSchedule}. */
export const CREATE_SCHEDULE_COMMAND: CommandName = commandNameOf('schedule.createSchedule');
/** Command name executed by {@link ScheduleCommands.addActivity}. */
export const ADD_ACTIVITY_COMMAND: CommandName = commandNameOf('schedule.addActivity');
/** Command name executed by {@link ScheduleCommands.updateActivity}. */
export const UPDATE_ACTIVITY_COMMAND: CommandName = commandNameOf('schedule.updateActivity');
/** Command name executed by {@link ScheduleCommands.addDependency}. */
export const ADD_DEPENDENCY_COMMAND: CommandName = commandNameOf('schedule.addDependency');
/** Command name executed by {@link ScheduleCommands.removeDependency}. */
export const REMOVE_DEPENDENCY_COMMAND: CommandName = commandNameOf('schedule.removeDependency');
/** Command name executed by {@link ScheduleCommands.addMilestone}. */
export const ADD_MILESTONE_COMMAND: CommandName = commandNameOf('schedule.addMilestone');
/** Command name executed by {@link ScheduleCommands.setBaseline}. */
export const SET_BASELINE_COMMAND: CommandName = commandNameOf('schedule.setBaseline');
/** Command name executed by {@link ScheduleCommands.recordProgress}. */
export const RECORD_PROGRESS_COMMAND: CommandName = commandNameOf('schedule.recordProgress');

const PROJECT_KIND: EntityKind = entityKindOf('project');

/**
 * Guard: a handler executes exactly its own command kind. Handing another
 * command's envelope to a handler is a trusted-path wiring error — loud.
 */
const requireCommandName = (
  command: CommandEnvelope<unknown>,
  expected: CommandName,
): void => {
  if (command.commandName !== expected) {
    throw new TypeError(
      `schedule command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) ---------------------------------

const NAME_RULE: StringRule = { min: 1, max: 200, description: 'display name' };
const LABEL_RULE: StringRule = { min: 1, max: 200, description: 'baseline label' };
const CODE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
  description: 'activity or milestone code (alphanumeric, dot, underscore, dash; no leading dot/dash)',
};
const PLANNED_DURATION_RULE: IntegerRule = {
  min: 1,
  max: 10_000,
  description: 'planned duration in calendar-free integer working units',
};
const REMAINING_DURATION_RULE: IntegerRule = {
  min: 0,
  max: 10_000,
  description: 'remaining duration in calendar-free integer working units (zero exactly when complete)',
};
const PERCENT_RULE: IntegerRule = {
  min: 0,
  max: 100,
  description: 'percent complete (integer 0..100)',
};
const LAG_RULE: IntegerRule = {
  min: -3_650,
  max: 3_650,
  description: 'link lag in calendar-free integer working units (defaults to 0)',
};

/** Validated payload of `schedule.createSchedule`. */
export interface CreateSchedulePayload {
  readonly name: string;
  /** Required under tenant scope; under project scope it must equal the command's project. */
  readonly projectId?: ProjectId;
}

const CREATE_PAYLOAD_KEYS = ['name', 'projectId'] as const;
const CREATE_PAYLOAD_GRAMMAR =
  'CreateSchedulePayload: { name: string (1..200), projectId?: ProjectId (required under tenant scope; must match under project scope) }';
/** Validated payload of `schedule.addActivity`. */
export interface AddActivityPayload {
  readonly scheduleId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly plannedStart: Timestamp | null;
  readonly plannedFinish: Timestamp | null;
  readonly parentActivityId: EntityId | null;
}

const ADD_ACTIVITY_PAYLOAD_KEYS = [
  'scheduleId',
  'expectedVersion',
  'code',
  'name',
  'plannedDuration',
  'plannedStart',
  'plannedFinish',
  'parentActivityId',
] as const;
const ADD_ACTIVITY_PAYLOAD_GRAMMAR =
  'AddActivityPayload: { scheduleId: EntityId, expectedVersion: number (>= 1), code: string (1..64), name: string (1..200), plannedDuration: integer (1..10000), plannedStart?: Timestamp | null, plannedFinish?: Timestamp | null, parentActivityId?: EntityId | null }';

/** Validated payload of `schedule.updateActivity`. */
export interface UpdateActivityPayload {
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly changes: ActivityChanges;
}

const UPDATE_ACTIVITY_PAYLOAD_KEYS = [
  'scheduleId',
  'activityId',
  'expectedVersion',
  'code',
  'name',
  'plannedDuration',
  'plannedStart',
  'plannedFinish',
  'parentActivityId',
] as const;
const UPDATE_ACTIVITY_PAYLOAD_GRAMMAR =
  'UpdateActivityPayload: { scheduleId: EntityId, activityId: EntityId, expectedVersion: number (>= 1), code?: string, name?: string, plannedDuration?: integer (1..10000), plannedStart?: Timestamp | null, plannedFinish?: Timestamp | null, parentActivityId?: EntityId | null } — at least one change field';

/** Validated payload of `schedule.addDependency`. */
export interface AddDependencyPayload {
  readonly scheduleId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: 'FS' | 'SS' | 'FF' | 'SF';
  readonly lagDays: number;
}

const ADD_DEPENDENCY_PAYLOAD_KEYS = [
  'scheduleId',
  'expectedVersion',
  'predecessorId',
  'successorId',
  'linkType',
  'lagDays',
] as const;
const ADD_DEPENDENCY_PAYLOAD_GRAMMAR =
  "AddDependencyPayload: { scheduleId: EntityId, expectedVersion: number (>= 1), predecessorId: EntityId, successorId: EntityId, linkType: 'FS' | 'SS' | 'FF' | 'SF', lagDays?: integer (-3650..3650; defaults to 0) }";

/** Validated payload of `schedule.removeDependency`. */
export interface RemoveDependencyPayload {
  readonly scheduleId: EntityId;
  readonly dependencyId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const REMOVE_DEPENDENCY_PAYLOAD_KEYS = [
  'scheduleId',
  'dependencyId',
  'expectedVersion',
] as const;
const REMOVE_DEPENDENCY_PAYLOAD_GRAMMAR =
  'RemoveDependencyPayload: { scheduleId: EntityId, dependencyId: EntityId, expectedVersion: number (>= 1) }';

/** Validated payload of `schedule.addMilestone`. */
export interface AddMilestonePayload {
  readonly scheduleId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly code: string;
  readonly name: string;
  readonly boundActivityId: EntityId | null;
}

const ADD_MILESTONE_PAYLOAD_KEYS = [
  'scheduleId',
  'expectedVersion',
  'code',
  'name',
  'boundActivityId',
] as const;
const ADD_MILESTONE_PAYLOAD_GRAMMAR =
  'AddMilestonePayload: { scheduleId: EntityId, expectedVersion: number (>= 1), code: string (1..64), name: string (1..200), boundActivityId?: EntityId | null }';

/** Validated payload of `schedule.setBaseline`. */
export interface SetBaselinePayload {
  readonly scheduleId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly label: string | undefined;
}

const SET_BASELINE_PAYLOAD_KEYS = ['scheduleId', 'expectedVersion', 'label'] as const;
const SET_BASELINE_PAYLOAD_GRAMMAR =
  'SetBaselinePayload: { scheduleId: EntityId, expectedVersion: number (>= 1), label?: string (1..200; defaults deterministically to "Baseline N") }';

/** Validated payload of `schedule.recordProgress`. */
export interface RecordProgressPayload {
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly percentComplete: number;
  readonly remainingDuration: number;
  readonly actualStart: Timestamp | null;
  readonly actualFinish: Timestamp | null;
}

const RECORD_PROGRESS_PAYLOAD_KEYS = [
  'scheduleId',
  'activityId',
  'expectedVersion',
  'percentComplete',
  'remainingDuration',
  'actualStart',
  'actualFinish',
] as const;
const RECORD_PROGRESS_PAYLOAD_GRAMMAR =
  'RecordProgressPayload: { scheduleId: EntityId, activityId: EntityId, expectedVersion: number (>= 1), percentComplete: integer (0..100), remainingDuration: integer (0..10000; zero exactly when complete), actualStart?: Timestamp | null, actualFinish?: Timestamp | null (exactly when complete) }';

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

/** Parse the create-schedule payload (total, fail-closed, strict keys). */
export function parseCreateSchedulePayload(
  raw: unknown,
): ParseResult<CreateSchedulePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CREATE_PAYLOAD_KEYS, '', CREATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const projectId = optionalFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  return parseOk({
    name: name.value,
    ...(projectId.value !== undefined ? { projectId: projectId.value } : {}),
  });
}

/** Parse the add-activity payload (total, fail-closed, strict keys). */
export function parseAddActivityPayload(raw: unknown): ParseResult<AddActivityPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ADD_ACTIVITY_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ADD_ACTIVITY_PAYLOAD_KEYS, '', ADD_ACTIVITY_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const plannedDuration = requireInteger(raw, 'plannedDuration', '', PLANNED_DURATION_RULE);
  if (!plannedDuration.ok) return plannedDuration;
  const plannedStart = optionalNullableFieldWith(raw, 'plannedStart', '', parseTimestamp);
  if (!plannedStart.ok) return plannedStart;
  const plannedFinish = optionalNullableFieldWith(raw, 'plannedFinish', '', parseTimestamp);
  if (!plannedFinish.ok) return plannedFinish;
  const parentActivityId = optionalNullableFieldWith(raw, 'parentActivityId', '', parseEntityId);
  if (!parentActivityId.ok) return parentActivityId;
  return parseOk({
    scheduleId: scheduleId.value,
    expectedVersion: expectedVersion.value,
    code: code.value,
    name: name.value,
    plannedDuration: plannedDuration.value,
    plannedStart: plannedStart.value,
    plannedFinish: plannedFinish.value,
    parentActivityId: parentActivityId.value,
  });
}

/**
 * Parse an optional-or-nullable CHANGE field of the update-activity
 * payload: an ABSENT field yields undefined ("do not change this field");
 * an explicit null means "clear it"; any other value delegates to the
 * sub-parser. (optionalNullableFieldWith alone cannot distinguish absent
 * from explicit null — both yield null — which would silently coalesce an
 * absent change field into a clearing change.)
 */
const optionalChangeField = <T>(
  raw: Record<string, unknown>,
  field: string,
  parseValue: (value: unknown) => ParseResult<T>,
): ParseResult<T | null | undefined> => {
  if (raw[field] === undefined) return parseOk(undefined);
  return optionalNullableFieldWith(raw, field, '', parseValue);
};

/** Parse the update-activity payload (total, fail-closed, strict keys). */
export function parseUpdateActivityPayload(
  raw: unknown,
): ParseResult<UpdateActivityPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UPDATE_ACTIVITY_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, UPDATE_ACTIVITY_PAYLOAD_KEYS, '', UPDATE_ACTIVITY_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const activityId = requireFieldWith(raw, 'activityId', '', parseEntityId);
  if (!activityId.ok) return activityId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const code = optionalFieldWith(raw, 'code', '', (value) => parseStringLike(value, CODE_RULE));
  if (!code.ok) return code;
  const name = optionalFieldWith(raw, 'name', '', (value) => parseStringLike(value, NAME_RULE));
  if (!name.ok) return name;
  const plannedDuration = optionalFieldWith(
    raw,
    'plannedDuration',
    '',
    (value) => parseIntegerLike(value, PLANNED_DURATION_RULE),
  );
  if (!plannedDuration.ok) return plannedDuration;
  const plannedStart = optionalChangeField(raw, 'plannedStart', parseTimestamp);
  if (!plannedStart.ok) return plannedStart;
  const plannedFinish = optionalChangeField(raw, 'plannedFinish', parseTimestamp);
  if (!plannedFinish.ok) return plannedFinish;
  const parentActivityId = optionalChangeField(raw, 'parentActivityId', parseEntityId);
  if (!parentActivityId.ok) return parentActivityId;
  if (
    code.value === undefined &&
    name.value === undefined &&
    plannedDuration.value === undefined &&
    plannedStart.value === undefined &&
    plannedFinish.value === undefined &&
    parentActivityId.value === undefined
  ) {
    return parseFail(
      'invalid-value',
      '',
      UPDATE_ACTIVITY_PAYLOAD_GRAMMAR,
      'no change field present (code/name/plannedDuration/plannedStart/plannedFinish/parentActivityId)',
    );
  }
  const changes: ActivityChanges = {
    ...(code.value !== undefined ? { code: code.value } : {}),
    ...(name.value !== undefined ? { name: name.value } : {}),
    ...(plannedDuration.value !== undefined ? { plannedDuration: plannedDuration.value } : {}),
    ...(plannedStart.value !== undefined ? { plannedStart: plannedStart.value } : {}),
    ...(plannedFinish.value !== undefined ? { plannedFinish: plannedFinish.value } : {}),
    ...(parentActivityId.value !== undefined
      ? { parentActivityId: parentActivityId.value }
      : {}),
  };
  return parseOk({
    scheduleId: scheduleId.value,
    activityId: activityId.value,
    expectedVersion: expectedVersion.value,
    changes,
  });
}

/** Parse the add-dependency payload (total, fail-closed, strict keys). */
export function parseAddDependencyPayload(
  raw: unknown,
): ParseResult<AddDependencyPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ADD_DEPENDENCY_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ADD_DEPENDENCY_PAYLOAD_KEYS, '', ADD_DEPENDENCY_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const predecessorId = requireFieldWith(raw, 'predecessorId', '', parseEntityId);
  if (!predecessorId.ok) return predecessorId;
  const successorId = requireFieldWith(raw, 'successorId', '', parseEntityId);
  if (!successorId.ok) return successorId;
  const linkType = requireFieldWith(raw, 'linkType', '', parseDependencyLinkType);
  if (!linkType.ok) return linkType;
  const lagDays = optionalFieldWith(raw, 'lagDays', '', (value) => parseIntegerLike(value, LAG_RULE));
  if (!lagDays.ok) return lagDays;
  return parseOk({
    scheduleId: scheduleId.value,
    expectedVersion: expectedVersion.value,
    predecessorId: predecessorId.value,
    successorId: successorId.value,
    linkType: linkType.value,
    lagDays: lagDays.value ?? 0,
  });
}

/** Parse the remove-dependency payload (total, fail-closed, strict keys). */
export function parseRemoveDependencyPayload(
  raw: unknown,
): ParseResult<RemoveDependencyPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REMOVE_DEPENDENCY_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REMOVE_DEPENDENCY_PAYLOAD_KEYS, '', REMOVE_DEPENDENCY_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const dependencyId = requireFieldWith(raw, 'dependencyId', '', parseEntityId);
  if (!dependencyId.ok) return dependencyId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    scheduleId: scheduleId.value,
    dependencyId: dependencyId.value,
    expectedVersion: expectedVersion.value,
  });
}

/** Parse the add-milestone payload (total, fail-closed, strict keys). */
export function parseAddMilestonePayload(
  raw: unknown,
): ParseResult<AddMilestonePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ADD_MILESTONE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ADD_MILESTONE_PAYLOAD_KEYS, '', ADD_MILESTONE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const boundActivityId = optionalNullableFieldWith(raw, 'boundActivityId', '', parseEntityId);
  if (!boundActivityId.ok) return boundActivityId;
  return parseOk({
    scheduleId: scheduleId.value,
    expectedVersion: expectedVersion.value,
    code: code.value,
    name: name.value,
    boundActivityId: boundActivityId.value,
  });
}

/** Parse the set-baseline payload (total, fail-closed, strict keys). */
export function parseSetBaselinePayload(raw: unknown): ParseResult<SetBaselinePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SET_BASELINE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SET_BASELINE_PAYLOAD_KEYS, '', SET_BASELINE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const label = optionalFieldWith(raw, 'label', '', (value) => parseStringLike(value, LABEL_RULE));
  if (!label.ok) return label;
  return parseOk({
    scheduleId: scheduleId.value,
    expectedVersion: expectedVersion.value,
    label: label.value,
  });
}

/** Parse the record-progress payload (total, fail-closed, strict keys). */
export function parseRecordProgressPayload(
  raw: unknown,
): ParseResult<RecordProgressPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RECORD_PROGRESS_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RECORD_PROGRESS_PAYLOAD_KEYS, '', RECORD_PROGRESS_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scheduleId = requireFieldWith(raw, 'scheduleId', '', parseEntityId);
  if (!scheduleId.ok) return scheduleId;
  const activityId = requireFieldWith(raw, 'activityId', '', parseEntityId);
  if (!activityId.ok) return activityId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const percentComplete = requireInteger(raw, 'percentComplete', '', PERCENT_RULE);
  if (!percentComplete.ok) return percentComplete;
  const remainingDuration = requireInteger(raw, 'remainingDuration', '', REMAINING_DURATION_RULE);
  if (!remainingDuration.ok) return remainingDuration;
  const actualStart = optionalNullableFieldWith(raw, 'actualStart', '', parseTimestamp);
  if (!actualStart.ok) return actualStart;
  const actualFinish = optionalNullableFieldWith(raw, 'actualFinish', '', parseTimestamp);
  if (!actualFinish.ok) return actualFinish;
  return parseOk({
    scheduleId: scheduleId.value,
    activityId: activityId.value,
    expectedVersion: expectedVersion.value,
    percentComplete: percentComplete.value,
    remainingDuration: remainingDuration.value,
    actualStart: actualStart.value,
    actualFinish: actualFinish.value,
  });
}

// ----- command service -------------------------------------------------------------

/**
 * Wiring dependencies of the schedule command service. `now` and
 * `newOpaqueId` are the injected suppliers (determinism rule): fixed values
 * in tests, wall clock / crypto randomness in production wiring. The store
 * is the pure-domain transactional seam (see store.ts); the event sink is
 * the mirrored OFF-007 port (see events.ts).
 */
export interface ScheduleCommandDeps {
  readonly store: ScheduleStore;
  readonly eventSink: EventSink;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface ScheduleCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The schedule mutation command surface. */
export interface ScheduleCommands {
  /** Create a project's program-of-work root (one schedule per project). */
  createSchedule(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Add one activity to the schedule's network. */
  addActivity(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Update one activity's current-plan data (code/name/duration/dates/parent). */
  updateActivity(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Add one typed dependency link (cycle/self/missing/duplicate rejected typed). */
  addDependency(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Remove one dependency link (the only removable entity of the model). */
  removeDependency(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Add one zero-duration milestone marker. */
  addMilestone(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /**
   * Baseline the schedule — the consequential, high-impact decision. Requires
   * the distinct stronger project-write capability IN ADDITION to the
   * schedule-write capability (two authorization gates).
   */
  setBaseline(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
  /** Record one append-only progress update against an activity. */
  recordProgress(
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ): Promise<CommandResult<ScheduleState>>;
}

/** What one mutation step produces: the next state plus its audit event parts. */
interface MutationOutcome {
  readonly next: ScheduleState;
  readonly eventName: EventName;
  readonly entityRefs: EntityRefs;
  readonly payload: ScheduleEventPayloads;
}

/** Create the schedule mutation command service. */
export function createScheduleCommands(deps: ScheduleCommandDeps): ScheduleCommands {
  const errorContextOf = (command: CommandEnvelope<unknown>): DomainErrorContext => ({
    scope: command.scope,
    correlationId: command.causality.correlationId,
  });

  /** Translate a payload parse failure into the typed domain failure. */
  const invalidPayload = (
    error: ContractParseError,
    command: CommandEnvelope<unknown>,
  ): DomainError =>
    domainError(
      'invariant-violation',
      `invalid command payload for '${command.commandName}': ${error.code} at '${
        error.path === '' ? '<root>' : error.path
      }' — expected ${error.expected}, received ${error.received}`,
      [
        {
          code: 'invalid-command-payload',
          message: `${error.code}: expected ${error.expected}, received ${error.received}`,
          path: error.path === '' ? null : error.path,
        },
      ],
      errorContextOf(command),
    );

  /** Build the request's AuthorizationContext from the command envelope. */
  const contextOf = (
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
  ) =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /** The schedule-domain resource being accessed, addressed within the COMMAND's scope. */
  const scheduleResource = (
    command: CommandEnvelope<unknown>,
    resourceKind: EntityKind,
    resourceId: EntityId | null,
  ) =>
    resourceScope({
      scope: command.scope,
      resourceKind,
      resourceId,
      ownerId: null,
    });

  /** The optimistic-concurrency token of the schedule root. */
  const expectedTokenOf = (
    scheduleId: EntityId,
    expectedVersion: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind: SCHEDULE_KIND,
    entityId: scheduleId,
    version: expectedVersion,
  });

  /** Issue the next canonical EntityId from the injected supplier. */
  const newEntityId = (): EntityId =>
    formatEntityId({ version: 'v1', opaque: deps.newOpaqueId() });

  /**
   * THE shared mutation flow (steps 3–7 of the module contract): load scoped,
   * A12 backstop, concurrency, pure transition, store write + event append
   * in ONE transaction — every failure rolls the whole mutation back.
   */
  const mutateSchedule = async (
    command: CommandEnvelope<unknown>,
    authorization: ScheduleCommandAuthorization,
    parts: {
      readonly scheduleId: EntityId;
      readonly expectedVersion: AggregateVersion;
      readonly resourceKind: EntityKind;
      readonly resourceId: EntityId | null;
      readonly step: (
        loaded: ScheduleState,
        now: Timestamp,
        context: DomainErrorContext,
      ) => Result<MutationOutcome, DomainError>;
    },
  ): Promise<CommandResult<ScheduleState>> => {
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization),
      scheduleResource(command, parts.resourceKind, parts.resourceId),
      'write',
      errorContextOf(command),
    );
    if (!decision.ok) return decision;

    const expected = expectedTokenOf(parts.scheduleId, parts.expectedVersion);

    return deps.store.runInTransaction(
      async (tx: ScheduleStoreTransaction): Promise<CommandResult<ScheduleState>> => {
        const now = deps.now();
        const context = errorContextOf(command);

        const loaded = await tx.loadSchedule(command.scope, parts.scheduleId);
        if (!loaded.ok) return tx.rollback(loaded);

        // A12 backstop (kernel): the command scope must cover the loaded
        // aggregate's owning scope — with the scoped store this cannot fire,
        // and it is checked anyway (defense in depth).
        const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
        if (!coverage.ok) return tx.rollback(coverage);

        const concurrency = checkConcurrency(
          expected,
          concurrencyTokenOf(loaded.value),
          context,
        );
        if (!concurrency.ok) return tx.rollback(concurrency);

        const outcome = parts.step(loaded.value, now, context);
        if (!outcome.ok) return tx.rollback(outcome);

        const saved = await tx.saveSchedule(command.scope, outcome.value.next, parts.expectedVersion);
        if (!saved.ok) return tx.rollback(saved);

        const event = scheduleEventEnvelope({
          command,
          eventName: outcome.value.eventName,
          scope: saved.value.scope,
          occurredAt: now,
          entityRefs: outcome.value.entityRefs,
          payload: outcome.value.payload,
        });
        const appended = await deps.eventSink.appendEvents(tx, [event]);
        if (!appended.ok) return tx.rollback(appended);

        return ok(saved.value);
      },
    );
  };

  return {
    createSchedule: async (command, authorization) => {
      requireCommandName(command, CREATE_SCHEDULE_COMMAND);
      const payload = parseCreateSchedulePayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Resolve the project the new schedule belongs to. Under project scope
      // the command initializes exactly its own project (a payload naming a
      // DIFFERENT project is a typed unauthorized second-boundary violation,
      // before any transaction opens); under tenant scope the payload must
      // name the project.
      let projectId: ProjectId;
      if (command.scope.kind === 'project') {
        if (
          payload.value.projectId !== undefined &&
          payload.value.projectId !== command.scope.projectId
        ) {
          return {
            ok: false,
            error: projectScopeViolation(
              {
                commandProjectId: command.scope.projectId,
                aggregateProjectId: payload.value.projectId,
              },
              errorContextOf(command),
            ),
          };
        }
        projectId = command.scope.projectId;
      } else if (payload.value.projectId !== undefined) {
        projectId = payload.value.projectId;
      } else {
        return {
          ok: false,
          error: domainError(
            'invariant-violation',
            `invalid command payload for '${command.commandName}': a tenant-scoped create must name the project the schedule belongs to (projectId)`,
            [
              {
                code: 'invalid-command-payload',
                message: 'missing-field: projectId is required under tenant scope',
                path: 'projectId',
              },
            ],
            errorContextOf(command),
          ),
        };
      }

      // Kind-level create authority over the target project (A12 structural
      // isolation + the caller's policy decide; a denied command never opens
      // a transaction).
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceScope({
          scope: { kind: 'project', tenantId: command.scope.tenantId, projectId },
          resourceKind: SCHEDULE_KIND,
          resourceId: null,
          ownerId: null,
        }),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: ScheduleStoreTransaction): Promise<CommandResult<ScheduleState>> => {
          const now = deps.now();
          const scheduleId = newEntityId();
          const scope = { kind: 'project', tenantId: command.scope.tenantId, projectId } as const;

          const initial = createScheduleState(
            { scheduleId, name: payload.value.name, now },
            scope,
            errorContextOf(command),
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertSchedule(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = scheduleEventEnvelope({
            command,
            eventName: SCHEDULE_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: scheduleRef(inserted.value) },
            payload: {
              scheduleId: inserted.value.entityId,
              name: inserted.value.name,
              version: inserted.value.version,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    addActivity: async (command, authorization) => {
      requireCommandName(command, ADD_ACTIVITY_COMMAND);
      const payload = parseAddActivityPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: ACTIVITY_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          const activityId = newEntityId();
          const next = addActivityState(
            loaded,
            {
              activityId,
              code: payload.value.code,
              name: payload.value.name,
              plannedDuration: payload.value.plannedDuration,
              plannedStart: payload.value.plannedStart,
              plannedFinish: payload.value.plannedFinish,
              parentActivityId: payload.value.parentActivityId,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const activity = next.value.activities[activityId];
          if (activity === undefined) {
            throw new TypeError(`added activity ${activityId} is missing from the next state`);
          }
          return ok({
            next: next.value,
            eventName: ACTIVITY_ADDED_EVENT,
            entityRefs: { before: null, after: { entityKind: ACTIVITY_KIND, entityId: activityId } },
            payload: {
              scheduleId: next.value.entityId,
              activityId,
              code: activity.code,
              name: activity.name,
              plannedDuration: activity.plannedDuration,
              parentActivityId: activity.parentActivityId,
              version: next.value.version,
            },
          });
        },
      });
    },

    updateActivity: async (command, authorization) => {
      requireCommandName(command, UPDATE_ACTIVITY_COMMAND);
      const payload = parseUpdateActivityPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: ACTIVITY_KIND,
        resourceId: payload.value.activityId,
        step: (loaded, now, context) => {
          const next = updateActivityState(
            loaded,
            payload.value.activityId,
            payload.value.changes,
            now,
            context,
          );
          if (!next.ok) return next;
          const before = loaded.activities[payload.value.activityId];
          const after = next.value.activities[payload.value.activityId];
          if (before === undefined || after === undefined) {
            throw new TypeError(
              `activity ${payload.value.activityId} is missing from a state it must exist in`,
            );
          }
          return ok({
            next: next.value,
            eventName: ACTIVITY_UPDATED_EVENT,
            entityRefs: {
              before: { entityKind: ACTIVITY_KIND, entityId: payload.value.activityId },
              after: { entityKind: ACTIVITY_KIND, entityId: payload.value.activityId },
            },
            payload: {
              scheduleId: next.value.entityId,
              activityId: payload.value.activityId,
              code: after.code,
              plannedDuration: after.plannedDuration,
              version: next.value.version,
              updatedAt: after.updatedAt,
            },
          });
        },
      });
    },

    addDependency: async (command, authorization) => {
      requireCommandName(command, ADD_DEPENDENCY_COMMAND);
      const payload = parseAddDependencyPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: DEPENDENCY_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          const dependencyId = newEntityId();
          const next = addDependencyState(
            loaded,
            {
              dependencyId,
              predecessorId: payload.value.predecessorId,
              successorId: payload.value.successorId,
              linkType: payload.value.linkType,
              lagDays: payload.value.lagDays,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          return ok({
            next: next.value,
            eventName: DEPENDENCY_ADDED_EVENT,
            entityRefs: { before: null, after: { entityKind: DEPENDENCY_KIND, entityId: dependencyId } },
            payload: {
              scheduleId: next.value.entityId,
              dependencyId,
              predecessorId: payload.value.predecessorId,
              successorId: payload.value.successorId,
              linkType: payload.value.linkType,
              lagDays: payload.value.lagDays,
              version: next.value.version,
            },
          });
        },
      });
    },

    removeDependency: async (command, authorization) => {
      requireCommandName(command, REMOVE_DEPENDENCY_COMMAND);
      const payload = parseRemoveDependencyPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: DEPENDENCY_KIND,
        resourceId: payload.value.dependencyId,
        step: (loaded, now, context) => {
          const removed = loaded.dependencies[payload.value.dependencyId];
          if (removed === undefined) {
            return {
              ok: false,
              error: entityNotFound(
                { entityKind: DEPENDENCY_KIND, entityId: payload.value.dependencyId },
                context,
              ),
            };
          }
          const next = removeDependencyState(loaded, payload.value.dependencyId, now, context);
          if (!next.ok) return next;
          return ok({
            next: next.value,
            eventName: DEPENDENCY_REMOVED_EVENT,
            entityRefs: {
              before: { entityKind: DEPENDENCY_KIND, entityId: payload.value.dependencyId },
              after: null,
            },
            payload: {
              scheduleId: next.value.entityId,
              dependencyId: payload.value.dependencyId,
              predecessorId: removed.predecessorId,
              successorId: removed.successorId,
              linkType: removed.linkType,
              version: next.value.version,
            },
          });
        },
      });
    },

    addMilestone: async (command, authorization) => {
      requireCommandName(command, ADD_MILESTONE_COMMAND);
      const payload = parseAddMilestonePayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: MILESTONE_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          const milestoneId = newEntityId();
          const next = addMilestoneState(
            loaded,
            {
              milestoneId,
              code: payload.value.code,
              name: payload.value.name,
              boundActivityId: payload.value.boundActivityId,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const milestone = next.value.milestones[milestoneId];
          if (milestone === undefined) {
            throw new TypeError(`added milestone ${milestoneId} is missing from the next state`);
          }
          return ok({
            next: next.value,
            eventName: MILESTONE_ADDED_EVENT,
            entityRefs: { before: null, after: { entityKind: MILESTONE_KIND, entityId: milestoneId } },
            payload: {
              scheduleId: next.value.entityId,
              milestoneId,
              code: milestone.code,
              name: milestone.name,
              boundActivityId: milestone.boundActivityId,
              version: next.value.version,
            },
          });
        },
      });
    },

    setBaseline: async (command, authorization) => {
      requireCommandName(command, SET_BASELINE_COMMAND);
      const payload = parseSetBaselinePayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // GATE 1 — the schedule-area write gate (the same capability every
      // schedule mutation requires).
      const scheduleDecision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        scheduleResource(command, BASELINE_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!scheduleDecision.ok) return scheduleDecision;

      // GATE 2 — the DISTINCT STRONGER project-area write gate: re-anchoring a
      // project's whole program of work additionally demands the project
      // write capability (an actor holding only the schedule capability can
      // record progress but can never set a baseline — typed forbidden here).
      const projectDecision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        scheduleResource(command, PROJECT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!projectDecision.ok) return projectDecision;

      return deps.store.runInTransaction(
        async (tx: ScheduleStoreTransaction): Promise<CommandResult<ScheduleState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadSchedule(command.scope, payload.value.scheduleId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expectedTokenOf(payload.value.scheduleId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const baselineId = newEntityId();
          const createdBy =
            command.actor.kind === 'system' ? null : command.actor.actorId;
          const next = setBaselineState(
            loaded.value,
            {
              baselineId,
              ...(payload.value.label !== undefined ? { label: payload.value.label } : {}),
              createdBy,
              now,
            },
            context,
          );
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveSchedule(command.scope, next.value, payload.value.expectedVersion);
          if (!saved.ok) return tx.rollback(saved);

          const baseline = saved.value.baselines[baselineId];
          if (baseline === undefined) {
            throw new TypeError(`baseline ${baselineId} is missing from the saved state`);
          }

          const event = scheduleEventEnvelope({
            command,
            eventName: BASELINE_SET_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: { entityKind: BASELINE_KIND, entityId: baselineId } },
            payload: {
              scheduleId: saved.value.entityId,
              baselineId,
              sequence: baseline.sequence,
              label: baseline.label,
              supersedes: baseline.supersedes,
              activityCount: baseline.snapshot.activities.length,
              dependencyCount: baseline.snapshot.dependencies.length,
              milestoneCount: baseline.snapshot.milestones.length,
              version: saved.value.version,
              createdAt: baseline.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    recordProgress: async (command, authorization) => {
      requireCommandName(command, RECORD_PROGRESS_COMMAND);
      const payload = parseRecordProgressPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateSchedule(command, authorization, {
        scheduleId: payload.value.scheduleId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: ACTIVITY_KIND,
        resourceId: payload.value.activityId,
        step: (loaded, now, context) => {
          const progressUpdateId = newEntityId();
          const next = recordProgressState(
            loaded,
            {
              progressUpdateId,
              activityId: payload.value.activityId,
              percentComplete: payload.value.percentComplete,
              remainingDuration: payload.value.remainingDuration,
              actualStart: payload.value.actualStart,
              actualFinish: payload.value.actualFinish,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const activity = next.value.activities[payload.value.activityId];
          if (activity === undefined) {
            throw new TypeError(
              `activity ${payload.value.activityId} is missing from a state it must exist in`,
            );
          }
          const activityReference = {
            entityKind: ACTIVITY_KIND,
            entityId: payload.value.activityId,
          } as const;
          return ok({
            next: next.value,
            eventName: PROGRESS_RECORDED_EVENT,
            entityRefs: { before: activityReference, after: activityReference },
            payload: {
              scheduleId: next.value.entityId,
              progressUpdateId,
              activityId: payload.value.activityId,
              percentComplete: payload.value.percentComplete,
              remainingDuration: payload.value.remainingDuration,
              actualStart: payload.value.actualStart,
              actualFinish: payload.value.actualFinish,
              version: next.value.version,
            },
          });
        },
      });
    },
  };
}
