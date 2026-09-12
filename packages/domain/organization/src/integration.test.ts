import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseCommandEnvelope,
  parseEntityId,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { CommandEnvelope, ParseResult, Scope, Timestamp } from '@office/contracts';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  createMigrator,
  createTenantsRepository,
  readMigrationFiles,
  startPersistenceTestHarness,
} from '@office/persistence';
import type { PersistencePool, PersistenceTestHarness, Transaction } from '@office/persistence';
import { ORGANIZATION_MIGRATIONS_DIR } from './migrations';
import { createInMemoryEventSink } from './events';
import type { EventSink, InMemoryEventSink } from './events';
import { createOrganizationsRepository } from './repository';
import { createOrganizationCommands } from './commands';
import type { OrganizationCommandDeps, OrganizationCommands } from './commands';
import type { MigrationFile } from '@office/persistence';
import type { DomainError, Result } from '@office/domain-kernel';

// OFF-007 organization domain — integration acceptance suite on the real
// PostgreSQL harness (DATABASE_URL CI mode / embedded-postgres local mode).
//
// The migration chain for this package composes the persistence foundation
// (0001, 0002) with this package's own migration (0100_organizations) — the
// same composition convention OFF-005 established. Everything is
// deterministic: fixed canonical ids, fixed injected timestamps, sequential
// id suppliers. No wall clock, no randomness.
//
// Acceptance suites, in order:
//   1. migrations — the composed chain applies from an empty database and
//      the organizations table carries the frozen column shapes (A2/A12);
//   2. lifecycle — create/update/archive with authorization, every mutation
//      appending its audit event through the EventSink (A3);
//   3. authorization — capability denials are typed forbidden; cross-tenant
//      attempts are typed not-found (A12 invisibility — no existence
//      oracle);
//   4. optimistic concurrency — stale versions are typed
//      concurrency-conflicts, state never silently overwritten;
//   5. atomicity — repository write + event append commit or vanish
//      together (a failing sink rolls the mutation back);
//   6. deterministic ids — same injected supplier sequence reproduces the
//      same canonical ids, and they parse with the contracts parser;
//   7. tenant isolation — listings and ownership are scoped by construction.

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
const PROJECT_A1 = unwrap(parseProjectId('office-prj-v1-4f9d2c81a7e34b5d90c1f2e3a4b5c6d7'));

const USER_ACTOR = { kind: 'user', actorId: unwrap(parseEntityId('office-ent-v1-b2c3d4e5f60718293a4b5c6d7e8f9a1')) } as const;

const scopeTenantA: Scope = { kind: 'tenant', tenantId: TENANT_A };
const scopeTenantB: Scope = { kind: 'tenant', tenantId: TENANT_B };
const scopeTenantUnknown: Scope = { kind: 'tenant', tenantId: TENANT_UNKNOWN };
const scopeProjectA1: Scope = { kind: 'project', tenantId: TENANT_A, projectId: PROJECT_A1 };

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
      idempotencyKey: `idem-org-${String((commandCounter += 1)).padStart(4, '0')}`,
      causality: { correlationId: 'corr-org-0001', causationId: null },
      issuedAt: '2026-09-12T10:15:30.000Z',
      schemaVersion: '1.0.0',
      payload,
    }),
  );

/** The allow-everything-with-capability policy used by the happy paths. */
const allowOrganizationWrite: Policy = definePolicy([
  { effect: 'allow', capabilities: ['organization.write'], actions: ['write'], resourceKinds: ['organization'] },
]);
const denyAll: Policy = definePolicy([]);
const explicitDeny: Policy = definePolicy([
  { effect: 'deny', capabilities: ['organization.write'], actions: ['write'] },
  { effect: 'allow', capabilities: ['organization.write'], actions: ['write'] },
]);

interface Service {
  readonly commands: OrganizationCommands;
  readonly sink: InMemoryEventSink;
  readonly pool: PersistencePool;
}

/**
 * The default opaque-id supplier shared by every service in this file: the
 * canonical organization id is the table's GLOBAL primary key, so each
 * created aggregate needs a distinct opaque part. Tests that deliberately
 * collide ids (duplicate-id / determinism suites) construct their own equal
 * suppliers explicitly.
 */
const sharedOpaqueIds = sequentialOpaqueIds();

const makeService = (
  pool: PersistencePool,
  sink: EventSink = createInMemoryEventSink(),
  newOpaqueId: () => string = sharedOpaqueIds,
): Service => {
  const deps: OrganizationCommandDeps = {
    repository: createOrganizationsRepository(),
    eventSink: sink,
    transactionRunner: { runInTransaction: (work) => pool.runInTransaction(work) },
    now: sequentialClock(),
    newOpaqueId,
  };
  return { commands: createOrganizationCommands(deps), sink: sink as InMemoryEventSink, pool };
};

// ----- harness boot + composed migration + shared seed ---------------------------

let harness: PersistenceTestHarness;
let pool: PersistencePool;
let migrationRun: { applied: readonly MigrationFile[]; verified: readonly MigrationFile[] };

const fixtureDirs: string[] = [];

/** Compose the canonical migration chain (persistence + organization) into one temp dir. */
const composedMigrationsDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'office-organization-migrations-'));
  const files = [
    ...(await readMigrationFiles(harness.migrationsDir)),
    ...(await readMigrationFiles(ORGANIZATION_MIGRATIONS_DIR)),
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
  // applies 0001, 0002 (persistence) + 0100 (organization) in one run.
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
  it('applies the persistence + organization chain in version order', () => {
    expect(migrationRun.applied.map((file) => file.version)).toStrictEqual([1, 2, 100]);
    expect(migrationRun.applied.map((file) => file.name)).toStrictEqual([
      'tenants',
      'projects',
      'organizations',
    ]);
    expect(migrationRun.verified).toStrictEqual([]);
  });

  it('creates the organizations table with typed columns and tenant ownership (A2/A12)', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
       ORDER BY ordinal_position`,
    );
    expect(
      result.rows.map((row) => [row['column_name'], row['data_type'], row['is_nullable']]),
    ).toStrictEqual([
      ['tenant_id', 'text', 'NO'],
      ['organization_id', 'text', 'NO'],
      ['name', 'text', 'NO'],
      ['status', 'text', 'NO'],
      ['archived_at', 'timestamp with time zone', 'YES'],
      ['version', 'bigint', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
      ['extension_metadata', 'jsonb', 'NO'],
    ]);
  });

  it('enforces the lifecycle consistency CHECK at the row level', async () => {
    // active + archived_at set violates the row-level lifecycle CHECK.
    await expect(
      pool.query(
        `INSERT INTO organizations (tenant_id, organization_id, name, status, archived_at, version, created_at, updated_at, extension_metadata)
         VALUES ($1, $2, $3, 'active', $4, 1, $4, $4, '{}'::jsonb)`,
        [TENANT_A, 'office-ent-v1-9999aaaa9999aaaa9999aaaa9999aaaa', 'Bad Row', new Date(NOW_1)],
      ),
    ).rejects.toThrow(/organizations_lifecycle_consistency/);
  });
});

// ----- 2. lifecycle with authorization + audit events ----------------------------

describe('lifecycle — create/update/archive with authorization and audit events (acceptance)', () => {
  it('creates an organization and appends the organizationCreated audit event (A3)', async () => {
    const service = makeService(pool);
    const command = makeCommand({ name: 'BuildCo', extensionMetadata: { tier: 'enterprise' } }, 'organization.createOrganization');
    const created = expectOk(await service.commands.createOrganization(command, { policy: allowOrganizationWrite, capabilities: ['organization.write'] }));

    expect(created.entityKind).toBe('organization');
    expect(created.name).toBe('BuildCo');
    expect(created.status).toBe('active');
    expect(created.archivedAt).toBeNull();
    expect(created.version).toBe(1);
    expect(created.scope).toStrictEqual(scopeTenantA);
    expect(created.extensionMetadata).toStrictEqual({ tier: 'enterprise' });
    expect(created.createdAt).toBe(NOW_1);
    expect(created.updatedAt).toBe(NOW_1);

    // The audit event: envelope carried through the EventSink.
    expect(service.sink.events).toHaveLength(1);
    const event = service.sink.events[0];
    if (event === undefined) throw new Error('expected the created event');
    expect(event.kind).toBe('event');
    expect(event.eventName).toBe('organization.organizationCreated');
    expect(event.scope).toStrictEqual(scopeTenantA);
    expect(event.actor).toStrictEqual(USER_ACTOR);
    expect(event.source).toBe('domain');
    expect(event.causality.correlationId).toBe('corr-org-0001');
    expect(event.causality.causationId).toBe(command.idempotencyKey);
    expect(event.occurredAt).toBe(NOW_1);
    expect(event.entityRefs).toStrictEqual({
      before: null,
      after: { entityKind: 'organization', entityId: created.entityId },
    });
    expect(event.payload).toStrictEqual({
      organizationId: created.entityId,
      name: 'BuildCo',
      status: 'active',
      version: 1,
      createdAt: NOW_1,
    });

    // The sink was handed the OPEN TRANSACTION (the mutation's executor),
    // proving the append happens inside the same transaction as the write.
    const recordedExecutor = service.sink.appends[0]?.executor as Partial<Transaction>;
    expect(typeof recordedExecutor.rollback).toBe('function');
  });

  it('updates an active organization and appends the organizationUpdated event', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const updated = expectOk(
      await service.commands.updateOrganization(
        makeCommand(
          { organizationId: created.entityId, expectedVersion: 1, name: 'BuildCo Group' },
          'organization.updateOrganization',
        ),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    expect(updated.name).toBe('BuildCo Group');
    expect(updated.version).toBe(2);
    expect(updated.status).toBe('active');
    expect(updated.updatedAt).toBe(NOW_2);

    expect(service.sink.events).toHaveLength(2);
    const event = service.sink.events[1];
    if (event === undefined) throw new Error('expected the updated event');
    expect(event.eventName).toBe('organization.organizationUpdated');
    expect(event.entityRefs).toStrictEqual({
      before: { entityKind: 'organization', entityId: created.entityId },
      after: { entityKind: 'organization', entityId: created.entityId },
    });
    expect(event.payload).toStrictEqual({
      organizationId: created.entityId,
      name: 'BuildCo Group',
      version: 2,
      updatedAt: NOW_2,
    });

    // Persisted state matches the returned state.
    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('BuildCo Group');
    expect(reloaded.version).toBe(2);
  });

  it('archives an active organization: explicit lifecycle event, never a delete', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const archived = expectOk(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(NOW_2);
    expect(archived.version).toBe(2);
    expect(archived.updatedAt).toBe(NOW_2);

    expect(service.sink.events).toHaveLength(2);
    const event = service.sink.events[1];
    if (event === undefined) throw new Error('expected the archived event');
    expect(event.eventName).toBe('organization.organizationArchived');
    expect(event.payload).toStrictEqual({
      organizationId: created.entityId,
      status: 'archived',
      archivedAt: NOW_2,
      version: 2,
      updatedAt: NOW_2,
    });

    // The row still exists — archive is not a delete.
    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('archived');
  });

  it('rejects updating an archived organization (immutable lifecycle), state and events unchanged', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expectOk(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    const failure = expectFailure(
      await service.commands.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 2, name: 'Late rename' }, 'organization.updateOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('organization-update-requires-active');

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.version).toBe(2);
    expect(reloaded.status).toBe('archived');
    expect(service.sink.events).toHaveLength(eventsBefore);
  });

  it('rejects archiving an already archived organization (one-way lifecycle)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expectOk(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const failure = expectFailure(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 2 }, 'organization.archiveOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('organization-archive-requires-active');
  });

  it('allows a project-scoped command to act on a tenant-level organization (kernel scope rule)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    // A project-scoped command of the same tenant may reference tenant-level
    // entities (checkScopeCovers documents the rule); the second boundary is
    // checked before any SQL runs.
    const updated = expectOk(
      await service.commands.updateOrganization(
        makeCommand(
          { organizationId: created.entityId, expectedVersion: 1, name: 'BuildCo Project View' },
          'organization.updateOrganization',
          scopeProjectA1,
        ),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(updated.name).toBe('BuildCo Project View');
    expect(updated.scope).toStrictEqual(scopeTenantA);
  });
});

// ----- 3. authorization denials ---------------------------------------------------

describe('authorization — typed denials (acceptance)', () => {
  it('denies create/update/archive without the required capability (default deny → forbidden)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    const noCapability = { policy: denyAll, capabilities: [] as const };
    const createFailure = expectFailure(
      await service.commands.createOrganization(
        makeCommand({ name: 'DeniedCo' }, 'organization.createOrganization'),
        noCapability,
      ),
    );
    expect(createFailure.code).toBe('forbidden');
    expect(createFailure.details[0]?.code).toBe('no-allow-rule');
    expect(createFailure.scope).toStrictEqual(scopeTenantA);

    const updateFailure = expectFailure(
      await service.commands.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1, name: 'Nope' }, 'organization.updateOrganization'),
        noCapability,
      ),
    );
    expect(updateFailure.code).toBe('forbidden');
    expect(updateFailure.details[0]?.code).toBe('no-allow-rule');

    const archiveFailure = expectFailure(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        noCapability,
      ),
    );
    expect(archiveFailure.code).toBe('forbidden');
    expect(archiveFailure.details[0]?.code).toBe('no-allow-rule');

    // Nothing changed: no new rows, no new events, state untouched.
    expect(service.sink.events).toHaveLength(eventsBefore);
    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.version).toBe(1);
    expect(reloaded.name).toBe('BuildCo');
  });

  it('denies through an explicit deny rule even when the capability is granted (forbidden)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const failure = expectFailure(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        { policy: explicitDeny, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('forbidden');
    expect(failure.details[0]?.code).toBe('explicit-deny');

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('active');
    expect(service.sink.events).toHaveLength(1);
  });

  it('denies cross-tenant attempts with typed not-found (A12 invisibility — no existence oracle)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'Tenant A Org' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    // A tenant B command addressing tenant A's organization: the row is
    // simply not visible in tenant B's scope (freeze A12) — typed not-found,
    // never the foreign row, never a cross-tenant leak.
    const updateFailure = expectFailure(
      await service.commands.updateOrganization(
        makeCommand(
          { organizationId: created.entityId, expectedVersion: 1, name: 'Hostile Takeover' },
          'organization.updateOrganization',
          scopeTenantB,
        ),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(updateFailure.code).toBe('not-found');
    expect(updateFailure.details[0]?.code).toBe('entity-not-found');
    expect(updateFailure.scope).toStrictEqual(scopeTenantB);

    const archiveFailure = expectFailure(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization', scopeTenantB),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(archiveFailure.code).toBe('not-found');

    // State and event stream untouched.
    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('Tenant A Org');
    expect(reloaded.version).toBe(1);
    expect(service.sink.events).toHaveLength(1);
  });

  it('rejects creating an organization for an unknown tenant (typed not-found)', async () => {
    const service = makeService(pool);
    const failure = expectFailure(
      await service.commands.createOrganization(
        makeCommand({ name: 'Ghost Org' }, 'organization.createOrganization', scopeTenantUnknown),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
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
      await first.commands.createOrganization(
        makeCommand({ name: 'First' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const second = makeService(pool, undefined, opaqueIdsFrom(0x1000));
    const failure = expectFailure(
      await second.commands.createOrganization(
        makeCommand({ name: 'Second' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('organization-id-already-exists');
    expect(second.sink.events).toHaveLength(0);

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
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
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expectOk(
      await service.commands.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1, name: 'BuildCo Group' }, 'organization.updateOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const eventsBefore = service.sink.events.length;

    // The stale caller still presents version 1.
    const failure = expectFailure(
      await service.commands.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1, name: 'Stale Write' }, 'organization.updateOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('concurrency-conflict');
    expect(failure.details[0]?.code).toBe('stale-aggregate-version');

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('BuildCo Group');
    expect(reloaded.version).toBe(2);
    expect(service.sink.events).toHaveLength(eventsBefore);
  });

  it('archive with a stale version is a typed concurrency-conflict; state unchanged', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expectOk(
      await service.commands.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1, name: 'BuildCo Group' }, 'organization.updateOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const failure = expectFailure(
      await service.commands.archiveOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1 }, 'organization.archiveOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('concurrency-conflict');

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.status).toBe('active');
    expect(reloaded.version).toBe(2);
  });
});

// ----- 5. atomicity ----------------------------------------------------------------

describe('atomicity — repository write + event append commit or vanish together (acceptance)', () => {
  it('rolls the create back when the event sink fails (no row, no event)', async () => {
    const commands = createOrganizationCommands({
      repository: createOrganizationsRepository(),
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
      await commands.createOrganization(
        makeCommand({ name: 'RollbackCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('event-sink-rejected');

    // The insert was rolled back with the append failure.
    const listing = expectOk(await createOrganizationsRepository().list(pool, scopeTenantA));
    expect(listing.filter((organization) => organization.name === 'RollbackCo')).toStrictEqual([]);
  });

  it('rolls the update back when the event sink fails (state unchanged, no event)', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'BuildCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const failing = createOrganizationCommands({
      repository: createOrganizationsRepository(),
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
      await failing.updateOrganization(
        makeCommand({ organizationId: created.entityId, expectedVersion: 1, name: 'Vanished' }, 'organization.updateOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.details[0]?.code).toBe('event-sink-rejected');

    const reloaded = expectOk(
      await createOrganizationsRepository().findById(pool, scopeTenantA, created.entityId),
    );
    expect(reloaded.name).toBe('BuildCo');
    expect(reloaded.version).toBe(1);
    expect(reloaded.updatedAt).toBe(NOW_1);
    expect(service.sink.events).toHaveLength(1);
  });
});

// ----- 6. deterministic ids ---------------------------------------------------------

describe('deterministic canonical ids (acceptance)', () => {
  it('the same injected supplier sequence reproduces the same canonical ids', async () => {
    // The canonical organization id is the table's GLOBAL primary key, so a
    // second create that composes the identical id cannot insert again: it
    // fails with the typed duplicate-id error whose detail names EXACTLY the
    // id the first service issued. Different tenants, different payloads —
    // the identical injected opaque sequence composes the identical id.
    const first = makeService(pool, undefined, opaqueIdsFrom(0x2000));
    const createdA = expectOk(
      await first.commands.createOrganization(
        makeCommand({ name: 'A' }, 'organization.createOrganization', scopeTenantA),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(createdA.entityId).toBe(formatEntityId({ version: 'v1', opaque: '0000000000002001' }));

    const second = makeService(pool, undefined, opaqueIdsFrom(0x2000));
    const failure = expectFailure(
      await second.commands.createOrganization(
        makeCommand({ name: 'B' }, 'organization.createOrganization', scopeTenantB),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('organization-id-already-exists');
    expect(failure.details[0]?.message).toBe(createdA.entityId);
    expect(second.sink.events).toHaveLength(0);
  });

  it('issued ids parse with the contracts parser', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'ParsableCo' }, 'organization.createOrganization'),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    const parsed = parseEntityId(created.entityId);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(created.entityId);
    }
  });
});

// ----- 7. tenant isolation -----------------------------------------------------------

describe('tenant isolation — the organizations table is tenant-scoped by construction (A12)', () => {
  it('lists only the organizations of the executing tenant', async () => {
    const tenantAService = makeService(pool);
    const tenantBService = makeService(pool);
    expectOk(
      await tenantAService.commands.createOrganization(
        makeCommand({ name: 'A Org' }, 'organization.createOrganization', scopeTenantA),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    expectOk(
      await tenantBService.commands.createOrganization(
        makeCommand({ name: 'B Org' }, 'organization.createOrganization', scopeTenantB),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );

    const repository = createOrganizationsRepository();
    const inA = expectOk(await repository.list(pool, scopeTenantA));
    const inB = expectOk(await repository.list(pool, scopeTenantB));
    expect(inA.map((organization) => organization.name)).not.toContain('B Org');
    expect(inB.map((organization) => organization.name)).not.toContain('A Org');
    expect(inA.some((organization) => organization.name === 'A Org')).toBe(true);
    expect(inB.some((organization) => organization.name === 'B Org')).toBe(true);
  });

  it('binds row ownership from the executing scope, never from caller input', async () => {
    const service = makeService(pool);
    const created = expectOk(
      await service.commands.createOrganization(
        makeCommand({ name: 'OwnedCo' }, 'organization.createOrganization', scopeTenantB),
        { policy: allowOrganizationWrite, capabilities: ['organization.write'] },
      ),
    );
    // The row is owned by tenant B (the executing scope of the command).
    const repository = createOrganizationsRepository();
    const inB = expectOk(await repository.findById(pool, scopeTenantB, created.entityId));
    expect(inB.scope).toStrictEqual(scopeTenantB);
    expect(inB.name).toBe('OwnedCo');
    const notInA = expectFailure(await repository.findById(pool, scopeTenantA, created.entityId));
    expect(notInA.code).toBe('not-found');
  });
});
