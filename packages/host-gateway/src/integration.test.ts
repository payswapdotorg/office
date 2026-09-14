// Office host gateway — the production composition's integration suite
// (OFF-DEPLOY).
//
// THE hosted composition over a REAL PostgreSQL database (the landed
// persistence test harness: DATABASE_URL unset → the embedded local cluster;
// CI mode unchanged). The acceptance chain, in order:
//
//   1. migrate(): the ordered union of EVERY landed migration directory
//      applies 0001..0004 + 0100 + 0101 from an empty scratch database, and
//      re-running is an idempotent verify-only no-op;
//   2. health(): reachable + applied count + latest name + the injected
//      release identity;
//   3. the canonical PG path: tenant → organization → project seeded through
//      the REAL command paths (the landed lifecycle command services over the
//      gateway-composed envelopes), read back scoped;
//   4. one canonical PG command with optimistic concurrency (project update:
//      the stale version is a typed concurrency-conflict, never an overwrite);
//   5. the command's audit events are in the REAL ledger and its outbox rows
//      are pending (appendEvent + enqueueOutbox inside the command's own
//      transaction — observed through the landed scoped readers);
//   6. the evidence walkers navigate the composed world's ledger stream;
//   7. A12 both directions through the gateway's read surface (a foreign
//      tenant's session → typed not-found; a same-tenant foreign-project
//      session → typed unauthorized — no existence oracle);
//   8. run-twice determinism: the same injected suppliers compose the
//      byte-identical seeded reference world.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPersistenceTestHarness } from '@office/persistence';
import type { PersistencePool, PersistenceTestHarness } from '@office/persistence';
import { fetchPendingOutbox, readAggregateEvents } from '@office/events';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseEntityId,
  parseEntityRef,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import {
  HOST_ACTOR_ID,
  HOST_PROJECT_ID,
  HOST_TENANT_ID,
  createHostRuntime,
} from './index';
import type { HostRuntime } from './index';

// ---- deterministic suppliers (the kernel rule: injected, sequential) ------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 14, 10, 0, 0);
const NOW_1 = new Date(BASE_EPOCH_MS).toISOString() as Timestamp;

const sequentialClock = (): (() => Timestamp) => {
  let at = BASE_EPOCH_MS;
  return () => {
    at += 1000;
    return new Date(at).toISOString() as Timestamp;
  };
};

const sequentialOpaqueIds = (): (() => string) => {
  let issued = 0;
  return () => String((issued += 1)).padStart(16, '0');
};

const unwrap = <T, E>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`unexpected failure (${what}): ${JSON.stringify(result.error)}`);
};

/** The fixed dispatch-drain instant (after every composed command's tick). */
const NOW_DRAIN = unwrap(parseTimestamp('2026-09-14T12:00:00.000Z'), 'drain instant');

// ---- the probe identities (generic vocabulary, canonical grammars) -------

const TENANT_B = formatTenantId({ version: 'v1', opaque: 'b1b2c3d4e5f60718293a4b5c6d7e8f9a' });
const PROJECT_OTHER = formatProjectId({ version: 'v1', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' });
const FOREIGN_ACTOR = formatEntityId({ version: 'v1', opaque: 'd4e5f60718293a4b5c6d7e8f9a1b2c3' });

// ---- harness boot ---------------------------------------------------------

let harness: PersistenceTestHarness;
let runtime: HostRuntime;
let pool: PersistencePool;

beforeAll(async () => {
  harness = await startPersistenceTestHarness();
  pool = harness.pool;
  runtime = await createHostRuntime({
    connectionString: harness.connectionString,
    now: sequentialClock(),
    newOpaqueId: sequentialOpaqueIds(),
    releaseId: 'test-release-0001',
  });
}, 180_000);

afterAll(async () => {
  await runtime.end();
  await harness.stop();
}, 120_000);

// ---- 1. migrations ----------------------------------------------------------

describe('migrations — the ordered union of every landed directory (acceptance)', () => {
  it('applies all six migrations in strict version order from the empty database', async () => {
    const run = unwrap(await runtime.migrate(), 'first migration run');
    expect(run.applied.map((file) => file.version)).toStrictEqual([1, 2, 3, 4, 100, 101]);
    expect(run.applied.map((file) => file.name)).toStrictEqual([
      'tenants',
      'projects',
      'event_ledger',
      'outbox',
      'organizations',
      'projects_lifecycle',
    ]);
    expect(run.verified).toStrictEqual([]);
  });

  it('re-runs as an idempotent verify-only no-op (forward-only, never edit applied files)', async () => {
    const rerun = unwrap(await runtime.migrate(), 'second migration run');
    expect(rerun.applied).toStrictEqual([]);
    expect(rerun.verified.map((file) => file.version)).toStrictEqual([1, 2, 3, 4, 100, 101]);
  });
});

// ---- 2. health ----------------------------------------------------------------

describe('health — the readiness report (pool + migration state + release)', () => {
  it('reports reachable, the applied count, the latest name, and the release identity', async () => {
    const report = await runtime.health();
    expect(report.kind).toBe('host-health');
    expect(report.database).toBe('reachable');
    expect(report.migrations.appliedCount).toBe(6);
    expect(report.migrations.latestName).toBe('projects_lifecycle');
    expect(report.release).toBe('test-release-0001');
  });
});

// ---- 3./4./5. the canonical PG path --------------------------------------------

describe('the canonical PG path — REAL commands, REAL ledger, REAL outbox (acceptance)', () => {
  it('seeds tenant → organization → project through the REAL command paths and reads them back scoped', async () => {
    const tenant = unwrap(
      await runtime.canonical.tenants.insert(pool, {
        tenantId: unwrap(parseTenantId(HOST_TENANT_ID), 'tenant id'),
        displayName: 'Hosted Operator Tenant',
        now: NOW_1,
      }),
      'tenant insert',
    );
    expect(tenant.tenantId).toBe(HOST_TENANT_ID);

    const organizationEnvelope = unwrap(
      runtime.canonical.composeCommand(
        { tenantId: HOST_TENANT_ID, actorId: HOST_ACTOR_ID, idempotencyKey: 'host-org-0001' },
        'organization.createOrganization',
        { name: 'Hosted Operator Organization' },
      ),
      'organization envelope',
    );
    const organization = unwrap(
      await runtime.canonical.services.organizations.createOrganization(
        organizationEnvelope,
        runtime.canonical.authorization,
      ),
      'organization create',
    );
    expect(organization.name).toBe('Hosted Operator Organization');
    expect(organization.status).toBe('active');
    expect(organization.version).toBe(1);

    const projectEnvelope = unwrap(
      runtime.canonical.composeCommand(
        {
          tenantId: HOST_TENANT_ID,
          projectId: HOST_PROJECT_ID,
          actorId: HOST_ACTOR_ID,
          idempotencyKey: 'host-prj-0001',
        },
        'projects.createProject',
        { name: 'Hosted Campus Works' },
      ),
      'project envelope',
    );
    const project = unwrap(
      await runtime.canonical.services.projects.createProject(
        projectEnvelope,
        runtime.canonical.authorization,
      ),
      'project create',
    );
    expect(project.entityId).toBe(HOST_PROJECT_ID);
    expect(project.name).toBe('Hosted Campus Works');
    expect(project.status).toBe('active');

    // The REAL scoped read: the hosted session's own project, by id.
    const read = unwrap(
      await runtime.canonical.projects.findById(pool, runtime.session.scope, project.entityId),
      'scoped project read',
    );
    expect(read.name).toBe('Hosted Campus Works');
  });

  it('executes one canonical project update with optimistic concurrency (stale = typed conflict)', async () => {
    const updated = unwrap(
      await runtime.canonical.updateProject({
        projectId: HOST_PROJECT_ID,
        expectedVersion: 1,
        name: 'Hosted Campus Works Phase 2',
      }),
      'project update',
    );
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('Hosted Campus Works Phase 2');

    const stale = await runtime.canonical.updateProject({
      projectId: HOST_PROJECT_ID,
      expectedVersion: 1,
      name: 'Stale Overwrite Attempt',
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('concurrency-conflict');
  });

  it('observes the command audit events in the REAL ledger with pending outbox rows', async () => {
    const aggregate = unwrap(
      parseEntityRef({ entityKind: 'project', entityId: HOST_PROJECT_ID }),
      'aggregate ref',
    );
    const events = unwrap(
      await readAggregateEvents(pool, runtime.session.scope, aggregate),
      'aggregate events',
    );
    expect(events.map((event) => event.envelope.eventName)).toStrictEqual([
      'projects.projectCreated',
      'projects.projectUpdated',
    ]);
    expect(events.map((event) => event.sequence)).toStrictEqual([1, 2]);

    const outbox = unwrap(
      // A fixed dispatch-drain instant after every composed command (the
      // outbox rows become available at their event's occurredAt — the
      // runtime's sequential clock is past every command by this instant).
      await fetchPendingOutbox(pool, runtime.session.scope, {
        now: NOW_DRAIN,
        limit: 50,
      }),
      'pending outbox',
    );
    expect(outbox.length).toBeGreaterThanOrEqual(2);
    const eventIds = new Set(events.map((event) => event.eventId));
    const ofThisAggregate = outbox.filter((entry) => eventIds.has(entry.event.eventId));
    expect(ofThisAggregate.length).toBe(2);
    for (const entry of ofThisAggregate) {
      expect(entry.record.state).toBe('pending');
      expect(entry.record.attempts).toBe(0);
    }
  });
});

// ---- 6. the evidence walkers ----------------------------------------------------

describe('the evidence walkers over the composed world (the semantic reference)', () => {
  it('navigates the overview, one aggregate stream, and one causality chain', () => {
    const overview = runtime.reads.evidenceOverview();
    expect(overview.kind).toBe('evidence-overview');
    expect(overview.eventCount).toBe(runtime.world.ledgerEvents.length);
    expect(overview.aggregateCount).toBeGreaterThan(5);

    const organizationId = runtime.world.identities.organizationId;
    const aggregate = unwrap(
      runtime.reads.aggregateHistory(undefined, 'organization', organizationId),
      'organization history',
    );
    expect(aggregate.events.length).toBeGreaterThan(0);

    const lastEvent = runtime.world.ledgerEvents[runtime.world.ledgerEvents.length - 1];
    expect(lastEvent).toBeDefined();
    if (lastEvent !== undefined) {
      const chain = unwrap(
        runtime.reads.causalityChain(undefined, lastEvent.eventId),
        'causality chain',
      );
      expect(chain.depth).toBeGreaterThan(0);
      expect(chain.entries[0]?.kind).toBe('event');
    }
  });
});

// ---- 7. A12 both directions -------------------------------------------------------

describe('A12 — cross-scope reads are typed rejections, never existence oracles', () => {
  it('typed not-found for a foreign tenant AND a foreign project; typed unauthorized for an existing cross-project aggregate', async () => {
    const foreignTenant = unwrap(
      runtime.openSession({ tenantId: TENANT_B, projectId: HOST_PROJECT_ID, actorId: FOREIGN_ACTOR }),
      'foreign tenant session',
    );
    const foreignWorkspace = await runtime.reads.workspace(foreignTenant);
    expect(foreignWorkspace.ok).toBe(false);
    if (!foreignWorkspace.ok) expect(foreignWorkspace.error.code).toBe('not-found');

    // Over the one-project seeded world a foreign project is ABSENT — the
    // workspace read is the SAME typed not-found the landed shell's own A12
    // suite asserts for both directions (no existence oracle: absent and
    // foreign are indistinguishable on reads).
    const foreignProject = unwrap(
      runtime.openSession({
        tenantId: HOST_TENANT_ID,
        projectId: PROJECT_OTHER,
        actorId: HOST_ACTOR_ID,
      }),
      'foreign project session',
    );
    const otherWorkspace = await runtime.reads.workspace(foreignProject);
    expect(otherWorkspace.ok).toBe(false);
    if (!otherWorkspace.ok) expect(otherWorkspace.error.code).toBe('not-found');

    // The write direction: an EXISTING same-tenant cross-project aggregate
    // (the hosted project's seeded workflow instance) resolves through the
    // composed world's scoped store as a typed unauthorized — the A12
    // discipline the gateway's approval-completion path flows (proven end to
    // end in the actions suite's wrong-scope deny case). The hosted session's
    // own scoped read of the same instance loads cleanly.
    const instance = unwrap(
      runtime.world.stores.workflows.findInstance(
        runtime.session.scope,
        unwrap(parseEntityId(runtime.world.identities.workflowInstanceId), 'instance id'),
      ),
      'hosted scoped instance read',
    );
    expect(instance.scope.kind).toBe('project');
    const crossProject = runtime.world.stores.workflows.findInstance(
      foreignProject.scope,
      unwrap(parseEntityId(runtime.world.identities.workflowInstanceId), 'instance id'),
    );
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) expect(crossProject.error.code).toBe('unauthorized');

    // The hosted session itself loads cleanly (the control surface).
    const hosted = unwrap(await runtime.reads.workspace(), 'hosted workspace');
    expect(hosted.kind).toBe('project-workspace');
    expect(hosted.header.projectName).toBe('Reference Campus Works');
  });

  it('typed-rejects malformed session identities (displayable, never a throw)', () => {
    const malformed = runtime.openSession({ tenantId: 'nope', projectId: HOST_PROJECT_ID, actorId: HOST_ACTOR_ID });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('invalid-tenant-id');
  });
});

// ---- 8. run-twice determinism ------------------------------------------------------

describe('determinism — the same injected suppliers compose the identical world', () => {
  it('re-composes the byte-identical seeded reference world', async () => {
    const second = await createHostRuntime({
      connectionString: harness.connectionString,
      now: sequentialClock(),
      newOpaqueId: sequentialOpaqueIds(),
      releaseId: 'test-release-0002',
    });
    try {
      expect(JSON.stringify(second.world.ledgerEvents)).toStrictEqual(
        JSON.stringify(runtime.world.ledgerEvents),
      );
      expect(JSON.stringify(second.world.identities)).toStrictEqual(
        JSON.stringify(runtime.world.identities),
      );
      expect(second.reads.evidenceOverview()).toStrictEqual(runtime.reads.evidenceOverview());
    } finally {
      await second.end();
    }
  });
});
