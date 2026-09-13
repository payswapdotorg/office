// Office adapter-schedule — the change-event mapping (OFF-023).
//
// The translation seam of THE canonical flow:
//
//   provider schedule mutation (activity date change, dependency added or
//   removed, baseline set)
//     → ProviderSnapshot (the SDK's normalized observation)
//     → canonical command proposal (schedule.updateActivity /
//       schedule.addDependency / schedule.removeDependency /
//       schedule.setBaseline / … — the AdapterCommandTranslator below)
//     → (executed by the HOST through the Action Gateway)
//     → canonical DomainEventEnvelope (schedule.activityUpdated /
//       schedule.dependencyAdded / … — the event vocabulary + trusted
//       envelope builders below)
//     → downstream impact notifications (notification.ts).
//
// Adapters NEVER write canonical state (freeze A8/A11): the translator only
// PROPOSES typed commands; the host executes them and emits the events. The
// schedule immutability disciplines (never a destructive mutation):
//   - BASELINES are immutable records: an in-place provider baseline change
//     is a typed rejection here — a re-baseline is a NEW provider baseline
//     object (supersedes), which proposes a NEW canonical baseline record;
//     an in-place change of a mapped baseline is the re-baselining conflict
//     the divergence detection records (conflict-rules.ts);
//   - DEPENDENCIES are added and removed, never mutated in place;
//   - ACTIVITY and SCHEDULE deletions have no canonical command (the
//     schedules-area history is append-only) — typed rejections;
//   - a provider project-schedule mutated in place has no canonical command
//     either (the frozen schedules-area vocabulary defines no
//     schedule-update command) — typed rejection.
//
// Provider payloads are parsed fail-closed before any proposal is composed;
// canonical event payloads are strict-keyed and round-trip the contracts
// parser by construction. Deterministic everywhere: no clock, no
// randomness, canonical orderings only.
import { CURRENT_SCHEMA_VERSION, parseCausationId, parseDomainEventEnvelope, parseEntityId, parseFail, parseOk } from '@office/contracts';
import type {
  CommandEnvelope,
  Causality,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  EntityRefs,
  EventName,
  ParseResult,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  providerObjectId,
  providerVersion,
  requireCanonicalTarget,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import type {
  AdapterCommandInput,
  AdapterCommandProposal,
  AdapterCommandTranslator,
  AdapterJsonObject,
  ProviderObjectKind,
} from '@office/adapters-sdk';
import {
  ACTIVITY_ADDED_EVENT,
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  ACTIVITY_UPDATED_EVENT,
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  BASELINE_OBJECT_KIND,
  BASELINE_SET_EVENT,
  CREATE_SCHEDULE_COMMAND,
  DEPENDENCY_ADDED_EVENT,
  DEPENDENCY_REMOVED_EVENT,
  PROJECT_SCHEDULE_OBJECT_KIND,
  REMOVE_DEPENDENCY_COMMAND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_CREATED_EVENT,
  SCHEDULE_SYSTEM_ID,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  isScheduleEventName,
  parseScheduleDate,
  parseScheduleLinkType,
  parseScheduleEventName,
  parseScheduleObjectKind,
  LAG_DAYS_DESCRIPTION,
  LAG_DAYS_BOUNDS,
  PLANNED_DURATION_BOUNDS,
  PLANNED_DURATION_DESCRIPTION,
  ACTIVITY_CODE_RULE,
  BASELINE_LABEL_RULE,
  SCHEDULE_NAME_RULE,
  parseProviderIdField,
  parseNullableProviderId,
} from './vocabulary';
import type { ScheduleDate, ScheduleLinkType } from './vocabulary';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireInteger,
  requireNullableFieldWith,
  requireNullableString,
  requirePositiveNumber,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';

// ---------------------------------------------------------------------------
// Provider payload parses (the extension bag's schedule-family fields).
// ---------------------------------------------------------------------------

/** The schedule-family fields a provider PROJECT-SCHEDULE payload carries. */
export interface ProjectScheduleProviderData {
  readonly name: string;
}

/** The schedule-family fields a provider ACTIVITY payload carries. */
export interface ActivityProviderData {
  readonly scheduleId: string;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly parentActivityId: string | null;
  readonly plannedStart: ScheduleDate;
  readonly plannedFinish: ScheduleDate;
}

/** The schedule-family fields a provider ACTIVITY-DEPENDENCY payload carries. */
export interface ActivityDependencyProviderData {
  readonly scheduleId: string;
  readonly predecessorId: string;
  readonly successorId: string;
  readonly linkType: ScheduleLinkType;
  readonly lagDays: number;
}

/** The schedule-family fields a provider BASELINE payload carries. */
export interface BaselineProviderData {
  readonly scheduleId: string;
  readonly label: string;
  readonly supersedes: string | null;
  readonly protected: boolean;
}

/** Parse a provider project-schedule payload (open extension bag; named fields strict). */
export function parseProjectScheduleProviderData(
  data: AdapterJsonObject,
): ParseResult<ProjectScheduleProviderData> {
  const name = requireString(data, 'name', '', SCHEDULE_NAME_RULE);
  if (!name.ok) return name;
  return parseOk({ name: name.value } satisfies ProjectScheduleProviderData);
}

/** Parse a provider activity payload (open bag; named fields strict). */
export function parseActivityProviderData(data: AdapterJsonObject): ParseResult<ActivityProviderData> {
  const scheduleId = requireFieldWith(data, 'scheduleId', '', parseProviderIdField);
  if (!scheduleId.ok) return scheduleId;
  const code = requireString(data, 'code', '', ACTIVITY_CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(data, 'name', '', SCHEDULE_NAME_RULE);
  if (!name.ok) return name;
  const plannedDuration = requireInteger(
    data,
    'plannedDuration',
    '',
    PLANNED_DURATION_BOUNDS.min,
    PLANNED_DURATION_BOUNDS.max,
    PLANNED_DURATION_DESCRIPTION,
  );
  if (!plannedDuration.ok) return plannedDuration;
  const parentActivityId = requireNullableString(data, 'parentActivityId', '', {
    min: 1,
    max: 128,
    pattern: /^[\x21-\x7e]+$/,
    description: 'the parent activity provider id (opaque printable-ASCII) or null',
  });
  if (!parentActivityId.ok) return parentActivityId;
  const plannedStart = requireFieldWith(data, 'plannedStart', '', parseScheduleDate);
  if (!plannedStart.ok) return plannedStart;
  const plannedFinish = requireFieldWith(data, 'plannedFinish', '', parseScheduleDate);
  if (!plannedFinish.ok) return plannedFinish;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      code: code.value,
      name: name.value,
      plannedDuration: plannedDuration.value,
      parentActivityId: parentActivityId.value,
      plannedStart: plannedStart.value,
      plannedFinish: plannedFinish.value,
    } satisfies ActivityProviderData,
  );
}

/** Parse a provider activity-dependency payload (open bag; named fields strict). */
export function parseActivityDependencyProviderData(
  data: AdapterJsonObject,
): ParseResult<ActivityDependencyProviderData> {
  const scheduleId = requireFieldWith(data, 'scheduleId', '', parseProviderIdField);
  if (!scheduleId.ok) return scheduleId;
  const predecessorId = requireFieldWith(data, 'predecessorId', '', parseProviderIdField);
  if (!predecessorId.ok) return predecessorId;
  const successorId = requireFieldWith(data, 'successorId', '', parseProviderIdField);
  if (!successorId.ok) return successorId;
  const linkType = requireFieldWith(data, 'linkType', '', parseScheduleLinkType);
  if (!linkType.ok) return linkType;
  const lagDays = requireInteger(
    data,
    'lagDays',
    '',
    LAG_DAYS_BOUNDS.min,
    LAG_DAYS_BOUNDS.max,
    LAG_DAYS_DESCRIPTION,
  );
  if (!lagDays.ok) return lagDays;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      predecessorId: predecessorId.value,
      successorId: successorId.value,
      linkType: linkType.value,
      lagDays: lagDays.value,
    } satisfies ActivityDependencyProviderData,
  );
}

/** Parse a provider baseline payload (open bag; named fields strict). */
export function parseBaselineProviderData(data: AdapterJsonObject): ParseResult<BaselineProviderData> {
  const scheduleId = requireFieldWith(data, 'scheduleId', '', parseProviderIdField);
  if (!scheduleId.ok) return scheduleId;
  const label = requireString(data, 'label', '', BASELINE_LABEL_RULE);
  if (!label.ok) return label;
  const supersedes = requireFieldWith(data, 'supersedes', '', parseNullableProviderId);
  if (!supersedes.ok) return supersedes;
  const protectedBaseline = requireFieldWith(
    data,
    'protected',
    '',
    (value: unknown): ParseResult<boolean> => {
      if (typeof value !== 'boolean') {
        return parseFail(
          'invalid-type',
          '',
          'the baseline protection flag (boolean: a protected baseline may not be re-baselined in place)',
          describeValue(value),
        );
      }
      return parseOk(value);
    },
  );
  if (!protectedBaseline.ok) return protectedBaseline;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      label: label.value,
      supersedes: supersedes.value,
      protected: protectedBaseline.value,
    } satisfies BaselineProviderData,
  );
}

// ---------------------------------------------------------------------------
// The command translator (provider mutations → canonical command proposals).
// ---------------------------------------------------------------------------

/** Wrap a provider-payload parse failure as a typed DomainError (local). */
const providerDataError = (
  tenantId: AdapterCommandInput['tenantId'],
  failure: { readonly code: string; readonly path: string; readonly expected: string; readonly received: string },
): DomainError =>
  domainError(
    'invariant-violation',
    `provider payload failed fail-closed parsing: ${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`,
    [
      {
        code: `provider-data-${failure.code}`,
        message: failure.received,
        path: failure.path === '' ? null : failure.path,
      },
    ],
    { scope: { kind: 'tenant', tenantId } },
  );

/** The proposed canonical command payload's provenance block (local type). */
type ExtensionMetadata = {
  readonly sourceKey: string;
  readonly providerData?: AdapterJsonObject;
};

const extensionMetadataOf = (
  input: AdapterCommandInput,
  withData: boolean,
): ExtensionMetadata =>
  withData ? { sourceKey: sourceRefKeyOf(input.source), providerData: input.data } : { sourceKey: sourceRefKeyOf(input.source) };

/**
 * The Primavera-class schedule adapter's command translator: proposes the
 * canonical schedules-area command for one provider observation. Pure and
 * deterministic — same input, same proposal; a translation failure is a
 * typed value, and a failed proposal never produces a command envelope.
 */
export function createScheduleTranslator(): AdapterCommandTranslator {
  return {
    proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError> {
      const objectKind = parseScheduleObjectKind(input.source.objectType);
      if (!objectKind.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `the schedule adapter does not translate provider object kind '${String(input.source.objectType)}' — only the schedule object family (project-schedule, activity, activity-dependency, baseline)`,
            [
              {
                code: 'schedule-object-kind-unknown',
                message: String(input.source.objectType),
                path: 'source.objectType',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }

      if (objectKind.value === 'project-schedule') {
        const data = parseProjectScheduleProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        if (input.changeKind === 'created') {
          return ok({
            commandName: CREATE_SCHEDULE_COMMAND,
            payload: {
              name: data.value.name,
              extensionMetadata: extensionMetadataOf(input, true),
            } satisfies AdapterJsonObject,
          });
        }
        return fail(
          domainError(
            'invariant-violation',
            `provider project-schedule ${input.source.objectId} was ${input.changeKind === 'deleted' ? 'deleted' : 'updated'} in place — the frozen schedules-area vocabulary defines no schedule-update or schedule-deletion command (the schedules-area history is append-only); an in-place provider schedule mutation is a divergence the runtime must reconcile explicitly`,
            [
              {
                code: 'schedule-update-unsupported',
                message: input.changeKind,
                path: 'changeKind',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }

      if (objectKind.value === 'activity') {
        const data = parseActivityProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        if (input.changeKind === 'deleted') {
          return fail(
            domainError(
              'invariant-violation',
              `provider activity ${input.source.objectId} was deleted — the schedules-area history is append-only (there is no activity-deletion command); a provider activity deletion is a divergence the runtime must reconcile explicitly`,
              [
                {
                  code: 'schedule-activity-deletion-unsupported',
                  message: input.source.objectId,
                  path: 'changeKind',
                },
              ],
              { scope: { kind: 'tenant', tenantId: input.tenantId } },
            ),
          );
        }
        const canonical = requireCanonicalTarget(input);
        if (!canonical.ok) return canonical;
        if (input.changeKind === 'created') {
          return ok({
            commandName: ADD_ACTIVITY_COMMAND,
            payload: {
              activityId: canonical.value.entityId,
              scheduleProviderId: data.value.scheduleId,
              code: data.value.code,
              name: data.value.name,
              plannedDuration: data.value.plannedDuration,
              parentActivityProviderId: data.value.parentActivityId,
              plannedStart: data.value.plannedStart,
              plannedFinish: data.value.plannedFinish,
              extensionMetadata: extensionMetadataOf(input, true),
            } satisfies AdapterJsonObject,
          });
        }
        return ok({
          commandName: UPDATE_ACTIVITY_COMMAND,
          payload: {
            activityId: canonical.value.entityId,
            scheduleProviderId: data.value.scheduleId,
            code: data.value.code,
            name: data.value.name,
            plannedDuration: data.value.plannedDuration,
            plannedStart: data.value.plannedStart,
            plannedFinish: data.value.plannedFinish,
            expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
            extensionMetadata: extensionMetadataOf(input, true),
          } satisfies AdapterJsonObject,
        });
      }

      if (objectKind.value === 'activity-dependency') {
        const data = parseActivityDependencyProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        if (input.changeKind === 'updated') {
          return fail(
            domainError(
              'invariant-violation',
              `provider activity-dependency ${input.source.objectId} was updated in place — dependencies are added and removed, never mutated: a changed link is a NEW provider dependency object (with the old one removed), never an in-place mutation`,
              [
                {
                  code: 'schedule-dependency-immutable',
                  message: input.source.objectId,
                  path: 'changeKind',
                },
              ],
              { scope: { kind: 'tenant', tenantId: input.tenantId } },
            ),
          );
        }
        const canonical = requireCanonicalTarget(input);
        if (!canonical.ok) return canonical;
        if (input.changeKind === 'deleted') {
          return ok({
            commandName: REMOVE_DEPENDENCY_COMMAND,
            payload: {
              dependencyId: canonical.value.entityId,
              scheduleProviderId: data.value.scheduleId,
              predecessorProviderId: data.value.predecessorId,
              successorProviderId: data.value.successorId,
              linkType: data.value.linkType,
              expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
              extensionMetadata: extensionMetadataOf(input, false),
            } satisfies AdapterJsonObject,
          });
        }
        return ok({
          commandName: ADD_DEPENDENCY_COMMAND,
          payload: {
            dependencyId: canonical.value.entityId,
            scheduleProviderId: data.value.scheduleId,
            predecessorProviderId: data.value.predecessorId,
            successorProviderId: data.value.successorId,
            linkType: data.value.linkType,
            lagDays: data.value.lagDays,
            extensionMetadata: extensionMetadataOf(input, true),
          } satisfies AdapterJsonObject,
        });
      }

      // objectKind.value === 'baseline'
      const data = parseBaselineProviderData(input.data);
      if (!data.ok) {
        return fail(providerDataError(input.tenantId, data.error));
      }
      if (input.changeKind === 'updated' || input.changeKind === 'deleted') {
        return fail(
          domainError(
            'invariant-violation',
            `provider baseline ${input.source.objectId} was ${input.changeKind === 'deleted' ? 'deleted' : 'updated'} in place — baselines are immutable records: a re-baseline is a NEW provider baseline object (supersedes) that registers a NEW canonical baseline record, never a mutation${data.value.protected ? ' of a PROTECTED baseline (the re-baselining conflict the divergence detection records)' : ''}`,
            [
              {
                code: 'schedule-baseline-immutable',
                message: input.source.objectId,
                path: 'changeKind',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: SET_BASELINE_COMMAND,
        payload: {
          baselineId: canonical.value.entityId,
          scheduleProviderId: data.value.scheduleId,
          label: data.value.label,
          supersedesProviderId: data.value.supersedes,
          extensionMetadata: extensionMetadataOf(input, true),
        } satisfies AdapterJsonObject,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The canonical schedules-area event payloads (strict-keyed, fail-closed).
// ---------------------------------------------------------------------------

/** Full provider provenance carried by every schedules-area event payload. */
export interface ScheduleEventProvenance {
  /** The canonical serialization of the provider SourceRef (full identity). */
  readonly sourceKey: string;
  /** The provider object id the observation came from. */
  readonly providerObjectId: string;
  /** The provider version/etag of the observation. */
  readonly providerVersion: string;
}

/** Payload of `schedule.scheduleCreated`. */
export interface ScheduleCreatedPayload {
  readonly scheduleId: EntityId;
  readonly name: string;
  readonly provenance: ScheduleEventProvenance;
}

/** Payload of `schedule.activityAdded`. */
export interface ActivityAddedPayload {
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly parentActivityId: EntityId | null;
  readonly plannedStart: ScheduleDate;
  readonly plannedFinish: ScheduleDate;
  readonly provenance: ScheduleEventProvenance;
}

/** Payload of THE `schedule.activityUpdated` event (the impact-notification trigger). */
export interface ActivityUpdatedPayload {
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly plannedStart: ScheduleDate;
  readonly plannedFinish: ScheduleDate;
  readonly version: number;
  readonly provenance: ScheduleEventProvenance;
}

/** Payload of `schedule.dependencyAdded`. */
export interface DependencyAddedPayload {
  readonly scheduleId: EntityId;
  readonly dependencyId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: ScheduleLinkType;
  readonly lagDays: number;
  readonly version: number;
  readonly provenance: ScheduleEventProvenance;
}

/** Payload of `schedule.dependencyRemoved`. */
export interface DependencyRemovedPayload {
  readonly scheduleId: EntityId;
  readonly dependencyId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly linkType: ScheduleLinkType;
  readonly version: number;
  readonly provenance: ScheduleEventProvenance;
}

/** Payload of `schedule.baselineSet` (an immutable baseline record registered). */
export interface BaselineSetPayload {
  readonly scheduleId: EntityId;
  readonly baselineId: EntityId;
  readonly label: string;
  readonly supersedes: EntityId | null;
  readonly provenance: ScheduleEventProvenance;
}

/** Every schedules-area event payload, discriminated by its event name. */
export type ScheduleEventPayloads =
  | ScheduleCreatedPayload
  | ActivityAddedPayload
  | ActivityUpdatedPayload
  | DependencyAddedPayload
  | DependencyRemovedPayload
  | BaselineSetPayload;

const SOURCE_KEY_RULE: StringRule = {
  min: 2,
  max: 1024,
  pattern: /^\[.*\]$/,
  description: 'the canonical JSON serialization of a SourceRef (a JSON array)',
};

const PROVIDER_VERSION_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]+$/,
  description: 'the provider version/etag of the observation (opaque printable-ASCII)',
};

const AGGREGATE_VERSION_DESCRIPTION = 'a positive aggregate version (integer >= 1)';

const parseProvenance = (raw: unknown): ParseResult<ScheduleEventProvenance> => {
  if (!isPlainObject(raw)) {
    return parseFail(
      'invalid-type',
      '',
      'ScheduleEventProvenance: { sourceKey, providerObjectId, providerVersion }',
      describeValue(raw),
    );
  }
  const sourceKey = requireString(raw, 'sourceKey', '', SOURCE_KEY_RULE);
  if (!sourceKey.ok) return sourceKey;
  const providerObjectId = requireString(raw, 'providerObjectId', '', {
    min: 1,
    max: 128,
    pattern: /^[\x21-\x7e]+$/,
    description: 'opaque printable-ASCII provider object id (no whitespace)',
  });
  if (!providerObjectId.ok) return providerObjectId;
  const providerVersion = requireString(raw, 'providerVersion', '', PROVIDER_VERSION_RULE);
  if (!providerVersion.ok) return providerVersion;
  return parseOk(
    {
      sourceKey: sourceKey.value,
      providerObjectId: providerObjectId.value,
      providerVersion: providerVersion.value,
    } satisfies ScheduleEventProvenance,
  );
};

const parseEntityIdField = (raw: Record<string, unknown>, field: string): ParseResult<EntityId> =>
  requireFieldWith(raw, field, '', parseEntityId);

const parseNullableEntityIdField = (
  raw: Record<string, unknown>,
  field: string,
): ParseResult<EntityId | null> => requireNullableFieldWith(raw, field, '', parseEntityId);

/** Local fail-closed root-type failure helper. */
function rootFailure<T>(grammarName: string): ParseResult<T> {
  return parseFail(
    'invalid-type',
    '',
    `a JSON object (${grammarName} payload)`,
    describeValue(null),
  ) as ParseResult<T>;
}

/** Parse an untrusted value as a ScheduleCreatedPayload (strict keys). */
export function parseScheduleCreatedPayload(raw: unknown): ParseResult<ScheduleCreatedPayload> {
  if (!isPlainObject(raw)) return rootFailure<ScheduleCreatedPayload>('schedule.scheduleCreated');
  const grammar = "ScheduleCreatedPayload: { scheduleId, name, provenance }";
  const unknownKey = unknownKeyFailure(raw, ['scheduleId', 'name', 'provenance'], '', grammar);
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const name = requireString(raw, 'name', '', SCHEDULE_NAME_RULE);
  if (!name.ok) return name;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      name: name.value,
      provenance: provenance.value,
    } satisfies ScheduleCreatedPayload,
  );
}

/** Parse an untrusted value as an ActivityAddedPayload (strict keys). */
export function parseActivityAddedPayload(raw: unknown): ParseResult<ActivityAddedPayload> {
  if (!isPlainObject(raw)) return rootFailure<ActivityAddedPayload>('schedule.activityAdded');
  const grammar =
    "ActivityAddedPayload: { scheduleId, activityId, code, name, plannedDuration, parentActivityId: EntityId | null, plannedStart, plannedFinish, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    [
      'scheduleId',
      'activityId',
      'code',
      'name',
      'plannedDuration',
      'parentActivityId',
      'plannedStart',
      'plannedFinish',
      'provenance',
    ],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const activityId = parseEntityIdField(raw, 'activityId');
  if (!activityId.ok) return activityId;
  const code = requireString(raw, 'code', '', ACTIVITY_CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(raw, 'name', '', SCHEDULE_NAME_RULE);
  if (!name.ok) return name;
  const plannedDuration = requireInteger(
    raw,
    'plannedDuration',
    '',
    PLANNED_DURATION_BOUNDS.min,
    PLANNED_DURATION_BOUNDS.max,
    PLANNED_DURATION_DESCRIPTION,
  );
  if (!plannedDuration.ok) return plannedDuration;
  const parentActivityId = parseNullableEntityIdField(raw, 'parentActivityId');
  if (!parentActivityId.ok) return parentActivityId;
  const plannedStart = requireFieldWith(raw, 'plannedStart', '', parseScheduleDate);
  if (!plannedStart.ok) return plannedStart;
  const plannedFinish = requireFieldWith(raw, 'plannedFinish', '', parseScheduleDate);
  if (!plannedFinish.ok) return plannedFinish;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      activityId: activityId.value,
      code: code.value,
      name: name.value,
      plannedDuration: plannedDuration.value,
      parentActivityId: parentActivityId.value,
      plannedStart: plannedStart.value,
      plannedFinish: plannedFinish.value,
      provenance: provenance.value,
    } satisfies ActivityAddedPayload,
  );
}

/** Parse an untrusted value as an ActivityUpdatedPayload (strict keys). */
export function parseActivityUpdatedPayload(raw: unknown): ParseResult<ActivityUpdatedPayload> {
  if (!isPlainObject(raw)) return rootFailure<ActivityUpdatedPayload>('schedule.activityUpdated');
  const grammar =
    "ActivityUpdatedPayload: { scheduleId, activityId, code, name, plannedDuration, plannedStart, plannedFinish, version, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    [
      'scheduleId',
      'activityId',
      'code',
      'name',
      'plannedDuration',
      'plannedStart',
      'plannedFinish',
      'version',
      'provenance',
    ],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const activityId = parseEntityIdField(raw, 'activityId');
  if (!activityId.ok) return activityId;
  const code = requireString(raw, 'code', '', ACTIVITY_CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(raw, 'name', '', SCHEDULE_NAME_RULE);
  if (!name.ok) return name;
  const plannedDuration = requireInteger(
    raw,
    'plannedDuration',
    '',
    PLANNED_DURATION_BOUNDS.min,
    PLANNED_DURATION_BOUNDS.max,
    PLANNED_DURATION_DESCRIPTION,
  );
  if (!plannedDuration.ok) return plannedDuration;
  const plannedStart = requireFieldWith(raw, 'plannedStart', '', parseScheduleDate);
  if (!plannedStart.ok) return plannedStart;
  const plannedFinish = requireFieldWith(raw, 'plannedFinish', '', parseScheduleDate);
  if (!plannedFinish.ok) return plannedFinish;
  const version = requirePositiveNumber(raw, 'version', '', AGGREGATE_VERSION_DESCRIPTION);
  if (!version.ok) return version;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      activityId: activityId.value,
      code: code.value,
      name: name.value,
      plannedDuration: plannedDuration.value,
      plannedStart: plannedStart.value,
      plannedFinish: plannedFinish.value,
      version: version.value,
      provenance: provenance.value,
    } satisfies ActivityUpdatedPayload,
  );
}

/** Parse an untrusted value as a DependencyAddedPayload (strict keys). */
export function parseDependencyAddedPayload(raw: unknown): ParseResult<DependencyAddedPayload> {
  if (!isPlainObject(raw)) return rootFailure<DependencyAddedPayload>('schedule.dependencyAdded');
  const grammar =
    "DependencyAddedPayload: { scheduleId, dependencyId, predecessorId, successorId, linkType: 'fs' | 'ss' | 'ff' | 'sf', lagDays, version, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    [
      'scheduleId',
      'dependencyId',
      'predecessorId',
      'successorId',
      'linkType',
      'lagDays',
      'version',
      'provenance',
    ],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const dependencyId = parseEntityIdField(raw, 'dependencyId');
  if (!dependencyId.ok) return dependencyId;
  const predecessorId = parseEntityIdField(raw, 'predecessorId');
  if (!predecessorId.ok) return predecessorId;
  const successorId = parseEntityIdField(raw, 'successorId');
  if (!successorId.ok) return successorId;
  const linkType = requireFieldWith(raw, 'linkType', '', parseScheduleLinkType);
  if (!linkType.ok) return linkType;
  const lagDays = requireInteger(
    raw,
    'lagDays',
    '',
    LAG_DAYS_BOUNDS.min,
    LAG_DAYS_BOUNDS.max,
    LAG_DAYS_DESCRIPTION,
  );
  if (!lagDays.ok) return lagDays;
  const version = requirePositiveNumber(raw, 'version', '', AGGREGATE_VERSION_DESCRIPTION);
  if (!version.ok) return version;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      dependencyId: dependencyId.value,
      predecessorId: predecessorId.value,
      successorId: successorId.value,
      linkType: linkType.value,
      lagDays: lagDays.value,
      version: version.value,
      provenance: provenance.value,
    } satisfies DependencyAddedPayload,
  );
}

/** Parse an untrusted value as a DependencyRemovedPayload (strict keys). */
export function parseDependencyRemovedPayload(raw: unknown): ParseResult<DependencyRemovedPayload> {
  if (!isPlainObject(raw)) return rootFailure<DependencyRemovedPayload>('schedule.dependencyRemoved');
  const grammar =
    "DependencyRemovedPayload: { scheduleId, dependencyId, predecessorId, successorId, linkType, version, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['scheduleId', 'dependencyId', 'predecessorId', 'successorId', 'linkType', 'version', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const dependencyId = parseEntityIdField(raw, 'dependencyId');
  if (!dependencyId.ok) return dependencyId;
  const predecessorId = parseEntityIdField(raw, 'predecessorId');
  if (!predecessorId.ok) return predecessorId;
  const successorId = parseEntityIdField(raw, 'successorId');
  if (!successorId.ok) return successorId;
  const linkType = requireFieldWith(raw, 'linkType', '', parseScheduleLinkType);
  if (!linkType.ok) return linkType;
  const version = requirePositiveNumber(raw, 'version', '', AGGREGATE_VERSION_DESCRIPTION);
  if (!version.ok) return version;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      dependencyId: dependencyId.value,
      predecessorId: predecessorId.value,
      successorId: successorId.value,
      linkType: linkType.value,
      version: version.value,
      provenance: provenance.value,
    } satisfies DependencyRemovedPayload,
  );
}

/** Parse an untrusted value as a BaselineSetPayload (strict keys). */
export function parseBaselineSetPayload(raw: unknown): ParseResult<BaselineSetPayload> {
  if (!isPlainObject(raw)) return rootFailure<BaselineSetPayload>('schedule.baselineSet');
  const grammar = "BaselineSetPayload: { scheduleId, baselineId, label, supersedes: EntityId | null, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['scheduleId', 'baselineId', 'label', 'supersedes', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const scheduleId = parseEntityIdField(raw, 'scheduleId');
  if (!scheduleId.ok) return scheduleId;
  const baselineId = parseEntityIdField(raw, 'baselineId');
  if (!baselineId.ok) return baselineId;
  const label = requireString(raw, 'label', '', BASELINE_LABEL_RULE);
  if (!label.ok) return label;
  const supersedes = parseNullableEntityIdField(raw, 'supersedes');
  if (!supersedes.ok) return supersedes;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      scheduleId: scheduleId.value,
      baselineId: baselineId.value,
      label: label.value,
      supersedes: supersedes.value,
      provenance: provenance.value,
    } satisfies BaselineSetPayload,
  );
}

/**
 * Parse an untrusted payload for one schedules-area event name (strict keys,
 * fail-closed). Returns null when the name is not a schedules-area event name
 * (the projection skips unknown names deterministically); a RECOGNIZED name
 * with a malformed payload is a typed parse failure instead.
 */
export function parseScheduleEventPayload(
  eventName: EventName,
  raw: unknown,
): ParseResult<ScheduleEventPayloads> | null {
  if (!isScheduleEventName(eventName)) return null;
  switch (eventName) {
    case SCHEDULE_CREATED_EVENT:
      return parseScheduleCreatedPayload(raw);
    case ACTIVITY_ADDED_EVENT:
      return parseActivityAddedPayload(raw);
    case ACTIVITY_UPDATED_EVENT:
      return parseActivityUpdatedPayload(raw);
    case DEPENDENCY_ADDED_EVENT:
      return parseDependencyAddedPayload(raw);
    case DEPENDENCY_REMOVED_EVENT:
      return parseDependencyRemovedPayload(raw);
    case BASELINE_SET_EVENT:
      return parseBaselineSetPayload(raw);
    default:
      // Unreachable: every SCHEDULE_EVENT_NAMES member is handled above (the
      // isScheduleEventName guard ran first); the default keeps the switch
      // total over future vocabulary extensions.
      return null;
  }
}

// ---------------------------------------------------------------------------
// The trusted event-envelope builders (the host-side execution seam).
// ---------------------------------------------------------------------------

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention): the correlation id of the causal chain is carried over; the
 * causation id of the resulting event is the COMMAND's idempotency key —
 * the id of the message that caused this mutation. For an adapter-proposed
 * command that key is the SourceRef-derived sync idempotency key, so the
 * canonical event is traceable to the exact provider object version.
 * Trusted path: the envelope was already validated (the idempotency-key
 * grammar is exactly the causation-id grammar), so a parse failure here is
 * a loud TypeError, never a silent drop.
 */
const causalityOf = (command: CommandEnvelope<unknown>): Causality => {
  const causationId = parseCausationId(command.idempotencyKey);
  if (!causationId.ok) {
    throw new TypeError(
      `command idempotency key is not a valid causation id: ${command.idempotencyKey}`,
    );
  }
  return {
    correlationId: command.causality.correlationId,
    causationId: causationId.value,
  };
};

/** Inputs of scheduleEventEnvelope (the generic trusted builder). */
export interface ScheduleEventEnvelopeParts<P extends ScheduleEventPayloads> {
  /** The executed command (actor, scope, and causal chain come from it). */
  readonly command: CommandEnvelope<unknown>;
  readonly eventName: EventName;
  /** The injected clock's instant recorded as occurredAt. */
  readonly occurredAt: Timestamp;
  /** Before/after entity references per the transition kind (freeze A3). */
  readonly entityRefs: EntityRefs;
  readonly payload: P;
}

/**
 * Build one canonical schedules-area event envelope (trusted path;
 * self-checked through the contracts parser AND the strict payload parser
 * for the event name, so an emitted event can never be invalid): source is
 * 'domain' (the canonical command path emits; the adapter ORIGIN is carried
 * by the adapter actor, the SourceRef-derived causation id, and the
 * payload's provenance block), scope and actor come from the command, and
 * the causal chain ties the event back to the exact provider object version.
 */
export function scheduleEventEnvelope<P extends ScheduleEventPayloads>(
  parts: ScheduleEventEnvelopeParts<P>,
): DomainEventEnvelope<P> {
  const eventName = parseScheduleEventName(parts.eventName);
  if (!eventName.ok) {
    throw new TypeError(`not a schedules-area event name: ${String(parts.eventName)}`);
  }
  const payloadCheck = parseScheduleEventPayload(eventName.value, parts.payload);
  if (payloadCheck === null || !payloadCheck.ok) {
    const failure = payloadCheck === null ? null : payloadCheck.error;
    throw new TypeError(
      `invalid ${eventName.value} payload: ${failure === null ? 'event name not recognized' : `${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`}`,
    );
  }
  const envelope: DomainEventEnvelope<P> = {
    kind: 'event',
    eventName: eventName.value,
    scope: parts.command.scope,
    actor: parts.command.actor,
    source: 'domain',
    causality: causalityOf(parts.command),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: parts.entityRefs,
    payload: parts.payload,
  };
  const roundTrip = parseDomainEventEnvelope(envelope);
  if (!roundTrip.ok) {
    throw new TypeError(
      `schedules-area event envelope did not round-trip the contracts parser: ${roundTrip.error.code} at '${roundTrip.error.path}'`,
    );
  }
  return envelope;
}

/** The sourceKey derivation shared by the envelope builders (local). */
const sourceKeyOf = (parts: {
  readonly command: CommandEnvelope<unknown>;
  readonly providerObjectId: string;
  readonly providerVersion: string;
  readonly objectType: ProviderObjectKind;
}): string => {
  // The command payload's extensionMetadata carries the canonical sourceKey
  // the translator composed from the observed SourceRef (sourceRefKeyOf);
  // the recomposition below is the fail-safe for commands assembled without
  // it — both agree by construction over the fixture's provider identity.
  const payload = parts.command.payload as {
    readonly extensionMetadata?: { readonly sourceKey?: unknown };
  };
  const sourceKey = payload?.extensionMetadata?.sourceKey;
  if (typeof sourceKey === 'string' && sourceKey.startsWith('[')) {
    return sourceKey;
  }
  return sourceRefKeyOf(
    sourceRef({
      adapterKind: SCHEDULE_ADAPTER_KIND,
      systemId: SCHEDULE_SYSTEM_ID,
      objectType: parts.objectType,
      objectId: providerObjectId(parts.providerObjectId),
      version: providerVersion(parts.providerVersion),
    }),
  );
};

/** Inputs of scheduleCreatedEnvelope. */
export interface ScheduleCreatedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  readonly schedule: EntityRef;
  readonly name: string;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/** Compose the `schedule.scheduleCreated` canonical event envelope. */
export function scheduleCreatedEnvelope(
  parts: ScheduleCreatedEnvelopeParts,
): DomainEventEnvelope<ScheduleCreatedPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: SCHEDULE_CREATED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: null, after: parts.schedule },
    payload: {
      scheduleId: parts.schedule.entityId,
      name: parts.name,
      provenance: provenanceOf(parts, PROJECT_SCHEDULE_OBJECT_KIND),
    },
  });
}

/** Inputs of activityAddedEnvelope. */
export interface ActivityAddedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  readonly activity: EntityRef;
  /** The owning schedule's canonical entity (resolved through mappings). */
  readonly schedule: EntityRef;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  /** The parent activity's canonical entity, or null for top-level activities. */
  readonly parentActivity: EntityRef | null;
  readonly plannedStart: ScheduleDate;
  readonly plannedFinish: ScheduleDate;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/** Compose the `schedule.activityAdded` canonical event envelope. */
export function activityAddedEnvelope(
  parts: ActivityAddedEnvelopeParts,
): DomainEventEnvelope<ActivityAddedPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: ACTIVITY_ADDED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: null, after: parts.activity },
    payload: {
      scheduleId: parts.schedule.entityId,
      activityId: parts.activity.entityId,
      code: parts.code,
      name: parts.name,
      plannedDuration: parts.plannedDuration,
      parentActivityId: parts.parentActivity === null ? null : parts.parentActivity.entityId,
      plannedStart: parts.plannedStart,
      plannedFinish: parts.plannedFinish,
      provenance: provenanceOf(parts, ACTIVITY_OBJECT_KIND),
    },
  });
}

/** Inputs of activityUpdatedEnvelope (THE flow's activity-change builder). */
export interface ActivityUpdatedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  /** The canonical activity (persists — an update is a state transition). */
  readonly activity: EntityRef;
  /** The owning schedule's canonical entity (resolved through mappings). */
  readonly schedule: EntityRef;
  readonly code: string;
  readonly name: string;
  readonly plannedDuration: number;
  readonly plannedStart: ScheduleDate;
  readonly plannedFinish: ScheduleDate;
  /** The canonical aggregate version AFTER the host executed the update. */
  readonly version: number;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/**
 * Compose THE `schedule.activityUpdated` canonical event envelope: the
 * activity-change event of the canonical flow — the trigger of the
 * downstream impact-notification flow (notification.ts). The changed
 * activity persists (entityRefs carry before AND after); the typed CPM data
 * (duration + planned dates) rides the payload.
 */
export function activityUpdatedEnvelope(
  parts: ActivityUpdatedEnvelopeParts,
): DomainEventEnvelope<ActivityUpdatedPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: ACTIVITY_UPDATED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: parts.activity, after: parts.activity },
    payload: {
      scheduleId: parts.schedule.entityId,
      activityId: parts.activity.entityId,
      code: parts.code,
      name: parts.name,
      plannedDuration: parts.plannedDuration,
      plannedStart: parts.plannedStart,
      plannedFinish: parts.plannedFinish,
      version: parts.version,
      provenance: provenanceOf(parts, ACTIVITY_OBJECT_KIND),
    },
  });
}

/** Inputs of dependencyAddedEnvelope. */
export interface DependencyAddedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  readonly dependency: EntityRef;
  readonly schedule: EntityRef;
  readonly predecessor: EntityRef;
  readonly successor: EntityRef;
  readonly linkType: ScheduleLinkType;
  readonly lagDays: number;
  readonly version: number;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/** Compose the `schedule.dependencyAdded` canonical event envelope. */
export function dependencyAddedEnvelope(
  parts: DependencyAddedEnvelopeParts,
): DomainEventEnvelope<DependencyAddedPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: DEPENDENCY_ADDED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: null, after: parts.dependency },
    payload: {
      scheduleId: parts.schedule.entityId,
      dependencyId: parts.dependency.entityId,
      predecessorId: parts.predecessor.entityId,
      successorId: parts.successor.entityId,
      linkType: parts.linkType,
      lagDays: parts.lagDays,
      version: parts.version,
      provenance: provenanceOf(parts, ACTIVITY_DEPENDENCY_OBJECT_KIND),
    },
  });
}

/** Inputs of dependencyRemovedEnvelope. */
export interface DependencyRemovedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  /** The removed dependency (persisting history: before carries it, after is null). */
  readonly dependency: EntityRef;
  readonly schedule: EntityRef;
  readonly predecessor: EntityRef;
  readonly successor: EntityRef;
  readonly linkType: ScheduleLinkType;
  readonly version: number;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/** Compose the `schedule.dependencyRemoved` canonical event envelope. */
export function dependencyRemovedEnvelope(
  parts: DependencyRemovedEnvelopeParts,
): DomainEventEnvelope<DependencyRemovedPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: DEPENDENCY_REMOVED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: parts.dependency, after: null },
    payload: {
      scheduleId: parts.schedule.entityId,
      dependencyId: parts.dependency.entityId,
      predecessorId: parts.predecessor.entityId,
      successorId: parts.successor.entityId,
      linkType: parts.linkType,
      version: parts.version,
      provenance: provenanceOf(parts, ACTIVITY_DEPENDENCY_OBJECT_KIND),
    },
  });
}

/** Inputs of baselineSetEnvelope (the immutable baseline registration). */
export interface BaselineSetEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  /** The NEW canonical baseline record (a re-baseline is a new record). */
  readonly baseline: EntityRef;
  readonly schedule: EntityRef;
  readonly label: string;
  /** The superseded baseline's canonical entity, or null for the first baseline. */
  readonly supersedes: EntityRef | null;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/**
 * Compose the `schedule.baselineSet` canonical event envelope: the immutable
 * baseline discipline — every newly observed provider baseline object
 * (including a re-baseline superseding a prior one) registers a NEW
 * canonical baseline record; a registered baseline is never mutated.
 */
export function baselineSetEnvelope(
  parts: BaselineSetEnvelopeParts,
): DomainEventEnvelope<BaselineSetPayload> {
  return scheduleEventEnvelope({
    command: parts.command,
    eventName: BASELINE_SET_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: null, after: parts.baseline },
    payload: {
      scheduleId: parts.schedule.entityId,
      baselineId: parts.baseline.entityId,
      label: parts.label,
      supersedes: parts.supersedes === null ? null : parts.supersedes.entityId,
      provenance: provenanceOf(parts, BASELINE_OBJECT_KIND),
    },
  });
}

/** The provenance composition shared by the concrete builders (local). */
const provenanceOf = (
  parts: {
    readonly command: CommandEnvelope<unknown>;
    readonly providerObjectId: string;
    readonly providerVersion: string;
  },
  objectType: ProviderObjectKind,
): ScheduleEventProvenance => ({
  sourceKey: sourceKeyOf({
    command: parts.command,
    providerObjectId: parts.providerObjectId,
    providerVersion: parts.providerVersion,
    objectType,
  }),
  providerObjectId: parts.providerObjectId,
  providerVersion: parts.providerVersion,
});
