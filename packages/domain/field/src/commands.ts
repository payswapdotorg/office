// Office field domain — command handlers (OFF-009).
//
// THE canonical mutation path of the field/work module (freeze "cross-view
// mutation" + the OFF-003 kernel contract + the OFF-007 identity-module
// pattern), executed for every command:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. require PROJECT scope (freeze A12 second boundary: every field
//      aggregate is project-bound, so a tenant-scoped command is a typed
//      unauthorized 'project-scope-required' denial — field-event capture
//      requires project scope, not just tenant scope);
//   3. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never mutates anything at all (no store write, no event, no
//      idempotency record);
//   4. deduplicate through the domain-kernel IdempotencyRegistry keyed by
//      (scope, idempotency key) — THE offline-style capture semantics (freeze
//      A9/A8): a replay of the same command (same key, same fingerprint)
//      returns the recorded outcome with exactly-once effects; a DIFFERENT
//      payload under the same key is a typed idempotency-conflict; a failed
//      execution is never recorded, so transient failures stay retryable;
//   5. load the aggregate through the scoped store (foreign tenant → typed
//      not-found, no existence oracle; wrong project → typed unauthorized
//      project-scope-violation) and re-check scope coverage (kernel A12
//      backstop, defense in depth);
//   6. check optimistic concurrency (stale version → typed
//      concurrency-conflict, the state is NEVER silently overwritten);
//   7. apply the invariant-checked pure transition (append-only histories;
//      one-way lifecycles);
//   8. append the audit event through the injected EventSink AND commit the
//      store write — the sink append precedes the store commit, so a sink
//      failure MUST abort the whole mutation (the state is left unchanged);
//   9. return the committed aggregate state as a typed Result (replays carry
//      replayed: true and the ORIGINAL outcome).
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). The canonical id itself is composed through the contracts format
// helper, so every issued id parses with parseEntityId by construction.
// Client-observed timestamps (observedAt / reportedAt / conductedAt /
// scheduledFor) are payload DATA recorded on the aggregate — never authority
// for ordering (see the package README).
import { formatEntityId, parseCommandName } from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  EntityId,
  EntityKind,
  ParseResult,
  ProjectScope,
  Scope,
  Timestamp,
} from '@office/contracts';
import { parseEntityId, parseEntityKind, parseFail, parseOk, parseTimestamp } from '@office/contracts';
import { authorize, authorizationContext, resourceScope } from '@office/authz';
import type { AuthorizationContext, AuthorizationDecision, Policy } from '@office/authz';
import {
  checkConcurrency,
  checkScopeCovers,
  concurrencyTokenOf,
  domainError,
  parseAggregateVersion,
  withIdempotency,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  IdempotencyRegistry,
  Result,
} from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import type { EventSink } from './events';
import {
  DAILY_LOG_DAY_CLOSED_EVENT,
  DAILY_LOG_ENTRY_APPENDED_EVENT,
  FIELD_EVENT_CAPTURED_EVENT,
  FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
  FIELD_EVENT_RESOLVED_EVENT,
  INSPECTION_CONDUCTED_EVENT,
  INSPECTION_OUTCOMED_EVENT,
  INSPECTION_SCHEDULED_EVENT,
  ISSUE_ASSIGNED_EVENT,
  ISSUE_COMMENTED_EVENT,
  ISSUE_RAISED_EVENT,
  ISSUE_REOPENED_EVENT,
  ISSUE_RESOLVED_EVENT,
  createdRefs,
  fieldEventEnvelope,
  updatedRefs,
} from './events';
import type { FieldStore } from './store';
import type {
  ChecklistItem,
  DailyLogEntryInput,
  DailyLogState,
  EvidenceReference,
  FieldEventState,
  InspectionFinding,
  InspectionOutcome,
  InspectionResult,
  InspectionState,
  IssueComment,
  IssueSeverity,
  IssueState,
  Measurement,
} from './state';
import {
  DAILY_LOG_KIND,
  FIELD_EVENT_KIND,
  INSPECTION_KIND,
  INSPECTION_OUTCOMES,
  ISSUE_KIND,
  ISSUE_SEVERITIES,
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
import {
  isPlainObject,
  optionalFieldWith,
  optionalSelfPathedField,
  parseFiniteNumber,
  parseLiteralOf,
  parseLogDay,
  parseStringLike,
  parseValueArrayWith,
  requireFieldWith,
  requireSelfPathedField,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';
import type { LogDay } from './parse';

// ----- command names ----------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid field command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link FieldEventCommands.captureFieldEvent}. */
export const CAPTURE_FIELD_EVENT_COMMAND: CommandName = commandNameOf('field.captureFieldEvent');
/** Command name executed by {@link FieldEventCommands.attachFieldEventEvidence}. */
export const ATTACH_FIELD_EVENT_EVIDENCE_COMMAND: CommandName = commandNameOf(
  'field.attachFieldEventEvidence',
);
/** Command name executed by {@link FieldEventCommands.resolveFieldEvent}. */
export const RESOLVE_FIELD_EVENT_COMMAND: CommandName = commandNameOf('field.resolveFieldEvent');
/** Command name executed by {@link DailyLogCommands.appendDailyLogEntry}. */
export const APPEND_DAILY_LOG_ENTRY_COMMAND: CommandName = commandNameOf(
  'field.appendDailyLogEntry',
);
/** Command name executed by {@link DailyLogCommands.closeDailyLogDay}. */
export const CLOSE_DAILY_LOG_DAY_COMMAND: CommandName = commandNameOf('field.closeDailyLogDay');
/** Command name executed by {@link IssueCommands.raiseIssue}. */
export const RAISE_ISSUE_COMMAND: CommandName = commandNameOf('field.raiseIssue');
/** Command name executed by {@link IssueCommands.assignIssue}. */
export const ASSIGN_ISSUE_COMMAND: CommandName = commandNameOf('field.assignIssue');
/** Command name executed by {@link IssueCommands.commentOnIssue}. */
export const COMMENT_ON_ISSUE_COMMAND: CommandName = commandNameOf('field.commentOnIssue');
/** Command name executed by {@link IssueCommands.resolveIssue}. */
export const RESOLVE_ISSUE_COMMAND: CommandName = commandNameOf('field.resolveIssue');
/** Command name executed by {@link IssueCommands.reopenIssue}. */
export const REOPEN_ISSUE_COMMAND: CommandName = commandNameOf('field.reopenIssue');
/** Command name executed by {@link InspectionCommands.scheduleInspection}. */
export const SCHEDULE_INSPECTION_COMMAND: CommandName = commandNameOf('field.scheduleInspection');
/** Command name executed by {@link InspectionCommands.conductInspection}. */
export const CONDUCT_INSPECTION_COMMAND: CommandName = commandNameOf('field.conductInspection');
/** Command name executed by {@link InspectionCommands.recordInspectionOutcome}. */
export const RECORD_INSPECTION_OUTCOME_COMMAND: CommandName = commandNameOf(
  'field.recordInspectionOutcome',
);

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
      `field command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) --------------------------------

const CATEGORY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case category',
};
const SUMMARY_RULE: StringRule = { min: 1, max: 200, description: 'summary' };
const TITLE_RULE: StringRule = { min: 1, max: 200, description: 'title' };
const DETAIL_RULE: StringRule = { min: 1, max: 4000, description: 'detail' };
const LOCATION_RULE: StringRule = { min: 1, max: 200, description: 'location' };
const BODY_RULE: StringRule = { min: 1, max: 2000, description: 'body text' };
const UNIT_RULE: StringRule = { min: 1, max: 32, description: 'unit of measure' };
const CHECKLIST_KEY_RULE: StringRule = {
  min: 1,
  max: 32,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,31}$/,
  description: 'lowercase kebab-case checklist item key',
};
const REQUIREMENT_RULE: StringRule = { min: 1, max: 500, description: 'requirement' };
const NOTE_RULE: StringRule = { min: 1, max: 1000, description: 'note' };

const parseSeverity = parseLiteralOf(ISSUE_SEVERITIES, 'issue severity');
const parseChecklistResult = parseLiteralOf(
  ['pass', 'fail', 'na'] as const,
  'checklist result',
);
const parseInspectionOutcomeLiteral = parseLiteralOf(INSPECTION_OUTCOMES, 'inspection outcome');

/** Parse a measurement value object (strict keys). */
export function parseMeasurement(raw: unknown): ParseResult<Measurement> {
  const grammar = 'Measurement: { value: finite number, unit: string (1..32) }';
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['value', 'unit'], '', grammar);
  if (unknownKey) return unknownKey;
  const value = requireFieldWith(raw, 'value', '', parseFiniteNumber);
  if (!value.ok) return value;
  const unit = requireString(raw, 'unit', '', UNIT_RULE);
  if (!unit.ok) return unit;
  return parseOk({ value: value.value, unit: unit.value } satisfies Measurement);
}

/** Parse one typed evidence link (strict keys; OFF-008 owns the model, this is the link). */
export function parseEvidenceReference(raw: unknown): ParseResult<EvidenceReference> {
  const grammar =
    'EvidenceReference: { entityKind: EntityKind, entityId: EntityId, revisionId: EntityId } — a typed link to an immutable revision';
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['entityKind', 'entityId', 'revisionId'], '', grammar);
  if (unknownKey) return unknownKey;
  const entityKind = requireFieldWith(raw, 'entityKind', '', parseEntityKind);
  if (!entityKind.ok) return entityKind;
  const entityId = requireFieldWith(raw, 'entityId', '', parseEntityId);
  if (!entityId.ok) return entityId;
  const revisionId = requireFieldWith(raw, 'revisionId', '', parseEntityId);
  if (!revisionId.ok) return revisionId;
  return parseOk(
    {
      entityKind: entityKind.value,
      entityId: entityId.value,
      revisionId: revisionId.value,
    } satisfies EvidenceReference,
  );
}

/** Parse an evidence-reference array (fail-closed, unique triples). */
const parseEvidenceList = (
  raw: unknown,
  field: string,
): ParseResult<readonly EvidenceReference[]> => {
  const parsed = parseValueArrayWith(raw, field, parseEvidenceReference, 'evidence references');
  if (!parsed.ok) return parsed;
  const seen = new Set<string>();
  for (const [index, ref] of parsed.value.entries()) {
    const key = `${ref.entityKind}\u0000${ref.entityId}\u0000${ref.revisionId}`;
    if (seen.has(key)) {
      return parseFail(
        'invalid-value',
        `${field}[${index}]`,
        'evidence references with unique (entityKind, entityId, revisionId) triples',
        'duplicate evidence reference',
      );
    }
    seen.add(key);
  }
  return parsed;
};

/** Validated payload of `field.captureFieldEvent` (the offline-style capture). */
export interface CaptureFieldEventPayload {
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
  readonly location: string;
  /** CLIENT-observed instant — data recorded on the aggregate, not ordering authority. */
  readonly observedAt: Timestamp;
  readonly observedBy: EntityId;
  readonly quantity?: Measurement;
  readonly evidence?: readonly EvidenceReference[];
}

const CAPTURE_PAYLOAD_KEYS = [
  'category',
  'summary',
  'detail',
  'location',
  'observedAt',
  'observedBy',
  'quantity',
  'evidence',
] as const;
const CAPTURE_PAYLOAD_GRAMMAR =
  'CaptureFieldEventPayload: { category: kebab (1..64), summary: string (1..200), detail?: string (1..4000), location: string (1..200), observedAt: Timestamp, observedBy: EntityId, quantity?: { value: finite number, unit: string (1..32) }, evidence?: EvidenceReference[] }';

/** Parse the capture payload (total, fail-closed, strict keys). */
export function parseCaptureFieldEventPayload(
  raw: unknown,
): ParseResult<CaptureFieldEventPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CAPTURE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CAPTURE_PAYLOAD_KEYS, '', CAPTURE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const category = requireString(raw, 'category', '', CATEGORY_RULE);
  if (!category.ok) return category;
  const summary = requireString(raw, 'summary', '', SUMMARY_RULE);
  if (!summary.ok) return summary;
  const detail = optionalFieldWith(raw, 'detail', '', (value) => parseStringLike(value, DETAIL_RULE));
  if (!detail.ok) return detail;
  const location = requireString(raw, 'location', '', LOCATION_RULE);
  if (!location.ok) return location;
  const observedAt = requireFieldWith(raw, 'observedAt', '', parseTimestamp);
  if (!observedAt.ok) return observedAt;
  const observedBy = requireFieldWith(raw, 'observedBy', '', parseEntityId);
  if (!observedBy.ok) return observedBy;
  const quantity = optionalFieldWith(raw, 'quantity', '', parseMeasurement);
  if (!quantity.ok) return quantity;
  const evidence = optionalSelfPathedField(raw, 'evidence', parseEvidenceList);
  if (!evidence.ok) return evidence;
  return parseOk({
    category: category.value,
    summary: summary.value,
    ...(detail.value !== undefined ? { detail: detail.value } : {}),
    location: location.value,
    observedAt: observedAt.value,
    observedBy: observedBy.value,
    ...(quantity.value !== undefined ? { quantity: quantity.value } : {}),
    ...(evidence.value !== undefined ? { evidence: evidence.value } : {}),
  });
}

/** Validated payload of `field.attachFieldEventEvidence`. */
export interface AttachFieldEventEvidencePayload {
  readonly fieldEventId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly evidence: readonly EvidenceReference[];
}

const ATTACH_PAYLOAD_KEYS = ['fieldEventId', 'expectedVersion', 'evidence'] as const;
const ATTACH_PAYLOAD_GRAMMAR =
  'AttachFieldEventEvidencePayload: { fieldEventId: EntityId, expectedVersion: number (>= 1), evidence: EvidenceReference[] (>= 1, unique) }';

/** Parse the attach-evidence payload (total, fail-closed, strict keys). */
export function parseAttachFieldEventEvidencePayload(
  raw: unknown,
): ParseResult<AttachFieldEventEvidencePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ATTACH_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ATTACH_PAYLOAD_KEYS, '', ATTACH_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const fieldEventId = requireFieldWith(raw, 'fieldEventId', '', parseEntityId);
  if (!fieldEventId.ok) return fieldEventId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const evidence = requireSelfPathedField(raw, 'evidence', parseEvidenceList);
  if (!evidence.ok) return evidence;
  if (evidence.value.length < 1) {
    return parseFail(
      'invalid-value',
      'evidence',
      'at least one evidence reference',
      'array of length 0',
    );
  }
  return parseOk({
    fieldEventId: fieldEventId.value,
    expectedVersion: expectedVersion.value,
    evidence: evidence.value,
  });
}

/** Validated payload of `field.resolveFieldEvent`. */
export interface ResolveFieldEventPayload {
  readonly fieldEventId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly resolutionNote?: string;
}

const RESOLVE_FIELD_EVENT_PAYLOAD_KEYS = ['fieldEventId', 'expectedVersion', 'resolutionNote'] as const;
const RESOLVE_FIELD_EVENT_PAYLOAD_GRAMMAR =
  'ResolveFieldEventPayload: { fieldEventId: EntityId, expectedVersion: number (>= 1), resolutionNote?: string (1..2000) }';

/** Parse the resolve-field-event payload (total, fail-closed, strict keys). */
export function parseResolveFieldEventPayload(
  raw: unknown,
): ParseResult<ResolveFieldEventPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RESOLVE_FIELD_EVENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    RESOLVE_FIELD_EVENT_PAYLOAD_KEYS,
    '',
    RESOLVE_FIELD_EVENT_PAYLOAD_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const fieldEventId = requireFieldWith(raw, 'fieldEventId', '', parseEntityId);
  if (!fieldEventId.ok) return fieldEventId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const resolutionNote = optionalFieldWith(raw, 'resolutionNote', '', (value) =>
    parseStringLike(value, BODY_RULE),
  );
  if (!resolutionNote.ok) return resolutionNote;
  return parseOk({
    fieldEventId: fieldEventId.value,
    expectedVersion: expectedVersion.value,
    ...(resolutionNote.value !== undefined ? { resolutionNote: resolutionNote.value } : {}),
  });
}

/** Validated nested shape of one daily-log entry. */
export interface DailyLogEntryPayload {
  readonly summary: string;
  readonly detail?: string;
  readonly fieldEventId?: EntityId;
  readonly correctsEntryId?: EntityId;
  readonly observedAt: Timestamp;
}

const ENTRY_PAYLOAD_KEYS = ['summary', 'detail', 'fieldEventId', 'correctsEntryId', 'observedAt'] as const;
const ENTRY_PAYLOAD_GRAMMAR =
  'DailyLogEntryPayload: { summary: string (1..2000), detail?: string (1..4000), fieldEventId?: EntityId, correctsEntryId?: EntityId, observedAt: Timestamp }';

/** Parse one daily-log entry payload (total, fail-closed, strict keys). */
export function parseDailyLogEntryPayload(raw: unknown): ParseResult<DailyLogEntryPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ENTRY_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ENTRY_PAYLOAD_KEYS, '', ENTRY_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const summary = requireString(raw, 'summary', '', { min: 1, max: 2000, description: 'entry summary' });
  if (!summary.ok) return summary;
  const detail = optionalFieldWith(raw, 'detail', '', (value) => parseStringLike(value, DETAIL_RULE));
  if (!detail.ok) return detail;
  const fieldEventId = optionalFieldWith(raw, 'fieldEventId', '', parseEntityId);
  if (!fieldEventId.ok) return fieldEventId;
  const correctsEntryId = optionalFieldWith(raw, 'correctsEntryId', '', parseEntityId);
  if (!correctsEntryId.ok) return correctsEntryId;
  const observedAt = requireFieldWith(raw, 'observedAt', '', parseTimestamp);
  if (!observedAt.ok) return observedAt;
  return parseOk({
    summary: summary.value,
    ...(detail.value !== undefined ? { detail: detail.value } : {}),
    ...(fieldEventId.value !== undefined ? { fieldEventId: fieldEventId.value } : {}),
    ...(correctsEntryId.value !== undefined ? { correctsEntryId: correctsEntryId.value } : {}),
    observedAt: observedAt.value,
  });
}

/**
 * Validated payload of `field.appendDailyLogEntry`. `expectedVersion` is
 * ABSENT when the append is expected to CREATE the (project, day, party) log
 * (its first entry) and PRESENT when appending to the existing log at that
 * version — a stale or missing pairing is a typed concurrency-conflict.
 */
export interface AppendDailyLogEntryPayload {
  readonly day: LogDay;
  readonly party: EntityId;
  readonly entry: DailyLogEntryPayload;
  readonly expectedVersion?: AggregateVersion;
}

const APPEND_PAYLOAD_KEYS = ['day', 'party', 'entry', 'expectedVersion'] as const;
const APPEND_PAYLOAD_GRAMMAR =
  'AppendDailyLogEntryPayload: { day: YYYY-MM-DD, party: EntityId, entry: DailyLogEntryPayload, expectedVersion?: number (>= 1, absent = create the log) }';

/** Parse the append-entry payload (total, fail-closed, strict keys). */
export function parseAppendDailyLogEntryPayload(
  raw: unknown,
): ParseResult<AppendDailyLogEntryPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPEND_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APPEND_PAYLOAD_KEYS, '', APPEND_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const day = requireFieldWith(raw, 'day', '', parseLogDay);
  if (!day.ok) return day;
  const party = requireFieldWith(raw, 'party', '', parseEntityId);
  if (!party.ok) return party;
  const entry = requireFieldWith(raw, 'entry', '', parseDailyLogEntryPayload);
  if (!entry.ok) return entry;
  const expectedVersion = optionalFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    day: day.value,
    party: party.value,
    entry: entry.value,
    ...(expectedVersion.value !== undefined
      ? { expectedVersion: expectedVersion.value }
      : {}),
  });
}

/** Validated payload of `field.closeDailyLogDay`. */
export interface CloseDailyLogDayPayload {
  readonly day: LogDay;
  readonly party: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const CLOSE_PAYLOAD_KEYS = ['day', 'party', 'expectedVersion'] as const;
const CLOSE_PAYLOAD_GRAMMAR =
  'CloseDailyLogDayPayload: { day: YYYY-MM-DD, party: EntityId, expectedVersion: number (>= 1) }';

/** Parse the close-day payload (total, fail-closed, strict keys). */
export function parseCloseDailyLogDayPayload(
  raw: unknown,
): ParseResult<CloseDailyLogDayPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CLOSE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CLOSE_PAYLOAD_KEYS, '', CLOSE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const day = requireFieldWith(raw, 'day', '', parseLogDay);
  if (!day.ok) return day;
  const party = requireFieldWith(raw, 'party', '', parseEntityId);
  if (!party.ok) return party;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    day: day.value,
    party: party.value,
    expectedVersion: expectedVersion.value,
  });
}

/** Validated payload of `field.raiseIssue` (the offline-style capture). */
export interface RaiseIssuePayload {
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly severity: IssueSeverity;
  /** CLIENT-observed instant — data recorded on the aggregate, not ordering authority. */
  readonly reportedAt: Timestamp;
  readonly reportedBy: EntityId;
}

const RAISE_PAYLOAD_KEYS = [
  'title',
  'description',
  'category',
  'severity',
  'reportedAt',
  'reportedBy',
] as const;
const RAISE_PAYLOAD_GRAMMAR =
  "RaiseIssuePayload: { title: string (1..200), description?: string (1..4000), category: kebab (1..64), severity: 'low' | 'medium' | 'high' | 'critical', reportedAt: Timestamp, reportedBy: EntityId }";

/** Parse the raise-issue payload (total, fail-closed, strict keys). */
export function parseRaiseIssuePayload(raw: unknown): ParseResult<RaiseIssuePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RAISE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RAISE_PAYLOAD_KEYS, '', RAISE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const description = optionalFieldWith(raw, 'description', '', (value) =>
    parseStringLike(value, DETAIL_RULE),
  );
  if (!description.ok) return description;
  const category = requireString(raw, 'category', '', CATEGORY_RULE);
  if (!category.ok) return category;
  const severity = requireFieldWith(raw, 'severity', '', parseSeverity);
  if (!severity.ok) return severity;
  const reportedAt = requireFieldWith(raw, 'reportedAt', '', parseTimestamp);
  if (!reportedAt.ok) return reportedAt;
  const reportedBy = requireFieldWith(raw, 'reportedBy', '', parseEntityId);
  if (!reportedBy.ok) return reportedBy;
  return parseOk({
    title: title.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    category: category.value,
    severity: severity.value,
    reportedAt: reportedAt.value,
    reportedBy: reportedBy.value,
  });
}

/** Shared parse of a mutation payload addressing an aggregate by id + version. */
const parseAddressedPayload = (
  raw: unknown,
  keys: readonly string[],
  grammar: string,
  idField: string,
): ParseResult<{ readonly id: EntityId; readonly expectedVersion: AggregateVersion }> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, keys, '', grammar);
  if (unknownKey) return unknownKey;
  const id = requireFieldWith(raw, idField, '', parseEntityId);
  if (!id.ok) return id;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({ id: id.value, expectedVersion: expectedVersion.value });
};

/** Validated payload of `field.assignIssue`. */
export interface AssignIssuePayload {
  readonly issueId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly assignee: EntityId;
}

const ASSIGN_PAYLOAD_KEYS = ['issueId', 'expectedVersion', 'assignee'] as const;
const ASSIGN_PAYLOAD_GRAMMAR =
  'AssignIssuePayload: { issueId: EntityId, expectedVersion: number (>= 1), assignee: EntityId }';

/** Parse the assign-issue payload (total, fail-closed, strict keys). */
export function parseAssignIssuePayload(raw: unknown): ParseResult<AssignIssuePayload> {
  const addressed = parseAddressedPayload(
    raw,
    ASSIGN_PAYLOAD_KEYS,
    ASSIGN_PAYLOAD_GRAMMAR,
    'issueId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ASSIGN_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const assignee = requireFieldWith(raw, 'assignee', '', parseEntityId);
  if (!assignee.ok) return assignee;
  return parseOk({
    issueId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    assignee: assignee.value,
  });
}

/** Validated payload of `field.commentOnIssue` (append-only comments). */
export interface CommentOnIssuePayload {
  readonly issueId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly body: string;
  readonly correctsCommentId?: EntityId;
}

const COMMENT_PAYLOAD_KEYS = ['issueId', 'expectedVersion', 'body', 'correctsCommentId'] as const;
const COMMENT_PAYLOAD_GRAMMAR =
  'CommentOnIssuePayload: { issueId: EntityId, expectedVersion: number (>= 1), body: string (1..2000), correctsCommentId?: EntityId }';

/** Parse the comment payload (total, fail-closed, strict keys). */
export function parseCommentOnIssuePayload(raw: unknown): ParseResult<CommentOnIssuePayload> {
  const addressed = parseAddressedPayload(
    raw,
    COMMENT_PAYLOAD_KEYS,
    COMMENT_PAYLOAD_GRAMMAR,
    'issueId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', COMMENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const body = requireString(raw, 'body', '', BODY_RULE);
  if (!body.ok) return body;
  const correctsCommentId = optionalFieldWith(raw, 'correctsCommentId', '', parseEntityId);
  if (!correctsCommentId.ok) return correctsCommentId;
  return parseOk({
    issueId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    body: body.value,
    ...(correctsCommentId.value !== undefined
      ? { correctsCommentId: correctsCommentId.value }
      : {}),
  });
}

/** Validated payload of `field.resolveIssue` (a reason is required). */
export interface ResolveIssuePayload {
  readonly issueId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly resolutionNote: string;
}

const RESOLVE_ISSUE_PAYLOAD_KEYS = ['issueId', 'expectedVersion', 'resolutionNote'] as const;
const RESOLVE_ISSUE_PAYLOAD_GRAMMAR =
  'ResolveIssuePayload: { issueId: EntityId, expectedVersion: number (>= 1), resolutionNote: string (1..2000, required) }';

/** Parse the resolve-issue payload (total, fail-closed, strict keys). */
export function parseResolveIssuePayload(raw: unknown): ParseResult<ResolveIssuePayload> {
  const addressed = parseAddressedPayload(
    raw,
    RESOLVE_ISSUE_PAYLOAD_KEYS,
    RESOLVE_ISSUE_PAYLOAD_GRAMMAR,
    'issueId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RESOLVE_ISSUE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const resolutionNote = requireString(raw, 'resolutionNote', '', BODY_RULE);
  if (!resolutionNote.ok) return resolutionNote;
  return parseOk({
    issueId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    resolutionNote: resolutionNote.value,
  });
}

/** Validated payload of `field.reopenIssue` (a reason is required). */
export interface ReopenIssuePayload {
  readonly issueId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly reopenReason: string;
}

const REOPEN_PAYLOAD_KEYS = ['issueId', 'expectedVersion', 'reopenReason'] as const;
const REOPEN_PAYLOAD_GRAMMAR =
  'ReopenIssuePayload: { issueId: EntityId, expectedVersion: number (>= 1), reopenReason: string (1..2000, required) }';

/** Parse the reopen-issue payload (total, fail-closed, strict keys). */
export function parseReopenIssuePayload(raw: unknown): ParseResult<ReopenIssuePayload> {
  const addressed = parseAddressedPayload(
    raw,
    REOPEN_PAYLOAD_KEYS,
    REOPEN_PAYLOAD_GRAMMAR,
    'issueId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REOPEN_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const reopenReason = requireString(raw, 'reopenReason', '', BODY_RULE);
  if (!reopenReason.ok) return reopenReason;
  return parseOk({
    issueId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    reopenReason: reopenReason.value,
  });
}

/** Parse one checklist item (strict keys). */
export function parseChecklistItem(raw: unknown): ParseResult<ChecklistItem> {
  const grammar = 'ChecklistItem: { key: kebab (1..32), requirement: string (1..500) }';
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['key', 'requirement'], '', grammar);
  if (unknownKey) return unknownKey;
  const key = requireString(raw, 'key', '', CHECKLIST_KEY_RULE);
  if (!key.ok) return key;
  const requirement = requireString(raw, 'requirement', '', REQUIREMENT_RULE);
  if (!requirement.ok) return requirement;
  return parseOk({ key: key.value, requirement: requirement.value } satisfies ChecklistItem);
}

/** Parse a checklist array (fail-closed, >= 1 item, unique keys). */
const parseChecklistList = (raw: unknown, field: string): ParseResult<readonly ChecklistItem[]> => {
  const parsed = parseValueArrayWith(raw, field, parseChecklistItem, 'checklist items');
  if (!parsed.ok) return parsed;
  if (parsed.value.length < 1) {
    return parseFail(
      'invalid-value',
      field,
      'at least one checklist item',
      'array of length 0',
    );
  }
  const seen = new Set<string>();
  for (const [index, item] of parsed.value.entries()) {
    if (seen.has(item.key)) {
      return parseFail(
        'invalid-value',
        `${field}[${index}]`,
        'checklist items with unique keys',
        `duplicate checklist key '${item.key}'`,
      );
    }
    seen.add(item.key);
  }
  return parsed;
};

/** Validated payload of `field.scheduleInspection`. */
export interface ScheduleInspectionPayload {
  readonly title: string;
  readonly description?: string;
  readonly scheduledFor: Timestamp;
  readonly checklist: readonly ChecklistItem[];
}

const SCHEDULE_PAYLOAD_KEYS = ['title', 'description', 'scheduledFor', 'checklist'] as const;
const SCHEDULE_PAYLOAD_GRAMMAR =
  'ScheduleInspectionPayload: { title: string (1..200), description?: string (1..4000), scheduledFor: Timestamp, checklist: ChecklistItem[] (>= 1, unique keys) }';

/** Parse the schedule-inspection payload (total, fail-closed, strict keys). */
export function parseScheduleInspectionPayload(
  raw: unknown,
): ParseResult<ScheduleInspectionPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SCHEDULE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SCHEDULE_PAYLOAD_KEYS, '', SCHEDULE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const description = optionalFieldWith(raw, 'description', '', (value) =>
    parseStringLike(value, DETAIL_RULE),
  );
  if (!description.ok) return description;
  const scheduledFor = requireFieldWith(raw, 'scheduledFor', '', parseTimestamp);
  if (!scheduledFor.ok) return scheduledFor;
  const checklist = requireSelfPathedField(raw, 'checklist', parseChecklistList);
  if (!checklist.ok) return checklist;
  return parseOk({
    title: title.value,
    ...(description.value !== undefined ? { description: description.value } : {}),
    scheduledFor: scheduledFor.value,
    checklist: checklist.value,
  });
}

/** Parse one checklist result record (strict keys). */
export function parseInspectionResult(raw: unknown): ParseResult<InspectionResult> {
  const grammar = "InspectionResult: { key: kebab (1..32), result: 'pass' | 'fail' | 'na', note?: string (1..1000) }";
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['key', 'result', 'note'], '', grammar);
  if (unknownKey) return unknownKey;
  const key = requireString(raw, 'key', '', CHECKLIST_KEY_RULE);
  if (!key.ok) return key;
  const result = requireFieldWith(raw, 'result', '', parseChecklistResult);
  if (!result.ok) return result;
  const note = optionalFieldWith(raw, 'note', '', (value) => parseStringLike(value, NOTE_RULE));
  if (!note.ok) return note;
  return parseOk({
    key: key.value,
    result: result.value,
    note: note.value ?? null,
  } satisfies InspectionResult);
}

/** Parse a checklist-result array (fail-closed, unique keys). */
const parseInspectionResultList = (
  raw: unknown,
  field: string,
): ParseResult<readonly InspectionResult[]> => {
  const parsed = parseValueArrayWith(raw, field, parseInspectionResult, 'checklist results');
  if (!parsed.ok) return parsed;
  const seen = new Set<string>();
  for (const [index, result] of parsed.value.entries()) {
    if (seen.has(result.key)) {
      return parseFail(
        'invalid-value',
        `${field}[${index}]`,
        'checklist results with unique keys',
        `duplicate result key '${result.key}'`,
      );
    }
    seen.add(result.key);
  }
  return parsed;
};

/** Validated payload of `field.conductInspection`. */
export interface ConductInspectionPayload {
  readonly inspectionId: EntityId;
  readonly expectedVersion: AggregateVersion;
  /** CLIENT-observed instant of the physical inspection — data. */
  readonly conductedAt: Timestamp;
  readonly results: readonly InspectionResult[];
}

const CONDUCT_PAYLOAD_KEYS = ['inspectionId', 'expectedVersion', 'conductedAt', 'results'] as const;
const CONDUCT_PAYLOAD_GRAMMAR =
  "ConductInspectionPayload: { inspectionId: EntityId, expectedVersion: number (>= 1), conductedAt: Timestamp, results: InspectionResult[] (unique keys, exactly the declared checklist) }";

/** Parse the conduct-inspection payload (total, fail-closed, strict keys). */
export function parseConductInspectionPayload(
  raw: unknown,
): ParseResult<ConductInspectionPayload> {
  const addressed = parseAddressedPayload(
    raw,
    CONDUCT_PAYLOAD_KEYS,
    CONDUCT_PAYLOAD_GRAMMAR,
    'inspectionId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONDUCT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const conductedAt = requireFieldWith(raw, 'conductedAt', '', parseTimestamp);
  if (!conductedAt.ok) return conductedAt;
  const results = requireSelfPathedField(raw, 'results', parseInspectionResultList);
  if (!results.ok) return results;
  return parseOk({
    inspectionId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    conductedAt: conductedAt.value,
    results: results.value,
  });
}

/** Parse one inspection finding (strict keys). */
export function parseInspectionFinding(raw: unknown): ParseResult<InspectionFinding> {
  const grammar = 'InspectionFinding: { issueId: EntityId, note?: string (1..1000) }';
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['issueId', 'note'], '', grammar);
  if (unknownKey) return unknownKey;
  const issueId = requireFieldWith(raw, 'issueId', '', parseEntityId);
  if (!issueId.ok) return issueId;
  const note = optionalFieldWith(raw, 'note', '', (value) => parseStringLike(value, NOTE_RULE));
  if (!note.ok) return note;
  return parseOk({
    issueId: issueId.value,
    note: note.value ?? null,
  } satisfies InspectionFinding);
}

/** Parse a findings array (fail-closed, unique issue links). */
const parseInspectionFindingList = (
  raw: unknown,
  field: string,
): ParseResult<readonly InspectionFinding[]> => {
  const parsed = parseValueArrayWith(raw, field, parseInspectionFinding, 'inspection findings');
  if (!parsed.ok) return parsed;
  const seen = new Set<string>();
  for (const [index, finding] of parsed.value.entries()) {
    if (seen.has(finding.issueId)) {
      return parseFail(
        'invalid-value',
        `${field}[${index}]`,
        'findings linking unique issues',
        `duplicate finding for issue ${finding.issueId}`,
      );
    }
    seen.add(finding.issueId);
  }
  return parsed;
};

/** Validated payload of `field.recordInspectionOutcome`. */
export interface RecordInspectionOutcomePayload {
  readonly inspectionId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly outcome: InspectionOutcome;
  readonly findings?: readonly InspectionFinding[];
  readonly summary?: string;
}

const OUTCOME_PAYLOAD_KEYS = ['inspectionId', 'expectedVersion', 'outcome', 'findings', 'summary'] as const;
const OUTCOME_PAYLOAD_GRAMMAR =
  "RecordInspectionOutcomePayload: { inspectionId: EntityId, expectedVersion: number (>= 1), outcome: 'passed' | 'failed' | 'partial', findings?: InspectionFinding[], summary?: string (1..2000) }";

/** Parse the record-outcome payload (total, fail-closed, strict keys). */
export function parseRecordInspectionOutcomePayload(
  raw: unknown,
): ParseResult<RecordInspectionOutcomePayload> {
  const addressed = parseAddressedPayload(
    raw,
    OUTCOME_PAYLOAD_KEYS,
    OUTCOME_PAYLOAD_GRAMMAR,
    'inspectionId',
  );
  if (!addressed.ok) return { ok: false, error: addressed.error };
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', OUTCOME_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const outcome = requireFieldWith(raw, 'outcome', '', parseInspectionOutcomeLiteral);
  if (!outcome.ok) return outcome;
  const findings = optionalSelfPathedField(raw, 'findings', parseInspectionFindingList);
  if (!findings.ok) return findings;
  const summary = optionalFieldWith(raw, 'summary', '', (value) => parseStringLike(value, BODY_RULE));
  if (!summary.ok) return summary;
  return parseOk({
    inspectionId: addressed.value.id,
    expectedVersion: addressed.value.expectedVersion,
    outcome: outcome.value,
    ...(findings.value !== undefined ? { findings: findings.value } : {}),
    ...(summary.value !== undefined ? { summary: summary.value } : {}),
  });
}

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

// ----- command service -----------------------------------------------------------

/**
 * Wiring dependencies of the field command service. `now` and `newOpaqueId`
 * are the injected suppliers (determinism rule): fixed values in tests, wall
 * clock / crypto randomness in production wiring. `executor` is the
 * transaction handle handed to the EventSink with every append — the
 * runtime's open transaction executor when the sink is transactional (the
 * ledger-backed adapter), any opaque handle for in-memory sinks.
 */
export interface FieldCommandDeps {
  /** The aggregate-keeper port (in-memory reference implementation shipped). */
  readonly store: FieldStore;
  /** The audit-event sink (in-memory and ledger-backed implementations shipped). */
  readonly eventSink: EventSink;
  /** The idempotency registry keyed by (scope, idempotency key) — offline replay. */
  readonly idempotencyRegistry: IdempotencyRegistry;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
  /** The executor (transaction handle) the sink appends with. */
  readonly executor: SqlExecutor;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface FieldCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/**
 * The typed outcome of a field command: the committed aggregate state, plus
 * whether this execution REPLAYED a prior one (offline-style capture: the
 * same (scope, idempotency key) had already executed — the original outcome
 * is returned, no second effect).
 */
export interface FieldCommandOutcome<T> {
  /** True when the recorded outcome of a prior execution was replayed. */
  readonly replayed: boolean;
  /** The committed aggregate state (the ORIGINAL outcome on replay). */
  readonly state: T;
}

/** The field-event command surface. */
export interface FieldEventCommands {
  /**
   * Capture a field observation (offline-style: the envelope's idempotency
   * key is CLIENT-generated; observedAt is the client-observed instant).
   */
  captureFieldEvent(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<FieldEventState>>>;
  /** Attach typed evidence links to an OPEN field event (append-only). */
  attachFieldEventEvidence(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<FieldEventState>>>;
  /** Resolve an OPEN field event — the one-way close of the capture lifecycle. */
  resolveFieldEvent(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<FieldEventState>>>;
}

/** The daily-log command surface. */
export interface DailyLogCommands {
  /**
   * Append one entry to the (project, day, party) log — the first appended
   * entry creates the log. Entries are append-only; corrections are new
   * entries referencing the corrected one.
   */
  appendDailyLogEntry(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<DailyLogState>>>;
  /** Close the day — the explicit, once-only lifecycle event. */
  closeDailyLogDay(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<DailyLogState>>>;
}

/** The issue command surface. */
export interface IssueCommands {
  /** Raise an issue (offline-style: client idempotency key + reportedAt). */
  raiseIssue(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<IssueState>>>;
  /** Assign an OPEN issue to a party (assignment changes the assignee). */
  assignIssue(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<IssueState>>>;
  /** Append one comment to the issue's append-only history. */
  commentOnIssue(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<IssueState>>>;
  /** Resolve an OPEN issue with a required resolution note. */
  resolveIssue(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<IssueState>>>;
  /** Reopen a RESOLVED issue with a required reason. */
  reopenIssue(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<IssueState>>>;
}

/** The inspection command surface. */
export interface InspectionCommands {
  /** Schedule an inspection with its declared checklist. */
  scheduleInspection(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<InspectionState>>>;
  /** Record the conduct of a SCHEDULED inspection (immutable checklist results). */
  conductInspection(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<InspectionState>>>;
  /** Record the terminal outcome of a CONDUCTED inspection with findings. */
  recordInspectionOutcome(
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
  ): Promise<CommandResult<FieldCommandOutcome<InspectionState>>>;
}

/** The field/work command surface: four aggregate command groups. */
export interface FieldCommands {
  readonly fieldEvents: FieldEventCommands;
  readonly dailyLogs: DailyLogCommands;
  readonly issues: IssueCommands;
  readonly inspections: InspectionCommands;
}

/** Create the field command service. */
export function createFieldCommands(deps: FieldCommandDeps): FieldCommands {
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
    authorization: FieldCommandAuthorization,
    scope: Scope,
  ): AuthorizationContext =>
    authorizationContext({
      actor: command.actor,
      scope,
      capabilities: authorization.capabilities,
    });

  /**
   * Every field command requires PROJECT scope (freeze A12 second boundary):
   * each of the four aggregates is project-bound, so a tenant-scoped command
   * cannot address one — typed unauthorized 'project-scope-required'.
   */
  const requireProjectScope = (
    command: CommandEnvelope<unknown>,
  ): Result<ProjectScope, DomainError> => {
    if (command.scope.kind === 'project') return { ok: true, value: command.scope };
    return {
      ok: false,
      error: domainError(
        'unauthorized',
        `field command '${command.commandName}' requires project scope (the second authorization boundary, freeze A12); received ${command.scope.kind} scope`,
        [
          {
            code: 'project-scope-required',
            message: `received ${command.scope.kind} scope`,
            path: 'scope',
          },
        ],
        errorContextOf(command),
      ),
    };
  };

  /** The write authorization of one field mutation (deny-by-default). */
  const authorizeWrite = (
    command: CommandEnvelope<unknown>,
    authorization: FieldCommandAuthorization,
    projectScope: ProjectScope,
    resourceKind: EntityKind,
    resourceId: EntityId | null,
  ): Result<AuthorizationDecision, DomainError> =>
    authorize(
      authorization.policy,
      contextOf(command, authorization, projectScope),
      resourceScope({
        scope: projectScope,
        resourceKind,
        resourceId,
        ownerId: null,
      }),
      'write',
      errorContextOf(command),
    );

  /**
   * Execute one command idempotently through the registry (offline-style
   * capture): the first execution records its outcome under (scope,
   * idempotency key); a same-fingerprint replay returns the ORIGINAL outcome
   * with replayed: true; a different fingerprint is a typed
   * idempotency-conflict; failures are never recorded (retryable).
   */
  const runIdempotent = async <T>(
    command: CommandEnvelope<unknown>,
    execute: () => Promise<Result<T, DomainError>> | Result<T, DomainError>,
  ): Promise<CommandResult<FieldCommandOutcome<T>>> => {
    const executed = await withIdempotency(deps.idempotencyRegistry, command, execute);
    if (!executed.ok) return executed;
    return {
      ok: true,
      value: { replayed: executed.value.replayed, state: executed.value.value },
    };
  };

  /** The optimistic-concurrency token of an addressed aggregate. */
  const tokenOf = (
    entityKind: EntityKind,
    entityId: EntityId,
    version: AggregateVersion,
  ): ConcurrencyToken => ({
    kind: 'concurrency-token',
    entityKind,
    entityId,
    version,
  });

  /** Issue one fresh canonical EntityId from the injected supplier. */
  const newEntityId = (): EntityId =>
    formatEntityId({ version: 'v1', opaque: deps.newOpaqueId() });

  /**
   * The typed concurrency-conflict of a creating append whose (day, party)
   * log already exists (the client presented no expectedVersion).
   */
  const dailyLogAlreadyExists = (
    existing: DailyLogState,
    context?: DomainErrorContext,
  ): DomainError =>
    domainError(
      'concurrency-conflict',
      `a daily log for day ${existing.day} and party ${existing.party} already exists (${existing.entityId}, version ${existing.version}); present its expectedVersion to append to it`,
      [
        {
          code: 'daily-log-already-exists',
          message: `daily log ${existing.entityId} at version ${existing.version}`,
          path: 'expectedVersion',
        },
      ],
      context,
    );

  return {
    fieldEvents: {
      captureFieldEvent: async (command, authorization) => {
        requireCommandName(command, CAPTURE_FIELD_EVENT_COMMAND);
        const payload = parseCaptureFieldEventPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          FIELD_EVENT_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);
          const fieldEventId = newEntityId();

          const initial = createFieldEventState(
            {
              fieldEventId,
              category: payload.value.category,
              summary: payload.value.summary,
              ...(payload.value.detail !== undefined ? { detail: payload.value.detail } : {}),
              location: payload.value.location,
              observedAt: payload.value.observedAt,
              observedBy: payload.value.observedBy,
              ...(payload.value.quantity !== undefined
                ? { quantity: payload.value.quantity }
                : {}),
              ...(payload.value.evidence !== undefined
                ? { evidence: payload.value.evidence }
                : {}),
              now,
            },
            scope,
            context,
          );
          if (!initial.ok) return initial;

          const event = fieldEventEnvelope({
            command,
            eventName: FIELD_EVENT_CAPTURED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: createdRefs(initial.value),
            payload: {
              fieldEventId: initial.value.entityId,
              category: initial.value.category,
              summary: initial.value.summary,
              detail: initial.value.detail,
              location: initial.value.location,
              observedAt: initial.value.observedAt,
              observedBy: initial.value.observedBy,
              quantity: initial.value.quantity,
              evidence: initial.value.evidence,
              status: initial.value.status,
              version: initial.value.version,
              createdAt: initial.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveFieldEvent(initial.value);
          return { ok: true, value: initial.value };
        });
      },

      attachFieldEventEvidence: async (command, authorization) => {
        requireCommandName(command, ATTACH_FIELD_EVENT_EVIDENCE_COMMAND);
        const payload = parseAttachFieldEventEvidencePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          FIELD_EVENT_KIND,
          payload.value.fieldEventId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findFieldEvent(command.scope, payload.value.fieldEventId);
          if (!loaded.ok) return loaded;

          // A12 backstop (kernel): the command scope must cover the loaded
          // aggregate's owning scope — with the scoped store this cannot
          // fire, and it is checked anyway (defense in depth for alternative
          // FieldStore implementations).
          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(FIELD_EVENT_KIND, payload.value.fieldEventId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = attachFieldEventEvidenceState(
            loaded.value,
            payload.value.evidence,
            now,
            context,
          );
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: FIELD_EVENT_EVIDENCE_ATTACHED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              fieldEventId: next.value.entityId,
              attached: payload.value.evidence,
              evidenceCount: next.value.evidence.length,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveFieldEvent(next.value);
          return { ok: true, value: next.value };
        });
      },

      resolveFieldEvent: async (command, authorization) => {
        requireCommandName(command, RESOLVE_FIELD_EVENT_COMMAND);
        const payload = parseResolveFieldEventPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          FIELD_EVENT_KIND,
          payload.value.fieldEventId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findFieldEvent(command.scope, payload.value.fieldEventId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(FIELD_EVENT_KIND, payload.value.fieldEventId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = resolveFieldEventState(
            loaded.value,
            now,
            payload.value.resolutionNote,
            context,
          );
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: FIELD_EVENT_RESOLVED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              fieldEventId: next.value.entityId,
              status: next.value.status,
              resolvedAt: now,
              resolutionNote: next.value.resolutionNote,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveFieldEvent(next.value);
          return { ok: true, value: next.value };
        });
      },
    },

    dailyLogs: {
      appendDailyLogEntry: async (command, authorization) => {
        requireCommandName(command, APPEND_DAILY_LOG_ENTRY_COMMAND);
        const payload = parseAppendDailyLogEntryPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          DAILY_LOG_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);

          // A grouping entry references a field event of the same project
          // scope — the reference must resolve (typed not-found otherwise).
          if (payload.value.entry.fieldEventId !== undefined) {
            const referenced = deps.store.findFieldEvent(
              command.scope,
              payload.value.entry.fieldEventId,
            );
            if (!referenced.ok) return referenced;
          }

          const entryInput: DailyLogEntryInput = {
            entryId: newEntityId(),
            summary: payload.value.entry.summary,
            ...(payload.value.entry.detail !== undefined
              ? { detail: payload.value.entry.detail }
              : {}),
            ...(payload.value.entry.fieldEventId !== undefined
              ? { fieldEventId: payload.value.entry.fieldEventId }
              : {}),
            ...(payload.value.entry.correctsEntryId !== undefined
              ? { correctsEntryId: payload.value.entry.correctsEntryId }
              : {}),
            observedAt: payload.value.entry.observedAt,
          };

          const existing = deps.store.findDailyLogByDay(
            command.scope,
            payload.value.day,
            payload.value.party,
            context,
          );

          if (!existing.ok) {
            if (existing.error.code !== 'not-found') return existing;
            // The (project, day, party) log does not exist yet: this append
            // CREATES it — the client must not have presented an
            // expectedVersion for a log that is not there.
            if (payload.value.expectedVersion !== undefined) {
              return existing;
            }
            const dailyLogId = newEntityId();
            const created = createDailyLogState(
              {
                dailyLogId,
                day: payload.value.day,
                party: payload.value.party,
                firstEntry: entryInput,
                now,
              },
              scope,
              context,
            );
            if (!created.ok) return created;
            const firstEntry = created.value.entries[0];
            if (firstEntry === undefined) {
              // Invariant-guaranteed non-null (entries are non-empty); a
              // violation means the transition is malformed — loud, never silent.
              throw new TypeError(
                `created daily log ${created.value.entityId} holds no first entry`,
              );
            }

            const event = fieldEventEnvelope({
              command,
              eventName: DAILY_LOG_ENTRY_APPENDED_EVENT,
              scope,
              occurredAt: now,
              entityRefs: createdRefs(created.value),
              payload: {
                dailyLogId: created.value.entityId,
                day: created.value.day,
                party: created.value.party,
                entry: firstEntry,
                entryCount: created.value.entries.length,
                status: created.value.status,
                version: created.value.version,
                updatedAt: created.value.updatedAt,
              },
            });
            const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
            if (!appended.ok) return appended;

            deps.store.saveDailyLog(created.value);
            return { ok: true, value: created.value };
          }

          // The log exists: the append must present its expectedVersion —
          // absence means the client believed the log absent (typed
          // concurrency-conflict, never a silent re-create).
          if (payload.value.expectedVersion === undefined) {
            return { ok: false, error: dailyLogAlreadyExists(existing.value, context) };
          }

          const coverage = checkScopeCovers(command.scope, existing.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(DAILY_LOG_KIND, existing.value.entityId, payload.value.expectedVersion),
            concurrencyTokenOf(existing.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = appendDailyLogEntryState(existing.value, entryInput, now, context);
          if (!next.ok) return next;
          const appendedEntry = next.value.entries[next.value.entries.length - 1];
          if (appendedEntry === undefined) {
            // Invariant-guaranteed non-null; a violation means the transition
            // is malformed — loud, never silent.
            throw new TypeError(
              `daily log ${next.value.entityId} holds no appended entry`,
            );
          }

          const event = fieldEventEnvelope({
            command,
            eventName: DAILY_LOG_ENTRY_APPENDED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(existing.value, next.value),
            payload: {
              dailyLogId: next.value.entityId,
              day: next.value.day,
              party: next.value.party,
              entry: appendedEntry,
              entryCount: next.value.entries.length,
              status: next.value.status,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveDailyLog(next.value);
          return { ok: true, value: next.value };
        });
      },

      closeDailyLogDay: async (command, authorization) => {
        requireCommandName(command, CLOSE_DAILY_LOG_DAY_COMMAND);
        const payload = parseCloseDailyLogDayPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          DAILY_LOG_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findDailyLogByDay(
            command.scope,
            payload.value.day,
            payload.value.party,
            context,
          );
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(DAILY_LOG_KIND, loaded.value.entityId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = closeDailyLogDayState(loaded.value, now, context);
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: DAILY_LOG_DAY_CLOSED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              dailyLogId: next.value.entityId,
              day: next.value.day,
              party: next.value.party,
              closedAt: now,
              entryCount: next.value.entries.length,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveDailyLog(next.value);
          return { ok: true, value: next.value };
        });
      },
    },

    issues: {
      raiseIssue: async (command, authorization) => {
        requireCommandName(command, RAISE_ISSUE_COMMAND);
        const payload = parseRaiseIssuePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          ISSUE_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);
          const issueId = newEntityId();

          const initial = createIssueState(
            {
              issueId,
              title: payload.value.title,
              ...(payload.value.description !== undefined
                ? { description: payload.value.description }
                : {}),
              category: payload.value.category,
              severity: payload.value.severity,
              reportedAt: payload.value.reportedAt,
              reportedBy: payload.value.reportedBy,
              now,
            },
            scope,
            context,
          );
          if (!initial.ok) return initial;

          const event = fieldEventEnvelope({
            command,
            eventName: ISSUE_RAISED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: createdRefs(initial.value),
            payload: {
              issueId: initial.value.entityId,
              title: initial.value.title,
              description: initial.value.description,
              category: initial.value.category,
              severity: initial.value.severity,
              status: initial.value.status,
              reportedAt: initial.value.reportedAt,
              reportedBy: initial.value.reportedBy,
              version: initial.value.version,
              createdAt: initial.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveIssue(initial.value);
          return { ok: true, value: initial.value };
        });
      },

      assignIssue: async (command, authorization) => {
        requireCommandName(command, ASSIGN_ISSUE_COMMAND);
        const payload = parseAssignIssuePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          ISSUE_KIND,
          payload.value.issueId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findIssue(command.scope, payload.value.issueId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(ISSUE_KIND, payload.value.issueId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = assignIssueState(loaded.value, payload.value.assignee, now, context);
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: ISSUE_ASSIGNED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              issueId: next.value.entityId,
              assignee: payload.value.assignee,
              assignedAt: now,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveIssue(next.value);
          return { ok: true, value: next.value };
        });
      },

      commentOnIssue: async (command, authorization) => {
        requireCommandName(command, COMMENT_ON_ISSUE_COMMAND);
        const payload = parseCommentOnIssuePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          ISSUE_KIND,
          payload.value.issueId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findIssue(command.scope, payload.value.issueId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(ISSUE_KIND, payload.value.issueId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const comment: IssueComment = {
            commentId: newEntityId(),
            body: payload.value.body,
            correctsCommentId: payload.value.correctsCommentId ?? null,
            recordedAt: now,
          };

          const next = commentOnIssueState(loaded.value, comment, now, context);
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: ISSUE_COMMENTED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              issueId: next.value.entityId,
              comment,
              commentCount: next.value.comments.length,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveIssue(next.value);
          return { ok: true, value: next.value };
        });
      },

      resolveIssue: async (command, authorization) => {
        requireCommandName(command, RESOLVE_ISSUE_COMMAND);
        const payload = parseResolveIssuePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          ISSUE_KIND,
          payload.value.issueId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findIssue(command.scope, payload.value.issueId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(ISSUE_KIND, payload.value.issueId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = resolveIssueState(loaded.value, now, payload.value.resolutionNote, context);
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: ISSUE_RESOLVED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              issueId: next.value.entityId,
              status: next.value.status,
              resolvedAt: now,
              resolutionNote: payload.value.resolutionNote,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveIssue(next.value);
          return { ok: true, value: next.value };
        });
      },

      reopenIssue: async (command, authorization) => {
        requireCommandName(command, REOPEN_ISSUE_COMMAND);
        const payload = parseReopenIssuePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          ISSUE_KIND,
          payload.value.issueId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findIssue(command.scope, payload.value.issueId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(ISSUE_KIND, payload.value.issueId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = reopenIssueState(loaded.value, now, payload.value.reopenReason, context);
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: ISSUE_REOPENED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              issueId: next.value.entityId,
              status: next.value.status,
              reopenedAt: now,
              reopenReason: payload.value.reopenReason,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveIssue(next.value);
          return { ok: true, value: next.value };
        });
      },
    },

    inspections: {
      scheduleInspection: async (command, authorization) => {
        requireCommandName(command, SCHEDULE_INSPECTION_COMMAND);
        const payload = parseScheduleInspectionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          INSPECTION_KIND,
          null,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const scope: Scope = projectScope.value;
          const context = errorContextOf(command);
          const inspectionId = newEntityId();

          const initial = createInspectionState(
            {
              inspectionId,
              title: payload.value.title,
              ...(payload.value.description !== undefined
                ? { description: payload.value.description }
                : {}),
              checklist: payload.value.checklist,
              scheduledFor: payload.value.scheduledFor,
              now,
            },
            scope,
            context,
          );
          if (!initial.ok) return initial;

          const event = fieldEventEnvelope({
            command,
            eventName: INSPECTION_SCHEDULED_EVENT,
            scope,
            occurredAt: now,
            entityRefs: createdRefs(initial.value),
            payload: {
              inspectionId: initial.value.entityId,
              title: initial.value.title,
              description: initial.value.description,
              scheduledFor: initial.value.scheduledFor,
              checklist: initial.value.checklist,
              status: initial.value.status,
              version: initial.value.version,
              createdAt: initial.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveInspection(initial.value);
          return { ok: true, value: initial.value };
        });
      },

      conductInspection: async (command, authorization) => {
        requireCommandName(command, CONDUCT_INSPECTION_COMMAND);
        const payload = parseConductInspectionPayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          INSPECTION_KIND,
          payload.value.inspectionId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findInspection(command.scope, payload.value.inspectionId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(INSPECTION_KIND, payload.value.inspectionId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          const next = conductInspectionState(
            loaded.value,
            payload.value.conductedAt,
            payload.value.results,
            now,
            context,
          );
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: INSPECTION_CONDUCTED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              inspectionId: next.value.entityId,
              status: next.value.status,
              conductedAt: payload.value.conductedAt,
              results: next.value.results,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveInspection(next.value);
          return { ok: true, value: next.value };
        });
      },

      recordInspectionOutcome: async (command, authorization) => {
        requireCommandName(command, RECORD_INSPECTION_OUTCOME_COMMAND);
        const payload = parseRecordInspectionOutcomePayload(command.payload);
        if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };
        const projectScope = requireProjectScope(command);
        if (!projectScope.ok) return projectScope;
        const decision = authorizeWrite(
          command,
          authorization,
          projectScope.value,
          INSPECTION_KIND,
          payload.value.inspectionId,
        );
        if (!decision.ok) return decision;

        return runIdempotent(command, async () => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = deps.store.findInspection(command.scope, payload.value.inspectionId);
          if (!loaded.ok) return loaded;

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return coverage;

          const concurrency = checkConcurrency(
            tokenOf(INSPECTION_KIND, payload.value.inspectionId, payload.value.expectedVersion),
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return concurrency;

          // Findings LINK issues (freeze A1: no duplicate canonical entities):
          // every linked issue must exist in the same project scope.
          const findings = payload.value.findings ?? [];
          for (const finding of findings) {
            const issue = deps.store.findIssue(command.scope, finding.issueId);
            if (!issue.ok) return issue;
          }

          const next = recordInspectionOutcomeState(
            loaded.value,
            payload.value.outcome,
            findings,
            payload.value.summary ?? null,
            now,
            context,
          );
          if (!next.ok) return next;

          const event = fieldEventEnvelope({
            command,
            eventName: INSPECTION_OUTCOMED_EVENT,
            scope: next.value.scope,
            occurredAt: now,
            entityRefs: updatedRefs(loaded.value, next.value),
            payload: {
              inspectionId: next.value.entityId,
              status: next.value.status,
              outcomeAt: now,
              findings: next.value.findings,
              outcomeSummary: next.value.outcomeSummary,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(deps.executor, [event]);
          if (!appended.ok) return appended;

          deps.store.saveInspection(next.value);
          return { ok: true, value: next.value };
        });
      },
    },
  };
}
