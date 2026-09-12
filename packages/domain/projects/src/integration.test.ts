import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatProjectId,
  parseCommandEnvelope,
  parseEntityId,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, ParseResult, ProjectId, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  createMigrator,
  createTenantsRepository,
  readMigrationFiles,
  startPersistenceTestHarness,
} from '@office/persistence';
import type { PersistencePool, PersistenceTestHarness, Transaction } from '@office/persistence';
import { PROJECT_MIGRATIONS_DIR } from './migrations';
import { createInMemoryEventSink } from './events';
import type { EventSink, InMemoryEventSink } from './events';
import { createProjectsDomainRepository } from './repository';
import { createProjectCommands } from './commands';
import type { ProjectCommandDeps, ProjectCommands } from './commands';
import type { MigrationFile } from '@office/persistence';
import type { DomainError, Result } from '@office/domain-kernel';

// OFF-007 project domain — integration acceptance suite on the real
// PostgreSQL harness (DATABASE_URL CI mode / embedded-postgres local mode).
//
// The migration chain for this package composes the persistence foundation
// (0001, 0002 — the projects table itself) with this package's own lifecycle
// ALTER (0101_projects_lifecycle) — the same composition convention OFF-005
// and the organization module established. Everything is deterministic:
// fixed canonical ids, fixed injected timestamps, sequential opaque-id
// suppliers; no wall clock, no randomness.
//
// Acceptance suites, in order:
//   1. migrations — the composed chain applies from an empty database and
//      the projects table carries the foundation columns PLUS the lifecycle
//      columns (A2/A12);
//   2. lifecycle — create (tenant scope issues a fresh id; a project-scoped
//      command initializes exactly its own project), update, archive with
//      authorization, every mutation appending its audit event through the
//      EventSink (A3);
//   3. authorization — capability denials are typed forbidden; cross-tenant
//      attempts are typed not-found (A12 invisibility — no existence
//      oracle); a project-scoped command addressing another project is a
//      typed unauthorized project-scope-violation BEFORE any transaction;
//   4. optimistic concurrency — stale versions are typed
//      concurrency-conflicts, state never silently overwritten;
//   5. atomicity — repository write + event append commit or vanish
//      together (a failing sink rolls the mutation back);
//   6. deterministic ids — same injected supplier sequence reproduces the
//      same canonical ids, and they parse with the contracts parser;
//   7. tenant/project isolation — listings, ownership, and the second
//      boundary are scoped by construction.

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

// ----- fixed test data ---------------------------------------------------------

const NOW_1: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:31.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-09-12T11:30:00.000Z'));
const NOW_3: Timestamp = unwrap(parseTimestamp('2026-09-12T12:45:10.000Z'));
const NOWS: readonly Timestamp[] = [NOW_1, NOW_2, NOW_3, NOW_3, NOW_3, NOW_3];

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'));
const TENANT_UNKNOWN = unwrap(parseTenantId('office-tnt-v1-777aaabb0123456789abcdef01234567'));

/** A fixed canonical project id used as a PROJECT SCOPE (the second boundary). */
const PROJECT_SCOPE_ID: ProjectId = unwrap(
  parseProjectId('office-prj-v1-4f9d2c81a7e34b5d90c1f2e3a4b5c6d7'),
);
/** Another fixed canonical project id (a DIFFERENT second boundary). */
const OTHER_PROJECT_SCOPE_ID: ProjectId = unwrap(
  parseProjectId('office-prj-v1-999888777666555444333222111aaa00'),
);

const USER_ACTOR = { kind: 'user', actorId: unwrap(parseEntityId('office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1')) } as const;

const scopeTenantA: Scope = { kind: 'tenant', tenantId: TENANT_A };
const scopeTenantB: Scope = { kind: 'tenant', tenantId: TENANT_B };
const scopeTenantUnknown: Scope = { kind: 'tenant', tenantId: TENANT_UNKNOWN };
const scopeProjectA1: Scope = {
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_SCOPE_ID,
};

/** Deterministic sequential opaque-id supplier (16 lowercase hex chars). */
const sequentialOpaqueIds = (): (() => string) => {
  let counter = 0;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(16, '0');
  };
};

/**
 * Deterministic sequential opaque-id supplier starting AFTER `start` (so
 * suites that deliberately collide ids pick ranges the shared supplier never
 * reaches in this file).
 */
const opaqueIdsFrom = (start: number): (() => string) => {
  let counter = start;
  return () => {
    counter += 1;
    return counter.toString(16).padStart(16, '0');
  };
};

/** Deterministic sequential clock over the fixed instants. */
const sequentialClock = (): (() => Timestamp) => {
  let index = 0;
  return () => NOWS[Math.min(index++, NOWS.length - 1)] ?? NOW_3;
};

let commandCounter = 0;

const makeCommand = (
  payload: unknown,
  commandName: string,
  scope: Scope = scopeTenantA,
): CommandEnvelope<unknown> =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName,
      scope,
      actor: USER_ACTOR,
      idempotencyKey: `idem-prj-${String((commandCounter += 1)).padStart(4, '0')}`,
      causality: { correlationId: 'corr-prj-0001', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

/** The allow-everything-with-capability policy used by the happy paths. */
const allowProjectWrite: Policy = definePolicy([
  { effect: 'allow', capabilities: ['projects.write'], actions: ['write'], resourceKinds: ['project'] },
]);
const denyAll: Policy = definePolicy([]);
const explicitDeny: Policy = definePolicy([
  { effect: 'deny', capabilities: ['projects.write'], actions: ['write'] },
  { effect: 'allow', capabilities: ['projects.write'], actions: ['write'] },
]);

interface Service {
  readonly commands: ProjectCommands;
  readonly sink: InMemoryEventSink;
  readonly pool: PersistencePool;
}

/**
 * The default opaque-id supplier shared by every service in this file: the
 * canonical project id is the table's GLOBAL primary key, so each created
 * aggregate needs a distinct opaque part. Tests that deliberately collide
 * ids (duplicate-id / determinism suites) construct their own equal
 * suppliers explicitly.
 */
const sharedOpaqueIds = sequentialOpaqueIds();

const makeService = (
  pool: PersistencePool,
  sink: EventSink = createInMemoryEventSink(),
  newOpaqueId: () => string = sharedOpaqueIds,
): Service => {
  const deps: ProjectCommandDeps = {
    repository: createProjectsDomainRepository(),
    eventSink: sink,
    transactionRunner: { runInTransaction: (work) => pool.runInTransaction(work) },
    now: sequentialClock(),
    newOpaqueId,
  };
  return { commands: createProjectCommands(deps), sink: sink as InMemoryEventSink, pool };
};

// ----- harness boot + composed migration + shared seed ---------------------------

let harness: PersistenceTestHarness;
let pool: PersistencePool;
let migrationRun: { applied: readonly MigrationFile[]; verified: readonly MigrationFile[] };

const fixtureDirs: string[] = [];

/** Compose the canonical migration chain (persistence + project) into one temp dir. */
const composedMigrationsDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'office-projects-migrations-'));
  const files = [
    ...(await readMigrationFiles(harness.migrationsDir)),
    ...(await readMigrationFiles(PROJECT_MIGRATIONS_DIR)),
  ];
  for (const file of files) {
    await writeFile(join(dir, file.fileName), file.text, 'utf8');
  }
  fixtureDirs.push(dir);
  return dir;
};

beforeAll(async () => {
  harness = await startPersistenceTestHarness();
  pool = harness.pool;

  // Migration gate: the scratch database is EMPTY here; the composed chain
  // applies 0001, 0002 (persistence — the projects table) + 0101 (project
  // lifecycle ALTER) in one run.
  const migrationsDir = await composedMigrationsDir();
  migrationRun = await createMigrator(pool, { migrationsDir, now: () => NOW_1 }).migrate();

  // Shared fixture tenants.
  const tenants = createTenantsRepository();
  expectOk(await tenants.insert(pool, { tenantId: TENANT_A, displayName: 'Tenant A', now: NOW_1 }));
  expectOk(await tenants.insert(pool, { tenantId: TENANT_B, displayName: 'Tenant B', now: NOW_1 }));
}, 180_000);

afterAll(async () => {
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await harness.stop();
}, 120_000);

// ----- 1. migrations -----------------------------------------------------------

describe('migrations — composed chain from an empty database (acceptance)', () => {
  it('applies the persistence + project chain in version order', () => {
    expect(migrationRun.applied.map((file) => file.version)).toStrictEqual([1, 2, 101]);
    expect(migrationRun.applied.map((file) => file.name)).toStrictEqual([
      'tenants',
      'projects',
      'projects_lifecycle',
    ]);
    expect(migrationRun.verified).toStrictEqual([]);
  });

  it('keeps the foundation columns and adds the lifecycle columns (A2/A12)', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'projects'
       ORDER BY ordinal_position`,
    );
    expect(
      result.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']]),
    ).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['project_id', 'text', 'NO'],
      ['name', 'text', 'NO'],
      ['version', 'bigint', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
      ['extension_metadata', 'jsonb', 'NO'],
      ['status', 'text', 'NO'],
      ['archived_at', 'timestamp with time zone', 'YES'],
    ]);
  });

  it('enforces the lifecycle consistency CHECK at the row level', async () => {
    // active + archived_at set violates the row-level lifecycle CHECK added
    // by 0101 (archive is explicit, timestamped, and one-way).
    await expect(
      pool.query(
        `INSERT INTO projects (tenant_id, project_id, name, version, created_at, updated_at, extension_metadata, status, archived_at)
         VALUES ($1, $2, $3, 1, $4, $4, '{}'::jsonb, 'active', $4)`,
        [TENANT_A, 'office-prj-v1-9999aaaa9999aaaa9999aaaa9999aaaa', 'Bad Row', new Date(NOW_1)],
      ),
    ).rejects.toThrow(/projects_lifecycle_consistency/);
  });

  it('defaults pre-lifecycle rows to the active status (pure additive ALTER)', async () => {
    // A row inserted the way the OFF-004 foundation repository inserts it
    // (no status/archived_at columns) lands as an ACTIVE project.
    const inserted = await pool.query(
      `INSERT INTO projects (tenant_id, project_id, name, version, created_at, updated_at, extension_metadata)
       VALUES ($1, $2, $3, 1, $4, $4, '{}'::jsonb)
       RETURNING status, archived_at`,
      [TENANT_A, 'office-prj-v1-aaaa8888aaaa8888aaaa8888aaaa8888', 'Foundation Row', new Date(NOW_1)],
    );
    expect(inserted.rows[0]?.['status']).toBe('active');
    expect(inserted.rows[0]?.['archived_at']).toBeNull();
  });
});

// ----- 2. lifecycle with authorization + audit events ----------------------------

describe('lifecycle — create/update/archive with authorization and audit events (acceptance)', () => {
  it('creates a project (tenant scope issues a fresh id) and appends the projectCreated audit event (A3)', async () => {
    const service = makeService(pool);
    const command = makeCommand(
      { name: 'Riverside Tower', extensionMetadata: { code: 'RT-01' } },
      'projects.createProject',
    );
    const created = expectOk(
      await service.commands.createProject(command, {
        policy: allowProjectWrite,
        capabilities: ['projects.write'],
      }),
    );

    expect(created.entityKind).toBe('project');
    expect(created.name).toBe('Riverside Tower');
    expect(created.status).toBe('active');
    expect(created.archivedAt).toBeNull();
    expect(created.version).toBe(1);
    // The aggregate owns its OWN project scope — the second boundary (A12).
    expect(created.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_A,
      projectId: created.entityId,
    });
    expect(created.extensionMetadata).toStrictEqual({ code: 'RT-01' });
    expect(created.createdAt).toBe(NOW_1);
    expect(created.updatedAt).toBe(NOW_1);

    // The audit event: envelope carried through the EventSink, carrying the
    // aggregate's own project scope.
    expect(service.sink.events).toHaveLength(1);
    const event = service.sink.events[0];
    if (event === undefined) throw new Error('expected the created event');
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('projects.projectCreated');
    expect(event.scope).toStrictEqual(created.scope);
    expect(event.actor).toStrictEqual(USER_ACTOR);
    expect(event.source).toBe('domain');
    expect(event.causality.correlationId).toBe('corr-prj-0001');
    expect(event.causality.causationId).toBe(command.idempotencyKey);
    expect(event.occurredAt).toBe(NOW_1);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'project', entityId: created.entityId },
    });
    expect(event.payload).toStrictEqual({
      projectId: created.entityId,
      name: 'Riverside Tower',
      status: 'active',
      version: 1,
      createdAt: NOW_1,
    });

    // The sink was handed the OPEN TRANSACTION (the mutation's executor),
    // proving the append happens inside the same transaction as the write.
    const recordedExecutor = service.sink.appends[0]?.executor as Partial<Transaction>;
    expect(typeof recordedExecutor.rollback).toBe('function');
  });

  it('a project-scoped create initializes exactly the project its scope addresses (no id issued)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Scoped Bootstrap' }, 'projects.createProject', scopeProjectA1),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    // The project id comes from the COMMAND's project scope — deterministic,
    // no supplier draw — and the aggregate owns exactly that scope.
    expect(created.entityId).toBe(PROJECT_SCOPE_ID);
    expect(created.scope).toStrictEqual(scopeProjectA1);

    // The repository's second-boundary guard: under this project scope, a
    // row for a DIFFERENT project id cannot be inserted (typed unauthorized).
    const repository = createProjectsDomainRepository();
    const mismatch = expectFailure(
      await repository.insert(pool, scopeProjectA1, {
        projectId: OTHER_PROJECT_SCOPE_ID,
        name: 'Foreign Bootstrap',
        now: NOW_1,
      }),
    );
    expect(mismatch.code).toBe('unauthorized');
    expect(mismatch.details[0]?.code).toBe('project-scope-violation');
  });

  it('updates an active project and appends the projectUpdated event', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const updated = expectOk(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Riverside Tower II' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    expect(updated.name).toBe('Riverside Tower II');
    expect(updated.version).toBe(2);
    expect(updated.status).toBe('active');
    expect(updated.updatedAt).toBe(NOW_2);
    expect(updated.scope).toStrictEqual(created.scope);

    expect(service.sink.events).toHaveLength(2);
    const event = service.sink.events[1];
    if (event === undefined) throw new Error('expected the updated event');
    expect(event.eventName).toBe('projects.projectUpdated');
    expect(event.scope).toStrictEqual(created.scope);
    expect(event.entityRefs).toStrictEqual({
      before: { entityKind: 'project', entityId: created.entityId },
      after: { entityKind: 'project', entityId: created.entityId },
    });
    expect(event.payload).toStrictEqual({
      projectId: created.entityId,
      name: 'Riverside Tower II',
      version: 2,
      updatedAt: NOW_2,
    });

    // Persisted state matches the returned state.
    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Riverside Tower II');
    expect(reloaded.version).toBe(2);
  });

  it('archives an active project: explicit lifecycle event, never a delete', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const archived = expectOk(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(NOW_2);
    expect(archived.version).toBe(2);
    expect(archived.updatedAt).toBe(NOW_2);

    expect(service.sink.events).toHaveLength(2);
    const event = service.sink.events[1];
    if (event === undefined) throw new Error('expected the archived event');
    expect(event.eventName).toBe('projects.projectArchived');
    expect(event.payload).toStrictEqual({
      projectId: created.entityId,
      status: 'archived',
      archivedAt: NOW_2,
      version: 2,
      updatedAt: NOW_2,
    });

    // The row still exists — archive is not a delete.
    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('archived');
  });

  it('rejects updating an archived project (immutable lifecycle), state and events unchanged', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expectOk(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    const failure = expectFailure(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 2, name: 'Late rename' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('project-update-requires-active');

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.version).toBe(2);
    expect(reloaded.status).toBe('archived');
    expect(service.sink.events).toHaveLength(eventsBefore);
  });

  it('rejects archiving an already archived project (one-way lifecycle)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expectOk(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const failure = expectFailure(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 2 },
          'projects.archiveProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('project-archive-requires-active');
  });

  it('lets a project-scoped command act on its own project, and a tenant-scoped command on any project of its tenant', async () => {
    const service = makeService(pool);
    // Tenant scope creates the project (fresh id from the shared supplier).
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Dual Boundary' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    // A project-scoped command of EXACTLY this project may update it.
    const ownScope: Scope = {
      kind: 'project',
      tenantId: TENANT_A,
      projectId: created.entityId,
    };
    const updated = expectOk(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Dual Boundary II' },
          'projects.updateProject',
          ownScope,
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(updated.name).toBe('Dual Boundary II');
    expect(updated.scope).toStrictEqual(ownScope);

    // A tenant-scoped command may archive it (tenant covers its projects).
    const archived = expectOk(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 2 },
          'projects.archiveProject',
          scopeTenantA,
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(archived.status).toBe('archived');
    expect(service.sink.events).toHaveLength(3);
  });
});

// ----- 3. authorization denials ---------------------------------------------------

describe('authorization — typed denials (acceptance)', () => {
  it('denies create/update/archive without the required capability (default deny → forbidden)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    const noCapability = { policy: denyAll, capabilities: [] as const };
    const createFailure = expectFailure(
      await service.commands.createProject(
        makeCommand({ name: 'Denied Tower' }, 'projects.createProject'),
        noCapability,
      ),
    );
    expect(createFailure.code).toBe('forbidden');
    expect(createFailure.details[0]?.code).toBe('no-allow-rule');
    expect(createFailure.scope).toStrictEqual(scopeTenantA);

    const updateFailure = expectFailure(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Nope' },
          'projects.updateProject',
        ),
        noCapability,
      ),
    );
    expect(updateFailure.code).toBe('forbidden');
    expect(updateFailure.details[0]?.code).toBe('no-allow-rule');

    const archiveFailure = expectFailure(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        noCapability,
      ),
    );
    expect(archiveFailure.code).toBe('forbidden');
    expect(archiveFailure.details[0]?.code).toBe('no-allow-rule');

    // Nothing changed: no new rows, no new events, state untouched.
    expect(service.sink.events).toHaveLength(eventsBefore);
    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.version).toBe(1);
    expect(reloaded.name).toBe('Riverside Tower');
  });

  it('denies through an explicit deny rule even when the capability is granted (forbidden)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const failure = expectFailure(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        { policy: explicitDeny, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('explicit-deny');

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('active');
    expect(service.sink.events).toHaveLength(1);
  });

  it('denies cross-tenant attempts with typed not-found (A12 invisibility — no existence oracle)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Tenant A Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    // A tenant B command addressing tenant A's project: the row is simply
    // not visible in tenant B's scope (freeze A12) — typed not-found, never
    // the foreign row, never a cross-tenant leak. Authorization passes (the
    // resource is addressed within the COMMAND's tenant); the tenant-scoped
    // repository makes the row invisible.
    const updateFailure = expectFailure(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Hostile Takeover' },
          'projects.updateProject',
          scopeTenantB,
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(updateFailure.code).toBe('not-found');
    expect(updateFailure.details[0]?.code).toBe('entity-not-found');
    expect(updateFailure.scope).toStrictEqual(scopeTenantB);

    const archiveFailure = expectFailure(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
          scopeTenantB,
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(archiveFailure.code).toBe('not-found');

    // State and event stream untouched.
    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Tenant A Tower');
    expect(reloaded.version).toBe(1);
    expect(service.sink.events).toHaveLength(1);
  });

  it('denies a project-scoped command addressing ANOTHER project (second boundary → typed unauthorized, before any transaction)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Boundary Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    // A project-scoped command of a DIFFERENT project addressing this
    // project: the structural A12 check in authorize() denies it BEFORE any
    // transaction opens (and before any SQL runs) — typed unauthorized,
    // project-scope-violation.
    const failure = expectFailure(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Crossing The Boundary' },
          'projects.updateProject',
          scopeProjectA1,
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('unauthorized');
    expect(failure.details[0]?.code).toBe('project-scope-violation');
    // The denial carries the REQUEST scope (never the foreign resource's).
    expect(failure.scope).toStrictEqual(scopeProjectA1);

    // State and event stream untouched.
    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Boundary Tower');
    expect(reloaded.version).toBe(1);
    expect(service.sink.events).toHaveLength(1);

    // The repository enforces the same boundary directly: a project-scoped
    // read of another project is a typed unauthorized, never the row.
    const readFailure = expectFailure(
      await createProjectsDomainRepository().findById(pool, scopeProjectA1, created.entityId),
    );
    expect(readFailure.code).toBe('unauthorized');
    expect(readFailure.details[0]?.code).toBe('project-scope-violation');
  });

  it('rejects creating a project for an unknown tenant (typed not-found)', async () => {
    const service = makeService(pool);
    const failure = expectFailure(
      await service.commands.createProject(
        makeCommand({ name: 'Ghost Tower' }, 'projects.createProject', scopeTenantUnknown),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('not-found');
    expect(failure.details[0]?.code).toBe('tenant-not-found');
    expect(service.sink.events).toHaveLength(0);
  });

  it('rejects a duplicate canonical id (typed invariant-violation, not a silent overwrite)', async () => {
    // Two services with the SAME deterministic id sequence: the second
    // create hits the same canonical id.
    const first = makeService(pool, undefined, opaqueIdsFrom(0x1000));
    const created = expectOk(
      await first.commands.createProject(
        makeCommand({ name: 'First' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const second = makeService(pool, undefined, opaqueIdsFrom(0x1000));
    const failure = expectFailure(
      await second.commands.createProject(
        makeCommand({ name: 'Second' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('project-id-already-exists');
    expect(second.sink.events).toHaveLength(0);

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('First');
    expect(reloaded.version).toBe(1);
  });
});

// ----- 4. optimistic concurrency --------------------------------------------------

describe('optimistic concurrency — stale versions never silently overwrite (acceptance)', () => {
  it('update with a stale version is a typed concurrency-conflict; state unchanged', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expectOk(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Riverside Tower II' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    // The stale caller still presents version 1.
    const failure = expectFailure(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Stale Write' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('concurrency-conflict');
    expect(failure.details[0]?.code).toBe('stale-aggregate-version');

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Riverside Tower II');
    expect(reloaded.version).toBe(2);
    expect(service.sink.events).toHaveLength(eventsBefore);
  });

  it('archive with a stale version is a typed concurrency-conflict; state unchanged', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expectOk(
      await service.commands.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Riverside Tower II' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const failure = expectFailure(
      await service.commands.archiveProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1 },
          'projects.archiveProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('concurrency-conflict');

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('active');
    expect(reloaded.version).toBe(2);
  });
});

// ----- 5. atomicity ----------------------------------------------------------------

describe('atomicity — repository write + event append commit or vanish together (acceptance)', () => {
  it('rolls the create back when the event sink fails (no row, no event)', async () => {
    const commands = createProjectCommands({
      repository: createProjectsDomainRepository(),
      eventSink: {
        appendEvents: async () => {
          return {
            ok: false as const,
            error: {
              kind: 'domain-error' as const,
              code: 'invariant-violation' as const,
              message: 'event sink rejected the append: ledger unavailable',
              scope: null,
              correlationId: null,
              details: [{ code: 'event-sink-rejected', message: 'ledger unavailable', path: null }],
            },
          };
        },
      },
      transactionRunner: { runInTransaction: (work) => pool.runInTransaction(work) },
      now: () => NOW_1,
      newOpaqueId: sharedOpaqueIds,
    });

    const failure = expectFailure(
      await commands.createProject(
        makeCommand({ name: 'RollbackCo' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('event-sink-rejected');

    // The insert was rolled back with the append failure.
    const listing = expectOk(await createProjectsDomainRepository().list(pool, scopeTenantA));
    expect(listing.filter((project) => project.name === 'RollbackCo')).toStrictEqual([]);
  });

  it('rolls the update back when the event sink fails (state unchanged, no event)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Riverside Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const failing = createProjectCommands({
      repository: createProjectsDomainRepository(),
      eventSink: {
        appendEvents: async () => ({
          ok: false as const,
          error: {
            kind: 'domain-error' as const,
            code: 'invariant-violation' as const,
            message: 'event sink rejected the append: ledger unavailable',
            scope: null,
            correlationId: null,
            details: [{ code: 'event-sink-rejected', message: 'ledger unavailable', path: null }],
          },
        }),
      },
      transactionRunner: { runInTransaction: (work) => pool.runInTransaction(work) },
      now: () => NOW_3,
      newOpaqueId: sharedOpaqueIds,
    });

    const failure = expectFailure(
      await failing.updateProject(
        makeCommand(
          { projectId: created.entityId, expectedVersion: 1, name: 'Vanished' },
          'projects.updateProject',
        ),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.details[0]?.code).toBe('event-sink-rejected');

    const reloaded = expectOk(
      await createProjectsDomainRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Riverside Tower');
    expect(reloaded.version).toBe(1);
    expect(reloaded.updatedAt).toBe(NOW_1);
    expect(service.sink.events).toHaveLength(1);
  });
});

// ----- 6. deterministic ids ---------------------------------------------------------

describe('deterministic canonical ids (acceptance)', () => {
  it('the same injected supplier sequence reproduces the same canonical ids', async () => {
    // The canonical project id is the table's GLOBAL primary key, so a
    // second create that composes the identical id cannot insert again: it
    // fails with the typed duplicate-id error whose detail names EXACTLY the
    // id the first service issued. Different tenants, different payloads —
    // the identical injected opaque sequence composes the identical id.
    const first = makeService(pool, undefined, opaqueIdsFrom(0x2000));
    const createdA = expectOk(
      await first.commands.createProject(
        makeCommand({ name: 'A' }, 'projects.createProject', scopeTenantA),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(createdA.entityId).toBe(formatProjectId({ version: 'v1', opaque: '0000000000002001' }));

    const second = makeService(pool, undefined, opaqueIdsFrom(0x2000));
    const failure = expectFailure(
      await second.commands.createProject(
        makeCommand({ name: 'B' }, 'projects.createProject', scopeTenantB),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('project-id-already-exists');
    // The duplicate detail names EXACTLY the id the first service issued:
    // different tenants, different payloads, identical injected sequence
    // → identical composed canonical id.
    expect(failure.details[0]?.message).toBe(createdA.entityId);
    expect(second.sink.events).toHaveLength(0);
  });

  it('issued ids parse with the contracts parser', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Parsable Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const parsed = parseProjectId(created.entityId);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(created.entityId);
    }
  });
});

// ----- 7. tenant/project isolation --------------------------------------------------

describe('tenant/project isolation — the projects table is scoped by construction (A12)', () => {
  it('lists only the executing tenant projects', async () => {
    const tenantAService = makeService(pool);
    const tenantBService = makeService(pool);
    expectOk(
      await tenantAService.commands.createProject(
        makeCommand({ name: 'A Tower' }, 'projects.createProject', scopeTenantA),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    expectOk(
      await tenantBService.commands.createProject(
        makeCommand({ name: 'B Tower' }, 'projects.createProject', scopeTenantB),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const repository = createProjectsDomainRepository();
    const inA = expectOk(await repository.list(pool, scopeTenantA));
    const inB = expectOk(await repository.list(pool, scopeTenantB));
    expect(inA.map((project) => project.name)).not.toContain('B Tower');
    expect(inB.map((project) => project.name)).not.toContain('A Tower');
    expect(inA.some((project) => project.name === 'A Tower')).toBe(true);
    expect(inB.some((project) => project.name === 'B Tower')).toBe(true);
  });

  it('binds row ownership from the executing scope, never from caller input', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'OwnedCo Tower' }, 'projects.createProject', scopeTenantB),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    // The row is owned by tenant B (the executing scope of the command).
    const repository = createProjectsDomainRepository();
    const inB = expectOk(await repository.findById(pool, scopeTenantB, created.entityId));
    expect(inB.scope).toStrictEqual({
      kind: 'project',
      tenantId: TENANT_B,
      projectId: created.entityId,
    });
    expect(inB.name).toBe('OwnedCo Tower');
    const notInA = expectFailure(
      await repository.findById(pool, scopeTenantA, created.entityId),
    );
    expect(notInA.code).toBe('not-found');
  });

  it('a project-scoped list sees exactly its own project (the second boundary at row level)', async () => {
    const service = makeService(pool);
    const first = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'First Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );
    const second = expectOk(
      await service.commands.createProject(
        makeCommand({ name: 'Second Tower' }, 'projects.createProject'),
        { policy: allowProjectWrite, capabilities: ['projects.write'] },
      ),
    );

    const repository = createProjectsDomainRepository();
    const scopedToFirst = expectOk(
      await repository.list(pool, {
        kind: 'project',
        tenantId: TENANT_A,
        projectId: first.entityId,
      }),
    );
    expect(scopedToFirst.map((project) => project.entityId)).toStrictEqual([first.entityId]);
    expect(scopedToFirst.some((project) => project.entityId === second.entityId)).toBe(false);

    // The tenant-scoped list of the same tenant sees both.
    const tenantWide = expectOk(await repository.list(pool, scopeTenantA));
    expect(tenantWide.some((project) => project.entityId === first.entityId)).toBe(true);
    expect(tenantWide.some((project) => project.entityId === second.entityId)).toBe(true);
  });
});
