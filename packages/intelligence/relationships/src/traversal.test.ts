import { describe, expect, it } from 'vitest';
import { traverseRelationships } from './traversal';
import { projectRelationships } from './projection';
import { createInMemoryEventSource } from './source';
import { MAX_TRAVERSAL_DEPTH, isTraversalQuery, parseTraversalQuery } from './model';
import { BUDGET_KIND, COST_ITEM_KIND } from './vocabulary';
import type { RelationshipIndex } from './model';
import {
  ACTIVITY_1,
  ACTIVITY_2,
  ACTIVITY_3,
  BUDGET_ID,
  CHANGE_EVENT_CHAIN_GOLDEN,
  CHANGE_EVENT_ID,
  COST_ITEM_ID,
  FIELD_EVIDENCE_CHAIN_GOLDEN,
  SCHEDULE_DEPENDENCY_CHAIN_GOLDEN,
  activityRef,
  buildChangeEventChainStream,
  buildFieldEvidenceChainStream,
  buildScheduleDependencyChainStream,
  changeEventRef,
  fieldEventRef,
  subgraphShapeOf,
} from './fixtures';
import type { GoldenSubgraph } from './fixtures';
import { PROJECT_1, projectScopeOf, testId, traversalAuthorizationOf, unwrap } from './test-support';

// OFF-013 traversal queries — the named construction causal chains, proven
// by golden fixtures: the schedule dependency chain (activity A3 depends-on
// A2 depends-on A1), the change-event chain (a change event evidenced-by a
// document revision and impacting cost + schedule, with the change order and
// field-issue claim around it), and the field evidence chain (a captured
// field event evidenced-by its linked document). Every returned edge carries
// its producing event id; queries parse fail-closed.

const reader = traversalAuthorizationOf(projectScopeOf(PROJECT_1));

const buildIndex = async (
  append: (source: ReturnType<typeof createInMemoryEventSource>) => Promise<unknown>,
): Promise<RelationshipIndex> => {
  const source = createInMemoryEventSource();
  await append(source);
  return unwrap(projectRelationships(unwrap(await source.readEvents())));
};

const scheduleChainIndex = (): Promise<RelationshipIndex> =>
  buildIndex((source) => buildScheduleDependencyChainStream(source));
const changeEventChainIndex = (): Promise<RelationshipIndex> =>
  buildIndex((source) => buildChangeEventChainStream(source));
const fieldEvidenceChainIndex = (): Promise<RelationshipIndex> =>
  buildIndex((source) => buildFieldEvidenceChainStream(source));

describe('relationship traversal (OFF-013)', () => {
  it('returns the golden schedule dependency chain (A3 depends-on A2 depends-on A1)', async () => {
    const source = createInMemoryEventSource();
    const { dependencyA2OnA1, dependencyA3OnA2 } = await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), relationshipKinds: ['depends-on'], maxDepth: 2, direction: 'outgoing' },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual(SCHEDULE_DEPENDENCY_CHAIN_GOLDEN);
      expect(result.value.depthReached).toBe(2);
      expect(result.value.start).toStrictEqual(activityRef(ACTIVITY_3));
      // Provenance at traversal time: every returned edge carries the ledger
      // id of the dependencyAdded event that asserted it.
      const producingEventIds = new Set<string>([dependencyA2OnA1.eventId, dependencyA3OnA2.eventId]);
      for (const edge of result.value.edges) {
        expect(producingEventIds.has(edge.provenance.eventId)).toBe(true);
        expect(edge.provenance.eventName).toBe('schedule.dependencyAdded');
      }
    }
  });

  it('truncates the schedule chain at the depth limit', async () => {
    const index = await scheduleChainIndex();
    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_3), relationshipKinds: ['depends-on'], maxDepth: 1, direction: 'outgoing' },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual({
        nodes: [
          { entityKind: 'activity', entityId: ACTIVITY_3, depth: 0 },
          { entityKind: 'activity', entityId: ACTIVITY_2, depth: 1 },
        ],
        edges: [
          {
            kind: 'depends-on',
            fromKind: 'activity',
            fromId: ACTIVITY_3,
            toKind: 'activity',
            toId: ACTIVITY_2,
            provenanceEventName: 'schedule.dependencyAdded',
          },
        ],
      } satisfies GoldenSubgraph);
      expect(result.value.depthReached).toBe(1);
    }
  });

  it('follows both directions from the middle of the dependency chain', async () => {
    const index = await scheduleChainIndex();
    const result = traverseRelationships(
      index,
      { start: activityRef(ACTIVITY_2), relationshipKinds: ['depends-on'], maxDepth: 2 },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual({
        nodes: [
          { entityKind: 'activity', entityId: ACTIVITY_2, depth: 0 },
          { entityKind: 'activity', entityId: ACTIVITY_1, depth: 1 },
          { entityKind: 'activity', entityId: ACTIVITY_3, depth: 1 },
        ],
        edges: [
          {
            kind: 'depends-on',
            fromKind: 'activity',
            fromId: ACTIVITY_2,
            toKind: 'activity',
            toId: ACTIVITY_1,
            provenanceEventName: 'schedule.dependencyAdded',
          },
          {
            kind: 'depends-on',
            fromKind: 'activity',
            fromId: ACTIVITY_3,
            toKind: 'activity',
            toId: ACTIVITY_2,
            provenanceEventName: 'schedule.dependencyAdded',
          },
        ],
      } satisfies GoldenSubgraph);
    }
  });

  it('returns the golden change-event chain (evidenced-by a revision, impacting cost + schedule)', async () => {
    const index = await changeEventChainIndex();
    const result = traverseRelationships(
      index,
      { start: changeEventRef(), maxDepth: 2 },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual(CHANGE_EVENT_CHAIN_GOLDEN);
      expect(result.value.depthReached).toBe(2);
      // The five-kind vocabulary is exercised by the golden itself; every
      // edge still carries its producing event's name.
      const provenanceNames = new Set(result.value.edges.map((edge) => edge.provenance.eventName));
      expect(provenanceNames).toContain('contracts.changeEventRaised');
      expect(provenanceNames).toContain('contracts.changeOrderSubmitted');
      expect(provenanceNames).toContain('contracts.claimReferenced');
      expect(provenanceNames).toContain('documents.revisionSuperseded');
      expect(provenanceNames).toContain('cost.costItemRecorded');
    }
  });

  it('filters the change-event traversal by relationship kind', async () => {
    const index = await changeEventChainIndex();
    const result = traverseRelationships(
      index,
      { start: changeEventRef(), relationshipKinds: ['impacts'], maxDepth: 2 },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual({
        nodes: [
          { entityKind: 'change-event', entityId: CHANGE_EVENT_ID, depth: 0 },
          { entityKind: 'activity', entityId: ACTIVITY_2, depth: 1 },
          { entityKind: 'activity', entityId: ACTIVITY_3, depth: 1 },
          { entityKind: 'budget', entityId: BUDGET_ID, depth: 1 },
          { entityKind: 'cost-item', entityId: COST_ITEM_ID, depth: 1 },
        ],
        edges: [
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'activity',
            toId: ACTIVITY_2,
            provenanceEventName: 'contracts.changeEventRaised',
          },
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'activity',
            toId: ACTIVITY_3,
            provenanceEventName: 'contracts.changeEventRaised',
          },
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'budget',
            toId: BUDGET_ID,
            provenanceEventName: 'contracts.changeEventRaised',
          },
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'cost-item',
            toId: COST_ITEM_ID,
            provenanceEventName: 'contracts.changeEventRaised',
          },
        ],
      } satisfies GoldenSubgraph);
      expect(result.value.depthReached).toBe(1);
    }
  });

  it('respects the entity-kind filter of the traversal query', async () => {
    const index = await changeEventChainIndex();
    const result = traverseRelationships(
      index,
      { start: changeEventRef(), entityKinds: [BUDGET_KIND, COST_ITEM_KIND], maxDepth: 2 },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual({
        nodes: [
          { entityKind: 'change-event', entityId: CHANGE_EVENT_ID, depth: 0 },
          { entityKind: 'budget', entityId: BUDGET_ID, depth: 1 },
          { entityKind: 'cost-item', entityId: COST_ITEM_ID, depth: 1 },
        ],
        edges: [
          {
            kind: 'derives-from',
            fromKind: 'cost-item',
            fromId: COST_ITEM_ID,
            toKind: 'budget',
            toId: BUDGET_ID,
            provenanceEventName: 'cost.costItemRecorded',
          },
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'budget',
            toId: BUDGET_ID,
            provenanceEventName: 'contracts.changeEventRaised',
          },
          {
            kind: 'impacts',
            fromKind: 'change-event',
            fromId: CHANGE_EVENT_ID,
            toKind: 'cost-item',
            toId: COST_ITEM_ID,
            provenanceEventName: 'contracts.changeEventRaised',
          },
        ],
      } satisfies GoldenSubgraph);
    }
  });

  it('returns the golden field evidence chain (field event evidenced-by its document)', async () => {
    const index = await fieldEvidenceChainIndex();
    const result = traverseRelationships(
      index,
      { start: fieldEventRef(), relationshipKinds: ['evidenced-by'], maxDepth: 2 },
      reader,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(subgraphShapeOf(result.value)).toStrictEqual(FIELD_EVIDENCE_CHAIN_GOLDEN);
      expect(result.value.edges[0]?.provenance.eventName).toBe('field.fieldEventCaptured');
    }
  });

  it('answers a typed not-found for a start entity the index has never seen', async () => {
    const index = await scheduleChainIndex();
    const result = traverseRelationships(
      index,
      { start: activityRef(testId('nope', 1)), maxDepth: 1 },
      reader,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('entity-not-found');
    }
  });

  it('parses traversal queries fail-closed (strict keys, bounds, vocabularies)', () => {
    const rawStart = { entityKind: 'activity', entityId: ACTIVITY_3 };
    const valid = parseTraversalQuery({
      start: rawStart,
      relationshipKinds: ['depends-on'],
      maxDepth: 2,
      direction: 'outgoing',
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.start.entityId).toBe(ACTIVITY_3);
      expect(valid.value.relationshipKinds).toStrictEqual(['depends-on']);
      expect(valid.value.maxDepth).toBe(2);
      expect(valid.value.direction).toBe('outgoing');
      expect(isTraversalQuery({ start: rawStart, maxDepth: 1 })).toBe(true);
    }
    expect(isTraversalQuery({ start: rawStart, maxDepth: 0 })).toBe(false);

    const unknownKey = parseTraversalQuery({ start: rawStart, maxDepth: 1, nope: true });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe('unknown-field');

    for (const maxDepth of [0, MAX_TRAVERSAL_DEPTH + 1]) {
      const outOfBounds = parseTraversalQuery({ start: rawStart, maxDepth });
      expect(outOfBounds.ok).toBe(false);
      if (!outOfBounds.ok) {
        expect(outOfBounds.error.code).toBe('invalid-value');
        expect(outOfBounds.error.path).toBe('maxDepth');
      }
    }
    const fractional = parseTraversalQuery({ start: rawStart, maxDepth: 1.5 });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.error.code).toBe('invalid-type');

    const badKind = parseTraversalQuery({
      start: rawStart,
      relationshipKinds: ['affects-not'],
      maxDepth: 1,
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.error.code).toBe('invalid-value');
      expect(badKind.error.path).toBe('relationshipKinds[0]');
    }

    const duplicateKind = parseTraversalQuery({
      start: rawStart,
      relationshipKinds: ['impacts', 'impacts'],
      maxDepth: 1,
    });
    expect(duplicateKind.ok).toBe(false);
    if (!duplicateKind.ok) {
      expect(duplicateKind.error.code).toBe('invalid-value');
      expect(duplicateKind.error.path).toBe('relationshipKinds[1]');
    }

    const badDirection = parseTraversalQuery({ start: rawStart, maxDepth: 1, direction: 'upward' });
    expect(badDirection.ok).toBe(false);
    if (!badDirection.ok) expect(badDirection.error.code).toBe('invalid-value');

    const badStart = parseTraversalQuery({ start: 'activity-3', maxDepth: 1 });
    expect(badStart.ok).toBe(false);
  });
});
