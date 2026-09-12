import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEntityKind, parseProjectId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { ParseResult, ProjectId, Scope, TenantId, Timestamp } from '@office/contracts';
import { INITIAL_AGGREGATE_VERSION, entityNotFound, fail } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  PersistenceFailure,
  createMigrator,
  createProjectsRepository,
  createTenantsRepository,
  readMigrationFiles,
  startPersistenceTestHarness,
} from './index';
import type {
  MigrationFile,
  PersistencePool,
  PersistenceTestHarness,
  ProjectRecord,
  ProjectsRepository,
  SqlExecutor,
  SqlValue,
  TenantRecord,
  TenantsRepository,
} from './index';

// OFF-004 integration acceptance — one real PostgreSQL for the whole file.
//
// Harness contract: DATABASE_URL set → the tests use that server (CI mode,
// postgres:17 service); unset → the harness boots its own embedded
// PostgreSQL 17.10 cluster (local mode) and tears it down in afterAll. Either
// way the pool binds to an EMPTY scratch database, so the migration gate
// below literally migrates from an empty database.
//
// Everything is deterministic: fixed canonical ids, fixed injected
// timestamps, fixed names. No wall clock, no randomness.
//
// Acceptance suites, in order:
//   1. migrations — applied from an empty database, recorded, verified
//      (incl. checksum tamper rejection and failed-migration rollback);
//   2. transactional boundary — runInTransaction commit / rollback /
//      tx.rollback(value) semantics (the OFF-005 seam);
//   3. tenant isolation — tenant A cannot read or write tenant B's rows;
//   4. project second boundary — row-level project scoping + typed
//      unauthorized on scope/address mismatch;
//   5. optimistic concurrency — load returns the version, stale updates are
//      typed concurrency-conflicts, state never silently overwritten;
//   6. typed columns + JSONB extension metadata round trips;
//   7. scoped-by-construction — every statement the repositories emit
//      carries the tenant scope predicate.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const expectOk = <T>(result: Result<T, DomainError>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result.error)}`);
};

const expectFailure = <T>(result: Result<T, DomainError>): DomainError => {
  if (result.ok) throw new Error('expected a typed failure');
  return result.error;
};

// ----- fixed test data -------------------------------------------------------

const NOW_1 = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2 = unwrap(parseTimestamp('2026-09-12T11:30:00.000Z'));
const NOW_3 = unwrap(parseTimestamp('2026-09-12T12:45:10.000Z'));
const PROJECT_KIND = unwrap(parseEntityKind('project'));

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'));
const TENANT_UNKNOWN: TenantId = unwrap(parseTenantId('office-tnt-v1-777aaabb0123456789abcdef01234567'));
const TENANT_TX: TenantId = unwrap(parseTenantId('office-tnt-v1-13579bdf02468ace13579bdf02468ace'));
const TENANT_REC: TenantId = unwrap(parseTenantId('office-tnt-v1-2468ace13579bdf02468ace13579bdf0'));

const PROJECT_A1: ProjectId = unwrap(parseProjectId('office-prj-v1-4f9d2c81a7e34b5d90c1f2e3a4b5c6d7'));
const PROJECT_A2: ProjectId = unwrap(parseProjectId('office-prj-v1-a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_A3: ProjectId = unwrap(parseProjectId('office-prj-v1-b7c3d4e5f60718293a4b5c6d7e8f9a1'));
const PROJECT_A4: ProjectId = unwrap(parseProjectId('office-prj-v1-c8d4e5f60718293a4b5c6d7e8f9a1b2'));
const PROJECT_A5: ProjectId = unwrap(parseProjectId('office-prj-v1-d9e5f60718293a4b5c6d7e8f9a1b2c3'));
const PROJECT_B1: ProjectId = unwrap(parseProjectId('office-prj-v1-9990abcdef1234567890abcdef123456'));
const PROJECT_TX1: ProjectId = unwrap(parseProjectId('office-prj-v1-5555feed0123456789abcdef01234567'));
const PROJECT_TX2: ProjectId = unwrap(parseProjectId('office-prj-v1-6666feed0123456789abcdef01234567'));
const PROJECT_TX3: ProjectId = unwrap(parseProjectId('office-prj-v1-7777feed0123456789abcdef01234567'));
const PROJECT_TX4: ProjectId = unwrap(parseProjectId('office-prj-v1-8888feed0123456789abcdef01234567'));
const PROJECT_MISSING: ProjectId = unwrap(parseProjectId('office-prj-v1-eeeefeed0123456789abcdef01234567'));
const PROJECT_REC: ProjectId = unwrap(parseProjectId('office-prj-v1-aaaafeed0123456789abcdef01234567'));

const scopeTenantA: Scope = { kind: 'tenant', tenantId: TENANT_A };
const scopeTenantB: Scope = { kind: 'tenant', tenantId: TENANT_B };
const scopeTenantUnknown: Scope = { kind: 'tenant', tenantId: TENANT_UNKNOWN };
const scopeProjectA1: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_A1 };
const scopeProjectA2: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_A2 };

// ----- harness boot + migration + shared seed --------------------------------

let harness: PersistenceTestHarness;
let pool: PersistencePool;
let tenants: TenantsRepository;
let projects: ProjectsRepository;
let migrationRun: { applied: readonly MigrationFile[]; verified: readonly MigrationFile[] };
let migrationFiles: readonly MigrationFile[];

const fixtureDirs: string[] = [];

beforeAll(async () => {
  harness = await startPersistenceTestHarness();
  pool = harness.pool;
  tenants = createTenantsRepository();
  projects = createProjectsRepository();

  // Migration gate: the scratch database is EMPTY here.
  const migrator = createMigrator(pool, { now: () => NOW_1 });
  migrationRun = await migrator.migrate();
  migrationFiles = await readMigrationFiles(harness.migrationsDir);

  // Shared fixture data (seeded through the repositories under test).
  expectOk(await tenants.insert(pool, { tenantId: TENANT_A, displayName: 'Tenant A', now: NOW_1 }));
  expectOk(await tenants.insert(pool, { tenantId: TENANT_B, displayName: 'Tenant B', now: NOW_1 }));
  expectOk(
    await projects.insert(pool, scopeTenantA, {
      projectId: PROJECT_A1,
      name: 'Riverside Hospital',
      now: NOW_1,
    }),
  );
  expectOk(
    await projects.insert(pool, scopeTenantA, {
      projectId: PROJECT_A2,
      name: 'Harbor Logistics Hub',
      now: NOW_1,
    }),
  );
  expectOk(
    await projects.insert(pool, scopeTenantB, {
      projectId: PROJECT_B1,
      name: 'Airport North Terminal',
      now: NOW_1,
    }),
  );
}, 180_000);

afterAll(async () => {
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await harness.stop();
}, 120_000);

const migrationFile = (version: number): MigrationFile => {
  const file = migrationFiles.find((candidate) => candidate.version === version);
  if (file === undefined) throw new Error(`migration ${version} not found in fixture`);
  return file;
};

/** Copy the real migrations into a temp dir, optionally overriding files. */
const fixtureMigrationsDir = async (
  extra: Readonly<Record<string, string>>,
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'office-migrations-'));
  for (const file of migrationFiles) {
    await writeFile(join(dir, file.fileName), file.text, 'utf8');
  }
  for (const [fileName, text] of Object.entries(extra)) {
    await writeFile(join(dir, fileName), text, 'utf8');
  }
  fixtureDirs.push(dir);
  return dir;
};

// ----- 1. migrations ---------------------------------------------------------

describe('migrations — from an empty database (acceptance)', () => {
  it('applies every pending migration in version order', () => {
    expect(migrationRun.applied.map((file) => file.version)).toStrictEqual([1, 2]);
    expect(migrationRun.applied.map((file) => file.name)).toStrictEqual(['tenants', 'projects']);
    expect(migrationRun.verified).toStrictEqual([]);
  });

  it('records applied versions, names, and checksums in schema_migrations', async () => {
    const ledger = await createMigrator(pool, { now: () => NOW_1 }).appliedMigrations();
    expect(ledger.map((entry) => entry.version)).toStrictEqual([1, 2]);
    expect(ledger.map((entry) => entry.name)).toStrictEqual(['tenants', 'projects']);
    expect(ledger.map((entry) => entry.checksum)).toStrictEqual([
      migrationFile(1).checksum,
      migrationFile(2).checksum,
    ]);
    // Deterministic injected clock: applied_at is exactly the fixed instant.
    expect(ledger.map((entry) => entry.appliedAt)).toStrictEqual([NOW_1, NOW_1]);
  });

  it('re-running is a verified no-op (idempotent, forward-only)', async () => {
    const rerun = await createMigrator(pool, { now: () => NOW_1 }).migrate();
    expect(rerun.applied).toStrictEqual([]);
    expect(rerun.verified.map((file) => file.version)).toStrictEqual([1, 2]);
  });

  it('creates the projects table with typed columns and NOT NULL integrity (A2)', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'projects'
       ORDER BY ordinal_position`,
    );
    expect(result.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']])).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['project_id', 'text', 'NO'],
      ['name', 'text', 'NO'],
      ['version', 'bigint', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
      ['extension_metadata', 'jsonb', 'NO'],
    ]);
  });

  it('creates the tenants table with typed columns (A2)', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tenants'
       ORDER BY ordinal_position`,
    );
    expect(result.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']])).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['display_name', 'text', 'NO'],
      ['version', 'bigint', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });

  it('enforces relational integrity: canonical PK and tenant FK with cascade', async () => {
    const result = await pool.query(
      `SELECT contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'projects'::regclass
       ORDER BY contype`,
    );
    const definitions = result.rows.map((row) => String(row['definition']));
    expect(definitions.join('\n')).toContain('PRIMARY KEY (project_id)');
    expect(definitions.join('\n')).toContain('FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE');
  });

  it('rejects a modified applied migration (checksum immutability guard)', async () => {
    const dir = await fixtureMigrationsDir({
      [migrationFile(2).fileName]: `${migrationFile(2).text}\n-- tampered after the fact\n`,
    });
    const tampered = createMigrator(pool, { migrationsDir: dir, now: () => NOW_1 });
    await expect(tampered.migrate()).rejects.toMatchObject({
      code: 'migration-validation',
    });
  });

  it('rolls a failed migration back completely and records nothing for it', async () => {
    const dir = await fixtureMigrationsDir({
      '0003_create_migration_probe.sql': 'CREATE TABLE migration_probe (id INT NOT NULL PRIMARY KEY);',
      '0004_bad.sql':
        'CREATE TABLE rollback_probe (id INT NOT NULL PRIMARY KEY);\nSELECT office_no_such_relation;',
    });
    const failing = createMigrator(pool, { migrationsDir: dir, now: () => NOW_1 });
    await expect(failing.migrate()).rejects.toMatchObject({ code: 'migration-failed' });

    // 0003 committed before the failure; 0004 rolled back completely.
    const probe = await pool.query(`SELECT to_regclass('public.migration_probe') AS reg`);
    expect(probe.rows[0]?.['reg']).not.toBeNull();
    const rollbackProbe = await pool.query(`SELECT to_regclass('public.rollback_probe') AS reg`);
    expect(rollbackProbe.rows[0]?.['reg']).toBeNull();
    const ledger = await createMigrator(pool).appliedMigrations();
    expect(ledger.map((entry) => entry.version)).toStrictEqual([1, 2, 3]);
  });
});

// ----- 2. transactional boundary ---------------------------------------------

describe('transactional boundary — runInTransaction (acceptance)', () => {
  beforeAll(async () => {
    expectOk(
      await tenants.insert(pool, { tenantId: TENANT_TX, displayName: 'Transaction Tenant', now: NOW_1 }),
    );
  }, 30_000);

  it('commits work that resolves, and the writes are visible afterwards', async () => {
    await pool.runInTransaction(async (tx) => {
      expectOk(
        await projects.insert(tx, { kind: 'tenant', tenantId: TENANT_TX }, {
          projectId: PROJECT_TX1,
          name: 'Committed Tower',
          now: NOW_1,
        }),
      );
    });
    const record = expectOk(
      await projects.findById(pool, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX1),
    );
    expect(record.version).toBe(1);
  });

  it('sees its own uncommitted writes inside the transaction', async () => {
    const inside = await pool.runInTransaction(async (tx) => {
      expectOk(
        await projects.insert(tx, { kind: 'tenant', tenantId: TENANT_TX }, {
          projectId: PROJECT_TX2,
          name: 'Visible Inside',
          now: NOW_1,
        }),
      );
      return projects.findById(tx, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX2);
    });
    expect(expectOk(inside).name).toBe('Visible Inside');
  });

  it('rolls back every write when work throws, and rethrows the original error', async () => {
    const before = expectOk(
      await projects.list(pool, { kind: 'tenant', tenantId: TENANT_TX }),
    );
    await expect(
      pool.runInTransaction(async (tx) => {
        expectOk(
          await projects.insert(tx, { kind: 'tenant', tenantId: TENANT_TX }, {
            projectId: PROJECT_TX3,
            name: 'Never Committed',
            now: NOW_1,
          }),
        );
        // A second write proves MULTIPLE partial writes are discarded.
        expectOk(
          await projects.update(
            tx,
            { kind: 'tenant', tenantId: TENANT_TX },
            PROJECT_TX1,
            INITIAL_AGGREGATE_VERSION,
            { name: 'Committed Tower (renamed in aborted tx)' },
            NOW_2,
          ),
        );
        throw new Error('boom: simulated handler failure');
      }),
    ).rejects.toThrow('boom: simulated handler failure');

    // NO partial writes: the insert is gone and the rename never happened.
    const missing = await projects.findById(pool, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX3);
    expect(expectFailure(missing).code).toBe('not-found');
    const untouched = expectOk(
      await projects.findById(pool, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX1),
    );
    expect(untouched.name).toBe('Committed Tower');
    expect(untouched.version).toBe(1);
    const after = expectOk(await projects.list(pool, { kind: 'tenant', tenantId: TENANT_TX }));
    expect(after).toStrictEqual(before);
  });

  it('tx.rollback(value) discards the writes and returns the value (the OFF-005 seam)', async () => {
    // Typing note for OFF-005: when the ONLY return of `work` is
    // `tx.rollback(value)` the callback infers as returning `never`, so the
    // handler's result type must be annotated explicitly (a callback that
    // also returns non-rollback values infers naturally).
    const outcome = await pool.runInTransaction(
      async (tx): Promise<Result<never, DomainError>> => {
        expectOk(
          await projects.insert(tx, { kind: 'tenant', tenantId: TENANT_TX }, {
            projectId: PROJECT_TX4,
            name: 'Rolled Back With Value',
            now: NOW_2,
          }),
        );
        // Simulated handler failure AFTER writes: return the typed DomainError
        // via rollback — the seam OFF-005 uses for atomic mutation + outbox.
        return tx.rollback(
          fail(entityNotFound({ entityKind: PROJECT_KIND, entityId: PROJECT_TX4 })),
        );
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('not-found');
      expect(outcome.error.details[0]?.code).toBe('entity-not-found');
    }
    // Every write of the attempt is gone.
    const missing = await projects.findById(pool, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX4);
    expect(expectFailure(missing).code).toBe('not-found');
  });

  it('a Result failure alone does not roll back — rollback stays explicit', async () => {
    // Repositories return typed failures as values; the transaction commits
    // unless the caller rolls back (throw or tx.rollback). This is the exact
    // contract OFF-005 composes: check the failure, decide, roll back.
    const committed = await pool.runInTransaction(async (tx) => {
      // PROJECT_TX2 already exists from the earlier commit → typed failure.
      const duplicate = await projects.insert(tx, { kind: 'tenant', tenantId: TENANT_TX }, {
        projectId: PROJECT_TX2,
        name: 'Duplicate Insert',
        now: NOW_1,
      });
      return duplicate.ok ? 'unexpected-success' : 'committed-with-failure-value';
    });
    expect(committed).toBe('committed-with-failure-value');
    // The earlier row is intact and the duplicate never landed.
    const existing = expectOk(
      await projects.findById(pool, { kind: 'tenant', tenantId: TENANT_TX }, PROJECT_TX2),
    );
    expect(existing.name).toBe('Visible Inside');
  });
});

// ----- 3. tenant isolation (acceptance) ----------------------------------------

describe('tenant isolation — tenant A cannot read or write tenant B rows', () => {
  it('findById of a foreign-tenant project is a typed not-found, never data', async () => {
    const outcome = await projects.findById(pool, scopeTenantA, PROJECT_B1);
    const error = expectFailure(outcome);
    expect(error.kind).toBe('domain-error');
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('entity-not-found');
    // The foreign row is simply not visible: no name, no existence oracle.
    expect(error.message).not.toContain('Airport North Terminal');
    // The error carries the COMMAND's scope, never the foreign tenant's.
    expect(error.scope).toStrictEqual(scopeTenantA);
  });

  it('a foreign-tenant row and a missing row are indistinguishable (no existence oracle)', async () => {
    const foreign = expectFailure(await projects.findById(pool, scopeTenantA, PROJECT_B1));
    const missing = expectFailure(await projects.findById(pool, scopeTenantA, PROJECT_MISSING));
    expect(foreign.code).toBe(missing.code);
    expect(foreign.details[0]?.code).toBe(missing.details[0]?.code);
    expect(foreign.details[0]?.code).toBe('entity-not-found');
  });

  it('list under tenant scope returns ONLY rows owned by that tenant, in deterministic order', async () => {
    const listA = expectOk(await projects.list(pool, scopeTenantA));
    expect(listA.map((record) => record.projectId)).toStrictEqual([PROJECT_A1, PROJECT_A2]);
    for (const record of listA) {
      expect(record.tenantId).toBe(TENANT_A);
    }
    const listB = expectOk(await projects.list(pool, scopeTenantB));
    expect(listB.map((record) => record.projectId)).toStrictEqual([PROJECT_B1]);
    for (const record of listB) {
      expect(record.tenantId).toBe(TENANT_B);
    }
  });

  it('update of a foreign-tenant row is a typed not-found and leaves the row untouched', async () => {
    const foreignBefore: ProjectRecord = expectOk(
      await projects.findById(pool, scopeTenantB, PROJECT_B1),
    );
    const outcome = await projects.update(
      pool,
      scopeTenantA,
      PROJECT_B1,
      foreignBefore.version,
      { name: 'Hijacked by Tenant A' },
      NOW_2,
    );
    const error = expectFailure(outcome);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('entity-not-found');
    // Nothing changed — not the name, not the version, not a timestamp.
    const foreignAfter = expectOk(await projects.findById(pool, scopeTenantB, PROJECT_B1));
    expect(foreignAfter).toStrictEqual(foreignBefore);
  });

  it('insert under an unknown tenant is a typed not-found and no row lands', async () => {
    const outcome = await projects.insert(pool, scopeTenantUnknown, {
      projectId: PROJECT_A3,
      name: 'Orphaned Project',
      now: NOW_2,
    });
    const error = expectFailure(outcome);
    expect(error.code).toBe('not-found');
    expect(error.details[0]?.code).toBe('tenant-not-found');
    const probe = await pool.query('SELECT COUNT(*)::int AS count FROM projects WHERE project_id = $1', [
      PROJECT_A3,
    ]);
    expect(probe.rows[0]?.['count']).toBe(0);
  });

  it('a cross-tenant canonical-id collision is a typed invariant-violation, never a takeover', async () => {
    // PROJECT_B1 already exists (owned by tenant B); tenant A attempts to
    // create its own project with the SAME canonical id.
    const outcome = await projects.insert(pool, scopeTenantA, {
      projectId: PROJECT_B1,
      name: 'Stolen Canonical Id',
      now: NOW_2,
    });
    const error = expectFailure(outcome);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('project-id-already-exists');
    const unchanged = expectOk(await projects.findById(pool, scopeTenantB, PROJECT_B1));
    expect(unchanged.name).toBe('Airport North Terminal');
    expect(unchanged.tenantId).toBe(TENANT_B);
  });
});

// ----- 4. project second boundary (A12) ----------------------------------------

describe('project second boundary — a project scope addresses exactly its own project', () => {
  it('findById under project scope loads exactly the scoped project', async () => {
    const record = expectOk(await projects.findById(pool, scopeProjectA1, PROJECT_A1));
    expect(record.projectId).toBe(PROJECT_A1);
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.name).toBe('Riverside Hospital');
  });

  it('findById of a sibling project (same tenant, other project) is a typed unauthorized', async () => {
    const outcome = await projects.findById(pool, scopeProjectA1, PROJECT_A2);
    const error = expectFailure(outcome);
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
    expect(error.scope).toStrictEqual(scopeProjectA1);
  });

  it('findById of a foreign-tenant project under project scope is unauthorized before any SQL runs', async () => {
    const outcome = await projects.findById(pool, scopeProjectA1, PROJECT_B1);
    const error = expectFailure(outcome);
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
  });

  it('update of a sibling project is a typed unauthorized and writes nothing', async () => {
    const before = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_A2));
    const outcome = await projects.update(
      pool,
      scopeProjectA1,
      PROJECT_A2,
      before.version,
      { name: 'Cross-Project Write' },
      NOW_3,
    );
    const error = expectFailure(outcome);
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
    const after = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_A2));
    expect(after).toStrictEqual(before);
  });

  it('list under project scope returns exactly the scoped project — never the sibling', async () => {
    const list = expectOk(await projects.list(pool, scopeProjectA1));
    expect(list.map((record) => record.projectId)).toStrictEqual([PROJECT_A1]);
    // The sibling A2 belongs to the same tenant and is still invisible.
    const scoped = expectOk(await projects.list(pool, scopeProjectA2));
    expect(scoped.map((record) => record.projectId)).toStrictEqual([PROJECT_A2]);
  });

  it('insert under project scope addressing a different project is a typed unauthorized', async () => {
    const outcome = await projects.insert(pool, scopeProjectA1, {
      projectId: PROJECT_A4,
      name: 'Wrong Project Insert',
      now: NOW_2,
    });
    const error = expectFailure(outcome);
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
    const probe = await pool.query('SELECT COUNT(*)::int AS count FROM projects WHERE project_id = $1', [
      PROJECT_A4,
    ]);
    expect(probe.rows[0]?.['count']).toBe(0);
  });
});

// ----- 5. optimistic concurrency ------------------------------------------------

describe('optimistic concurrency — stale versions never silently overwrite', () => {
  beforeAll(async () => {
    expectOk(
      await tenants.insert(pool, { tenantId: TENANT_REC, displayName: 'Reconstruction Co', now: NOW_1 }),
    );
  }, 30_000);

  it('update with the current version commits and bumps it; created_at stays immutable', async () => {
    const loaded: ProjectRecord = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_A1));
    expect(loaded.version).toBe(INITIAL_AGGREGATE_VERSION);
    const renamed = expectOk(
      await projects.update(
        pool,
        scopeTenantA,
        PROJECT_A1,
        loaded.version,
        { name: 'Riverside Hospital Phase II' },
        NOW_2,
      ),
    );
    expect(renamed.version).toBe(2);
    expect(renamed.name).toBe('Riverside Hospital Phase II');
    expect(renamed.createdAt).toBe(loaded.createdAt);
    expect(renamed.updatedAt).toBe(NOW_2);
  });

  it('update with a stale version is a typed concurrency-conflict and touches nothing', async () => {
    const outcome = await projects.update(
      pool,
      scopeTenantA,
      PROJECT_A1,
      INITIAL_AGGREGATE_VERSION,
      { name: 'Silent Overwrite Attempt' },
      NOW_3,
    );
    const error = expectFailure(outcome);
    expect(error.code).toBe('concurrency-conflict');
    expect(error.details[0]?.code).toBe('stale-aggregate-version');
    expect(error.message).toContain('expected version 1');
    expect(error.message).toContain('actual version 2');
    const current = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_A1));
    expect(current.version).toBe(2);
    expect(current.name).toBe('Riverside Hospital Phase II');
    expect(current.updatedAt).toBe(NOW_2);
  });

  it('update of a missing project is a typed not-found, not a conflict', async () => {
    const outcome = await projects.update(
      pool,
      scopeTenantA,
      PROJECT_MISSING,
      INITIAL_AGGREGATE_VERSION,
      { name: 'Ghost Update' },
      NOW_3,
    );
    expect(expectFailure(outcome).code).toBe('not-found');
  });

  it('tenant rename follows the same optimistic-concurrency guard', async () => {
    const renamed: TenantRecord = expectOk(
      await tenants.rename(
        pool,
        TENANT_REC,
        INITIAL_AGGREGATE_VERSION,
        'Reconstruction Co (Renamed)',
        NOW_2,
      ),
    );
    expect(renamed.version).toBe(2);
    expect(renamed.displayName).toBe('Reconstruction Co (Renamed)');
    expect(renamed.createdAt).toBe(NOW_1);
    expect(renamed.updatedAt).toBe(NOW_2);

    const stale = await tenants.rename(pool, TENANT_REC, INITIAL_AGGREGATE_VERSION, 'Stale Rename', NOW_3);
    expect(expectFailure(stale).code).toBe('concurrency-conflict');

    const unchanged = expectOk(await tenants.findById(pool, TENANT_REC));
    expect(unchanged.displayName).toBe('Reconstruction Co (Renamed)');
    expect(unchanged.version).toBe(2);
    expect(unchanged.updatedAt).toBe(NOW_2);
  });

  it('rename of an unknown tenant is a typed not-found', async () => {
    const outcome = await tenants.rename(
      pool,
      TENANT_UNKNOWN,
      INITIAL_AGGREGATE_VERSION,
      'Ghost Tenant',
      NOW_3,
    );
    expect(expectFailure(outcome).code).toBe('not-found');
  });

  it('a duplicate canonical tenant id is a typed invariant-violation', async () => {
    const outcome = await tenants.insert(pool, {
      tenantId: TENANT_A,
      displayName: 'Duplicate Tenant',
      now: NOW_2,
    });
    const error = expectFailure(outcome);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('tenant-id-already-exists');
  });
});

// ----- 6. typed columns + JSONB extension metadata ------------------------------

describe('typed columns and JSONB extension metadata', () => {
  it('round trips extension metadata through insert and read', async () => {
    const metadata = {
      phase: 'preconstruction',
      codes: ['2024-IBC', 'ACI-318'],
      budget: { currency: 'USD', amount: 15750000 },
    };
    const inserted: ProjectRecord = expectOk(
      await projects.insert(pool, scopeTenantA, {
        projectId: PROJECT_A4,
        name: 'Seaport Data Center',
        now: NOW_2,
        extensionMetadata: metadata,
      }),
    );
    expect(inserted.extensionMetadata).toStrictEqual(metadata);
    const loaded = expectOk(await projects.findById(pool, scopeTenantA, PROJECT_A4));
    expect(loaded.extensionMetadata).toStrictEqual(metadata);
    expect(loaded.name).toBe('Seaport Data Center');
  });

  it('defaults extension metadata to the empty object', async () => {
    const inserted = expectOk(
      await projects.insert(pool, scopeTenantA, {
        projectId: PROJECT_A5,
        name: 'Midtown Retrofit',
        now: NOW_2,
      }),
    );
    expect(inserted.extensionMetadata).toStrictEqual({});
  });

  it('update replaces extension metadata and tracks updated_at, never created_at', async () => {
    const updated = expectOk(
      await projects.update(
        pool,
        scopeTenantA,
        PROJECT_A4,
        INITIAL_AGGREGATE_VERSION,
        { extensionMetadata: { phase: 'construction' } },
        NOW_3,
      ),
    );
    expect(updated.extensionMetadata).toStrictEqual({ phase: 'construction' });
    expect(updated.name).toBe('Seaport Data Center');
    const createdAt: Timestamp = updated.createdAt;
    expect(createdAt).toBe(NOW_2);
    expect(updated.updatedAt).toBe(NOW_3);
    expect(updated.version).toBe(2);
  });

  it('fails closed on a corrupt JSONB row (array where an object is required)', async () => {
    expectOk(
      await projects.insert(pool, scopeTenantA, {
        projectId: PROJECT_REC,
        name: 'Corrupt Metadata Probe',
        now: NOW_2,
        extensionMetadata: { ok: true },
      }),
    );
    // Raw SQL outside the repositories plants a shape the schema permits
    // (JSONB accepts arrays) but the fail-closed decoder forbids.
    await pool.query(
      `UPDATE projects SET extension_metadata = '["not","an","object"]'::jsonb WHERE project_id = $1`,
      [PROJECT_REC],
    );
    await expect(projects.findById(pool, scopeTenantA, PROJECT_REC)).rejects.toMatchObject({
      name: 'PersistenceFailure',
      code: 'row-corruption',
    });
    // Repair the probe row afterwards: the corruption contract is proven, and
    // later tenant-wide reads (suite 7) must stay decodable.
    await pool.query(
      `UPDATE projects SET extension_metadata = '{}'::jsonb WHERE project_id = $1`,
      [PROJECT_REC],
    );
  });

  it('wraps raw driver errors in PersistenceFailure with the driver error as cause', async () => {
    await expect(pool.query('SELECT * FROM office_no_such_relation')).rejects.toBeInstanceOf(
      PersistenceFailure,
    );
    await expect(pool.query('SELECT * FROM office_no_such_relation')).rejects.toMatchObject({
      code: 'driver-error',
      cause: { code: '42P01' },
    });
  });
});

// ----- 7. scoped by construction ------------------------------------------------

describe('scoped by construction — every repository statement carries the scope', () => {
  it('binds the scope tenant as the first parameter of every statement', async () => {
    const statements: { text: string; values: readonly SqlValue[] | undefined }[] = [];
    const recording: SqlExecutor = {
      query: async (text, values) => {
        statements.push({ text, values });
        return pool.query(text, values);
      },
    };

    expectOk(
      await projects.insert(recording, scopeTenantA, {
        projectId: PROJECT_A3,
        name: 'Solar Array Field',
        now: NOW_3,
      }),
    );
    expectOk(await projects.findById(recording, scopeTenantA, PROJECT_A3));
    expectOk(await projects.list(recording, scopeTenantA));
    expectOk(
      await projects.update(
        recording,
        scopeTenantA,
        PROJECT_A3,
        INITIAL_AGGREGATE_VERSION,
        { name: 'Solar Array Field II' },
        NOW_3,
      ),
    );

    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      // The tenant scope is the FIRST bound value of every statement.
      expect(statement.values?.[0]).toBe(TENANT_A);
    }
    const inserts = statements.filter((statement) => statement.text.startsWith('INSERT INTO projects'));
    expect(inserts).toHaveLength(1);
    // The insert takes tenant ownership from the SCOPE column value.
    expect(inserts[0]?.text).toContain('(tenant_id,');
    for (const statement of statements.filter(
      (statement) => !statement.text.startsWith('INSERT INTO projects'),
    )) {
      // Every read and write filters on the tenant predicate.
      expect(statement.text).toContain('tenant_id = $1');
    }
  });

  it('project scope adds the second boundary predicate to every statement', async () => {
    const statements: { text: string; values: readonly SqlValue[] | undefined }[] = [];
    const recording: SqlExecutor = {
      query: async (text, values) => {
        statements.push({ text, values });
        return pool.query(text, values);
      },
    };

    expectOk(await projects.findById(recording, scopeProjectA2, PROJECT_A2));
    expectOk(await projects.list(recording, scopeProjectA2));
    expectOk(
      await projects.update(
        recording,
        scopeProjectA2,
        PROJECT_A2,
        INITIAL_AGGREGATE_VERSION,
        { name: 'Harbor Logistics Hub Extended' },
        NOW_3,
      ),
    );

    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      expect(statement.text).toContain('tenant_id = $1 AND project_id = $2');
      expect(statement.values?.[0]).toBe(TENANT_A);
      expect(statement.values?.[1]).toBe(PROJECT_A2);
    }
  });

  it('the recorded statements executed scoped: rows landed, lists stay isolated', async () => {
    const listA = expectOk(await projects.list(pool, scopeTenantA));
    expect(listA.map((record) => record.tenantId).every((tenantId) => tenantId === TENANT_A)).toBe(true);
    expect(new Set(listA.map((record) => record.projectId))).toStrictEqual(
      new Set([PROJECT_A1, PROJECT_A2, PROJECT_A3, PROJECT_A4, PROJECT_A5, PROJECT_REC]),
    );
    const listB = expectOk(await projects.list(pool, scopeTenantB));
    expect(listB.map((record) => record.projectId)).toStrictEqual([PROJECT_B1]);
  });
});
