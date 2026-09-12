// Office project domain — projects repository (OFF-007).
//
// THE repository of the project domain module, over the `projects` table
// (created by the OFF-004 foundation's migration 0002 and extended with the
// explicit lifecycle by this package's migration 0101). It follows the OFF-004
// reference repositories and the sibling organization repository exactly
// (scope isolation by construction, freeze A12):
//
//   * every method takes a validated contracts `Scope` as its scope of
//     execution — there is no unscoped entry point;
//   * projects are PROJECT-bound entities: every statement binds `tenant_id`
//     from the scope as its first parameter AND addresses the project id, so
//     tenant A can never read or write tenant B's rows: a foreign row is
//     simply not there (typed not-found, no existence oracle), never leaked;
//   * the project second boundary is checked BEFORE any SQL (the same
//     projectScopeMismatch guard the reference ProjectsRepository uses): a
//     project-scoped call may only address its own project — anything else
//     is a typed unauthorized project-scope-violation;
//   * writes are guarded by optimistic concurrency (`WHERE ... AND
//     version = $expected`), so a stale version is a typed
//     concurrency-conflict and never a silent overwrite;
//   * archive is an UPDATE (status/archived_at lifecycle columns), never a
//     DELETE — the lifecycle is explicit and auditable.
import { formatTimestamp, parseProjectId, parseTenantId } from '@office/contracts';
import type { ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import {
  INITIAL_AGGREGATE_VERSION,
  concurrencyConflict,
  domainError,
  entityNotFound,
  fail,
  ok,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { PersistenceFailure, projectScopeMismatch } from '@office/persistence';
import type { SqlExecutor, SqlValue } from '@office/persistence';
import type { ProjectChanges, ProjectState, ProjectStatus } from './state';
import { PROJECT_KIND, PROJECT_STATUSES } from './state';

/** Input of a project insert; the canonical id is issued upstream (injected). */
export interface NewProject {
  readonly projectId: ProjectId;
  readonly name: string;
  /** Optional extension metadata (defaults to the empty object). */
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

const PROJECT_COLUMNS =
  'tenant_id, project_id, name, status, archived_at, version, created_at, updated_at, extension_metadata';

type Row = Record<string, unknown>;

const rowCorruption = (column: string, row: Row): PersistenceFailure =>
  new PersistenceFailure('row-corruption', `corrupt row in table 'projects': field '${column}'`, {
    cause: row,
  });

/** Read a non-empty TEXT column (fail-closed). */
const readText = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) throw rowCorruption(column, row);
  return value;
};

/** Read the canonical project id column (fail-closed; kind code 'prj'). */
const readProjectId = (row: Row): ProjectId => {
  const parsed = parseProjectId(row['project_id']);
  if (!parsed.ok) throw rowCorruption('project_id', row);
  return parsed.value;
};

/** Read the canonical tenant id column (fail-closed). */
const readTenantId = (row: Row): TenantId => {
  const parsed = parseTenantId(row['tenant_id']);
  if (!parsed.ok) throw rowCorruption('tenant_id', row);
  return parsed.value;
};

/** Read the lifecycle status column (fail-closed against the vocabulary). */
const readStatus = (row: Row): ProjectStatus => {
  const value = row['status'];
  if (typeof value !== 'string' || !(PROJECT_STATUSES as readonly string[]).includes(value)) {
    throw rowCorruption('status', row);
  }
  return value as ProjectStatus;
};

/** Read a TIMESTAMPTZ column as the canonical UTC Timestamp string. */
const readTimestamp = (row: Row, column: string): Timestamp => {
  const value = row[column];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw rowCorruption(column, row);
  }
  return formatTimestamp(value);
};

/** Read a nullable TIMESTAMPTZ column (null stays null). */
const readNullableTimestamp = (row: Row, column: string): Timestamp | null =>
  row[column] === null ? null : readTimestamp(row, column);

/** Read the aggregate version BIGINT column (string or number, fail-closed). */
const readAggregateVersion = (row: Row): AggregateVersion => {
  const raw = row['version'];
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > Number.MAX_SAFE_INTEGER) {
    throw rowCorruption('version', row);
  }
  return numeric as AggregateVersion;
};

/** Read the extension-metadata JSONB column (must be a JSON object, A2). */
const readJsonObject = (row: Row): Readonly<Record<string, unknown>> => {
  const value = row['extension_metadata'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rowCorruption('extension_metadata', row);
  }
  return value as Record<string, unknown>;
};

/** Convert a canonical Timestamp into the Date node-postgres binds for TIMESTAMPTZ. */
const toDate = (timestamp: Timestamp): Date => new Date(timestamp);

/**
 * Extract the node-postgres error code/constraint pair from a thrown error
 * (unwrapping a PersistenceFailure's cause) so inserts can map the table's
 * unique/foreign-key violations onto typed DomainErrors.
 */
const constraintInfoOf = (error: unknown): { readonly code?: unknown; readonly constraint?: unknown } => {
  const cause = error instanceof PersistenceFailure ? error.cause : error;
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as { code?: unknown; constraint?: unknown };
    return { code: candidate.code, constraint: candidate.constraint };
  }
  return {};
};

/** Map one projects row onto the ProjectState (fail-closed). */
const mapRow = (row: Row): ProjectState => ({
  entityKind: PROJECT_KIND,
  entityId: readProjectId(row),
  scope: {
    kind: 'project',
    tenantId: readTenantId(row),
    projectId: readProjectId(row),
  },
  version: readAggregateVersion(row),
  name: readText(row, 'name'),
  status: readStatus(row),
  archivedAt: readNullableTimestamp(row, 'archived_at'),
  createdAt: readTimestamp(row, 'created_at'),
  updatedAt: readTimestamp(row, 'updated_at'),
  extensionMetadata: readJsonObject(row),
});

/** Require at least one change field (trusted-path check). */
const requireChanges = (changes: ProjectChanges): void => {
  if (changes.name === undefined && changes.extensionMetadata === undefined) {
    throw new TypeError('project update requires at least one change field');
  }
};

/**
 * Project repository: every read and write executes under an explicit tenant
 * (or tenant+project) scope, by construction. Under project scope exactly the
 * scoped project is addressable (the second boundary); under tenant scope any
 * project of the tenant is.
 */
export interface ProjectsDomainRepository {
  /**
   * Insert a project owned by the scope's tenant. The tenant ownership of the
   * row comes from the scope itself, never from a caller-supplied column. A
   * project-scoped scope may only initialize its OWN project (typed
   * unauthorized otherwise); unknown tenant → typed not-found; duplicate
   * canonical id → typed invariant-violation.
   */
  insert(
    db: SqlExecutor,
    scope: Scope,
    input: NewProject,
  ): Promise<Result<ProjectState, DomainError>>;
  /**
   * Load the addressed project within the scope. Cross-tenant → typed
   * not-found (the row is not visible — no existence oracle, freeze A12);
   * project scope addressing another project → typed unauthorized.
   */
  findById(
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
  ): Promise<Result<ProjectState, DomainError>>;
  /**
   * List the projects visible to the scope: every project of the scope's
   * tenant under tenant scope; exactly the scoped project under project
   * scope (the second boundary applied at row level).
   */
  list(db: SqlExecutor, scope: Scope): Promise<Result<readonly ProjectState[], DomainError>>;
  /**
   * Update the addressed project with optimistic concurrency: a stale
   * expected version is a typed concurrency-conflict; a missing (or foreign)
   * row is a typed not-found. `changes` must carry at least one field (loud
   * TypeError otherwise — trusted-path programming error).
   */
  update(
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
    changes: ProjectChanges,
    now: Timestamp,
  ): Promise<Result<ProjectState, DomainError>>;
  /**
   * Archive the addressed project with optimistic concurrency: the explicit
   * lifecycle UPDATE (status 'archived' + archived_at), never a DELETE.
   * Stale version → typed concurrency-conflict; missing row → typed
   * not-found.
   */
  archive(
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
    now: Timestamp,
  ): Promise<Result<ProjectState, DomainError>>;
}

/** Create the project domain repository. */
export const createProjectsDomainRepository = (): ProjectsDomainRepository => {
  const selectProject = async (
    db: SqlExecutor,
    scope: Scope,
    projectId: ProjectId,
  ): Promise<ProjectState | null> => {
    const result = await db.query(
      `SELECT ${PROJECT_COLUMNS} FROM projects
       WHERE tenant_id = $1 AND project_id = $2`,
      [scope.tenantId, projectId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  };

  return {
    insert: async (db, scope, input) => {
      // The project second boundary: a project-scoped call may only
      // initialize its OWN project (tenant scope initializes any new id).
      const scopeError = projectScopeMismatch(scope, input.projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      try {
        // tenant_id is bound from the SCOPE, never from the input — the row
        // is owned by the executing tenant by construction.
        const result = await db.query(
          `INSERT INTO projects (tenant_id, project_id, name, status, archived_at, version, created_at, updated_at, extension_metadata)
           VALUES ($1, $2, $3, 'active', NULL, $4, $5, $5, $6)
           RETURNING ${PROJECT_COLUMNS}`,
          [
            scope.tenantId,
            input.projectId,
            input.name,
            INITIAL_AGGREGATE_VERSION,
            toDate(input.now),
            input.extensionMetadata ?? {},
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return fail(
            domainError(
              'invariant-violation',
              `project insert returned no row for ${input.projectId}`,
              [{ code: 'project-insert-no-row', message: input.projectId, path: null }],
              { scope },
            ),
          );
        }
        return ok(mapRow(row));
      } catch (error) {
        const { code, constraint } = constraintInfoOf(error);
        if (code === '23505' && constraint === 'projects_pkey') {
          return fail(
            domainError(
              'invariant-violation',
              `canonical project id already exists: ${input.projectId}`,
              [
                {
                  code: 'project-id-already-exists',
                  message: input.projectId,
                  path: 'projectId',
                },
              ],
              { scope },
            ),
          );
        }
        if (code === '23503' && constraint === 'projects_tenant_id_fkey') {
          return fail(
            domainError(
              'not-found',
              `tenant ${scope.tenantId} not found: cannot create project ${input.projectId}`,
              [{ code: 'tenant-not-found', message: scope.tenantId, path: 'tenantId' }],
              { scope },
            ),
          );
        }
        throw error;
      }
    },

    findById: async (db, scope, projectId) => {
      const scopeError = projectScopeMismatch(scope, projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      const project = await selectProject(db, scope, projectId);
      if (project === null) {
        return fail(
          entityNotFound({ entityKind: PROJECT_KIND, entityId: projectId }, { scope }),
        );
      }
      return ok(project);
    },

    list: async (db, scope) => {
      // The second boundary at row level: a project-scoped call sees exactly
      // its own project; a tenant-scoped call sees every project of its
      // tenant.
      const result =
        scope.kind === 'project'
          ? await db.query(
              `SELECT ${PROJECT_COLUMNS} FROM projects
               WHERE tenant_id = $1 AND project_id = $2
               ORDER BY created_at DESC, project_id ASC`,
              [scope.tenantId, scope.projectId],
            )
          : await db.query(
              `SELECT ${PROJECT_COLUMNS} FROM projects
               WHERE tenant_id = $1
               ORDER BY created_at DESC, project_id ASC`,
              [scope.tenantId],
            );
      return ok(result.rows.map(mapRow));
    },

    update: async (db, scope, projectId, expectedVersion, changes, now) => {
      requireChanges(changes);
      const scopeError = projectScopeMismatch(scope, projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      const values: SqlValue[] = [scope.tenantId, projectId, expectedVersion];
      const assignments: string[] = [];
      if (changes.name !== undefined) {
        values.push(changes.name);
        assignments.push(`name = $${values.length}`);
      }
      if (changes.extensionMetadata !== undefined) {
        values.push(changes.extensionMetadata);
        assignments.push(`extension_metadata = $${values.length}`);
      }
      values.push(toDate(now));
      const nowParam = `$${values.length}`;
      const result = await db.query(
        `UPDATE projects
         SET ${assignments.join(', ')}, version = version + 1, updated_at = ${nowParam}
         WHERE tenant_id = $1 AND project_id = $2 AND version = $3
         RETURNING ${PROJECT_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapRow(row));
      }
      // Zero affected rows: absent (or foreign-tenant) row vs. stale version —
      // the scoped re-read classifies exactly.
      const current = await selectProject(db, scope, projectId);
      if (current === null) {
        return fail(
          entityNotFound({ entityKind: PROJECT_KIND, entityId: projectId }, { scope }),
        );
      }
      return fail(
        concurrencyConflict(
          {
            entityKind: PROJECT_KIND,
            entityId: projectId,
            expectedVersion,
            actualVersion: current.version,
          },
          { scope },
        ),
      );
    },

    archive: async (db, scope, projectId, expectedVersion, now) => {
      const scopeError = projectScopeMismatch(scope, projectId, { scope });
      if (scopeError !== null) return fail(scopeError);
      const result = await db.query(
        `UPDATE projects
         SET status = 'archived', archived_at = $4, version = version + 1, updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND version = $3
         RETURNING ${PROJECT_COLUMNS}`,
        [scope.tenantId, projectId, expectedVersion, toDate(now)],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapRow(row));
      }
      // Zero affected rows: absent (or foreign-tenant) row vs. stale version —
      // the scoped re-read classifies exactly.
      const current = await selectProject(db, scope, projectId);
      if (current === null) {
        return fail(
          entityNotFound({ entityKind: PROJECT_KIND, entityId: projectId }, { scope }),
        );
      }
      return fail(
        concurrencyConflict(
          {
            entityKind: PROJECT_KIND,
            entityId: projectId,
            expectedVersion,
            actualVersion: current.version,
          },
          { scope },
        ),
      );
    },
  };
};
