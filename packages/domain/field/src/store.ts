// Office field domain — the in-memory aggregate store (OFF-009).
//
// This package is PURE DOMAIN (no SQL, no migrations, no repository layer):
// FieldStore is the aggregate-keeper PORT the command handlers mutate
// through — the in-memory implementation below is the deterministic
// reference (tests, read-model comparison, pure in-memory composition), and
// a persistence-backed implementation can satisfy the same port later
// without touching the aggregate or command layers.
//
// Scope isolation (freeze A12), mirroring the reference repositories of
// @office/persistence and the identity domain packages exactly:
//   * every find* takes a validated contracts Scope — there is no unscoped
//     entry point;
//   * a foreign tenant's aggregate is INVISIBLE: typed not-found, no
//     existence oracle (the failure names the sought id, never confirming
//     or denying a foreign tenant's row);
//   * the project second boundary: a project-scoped lookup may only see its
//     own project's aggregates — anything else is a typed unauthorized
//     project-scope-violation (same tenant, wrong project);
//   * a tenant-scoped lookup sees every aggregate of its tenant (the
//     by-(day, party) daily-log lookup is the exception: a daily log is
//     identified by (project, day, party), so that lookup requires project
//     scope — fail-closed otherwise);
//   * saves are keyed by canonical id and keep first-insertion order (the
//     deterministic iteration the read-model comparison relies on).
import { domainError, entityNotFound, fail, ok, projectScopeViolation } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind, ProjectId, Scope } from '@office/contracts';
import type {
  DailyLogState,
  FieldEventState,
  InspectionState,
  IssueState,
} from './state';
import {
  DAILY_LOG_KIND,
  FIELD_EVENT_KIND,
  INSPECTION_KIND,
  ISSUE_KIND,
} from './state';
import type { LogDay } from './parse';

/**
 * The aggregate-keeper port of the field domain. Save semantics: a save of a
 * state whose canonical id is absent inserts it; a save of a present id
 * replaces it (the optimistic-concurrency guard lives in the command
 * handlers, which only ever save invariant-checked NEXT states).
 */
export interface FieldStore {
  /** Load a field event by id within the scope (A12 visibility rules). */
  findFieldEvent(
    scope: Scope,
    fieldEventId: EntityId,
    context?: DomainErrorContext,
  ): Result<FieldEventState, DomainError>;
  /** Insert or replace a field event state. */
  saveFieldEvent(state: FieldEventState): void;

  /** Load the daily log of (project scope, day, party); typed not-found when absent. */
  findDailyLogByDay(
    scope: Scope,
    day: LogDay,
    party: EntityId,
    context?: DomainErrorContext,
  ): Result<DailyLogState, DomainError>;
  /** Load a daily log by id within the scope (A12 visibility rules). */
  findDailyLogById(
    scope: Scope,
    dailyLogId: EntityId,
    context?: DomainErrorContext,
  ): Result<DailyLogState, DomainError>;
  /** Insert or replace a daily-log state (maintaining the (project, day, party) index). */
  saveDailyLog(state: DailyLogState): void;

  /** Load an issue by id within the scope (A12 visibility rules). */
  findIssue(
    scope: Scope,
    issueId: EntityId,
    context?: DomainErrorContext,
  ): Result<IssueState, DomainError>;
  /** Insert or replace an issue state. */
  saveIssue(state: IssueState): void;

  /** Load an inspection by id within the scope (A12 visibility rules). */
  findInspection(
    scope: Scope,
    inspectionId: EntityId,
    context?: DomainErrorContext,
  ): Result<InspectionState, DomainError>;
  /** Insert or replace an inspection state. */
  saveInspection(state: InspectionState): void;

  /** Every field event, in first-insertion order (read-model comparison, tests). */
  fieldEvents(): readonly FieldEventState[];
  /** Every daily log, in first-insertion order (read-model comparison, tests). */
  dailyLogs(): readonly DailyLogState[];
  /** Every issue, in first-insertion order (read-model comparison, tests). */
  issues(): readonly IssueState[];
  /** Every inspection, in first-insertion order (read-model comparison, tests). */
  inspections(): readonly InspectionState[];
}

/** The not-found failure of a lookup by (project, day, party) — no synthetic id exists. */
const dailyLogNotFound = (
  scope: Scope,
  day: LogDay,
  party: EntityId,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `daily log of day ${day} for party ${party} not found in the accessible scope`,
    [{ code: 'daily-log-not-found', message: `day ${day}, party ${party}`, path: 'day' }],
    context ?? { scope },
  );

/** The fail-closed failure of a by-(day, party) lookup without project scope. */
const dailyLogLookupRequiresProject = (scope: Scope): DomainError =>
  domainError(
    'invariant-violation',
    `a daily log is identified by (project, day, party); the by-day lookup requires project scope, received ${scope.kind} scope`,
    [{ code: 'daily-log-lookup-requires-project-scope', message: scope.kind, path: 'scope' }],
    { scope },
  );

/** The typed second-boundary denial of a project-scoped lookup (A12). */
const projectScopeDenial = (
  lookupScope: Scope & { readonly kind: 'project' },
  aggregateProjectId: ProjectId,
  context?: DomainErrorContext,
): DomainError =>
  projectScopeViolation(
    { commandProjectId: lookupScope.projectId, aggregateProjectId },
    {
      scope: context?.scope ?? lookupScope,
      correlationId: context?.correlationId ?? null,
    },
  );

/** Denial context resolution for the not-found path (A12: the request scope, never the foreign one). */
const notFoundContext = (scope: Scope, context?: DomainErrorContext): DomainErrorContext => ({
  scope: context?.scope ?? scope,
  correlationId: context?.correlationId ?? null,
});

/**
 * Create the deterministic in-memory FieldStore (the reference
 * implementation of the port).
 */
export function createInMemoryFieldStore(): FieldStore {
  const fieldEventsById = new Map<EntityId, FieldEventState>();
  const dailyLogsById = new Map<EntityId, DailyLogState>();
  const dailyLogIdByDayParty = new Map<string, EntityId>();
  const issuesById = new Map<EntityId, IssueState>();
  const inspectionsById = new Map<EntityId, InspectionState>();

  /** Index key of a daily log's (project, day, party) identity. */
  const dailyLogKey = (projectId: ProjectId, day: LogDay, party: EntityId): string =>
    `${projectId}\u0000${day}\u0000${party}`;

  /**
   * One scoped by-id load, applying the A12 visibility rules: absent or
   * foreign-tenant → typed not-found (invisibility, no existence oracle);
   * same tenant, wrong project under a project-scoped lookup → typed
   * unauthorized project-scope-violation.
   */
  const loadScoped = <S extends { readonly entityId: EntityId; readonly scope: Scope }>(
    byId: Map<EntityId, S>,
    entityKind: EntityKind,
    scope: Scope,
    entityId: EntityId,
    context?: DomainErrorContext,
  ): Result<S, DomainError> => {
    const found = byId.get(entityId);
    if (
      found === undefined ||
      found.scope.tenantId !== scope.tenantId
    ) {
      return fail(entityNotFound({ entityKind, entityId }, notFoundContext(scope, context)));
    }
    if (
      scope.kind === 'project' &&
      found.scope.kind === 'project' &&
      scope.projectId !== found.scope.projectId
    ) {
      return fail(projectScopeDenial(scope, found.scope.projectId, context));
    }
    return ok(found);
  };

  return {
    findFieldEvent: (scope, fieldEventId, context) =>
      loadScoped(fieldEventsById, FIELD_EVENT_KIND, scope, fieldEventId, context),
    saveFieldEvent: (state) => {
      fieldEventsById.set(state.entityId, state);
    },

    findDailyLogByDay: (scope, day, party, context) => {
      if (scope.kind !== 'project') {
        return fail(dailyLogLookupRequiresProject(scope));
      }
      const dailyLogId = dailyLogIdByDayParty.get(dailyLogKey(scope.projectId, day, party));
      if (dailyLogId === undefined) {
        return fail(dailyLogNotFound(scope, day, party, context));
      }
      return loadScoped(dailyLogsById, DAILY_LOG_KIND, scope, dailyLogId, context);
    },
    findDailyLogById: (scope, dailyLogId, context) =>
      loadScoped(dailyLogsById, DAILY_LOG_KIND, scope, dailyLogId, context),
    saveDailyLog: (state) => {
      dailyLogsById.set(state.entityId, state);
      if (state.scope.kind === 'project') {
        dailyLogIdByDayParty.set(
          dailyLogKey(state.scope.projectId, state.day, state.party),
          state.entityId,
        );
      }
    },

    findIssue: (scope, issueId, context) =>
      loadScoped(issuesById, ISSUE_KIND, scope, issueId, context),
    saveIssue: (state) => {
      issuesById.set(state.entityId, state);
    },

    findInspection: (scope, inspectionId, context) =>
      loadScoped(inspectionsById, INSPECTION_KIND, scope, inspectionId, context),
    saveInspection: (state) => {
      inspectionsById.set(state.entityId, state);
    },

    fieldEvents: () => [...fieldEventsById.values()],
    dailyLogs: () => [...dailyLogsById.values()],
    issues: () => [...issuesById.values()],
    inspections: () => [...inspectionsById.values()],
  };
}
