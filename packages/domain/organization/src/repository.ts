// Office organization domain — organizations repository (OFF-007).
//
// THE repository of the organization domain module, over the `organizations`
// table (migration 0100). It follows the OFF-004 reference repositories
// exactly (scope isolation by construction, freeze A12):
//
//   * every method takes a validated contracts `Scope` as its scope of
//     execution — there is no unscoped entry point;
//   * organizations are TENANT-level entities (no project_id column, freeze
//     A1/A12): every statement binds `tenant_id` from the scope as its first
//     parameter — the same construction guarantee the scopedSql helper gives
//     project-bound tables — so tenant A can never read or write tenant B's
//     rows: a foreign row is simply not there (typed not-found, no existence
//     oracle), never leaked;
//   * a project-scoped call may address tenant-level organizations (the
//     kernel's documented scope rule); only its tenantId is used;
//   * writes are guarded by optimistic concurrency (`WHERE ... AND
//     version = $expected`), so a stale version is a typed
//     concurrency-conflict and never a silent overwrite;
//   * archive is an UPDATE (status/archived_at lifecycle columns), never a
//     DELETE — the lifecycle is explicit and auditable.
import { formatTimestamp, parseEntityId, parseTenantId } from '@office/contracts';
import type { EntityId, Scope, TenantId, Timestamp } from '@office/contracts';
import {
  INITIAL_AGGREGATE_VERSION,
  concurrencyConflict,
  domainError,
  entityNotFound,
  fail,
  ok,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { PersistenceFailure } from '@office/persistence';
import type { SqlExecutor, SqlValue } from '@office/persistence';
import type { OrganizationChanges, OrganizationState, OrganizationStatus } from './state';
import { ORGANIZATION_KIND, ORGANIZATION_STATUSES } from './state';

/** Input of an organization insert; the canonical id is issued upstream (injected). */
export interface NewOrganization {
  readonly organizationId: EntityId;
  readonly name: string;
  /** Optional extension metadata (defaults to the empty object). */
  readonly extensionMetadata?: Readonly<Record<string, unknown>>;
  readonly now: Timestamp;
}

const ORGANIZATION_COLUMNS =
  'tenant_id, organization_id, name, status, archived_at, version, created_at, updated_at, extension_metadata';

type Row = Record<string, unknown>;

const rowCorruption = (column: string, row: Row): PersistenceFailure =>
  new PersistenceFailure('row-corruption', `corrupt row in table 'organizations': field '${column}'`, {
    cause: row,
  });

/** Read a non-empty TEXT column (fail-closed). */
const readText = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) throw rowCorruption(column, row);
  return value;
};

/** Read the canonical organization id column (fail-closed). */
const readOrganizationId = (row: Row): EntityId => {
  const parsed = parseEntityId(row['organization_id']);
  if (!parsed.ok) throw rowCorruption('organization_id', row);
  return parsed.value;
};

/** Read the canonical tenant id column (fail-closed). */
const readTenantId = (row: Row): TenantId => {
  const parsed = parseTenantId(row['tenant_id']);
  if (!parsed.ok) throw rowCorruption('tenant_id', row);
  return parsed.value;
};

/** Read the lifecycle status column (fail-closed against the vocabulary). */
const readStatus = (row: Row): OrganizationStatus => {
  const value = row['status'];
  if (typeof value !== 'string' || !(ORGANIZATION_STATUSES as readonly string[]).includes(value)) {
    throw rowCorruption('status', row);
  }
  return value as OrganizationStatus;
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

/** Map one organizations row onto the OrganizationState (fail-closed). */
const mapRow = (row: Row): OrganizationState => ({
  entityKind: ORGANIZATION_KIND,
  entityId: readOrganizationId(row),
  scope: { kind: 'tenant', tenantId: readTenantId(row) },
  version: readAggregateVersion(row),
  name: readText(row, 'name'),
  status: readStatus(row),
  archivedAt: readNullableTimestamp(row, 'archived_at'),
  createdAt: readTimestamp(row, 'created_at'),
  updatedAt: readTimestamp(row, 'updated_at'),
  extensionMetadata: readJsonObject(row),
});

/** Require at least one change field (trusted-path check). */
const requireChanges = (changes: OrganizationChanges): void => {
  if (changes.name === undefined && changes.extensionMetadata === undefined) {
    throw new TypeError('organization update requires at least one change field');
  }
};

/**
 * Organization repository: every read and write executes under an explicit
 * tenant (or tenant+project) scope, by construction.
 */
export interface OrganizationsRepository {
  /**
   * Insert an organization owned by the scope's tenant. The tenant ownership
   * of the row comes from the scope itself, never from a caller-supplied
   * column. Unknown tenant → typed not-found; duplicate canonical id → typed
   * invariant-violation.
   */
  insert(
    db: SqlExecutor,
    scope: Scope,
    input: NewOrganization,
  ): Promise<Result<OrganizationState, DomainError>>;
  /**
   * Load the addressed organization within the scope. Cross-tenant → typed
   * not-found (the row is not visible — no existence oracle, freeze A12).
   */
  findById(
    db: SqlExecutor,
    scope: Scope,
    organizationId: EntityId,
  ): Promise<Result<OrganizationState, DomainError>>;
  /**
   * List the organizations visible to the scope: every organization of the
   * scope's tenant (organizations are tenant-level; project scope sees its
   * tenant's organizations too).
   */
  list(db: SqlExecutor, scope: Scope): Promise<Result<readonly OrganizationState[], DomainError>>;
  /**
   * Update the addressed organization with optimistic concurrency: a stale
   * expected version is a typed concurrency-conflict; a missing (or foreign)
   * row is a typed not-found. `changes` must carry at least one field (loud
   * TypeError otherwise — trusted-path programming error).
   */
  update(
    db: SqlExecutor,
    scope: Scope,
    organizationId: EntityId,
    expectedVersion: AggregateVersion,
    changes: OrganizationChanges,
    now: Timestamp,
  ): Promise<Result<OrganizationState, DomainError>>;
  /**
   * Archive the addressed organization with optimistic concurrency: the
   * explicit lifecycle UPDATE (status 'archived' + archived_at), never a
   * DELETE. Stale version → typed concurrency-conflict; missing row → typed
   * not-found.
   */
  archive(
    db: SqlExecutor,
    scope: Scope,
    organizationId: EntityId,
    expectedVersion: AggregateVersion,
    now: Timestamp,
  ): Promise<Result<OrganizationState, DomainError>>;
}

/** Create the organization repository. */
export const createOrganizationsRepository = (): OrganizationsRepository => {
  const selectOrganization = async (
    db: SqlExecutor,
    scope: Scope,
    organizationId: EntityId,
  ): Promise<OrganizationState | null> => {
    const result = await db.query(
      `SELECT ${ORGANIZATION_COLUMNS} FROM organizations
       WHERE tenant_id = $1 AND organization_id = $2`,
      [scope.tenantId, organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  };

  return {
    insert: async (db, scope, input) => {
      try {
        // tenant_id is bound from the SCOPE, never from the input — the row
        // is owned by the executing tenant by construction.
        const result = await db.query(
          `INSERT INTO organizations (tenant_id, organization_id, name, status, archived_at, version, created_at, updated_at, extension_metadata)
           VALUES ($1, $2, $3, 'active', NULL, $4, $5, $5, $6)
           RETURNING ${ORGANIZATION_COLUMNS}`,
          [
            scope.tenantId,
            input.organizationId,
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
              `organization insert returned no row for ${input.organizationId}`,
              [{ code: 'organization-insert-no-row', message: input.organizationId, path: null }],
              { scope },
            ),
          );
        }
        return ok(mapRow(row));
      } catch (error) {
        const { code, constraint } = constraintInfoOf(error);
        if (code === '23505' && constraint === 'organizations_pkey') {
          return fail(
            domainError(
              'invariant-violation',
              `canonical organization id already exists: ${input.organizationId}`,
              [
                {
                  code: 'organization-id-already-exists',
                  message: input.organizationId,
                  path: 'organizationId',
                },
              ],
              { scope },
            ),
          );
        }
        if (code === '23503' && constraint === 'organizations_tenant_id_fkey') {
          return fail(
            domainError(
              'not-found',
              `tenant ${scope.tenantId} not found: cannot create organization ${input.organizationId}`,
              [{ code: 'tenant-not-found', message: scope.tenantId, path: 'tenantId' }],
              { scope },
            ),
          );
        }
        throw error;
      }
    },

    findById: async (db, scope, organizationId) => {
      const organization = await selectOrganization(db, scope, organizationId);
      if (organization === null) {
        return fail(
          entityNotFound({ entityKind: ORGANIZATION_KIND, entityId: organizationId }, { scope }),
        );
      }
      return ok(organization);
    },

    list: async (db, scope) => {
      const result = await db.query(
        `SELECT ${ORGANIZATION_COLUMNS} FROM organizations
         WHERE tenant_id = $1
         ORDER BY created_at DESC, organization_id ASC`,
        [scope.tenantId],
      );
      return ok(result.rows.map(mapRow));
    },

    update: async (db, scope, organizationId, expectedVersion, changes, now) => {
      requireChanges(changes);
      const values: SqlValue[] = [scope.tenantId, organizationId, expectedVersion];
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
        `UPDATE organizations
         SET ${assignments.join(', ')}, version = version + 1, updated_at = ${nowParam}
         WHERE tenant_id = $1 AND organization_id = $2 AND version = $3
         RETURNING ${ORGANIZATION_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapRow(row));
      }
      // Zero affected rows: absent (or foreign-tenant) row vs. stale version —
      // the scoped re-read classifies exactly.
      const current = await selectOrganization(db, scope, organizationId);
      if (current === null) {
        return fail(
          entityNotFound({ entityKind: ORGANIZATION_KIND, entityId: organizationId }, { scope }),
        );
      }
      return fail(
        concurrencyConflict(
          {
            entityKind: ORGANIZATION_KIND,
            entityId: organizationId,
            expectedVersion,
            actualVersion: current.version,
          },
          { scope },
        ),
      );
    },

    archive: async (db, scope, organizationId, expectedVersion, now) => {
      const result = await db.query(
        `UPDATE organizations
         SET status = 'archived', archived_at = $4, version = version + 1, updated_at = $4
         WHERE tenant_id = $1 AND organization_id = $2 AND version = $3
         RETURNING ${ORGANIZATION_COLUMNS}`,
        [scope.tenantId, organizationId, expectedVersion, toDate(now)],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapRow(row));
      }
      // Zero affected rows: absent (or foreign-tenant) row vs. stale version —
      // the scoped re-read classifies exactly.
      const current = await selectOrganization(db, scope, organizationId);
      if (current === null) {
        return fail(
          entityNotFound({ entityKind: ORGANIZATION_KIND, entityId: organizationId }, { scope }),
        );
      }
      return fail(
        concurrencyConflict(
          {
            entityKind: ORGANIZATION_KIND,
            entityId: organizationId,
            expectedVersion,
            actualVersion: current.version,
          },
          { scope },
        ),
      );
    },
  };
};
