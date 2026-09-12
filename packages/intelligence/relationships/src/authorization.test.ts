import { describe, expect, it } from 'vitest';
import type { EntityId, EntityRef, Scope } from '@office/contracts';
import { parseEntityKind } from '@office/contracts';
import { checkNodeReadable } from './authorization';
import { traverseRelationships } from './traversal';
import { projectRelationships } from './projection';
import { createInMemoryEventSource } from './source';
import { SCHEDULE_KIND } from './vocabulary';
import {
  ACTIVITY_1,
  ACTIVITY_2,
  ACTIVITY_3,
  CHANGE_EVENT_ID,
  CHANGE_ORDER_ID,
  OBLIGATION_ID,
  activityRef,
  buildChangeEventChainStream,
  buildScheduleDependencyChainStream,
  changeEventRef,
  subgraphShapeOf,
} from './fixtures';
import type { GoldenSubgraph } from './fixtures';
import {
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  PROJECT_1,
  PROJECT_2,
  TENANT_B,
  T4,
  appendCommandEvent,
  projectScopeOf,
  tenantScopeOf,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  traversalAuthorizationOf,
  unwrap,
} from './test-support';

// OFF-013 traversal-time authorization — deny-by-default, enforced on EVERY
// traversed node at query time (never baked into the index): a caller whose
// context lacks the area read capability gets a typed denial (or a
// scope-filtered subgraph for non-start nodes), policy rules layer on top
// (explicit deny wins, no allow rule denies), and structural A12 isolation
// makes cross-tenant/cross-project nodes invisible in BOTH directions — the
// graph is never an existence oracle.

const TENANT_A_PROJECT_1 = projectScopeOf(PROJECT_1);
const TENANT_B_SCOPE = tenantScopeOf(TENANT_B);
const PROJECT_2_SCOPE = projectScopeOf(PROJECT_2);

// A second dependency edge in a foreign scope (same shape as the fixture
// chain, distinct deterministic ids): tenant B for the cross-tenant probes,
// tenant A project 2 for the cross-project probes.
const SCHEDULE_B_ID = testId('tbs', 1);
const ACTIVITY_B1 = testId('tba', 1);
const ACTIVITY_B2 = testId('tba', 2);
const SCHEDULE_P2_ID = testId('p2s', 1);
const ACTIVITY_P2_1 = testId('p2a', 1);
const ACTIVITY_P2_2 = testId('p2a', 2);

const dependencyEvent = (parts: {
  readonly scope: Scope;
  readonly scheduleId: EntityId;
  readonly predecessorId: EntityId;
  readonly successorId: EntityId;
  readonly key: number;
}) => ({
  command: testCommand({
    commandName: 'schedule.addDependency',
    scope: parts.scope,
    idempotencyKey: testKey(parts.key),
    correlationId: testCorrelationId(parts.key),
    issuedAt: T4,
  }),
  eventName: 'schedule.dependencyAdded',
  scope: parts.scope,
  occurredAt: T4,
  aggregate: { entityKind: SCHEDULE_KIND, entityId: parts.scheduleId } satisfies EntityRef,
  payload: {
    scheduleId: parts.scheduleId,
    dependencyId: testId('dep', 9),
    predecessorId: parts.predecessorId,
    successorId: parts.successorId,
    linkType: 'finish-to-start',
    lagDays: 0,
    version: 1,
  },
});

describe('traversal-time authorization (OFF-013)', () => {
  it('denies a start node typedly when the context lacks the area read capability', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const documentsOnlyReader = traversalAuthorizationOf(TENANT_A_PROJECT_1, {
      capabilities: ['documents.read'],
    });
    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), relationshipKinds: ['depends-on'], maxDepth: 2 },
      documentsOnlyReader,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('missing-read-capability');
    }

    // Positive control: the same start under a full reader is visible.
    const fullReader = traversalAuthorizationOf(TENANT_A_PROJECT_1);
    const node = index.entityNodeOf(activityRef(ACTIVITY_3));
    expect(node).not.toBeNull();
    if (node !== null) expect(checkNodeReadable(fullReader, node).ok).toBe(true);
  });

  it('denies by default when the policy has no allow rule at all', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), maxDepth: 1 },
      traversalAuthorizationOf(TENANT_A_PROJECT_1, { policy: EMPTY_POLICY }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
  });

  it('lets an explicit deny rule win over the allow-all default', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), maxDepth: 1 },
      traversalAuthorizationOf(TENANT_A_PROJECT_1, { policy: DENY_ALL_READS_POLICY }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
  });

  it('scope-filters the subgraph when only some areas are readable', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    // A contracts-only reader: the change event, its obligation, and its
    // change order stay visible; every document/cost/schedule/work node is
    // invisible — its edges are dropped, paths through it do not exist.
    const contractsOnlyReader = traversalAuthorizationOf(TENANT_A_PROJECT_1, {
      capabilities: ['contracts.read'],
    });
    const result = traverseRelationships(
      index,
      { start: changeEventRef(), maxDepth: 2 },
      contractsOnlyReader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual({
        nodes: [
          { entityKind: 'change-event', entityId: CHANGE_EVENT_ID, depth: 0 },
          { entityKind: 'change-order', entityId: CHANGE_ORDER_ID, depth: 1 },
          { entityKind: 'scope-obligation', entityId: OBLIGATION_ID, depth: 1 },
        ],
        edges: [
          {
            kind: 'affects',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'scope-obligation',
            toId: OBLIGATION_ID,
            provenanceEventName: 'contracts.changeEventRaised',
          },
          {
            kind: 'derives-from',
            fromKind: 'change-order',
            fromId: CHANGE_ORDER_ID,
            toKind: 'change-event',
            toId: CHANGE_EVENT_ID,
            provenanceEventName: 'contracts.changeOrderSubmitted',
          },
        ],
      } satisfies GoldenSubgraph);
    }
  });

  it('makes cross-tenant starts not-found in BOTH directions (no existence oracle)', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    await appendCommandEvent(
      source,
      dependencyEvent({
        scope: TENANT_B_SCOPE,
        scheduleId: SCHEDULE_B_ID,
        predecessorId: ACTIVITY_B1,
        successorId: ACTIVITY_B2,
        key: 101,
      }),
    );
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));
    // One scope-blind index over both tenants — 4 tenant-A nodes + 3 tenant-B.
    expect(index.derivation.entityCount).toBe(7);

    const tenantAReader = traversalAuthorizationOf(TENANT_A_PROJECT_1);
    const tenantBReader = traversalAuthorizationOf(TENANT_B_SCOPE);

    // Direction 1: tenant A cannot see tenant B's activity.
    const fromA = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_B2), maxDepth: 2 },
      tenantAReader,
    );
    expect(fromA.ok).toBe(false);
    if (!fromA.ok) {
      expect(fromA.error.code).toBe('not-found');
      expect(fromA.error.details[0]?.code).toBe('entity-not-found');
      // The denial carries the REQUEST scope, never the foreign resource's.
      expect(fromA.error.scope).toStrictEqual(TENANT_A_PROJECT_1);
    }

    // Direction 2: tenant B cannot see tenant A's activity.
    const fromB = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), maxDepth: 2 },
      tenantBReader,
    );
    expect(fromB.ok).toBe(false);
    if (!fromB.ok) expect(fromB.error.code).toBe('not-found');

    // No existence oracle: a foreign entity is indistinguishable from a
    // nonexistent one under the same caller.
    const nonexistent = traverseRelationships(
      index,
      { start: activityRef(testId('zzz', 1)), maxDepth: 2 },
      tenantBReader,
    );
    expect(nonexistent.ok).toBe(false);
    if (!fromB.ok && !nonexistent.ok) {
      expect(nonexistent.error.code).toBe(fromB.error.code);
      expect(nonexistent.error.details[0]?.code).toBe(fromB.error.details[0]?.code);
      expect(nonexistent.error.details[0]?.code).toBe('entity-not-found');
    }
  });

  it('never leaks foreign nodes through a shared multi-tenant index', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    await appendCommandEvent(
      source,
      dependencyEvent({
        scope: TENANT_B_SCOPE,
        scheduleId: SCHEDULE_B_ID,
        predecessorId: ACTIVITY_B1,
        successorId: ACTIVITY_B2,
        key: 101,
      }),
    );
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    // Tenant A's traversal stays exactly the tenant-A chain.
    const tenantA = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), relationshipKinds: ['depends-on'], maxDepth: 4 },
      traversalAuthorizationOf(TENANT_A_PROJECT_1),
    );
    expect(tenantA.ok).toBe(true);
    if (tenantA.ok) {
      const shape = subgraphShapeOf(tenantA.value);
      expect(shape.nodes).toHaveLength(3);
      expect(shape.edges).toHaveLength(2);
      expect(JSON.stringify(shape)).not.toContain(ACTIVITY_B1);
      expect(JSON.stringify(shape)).not.toContain(ACTIVITY_B2);
      expect(JSON.stringify(shape)).not.toContain(SCHEDULE_B_ID);
    }

    // Tenant B's traversal sees only its own edge.
    const tenantB = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_B2), relationshipKinds: ['depends-on'], maxDepth: 2 },
      traversalAuthorizationOf(TENANT_B_SCOPE),
    );
    expect(tenantB.ok).toBe(true);
    if (tenantB.ok) {
      expect(subgraphShapeOf(tenantB.value)).toStrictEqual({
        nodes: [
          { entityKind: 'activity', entityId: ACTIVITY_B2, depth: 0 },
          { entityKind: 'activity', entityId: ACTIVITY_B1, depth: 1 },
        ],
        edges: [
          {
            kind: 'depends-on',
            fromKind: 'activity',
            fromId: ACTIVITY_B2,
            toKind: 'activity',
            toId: ACTIVITY_B1,
            provenanceEventName: 'schedule.dependencyAdded',
          },
        ],
      } satisfies GoldenSubgraph);
    }
  });

  it('makes cross-project starts not-found within the same tenant', async () => {
    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    await appendCommandEvent(
      source,
      dependencyEvent({
        scope: PROJECT_2_SCOPE,
        scheduleId: SCHEDULE_P2_ID,
        predecessorId: ACTIVITY_P2_1,
        successorId: ACTIVITY_P2_2,
        key: 111,
      }),
    );
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_P2_2), maxDepth: 1 },
      traversalAuthorizationOf(TENANT_A_PROJECT_1),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }

    // The project-2 caller sees their own edge; the project-1 fixture chain
    // (same tenant, other project) is invisible to them.
    const own = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_P2_2), relationshipKinds: ['depends-on'], maxDepth: 2 },
      traversalAuthorizationOf(PROJECT_2_SCOPE),
    );
    expect(own.ok).toBe(true);
    if (own.ok) {
      const shape = subgraphShapeOf(own.value);
      expect(shape.nodes).toHaveLength(2);
      expect(JSON.stringify(shape)).not.toContain(ACTIVITY_1);
      expect(JSON.stringify(shape)).not.toContain(ACTIVITY_2);
      expect(JSON.stringify(shape)).not.toContain(ACTIVITY_3);
    }
  });

  it('fails closed for entity kinds outside the engine vocabulary', () => {
    const unknownKind = unwrap(parseEntityKind('ufo'));
    const reader = traversalAuthorizationOf(TENANT_A_PROJECT_1);
    const check = checkNodeReadable(reader, {
      entity: { entityKind: unknownKind, entityId: testId('ufo', 1) },
      scope: TENANT_A_PROJECT_1,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.error.code).toBe('forbidden');
      expect(check.error.details[0]?.code).toBe('unknown-entity-kind');
    }
  });
});
