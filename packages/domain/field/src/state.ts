// Office field domain — aggregate states, invariants, transitions (OFF-009).
//
// The four project-scoped aggregates of the Work & Field Operations bounded
// context (freeze A1, context 6): the FieldEvent (a captured observation:
// what was observed, where, when-observed, by whom, optional
// quantity/measurement, attached evidence links), the DailyLog (one log per
// (project, day, party), append-only entries that group field events, the day
// closes exactly once), the Issue (raise / categorize / severity / assign /
// comment / resolve / reopen with reasons), and the Inspection (scheduled →
// conducted with immutable checklist results → a passed/failed/partial
// outcome whose findings link issues).
//
// Every aggregate extends the domain kernel's Aggregate (canonical identity,
// owning scope, monotonic version) and is PROJECT-SCOPE bound (freeze A12 —
// the second authorization boundary): scope is always
// { kind: 'project', tenantId, projectId }, enforced by an invariant per
// aggregate, so a state can never claim a foreign project scope.
//
// Histories are append-only by construction: there is no transition that
// edits or removes a captured field event, a daily-log entry, an issue
// comment, or a conducted inspection's checklist results — corrections are
// NEW entries that reference the corrected one, and every mutation is a
// recorded lifecycle event. Lifecycles are explicit and one-way: field events
// open → resolved; daily-log days open → closed (once); issues open ⇄
// resolved (resolve/reopen with reasons); inspections scheduled → conducted →
// passed/failed/partial (terminal).
//
// State invariants are declarative (kernel Invariant<S>) and checked on every
// NEXT state before it commits; lifecycle preconditions are checked by the
// pure transition functions below — both layers return typed
// invariant-violation DomainErrors, never bare throws.
import { parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind, Scope, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, nextAggregateVersion } from '@office/domain-kernel';
import type { Aggregate, AggregateVersion, DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { checkInvariants, defineInvariant } from '@office/domain-kernel';
import { fail, invariantViolation, ok } from '@office/domain-kernel';
import { isLogDay } from './parse';
import type { LogDay } from './parse';

const parsedKind = (literal: string, module: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid ${module} entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Canonical entity kind of the FieldEvent aggregate. */
export const FIELD_EVENT_KIND: EntityKind = parsedKind('field-event', 'field event');
/** Canonical entity kind of the DailyLog aggregate. */
export const DAILY_LOG_KIND: EntityKind = parsedKind('daily-log', 'daily log');
/** Canonical entity kind of the Issue aggregate. */
export const ISSUE_KIND: EntityKind = parsedKind('field-issue', 'issue');
/** Canonical entity kind of the Inspection aggregate. */
export const INSPECTION_KIND: EntityKind = parsedKind('inspection', 'inspection');

// ----- shared value objects ------------------------------------------------------

/**
 * A typed evidence link (freeze A4 provenance): the linked entity (kind +
 * canonical id) pinned to an immutable revision id. The evidence/revision
 * MODEL lives in OFF-008 (documents) — this package only carries the typed
 * link, never a copy of the evidence itself.
 */
export interface EvidenceReference {
  /** Canonical kind of the linked entity (e.g. 'document'). */
  readonly entityKind: EntityKind;
  /** Canonical id of the linked entity. */
  readonly entityId: EntityId;
  /** Canonical id of the immutable revision the link is pinned to. */
  readonly revisionId: EntityId;
}

/** Identity of an evidence link (for duplicate detection). */
const evidenceKey = (ref: EvidenceReference): string =>
  `${ref.entityKind}\u0000${ref.entityId}\u0000${ref.revisionId}`;

/** Optional quantity/measurement captured with a field event. */
export interface Measurement {
  /** Measured value (finite number; sign/precision are the domain's data). */
  readonly value: number;
  /** Unit of measure (e.g. 'm3', 'tonnes', 'units'). */
  readonly unit: string;
}

// ----- FieldEvent ----------------------------------------------------------------

/** Lifecycle status of a field event. `resolved` is terminal (one-way). */
export type FieldEventStatus = 'open' | 'resolved';

/** All field-event lifecycle statuses, in canonical order. */
export const FIELD_EVENT_STATUSES: readonly FieldEventStatus[] = ['open', 'resolved'];

/**
 * The FieldEvent aggregate state: one captured field observation. `observedAt`
 * is the CLIENT-OBSERVED instant (data recorded on the aggregate — freeze A9
 * offline field operation); `createdAt`/`updatedAt` are the server-side
 * injected-clock instants. Ordering authority is never the client timestamp
 * (see the package README).
 */
export interface FieldEventState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** What kind of observation this is (lowercase kebab category, 1..64). */
  readonly category: string;
  /** What was observed (1..200 characters). */
  readonly summary: string;
  /** Optional detail (up to 4000 characters). */
  readonly detail: string | null;
  /** Where it was observed (free-text location reference, 1..200). */
  readonly location: string;
  /** When it was observed (CLIENT clock — data, not ordering authority). */
  readonly observedAt: Timestamp;
  /** By whom it was observed (canonical id of the observing party). */
  readonly observedBy: EntityId;
  /** Optional quantity/measurement. */
  readonly quantity: Measurement | null;
  /** Attached evidence links (append-only). */
  readonly evidence: readonly EvidenceReference[];
  /** Lifecycle status; `resolved` is terminal. */
  readonly status: FieldEventStatus;
  /** When the field event was resolved; null while open. */
  readonly resolvedAt: Timestamp | null;
  /** Optional resolution note recorded at resolve time. */
  readonly resolutionNote: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * Declarative invariants over any FieldEventState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const FIELD_EVENT_INVARIANTS = [
  defineInvariant<FieldEventState>(
    'field-event-summary-nonempty',
    'a field event summary is 1..200 characters',
    (state) => state.summary.length >= 1 && state.summary.length <= 200,
  ),
  defineInvariant<FieldEventState>(
    'field-event-category-nonempty',
    'a field event category is 1..64 characters',
    (state) => state.category.length >= 1 && state.category.length <= 64,
  ),
  defineInvariant<FieldEventState>(
    'field-event-status-vocabulary',
    "a field event status is 'open' or 'resolved'",
    (state) => (FIELD_EVENT_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<FieldEventState>(
    'field-event-resolution-timestamp-pairs-with-status',
    "resolvedAt is null exactly while status is 'open' (resolution is explicit and timestamped)",
    (state) =>
      (state.status === 'open' && state.resolvedAt === null) ||
      (state.status === 'resolved' && state.resolvedAt !== null),
  ),
  defineInvariant<FieldEventState>(
    'field-event-evidence-links-unique',
    'an evidence link appears at most once on a field event (kind + entity + revision)',
    (state) => new Set(state.evidence.map(evidenceKey)).size === state.evidence.length,
  ),
  defineInvariant<FieldEventState>(
    'field-event-is-project-scoped',
    'a field event is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<FieldEventState>(
    'field-event-version-is-monotonic',
    'a field event version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly captured field event (the canonical id is issued inside the handler). */
export interface NewFieldEvent {
  readonly fieldEventId: EntityId;
  readonly category: string;
  readonly summary: string;
  readonly detail?: string | null;
  readonly location: string;
  readonly observedAt: Timestamp;
  readonly observedBy: EntityId;
  readonly quantity?: Measurement | null;
  readonly evidence?: readonly EvidenceReference[];
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly captured field event (trusted path — the
 * payload was validated fail-closed upstream). Returns the state checked
 * against every invariant.
 */
export function createFieldEventState(
  input: NewFieldEvent,
  scope: Scope,
  context?: DomainErrorContext,
): Result<FieldEventState, DomainError> {
  const state: FieldEventState = {
    entityKind: FIELD_EVENT_KIND,
    entityId: input.fieldEventId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    category: input.category,
    summary: input.summary,
    detail: input.detail ?? null,
    location: input.location,
    observedAt: input.observedAt,
    observedBy: input.observedBy,
    quantity: input.quantity ?? null,
    evidence: input.evidence ?? [],
    status: 'open',
    resolvedAt: null,
    resolutionNote: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, FIELD_EVENT_INVARIANTS, context);
}

/**
 * Pure transition: attach evidence links to an OPEN field event. The evidence
 * list is append-only — this is the only transition that grows it, already
 * attached links are a typed invariant-violation (never silently skipped),
 * and a resolved field event accepts no further attachments. The next state
 * carries version + 1 and the given `now` as updatedAt.
 */
export function attachFieldEventEvidenceState(
  current: FieldEventState,
  evidence: readonly EvidenceReference[],
  now: Timestamp,
  context?: DomainErrorContext,
): Result<FieldEventState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'field-event-evidence-requires-open',
          statement: `field event ${current.entityId} is '${current.status}'; only an open field event accepts evidence attachments`,
        },
        context,
      ),
    );
  }
  const existing = new Set(current.evidence.map(evidenceKey));
  for (const ref of evidence) {
    if (existing.has(evidenceKey(ref))) {
      return fail(
        invariantViolation(
          {
            name: 'field-event-evidence-already-attached',
            statement: `evidence link ${ref.entityKind} ${ref.entityId} revision ${ref.revisionId} is already attached to field event ${current.entityId}`,
          },
          context,
        ),
      );
    }
  }
  const next: FieldEventState = {
    ...current,
    evidence: [...current.evidence, ...evidence],
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, FIELD_EVENT_INVARIANTS, context);
}

/**
 * Pure transition: resolve an OPEN field event — the explicit, one-way close
 * of the capture lifecycle. The next state carries status 'resolved',
 * resolvedAt = now, the optional resolution note, version + 1.
 */
export function resolveFieldEventState(
  current: FieldEventState,
  now: Timestamp,
  resolutionNote?: string | null,
  context?: DomainErrorContext,
): Result<FieldEventState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'field-event-resolve-requires-open',
          statement: `field event ${current.entityId} is already '${current.status}'; resolve is a one-way transition from 'open'`,
        },
        context,
      ),
    );
  }
  const next: FieldEventState = {
    ...current,
    status: 'resolved',
    resolvedAt: now,
    resolutionNote: resolutionNote ?? null,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, FIELD_EVENT_INVARIANTS, context);
}

// ----- DailyLog ------------------------------------------------------------------

/** Lifecycle status of a daily-log day. `closed` is terminal (closes once). */
export type DailyLogStatus = 'open' | 'closed';

/** All daily-log lifecycle statuses, in canonical order. */
export const DAILY_LOG_STATUSES: readonly DailyLogStatus[] = ['open', 'closed'];

/**
 * One append-only daily-log entry. Entries are immutable records: there is no
 * edit or delete transition — a correction is a NEW entry whose
 * `correctsEntryId` references the entry it corrects.
 */
export interface DailyLogEntry {
  /** Canonical id of the entry (issued at append; referenced by corrections). */
  readonly entryId: EntityId;
  /** What the entry records (1..2000 characters). */
  readonly summary: string;
  /** Optional detail (up to 4000 characters). */
  readonly detail: string | null;
  /** The field event this entry groups into the day's log, when applicable. */
  readonly fieldEventId: EntityId | null;
  /** The entry this entry corrects, when it is a correction. */
  readonly correctsEntryId: EntityId | null;
  /** When the entry's content was observed/recorded by the CLIENT (data). */
  readonly observedAt: Timestamp;
  /** When the entry was appended (injected server clock). */
  readonly recordedAt: Timestamp;
}

/**
 * The DailyLog aggregate state: the log of one (project, day, party). The
 * aggregate is created by the first appended entry; entries are append-only
 * while the day is open; the day closes exactly once (terminal).
 */
export interface DailyLogState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** The logged calendar day ('YYYY-MM-DD', UTC). */
  readonly day: LogDay;
  /** The party keeping this log (canonical id of the company/person). */
  readonly party: EntityId;
  /** Append-only entries, in append order. */
  readonly entries: readonly DailyLogEntry[];
  /** Lifecycle status; `closed` is terminal (the day closes once). */
  readonly status: DailyLogStatus;
  /** When the day was closed; null while open. */
  readonly closedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * Declarative invariants over any DailyLogState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const DAILY_LOG_INVARIANTS = [
  defineInvariant<DailyLogState>(
    'daily-log-day-is-canonical',
    "a daily log day is a canonical calendar day 'YYYY-MM-DD'",
    (state) => isLogDay(state.day),
  ),
  defineInvariant<DailyLogState>(
    'daily-log-status-vocabulary',
    "a daily log status is 'open' or 'closed'",
    (state) => (DAILY_LOG_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<DailyLogState>(
    'daily-log-closed-timestamp-pairs-with-status',
    "closedAt is null exactly while status is 'open' (the day closes once, explicitly)",
    (state) =>
      (state.status === 'open' && state.closedAt === null) ||
      (state.status === 'closed' && state.closedAt !== null),
  ),
  defineInvariant<DailyLogState>(
    'daily-log-entries-nonempty',
    'a daily log holds at least one entry (the first appended entry creates it)',
    (state) => state.entries.length >= 1,
  ),
  defineInvariant<DailyLogState>(
    'daily-log-entry-ids-unique',
    'daily-log entry ids are unique within the log',
    (state) => new Set(state.entries.map((entry) => entry.entryId)).size === state.entries.length,
  ),
  defineInvariant<DailyLogState>(
    'daily-log-corrections-reference-recorded-entries',
    'a correction entry references an entry of the same log',
    (state) =>
      state.entries.every(
        (entry) =>
          entry.correctsEntryId === null ||
          state.entries.some((other) => other.entryId === entry.correctsEntryId),
      ),
  ),
  defineInvariant<DailyLogState>(
    'daily-log-is-project-scoped',
    'a daily log is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<DailyLogState>(
    'daily-log-version-is-monotonic',
    'a daily log version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a daily-log entry to append (ids and clocks are supplied by the handler). */
export interface DailyLogEntryInput {
  readonly entryId: EntityId;
  readonly summary: string;
  readonly detail?: string | null;
  readonly fieldEventId?: EntityId | null;
  readonly correctsEntryId?: EntityId | null;
  readonly observedAt: Timestamp;
}

/** Build one append-only daily-log entry from its input (trusted path). */
const dailyLogEntryOf = (input: DailyLogEntryInput, now: Timestamp): DailyLogEntry => ({
  entryId: input.entryId,
  summary: input.summary,
  detail: input.detail ?? null,
  fieldEventId: input.fieldEventId ?? null,
  correctsEntryId: input.correctsEntryId ?? null,
  observedAt: input.observedAt,
  recordedAt: now,
});

/** Validate a correction reference against the current entries (pure). */
const checkCorrection = (
  entries: readonly DailyLogEntry[],
  correctsEntryId: EntityId | null,
  dailyLogId: EntityId,
  context?: DomainErrorContext,
): Result<true, DomainError> => {
  if (correctsEntryId === null) return ok(true);
  if (entries.some((entry) => entry.entryId === correctsEntryId)) return ok(true);
  return fail(
    invariantViolation(
      {
        name: 'daily-log-correction-references-entry',
        statement: `correction of entry ${correctsEntryId} references an entry daily log ${dailyLogId} does not hold (corrections reference the corrected entry of the same log)`,
      },
      context,
    ),
  );
};

/** Parts of a newly created daily log: identity, scoping keys, first entry. */
export interface NewDailyLog {
  readonly dailyLogId: EntityId;
  readonly day: LogDay;
  readonly party: EntityId;
  readonly firstEntry: DailyLogEntryInput;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly created daily log (trusted path — the
 * payload was validated fail-closed upstream): the first appended entry
 * creates the log for (project, day, party). Returns the state checked
 * against every invariant.
 */
export function createDailyLogState(
  input: NewDailyLog,
  scope: Scope,
  context?: DomainErrorContext,
): Result<DailyLogState, DomainError> {
  const created: DailyLogState = {
    entityKind: DAILY_LOG_KIND,
    entityId: input.dailyLogId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    day: input.day,
    party: input.party,
    entries: [dailyLogEntryOf(input.firstEntry, input.now)],
    status: 'open',
    closedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(created, DAILY_LOG_INVARIANTS, context);
}

/**
 * Pure transition: append one entry to an OPEN day's log — the only
 * transition that grows the append-only history. A closed day accepts no
 * appends (typed invariant-violation); corrections must reference an entry
 * of the same log. The next state carries version + 1 and the given `now` as
 * the entry's recordedAt and the log's updatedAt.
 */
export function appendDailyLogEntryState(
  current: DailyLogState,
  input: DailyLogEntryInput,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<DailyLogState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'daily-log-append-requires-open',
          statement: `daily log ${current.entityId} (day ${current.day}, party ${current.party}) is '${current.status}'; a closed day accepts no further entries`,
        },
        context,
      ),
    );
  }
  const entry = dailyLogEntryOf(input, now);
  const correction = checkCorrection(
    current.entries,
    entry.correctsEntryId,
    current.entityId,
    context,
  );
  if (!correction.ok) return correction;
  const next: DailyLogState = {
    ...current,
    entries: [...current.entries, entry],
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, DAILY_LOG_INVARIANTS, context);
}

/**
 * Pure transition: close the day — the explicit, once-only lifecycle event.
 * The next state carries status 'closed', closedAt = now, version + 1.
 */
export function closeDailyLogDayState(
  current: DailyLogState,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<DailyLogState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'daily-log-close-requires-open',
          statement: `daily log ${current.entityId} (day ${current.day}, party ${current.party}) is already '${current.status}'; the day closes exactly once`,
        },
        context,
      ),
    );
  }
  const next: DailyLogState = {
    ...current,
    status: 'closed',
    closedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, DAILY_LOG_INVARIANTS, context);
}

// ----- Issue ---------------------------------------------------------------------

/** Severity of an issue, in canonical (ascending) order. */
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';

/** All issue severities, in canonical order. */
export const ISSUE_SEVERITIES: readonly IssueSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
];

/** Lifecycle status of an issue: open ⇄ resolved (resolve/reopen with reasons). */
export type IssueStatus = 'open' | 'resolved';

/** All issue lifecycle statuses, in canonical order. */
export const ISSUE_STATUSES: readonly IssueStatus[] = ['open', 'resolved'];

/**
 * One append-only issue comment. Comments are immutable records: there is no
 * edit or delete transition — a correction is a NEW comment whose
 * `correctsCommentId` references the comment it corrects.
 */
export interface IssueComment {
  /** Canonical id of the comment (issued at append; referenced by corrections). */
  readonly commentId: EntityId;
  /** The comment body (1..2000 characters). */
  readonly body: string;
  /** The comment this comment corrects, when it is a correction. */
  readonly correctsCommentId: EntityId | null;
  /** When the comment was appended (injected server clock). */
  readonly recordedAt: Timestamp;
}

/**
 * The Issue aggregate state: a raised, categorized, severity-graded project
 * issue with an assignee and an append-only comment history.
 * `reportedAt` is the CLIENT-OBSERVED instant (data recorded on the
 * aggregate); `createdAt` is the injected server clock.
 */
export interface IssueState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** What the issue is about (1..200 characters). */
  readonly title: string;
  /** Optional description (up to 4000 characters). */
  readonly description: string | null;
  /** Issue category (lowercase kebab, 1..64). */
  readonly category: string;
  /** Issue severity. */
  readonly severity: IssueSeverity;
  /** Lifecycle status: open ⇄ resolved. */
  readonly status: IssueStatus;
  /** When the issue was reported (CLIENT clock — data, not ordering authority). */
  readonly reportedAt: Timestamp;
  /** The party that raised the issue (canonical id). */
  readonly reportedBy: EntityId;
  /** Current assignee (canonical id), or null while unassigned. */
  readonly assignee: EntityId | null;
  /** When the issue was (last) assigned; null while unassigned. */
  readonly assignedAt: Timestamp | null;
  /** Append-only comments, in append order. */
  readonly comments: readonly IssueComment[];
  /** When the issue was (last) resolved; null while open. */
  readonly resolvedAt: Timestamp | null;
  /** The resolution note of the (last) resolution; null while open. */
  readonly resolutionNote: string | null;
  /** When the issue was (last) reopened; null until the first reopen. */
  readonly reopenedAt: Timestamp | null;
  /** The reason of the (last) reopen; null until the first reopen. */
  readonly reopenReason: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * Declarative invariants over any IssueState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const ISSUE_INVARIANTS = [
  defineInvariant<IssueState>(
    'issue-title-nonempty',
    'an issue title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= 200,
  ),
  defineInvariant<IssueState>(
    'issue-category-nonempty',
    'an issue category is 1..64 characters',
    (state) => state.category.length >= 1 && state.category.length <= 64,
  ),
  defineInvariant<IssueState>(
    'issue-severity-vocabulary',
    "an issue severity is 'low', 'medium', 'high', or 'critical'",
    (state) => (ISSUE_SEVERITIES as readonly string[]).includes(state.severity),
  ),
  defineInvariant<IssueState>(
    'issue-status-vocabulary',
    "an issue status is 'open' or 'resolved'",
    (state) => (ISSUE_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<IssueState>(
    'issue-resolution-timestamp-pairs-with-status',
    "resolvedAt and resolutionNote are non-null exactly while status is 'resolved'",
    (state) =>
      (state.status === 'open' && state.resolvedAt === null && state.resolutionNote === null) ||
      (state.status === 'resolved' && state.resolvedAt !== null && state.resolutionNote !== null),
  ),
  defineInvariant<IssueState>(
    'issue-reopen-fields-pair-together',
    'reopenedAt and reopenReason are both null or both non-null (a reopen records both)',
    (state) =>
      (state.reopenedAt === null && state.reopenReason === null) ||
      (state.reopenedAt !== null && state.reopenReason !== null),
  ),
  defineInvariant<IssueState>(
    'issue-assignment-pairs-with-timestamp',
    'assignedAt is non-null exactly while an assignee is set',
    (state) => (state.assignee === null) === (state.assignedAt === null),
  ),
  defineInvariant<IssueState>(
    'issue-comment-ids-unique',
    'issue comment ids are unique within the issue',
    (state) =>
      new Set(state.comments.map((comment) => comment.commentId)).size ===
      state.comments.length,
  ),
  defineInvariant<IssueState>(
    'issue-comment-corrections-reference-recorded-comments',
    'a correction comment references a comment of the same issue',
    (state) =>
      state.comments.every(
        (comment) =>
          comment.correctsCommentId === null ||
          state.comments.some((other) => other.commentId === comment.correctsCommentId),
      ),
  ),
  defineInvariant<IssueState>(
    'issue-is-project-scoped',
    'an issue is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<IssueState>(
    'issue-version-is-monotonic',
    'an issue version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly raised issue (the canonical id is issued inside the handler). */
export interface NewIssue {
  readonly issueId: EntityId;
  readonly title: string;
  readonly description?: string | null;
  readonly category: string;
  readonly severity: IssueSeverity;
  readonly reportedAt: Timestamp;
  readonly reportedBy: EntityId;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly raised issue (trusted path — the payload
 * was validated fail-closed upstream). Returns the state checked against
 * every invariant.
 */
export function createIssueState(
  input: NewIssue,
  scope: Scope,
  context?: DomainErrorContext,
): Result<IssueState, DomainError> {
  const state: IssueState = {
    entityKind: ISSUE_KIND,
    entityId: input.issueId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    title: input.title,
    description: input.description ?? null,
    category: input.category,
    severity: input.severity,
    status: 'open',
    reportedAt: input.reportedAt,
    reportedBy: input.reportedBy,
    assignee: null,
    assignedAt: null,
    comments: [],
    resolvedAt: null,
    resolutionNote: null,
    reopenedAt: null,
    reopenReason: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, ISSUE_INVARIANTS, context);
}

/**
 * Pure transition: assign an OPEN issue to a party. Assigning the issue to
 * its current assignee is a typed invariant-violation (never a silent
 * no-op); a resolved issue must be reopened before reassignment. The next
 * state carries assignee, assignedAt = now, version + 1.
 */
export function assignIssueState(
  current: IssueState,
  assignee: EntityId,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<IssueState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'issue-assignment-requires-open',
          statement: `issue ${current.entityId} is '${current.status}'; reopen the issue before assigning it`,
        },
        context,
      ),
    );
  }
  if (current.assignee === assignee) {
    return fail(
      invariantViolation(
        {
          name: 'issue-already-assigned-to-party',
          statement: `issue ${current.entityId} is already assigned to ${assignee}; assignment changes the assignee, it never re-confirms one`,
        },
        context,
      ),
    );
  }
  const next: IssueState = {
    ...current,
    assignee,
    assignedAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ISSUE_INVARIANTS, context);
}

/**
 * Pure transition: append one comment to the issue's append-only history.
 * Comments may arrive while the issue is open or resolved (the record is
 * append-only history, not a lifecycle mutation); a correction must reference
 * a comment of the same issue. The next state carries version + 1.
 */
export function commentOnIssueState(
  current: IssueState,
  comment: IssueComment,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<IssueState, DomainError> {
  if (
    comment.correctsCommentId !== null &&
    !current.comments.some((other) => other.commentId === comment.correctsCommentId)
  ) {
    return fail(
      invariantViolation(
        {
          name: 'issue-comment-correction-references-comment',
          statement: `correction of comment ${comment.correctsCommentId} references a comment issue ${current.entityId} does not hold (corrections reference the corrected comment of the same issue)`,
        },
        context,
      ),
    );
  }
  const next: IssueState = {
    ...current,
    comments: [...current.comments, comment],
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ISSUE_INVARIANTS, context);
}

/**
 * Pure transition: resolve an OPEN issue with a required resolution note —
 * the recorded close of the raise lifecycle. The next state carries status
 * 'resolved', resolvedAt = now, the note, version + 1.
 */
export function resolveIssueState(
  current: IssueState,
  now: Timestamp,
  resolutionNote: string,
  context?: DomainErrorContext,
): Result<IssueState, DomainError> {
  if (current.status !== 'open') {
    return fail(
      invariantViolation(
        {
          name: 'issue-resolve-requires-open',
          statement: `issue ${current.entityId} is already '${current.status}'; resolve is a transition from 'open' (reopen it first if it must be resolved again)`,
        },
        context,
      ),
    );
  }
  const next: IssueState = {
    ...current,
    status: 'resolved',
    resolvedAt: now,
    resolutionNote,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ISSUE_INVARIANTS, context);
}

/**
 * Pure transition: reopen a RESOLVED issue with a required reason — the
 * explicit return to 'open'. The next state carries status 'open', a null
 * resolution pair, the recorded reopen pair, version + 1.
 */
export function reopenIssueState(
  current: IssueState,
  now: Timestamp,
  reopenReason: string,
  context?: DomainErrorContext,
): Result<IssueState, DomainError> {
  if (current.status !== 'resolved') {
    return fail(
      invariantViolation(
        {
          name: 'issue-reopen-requires-resolved',
          statement: `issue ${current.entityId} is '${current.status}'; only a resolved issue can be reopened`,
        },
        context,
      ),
    );
  }
  const next: IssueState = {
    ...current,
    status: 'open',
    resolvedAt: null,
    resolutionNote: null,
    reopenedAt: now,
    reopenReason,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, ISSUE_INVARIANTS, context);
}

// ----- Inspection ----------------------------------------------------------------

/** Lifecycle status of an inspection; the outcome statuses are terminal. */
export type InspectionStatus = 'scheduled' | 'conducted' | 'passed' | 'failed' | 'partial';

/** All inspection lifecycle statuses, in canonical order. */
export const INSPECTION_STATUSES: readonly InspectionStatus[] = [
  'scheduled',
  'conducted',
  'passed',
  'failed',
  'partial',
];

/** The terminal outcome of an inspection (the last three statuses). */
export type InspectionOutcome = 'passed' | 'failed' | 'partial';

/** All inspection outcomes, in canonical order. */
export const INSPECTION_OUTCOMES: readonly InspectionOutcome[] = [
  'passed',
  'failed',
  'partial',
];

/** One checklist item declared when the inspection is scheduled. */
export interface ChecklistItem {
  /** Item key, unique within the checklist (lowercase kebab, 1..32). */
  readonly key: string;
  /** What the item requires (1..500 characters). */
  readonly requirement: string;
}

/** The recorded result of one checklist item — an immutable record. */
export interface InspectionResult {
  /** The checklist item key this result records. */
  readonly key: string;
  /** The result of the item. */
  readonly result: 'pass' | 'fail' | 'na';
  /** Optional note (up to 1000 characters). */
  readonly note: string | null;
}

/** One finding recorded at the inspection's outcome, linking an issue. */
export interface InspectionFinding {
  /** The linked issue (canonical id; must exist in the same project scope). */
  readonly issueId: EntityId;
  /** Optional finding note (up to 1000 characters). */
  readonly note: string | null;
}

/**
 * The Inspection aggregate state: scheduled → conducted (checklist results as
 * immutable records) → a terminal passed/failed/partial outcome with findings
 * linking issues. `conductedAt` is the CLIENT-OBSERVED instant of the
 * physical inspection (data); all bookkeeping timestamps come from the
 * injected clock.
 */
export interface InspectionState extends Aggregate {
  readonly entityId: EntityId;
  readonly scope: Scope;
  readonly version: AggregateVersion;
  /** What the inspection inspects (1..200 characters). */
  readonly title: string;
  /** Optional description (up to 4000 characters). */
  readonly description: string | null;
  /** The declared checklist (set at schedule time, immutable thereafter). */
  readonly checklist: readonly ChecklistItem[];
  /** When the inspection is scheduled to take place (planned instant, data). */
  readonly scheduledFor: Timestamp;
  /** Lifecycle status; 'passed'/'failed'/'partial' are terminal. */
  readonly status: InspectionStatus;
  /** The immutable checklist results; non-empty exactly once conducted. */
  readonly results: readonly InspectionResult[];
  /** When the inspection was conducted (CLIENT clock — data); null until then. */
  readonly conductedAt: Timestamp | null;
  /** Findings linking issues; set exactly at the outcome transition. */
  readonly findings: readonly InspectionFinding[];
  /** Optional outcome summary; set exactly at the outcome transition. */
  readonly outcomeSummary: string | null;
  /** When the outcome was recorded; null until the outcome transition. */
  readonly outcomeAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * Declarative invariants over any InspectionState, in declaration order.
 * checkInvariants stops at the first violation — failures are deterministic.
 */
export const INSPECTION_INVARIANTS = [
  defineInvariant<InspectionState>(
    'inspection-title-nonempty',
    'an inspection title is 1..200 characters',
    (state) => state.title.length >= 1 && state.title.length <= 200,
  ),
  defineInvariant<InspectionState>(
    'inspection-status-vocabulary',
    "an inspection status is 'scheduled', 'conducted', 'passed', 'failed', or 'partial'",
    (state) => (INSPECTION_STATUSES as readonly string[]).includes(state.status),
  ),
  defineInvariant<InspectionState>(
    'inspection-checklist-keys-unique',
    'checklist item keys are unique within the inspection',
    (state) => new Set(state.checklist.map((item) => item.key)).size === state.checklist.length,
  ),
  defineInvariant<InspectionState>(
    'inspection-results-exactly-when-conducted',
    'checklist results are non-empty exactly once the inspection has been conducted',
    (state) =>
      (state.status === 'scheduled' && state.results.length === 0 && state.conductedAt === null) ||
      (state.status !== 'scheduled' &&
        state.results.length >= 1 &&
        state.conductedAt !== null),
  ),
  defineInvariant<InspectionState>(
    'inspection-results-cover-checklist-exactly',
    'the recorded results are exactly the declared checklist items (no missing, no extra, no duplicates)',
    (state) => {
      // Results are recorded exactly once conducted (see
      // inspection-results-exactly-when-conducted): while none are recorded
      // (status 'scheduled') there is nothing to cover; once recorded, the
      // results must be exactly the declared checklist.
      if (state.results.length === 0) return true;
      const expected = new Set(state.checklist.map((item) => item.key));
      const recorded = state.results.map((result) => result.key);
      return (
        recorded.length === expected.size &&
        recorded.every((key) => expected.has(key))
      );
    },
  ),
  defineInvariant<InspectionState>(
    'inspection-findings-exactly-at-outcome',
    'findings and outcomeAt are set exactly when the inspection carries a terminal outcome',
    (state) => {
      const outcomed = (INSPECTION_OUTCOMES as readonly string[]).includes(state.status);
      return (
        (outcomed && state.outcomeAt !== null) ||
        (!outcomed && state.findings.length === 0 && state.outcomeAt === null)
      );
    },
  ),
  defineInvariant<InspectionState>(
    'inspection-is-project-scoped',
    'an inspection is owned by exactly one project scope (the second boundary, A12)',
    (state) => state.scope.kind === 'project',
  ),
  defineInvariant<InspectionState>(
    'inspection-version-is-monotonic',
    'an inspection version is a positive integer (starts at 1, +1 per mutation)',
    (state) => Number.isInteger(state.version) && state.version >= 1,
  ),
] as const;

/** Parts of a newly scheduled inspection (the canonical id is issued inside the handler). */
export interface NewInspection {
  readonly inspectionId: EntityId;
  readonly title: string;
  readonly description?: string | null;
  readonly checklist: readonly ChecklistItem[];
  readonly scheduledFor: Timestamp;
  readonly now: Timestamp;
}

/**
 * Build the initial state of a newly scheduled inspection (trusted path — the
 * payload was validated fail-closed upstream). Returns the state checked
 * against every invariant.
 */
export function createInspectionState(
  input: NewInspection,
  scope: Scope,
  context?: DomainErrorContext,
): Result<InspectionState, DomainError> {
  const state: InspectionState = {
    entityKind: INSPECTION_KIND,
    entityId: input.inspectionId,
    scope,
    version: INITIAL_AGGREGATE_VERSION,
    title: input.title,
    description: input.description ?? null,
    checklist: input.checklist,
    scheduledFor: input.scheduledFor,
    status: 'scheduled',
    results: [],
    conductedAt: null,
    findings: [],
    outcomeSummary: null,
    outcomeAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return checkInvariants(state, INSPECTION_INVARIANTS, context);
}

/**
 * Pure transition: record the conduct of a SCHEDULED inspection — the
 * checklist results become the inspection's immutable record. The results
 * must be exactly the declared checklist items: a missing item, an extra
 * item, or a duplicate key is a typed invariant-violation. The next state
 * carries status 'conducted', conductedAt (the client-observed instant of
 * the physical inspection — data), version + 1.
 */
export function conductInspectionState(
  current: InspectionState,
  conductedAt: Timestamp,
  results: readonly InspectionResult[],
  now: Timestamp,
  context?: DomainErrorContext,
): Result<InspectionState, DomainError> {
  if (current.status !== 'scheduled') {
    return fail(
      invariantViolation(
        {
          name: 'inspection-conduct-requires-scheduled',
          statement: `inspection ${current.entityId} is '${current.status}'; only a scheduled inspection can be conducted`,
        },
        context,
      ),
    );
  }
  const expected = new Set(current.checklist.map((item) => item.key));
  const recorded = results.map((result) => result.key);
  if (recorded.length !== expected.size || !recorded.every((key) => expected.has(key))) {
    const missing = [...expected].filter((key) => !recorded.includes(key));
    const extra = recorded.filter((key) => !expected.has(key));
    return fail(
      invariantViolation(
        {
          name: 'inspection-results-cover-checklist-exactly',
          statement: `inspection ${current.entityId} results must cover the declared checklist exactly: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}], duplicates ${
            recorded.length !== new Set(recorded).size
          }`,
        },
        context,
      ),
    );
  }
  const next: InspectionState = {
    ...current,
    status: 'conducted',
    conductedAt,
    results,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, INSPECTION_INVARIANTS, context);
}

/**
 * Pure transition: record the terminal outcome of a CONDUCTED inspection —
 * passed/failed/partial, with findings linking issues. The next state carries
 * the terminal status, the findings, outcomeAt = now, version + 1. Outcome is
 * one-way: a terminal inspection accepts no further transitions.
 */
export function recordInspectionOutcomeState(
  current: InspectionState,
  outcome: InspectionOutcome,
  findings: readonly InspectionFinding[],
  outcomeSummary: string | null,
  now: Timestamp,
  context?: DomainErrorContext,
): Result<InspectionState, DomainError> {
  if (current.status !== 'conducted') {
    return fail(
      invariantViolation(
        {
          name: 'inspection-outcome-requires-conducted',
          statement: `inspection ${current.entityId} is '${current.status}'; only a conducted inspection can record its outcome`,
        },
        context,
      ),
    );
  }
  const next: InspectionState = {
    ...current,
    status: outcome,
    findings,
    outcomeSummary,
    outcomeAt: now,
    version: nextAggregateVersion(current.version),
    updatedAt: now,
  };
  return checkInvariants(next, INSPECTION_INVARIANTS, context);
}
