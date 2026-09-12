// Office persistence — tenant metadata repository (OFF-004).
//
// Reference repository over the `tenants` table. The tenants table is the
// root of the tenant hierarchy (A12): its rows are addressed by their own
// canonical tenant id, so every statement here filters on `tenant_id` — the
// addressed tenant IS the scope, and no method exists that can touch more
// than one tenant's row (no cross-tenant path, no unscoped list). Real
// tenancy lifecycle (provisioning, suspension) is owned by OFF-007 on top of
// this foundation.
import type { TenantId, Timestamp } from '@office/contracts';
import {
  INITIAL_AGGREGATE_VERSION,
  concurrencyConflict,
  domainError,
  entityNotFound,
  fail,
  ok,
} from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import { driverErrorInfo } from './failure';
import { readAggregateVersion, readTenantId, readText, readTimestamp, toDate, entityKindOf } from './rows';
import type { SqlExecutor } from './sql';

/** A tenant metadata row, decoded into canonical types. */
export interface TenantRecord {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly version: AggregateVersion;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Input of a tenant insert; the canonical id is issued upstream (injected). */
export interface NewTenant {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly now: Timestamp;
}

/**
 * Tenant metadata repository. Every method is scoped to exactly one tenant
 * by construction: the addressed tenant id is the only access path.
 */
export interface TenantsRepository {
  /** Insert a tenant row (version starts at 1). */
  insert(db: SqlExecutor, input: NewTenant): Promise<Result<TenantRecord, DomainError>>;
  /** Load the addressed tenant. */
  findById(db: SqlExecutor, tenantId: TenantId): Promise<Result<TenantRecord, DomainError>>;
  /**
   * Rename the addressed tenant with optimistic concurrency: a stale
   * expected version is a typed concurrency-conflict, never a silent
   * overwrite.
   */
  rename(
    db: SqlExecutor,
    tenantId: TenantId,
    expectedVersion: AggregateVersion,
    displayName: string,
    now: Timestamp,
  ): Promise<Result<TenantRecord, DomainError>>;
}

const TENANT_COLUMNS = 'tenant_id, display_name, version, created_at, updated_at';
const TENANT_KIND = entityKindOf('tenant');

const mapTenantRow = (row: Record<string, unknown>): TenantRecord => ({
  tenantId: readTenantId(row, 'tenants'),
  displayName: readText(row, 'tenants', 'display_name'),
  version: readAggregateVersion(row, 'tenants'),
  createdAt: readTimestamp(row, 'tenants', 'created_at'),
  updatedAt: readTimestamp(row, 'tenants', 'updated_at'),
});

/** Create the tenant metadata repository. */
export const createTenantsRepository = (): TenantsRepository => {
  const selectTenant = async (
    db: SqlExecutor,
    tenantId: TenantId,
  ): Promise<TenantRecord | null> => {
    const result = await db.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE tenant_id = $1`, [
      tenantId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapTenantRow(row);
  };

  return {
    insert: async (db, input) => {
      try {
        const result = await db.query(
          `INSERT INTO tenants (tenant_id, display_name, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           RETURNING ${TENANT_COLUMNS}`,
          [input.tenantId, input.displayName, INITIAL_AGGREGATE_VERSION, toDate(input.now)],
        );
        const row = result.rows[0];
        if (row === undefined) {
          return fail(
            domainError(
              'invariant-violation',
              `tenant insert returned no row for ${input.tenantId}`,
              [{ code: 'tenant-insert-no-row', message: input.tenantId, path: null }],
            ),
          );
        }
        return ok(mapTenantRow(row));
      } catch (error) {
        const { code, constraint } = driverErrorInfo(error);
        if (code === '23505' && constraint === 'tenants_pkey') {
          return fail(
            domainError(
              'invariant-violation',
              `canonical tenant id already exists: ${input.tenantId}`,
              [{ code: 'tenant-id-already-exists', message: input.tenantId, path: 'tenantId' }],
            ),
          );
        }
        throw error;
      }
    },

    findById: async (db, tenantId) => {
      const tenant = await selectTenant(db, tenantId);
      if (tenant === null) {
        return fail(entityNotFound({ entityKind: TENANT_KIND, entityId: tenantId }));
      }
      return ok(tenant);
    },

    rename: async (db, tenantId, expectedVersion, displayName, now) => {
      const result = await db.query(
        `UPDATE tenants
         SET display_name = $1, version = version + 1, updated_at = $2
         WHERE tenant_id = $3 AND version = $4
         RETURNING ${TENANT_COLUMNS}`,
        [displayName, toDate(now), tenantId, expectedVersion],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return ok(mapTenantRow(row));
      }
      // Zero affected rows: either the tenant does not exist, or it exists
      // with a different version — the scoped re-read classifies exactly.
      const current = await selectTenant(db, tenantId);
      if (current === null) {
        return fail(entityNotFound({ entityKind: TENANT_KIND, entityId: tenantId }));
      }
      return fail(
        concurrencyConflict({
          entityKind: TENANT_KIND,
          entityId: tenantId,
          expectedVersion,
          actualVersion: current.version,
        }),
      );
    },
  };
};
