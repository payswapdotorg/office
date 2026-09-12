import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import { projectRelationships } from './projection';
import { createInMemoryEventSource } from './source';
import type { RelationshipIndex } from './model';
import { SCHEDULE_KIND } from './vocabulary';
import {
  ACTIVITY_1,
  ACTIVITY_2,
  ACTIVITY_3,
  BUDGET_ID,
  CHANGE_EVENT_ID,
  CHANGE_ORDER_ID,
  CLAIM_ENTITY_ID,
  COST_ITEM_ID,
  DEPENDENCY_1,
  DOCUMENT_ID,
  FIELD_EVENT_ID,
  REVISION_1,
  REVISION_2,
  SCHEDULE_ID,
  activityRef,
  buildChangeEventChainStream,
  buildFieldEvidenceChainStream,
  buildScheduleDependencyChainStream,
} from './fixtures';
import {
  T0,
  T1,
  T4,
  appendCommandEvent,
  projectScopeOf,
  PROJECT_1,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  unwrap,
} from './test-support';

// OFF-013 relationship projection — determinism and rebuildability (A7):
// the same event stream always projects to the identical index, rebuilding
// from scratch (a fresh source, the same append sequence) yields the
// identical index, unknown event names are skipped deterministically (no
// crash, no invented data), a recognized name with a malformed payload fails
// closed, explicit removals are honored in ledger order, and every derived
// edge carries its producing event's ledger id as provenance.

/** The comparable (function-free) data shape of one index. */
const indexDataOf = (index: RelationshipIndex) => ({
  relationships: index.relationships,
  entities: index.entities,
  derivation: index.derivation,
});

const scheduleAggregate: EntityRef = { entityKind: SCHEDULE_KIND, entityId: SCHEDULE_ID };

describe('relationship projection (OFF-013)', () => {
  it('projects the same event stream to an identical index', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const first = unwrap(projectRelationships(unwrap(await source.readEvents())));
    const second = unwrap(projectRelationships(unwrap(await source.readEvents())));

    expect(indexDataOf(second)).toStrictEqual(indexDataOf(first));
    expect(JSON.stringify(indexDataOf(second))).toBe(JSON.stringify(indexDataOf(first)));
    // The adjacency accessor is deterministic too (same edges, same order).
    expect(second.relationshipsOf(activityRef(ACTIVITY_2))).toStrictEqual(
      first.relationshipsOf(activityRef(ACTIVITY_2)),
    );
    expect(second.entityNodeOf(activityRef(ACTIVITY_2))).toStrictEqual(
      first.entityNodeOf(activityRef(ACTIVITY_2)),
    );
  });

  it('rebuilds identically from scratch (fresh source, same append sequence)', async () => {
    const buildFresh = {
      schedule: async () => {
        const source = createInMemoryEventSource();
        await buildScheduleDependencyChainStream(source);
        return unwrap(projectRelationships(unwrap(await source.readEvents())));
      },
      changeEvent: async () => {
        const source = createInMemoryEventSource();
        await buildChangeEventChainStream(source);
        return unwrap(projectRelationships(unwrap(await source.readEvents())));
      },
      field: async () => {
        const source = createInMemoryEventSource();
        await buildFieldEvidenceChainStream(source);
        return unwrap(projectRelationships(unwrap(await source.readEvents())));
      },
    } as const;

    for (const rebuild of [buildFresh.schedule, buildFresh.changeEvent, buildFresh.field]) {
      const rebuilt = await rebuild();
      const rebuiltAgain = await rebuild();
      expect(indexDataOf(rebuiltAgain)).toStrictEqual(indexDataOf(rebuilt));
    }
  });

  it('derives the schedule dependency chain with full event provenance', async () => {
    const source = createInMemoryEventSource();
    const { dependencyA2OnA1, dependencyA3OnA2 } = await buildScheduleDependencyChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    expect(
      index.relationships.map((edge) => [edge.kind, edge.from.entityId, edge.to.entityId]),
    ).toStrictEqual([
      ['depends-on', ACTIVITY_2, ACTIVITY_1],
      ['depends-on', ACTIVITY_3, ACTIVITY_2],
    ]);
    expect(index.relationshipsOf(activityRef(ACTIVITY_2))).toHaveLength(2);
    expect(index.entityNodeOf(activityRef(ACTIVITY_1))?.scope).toStrictEqual(
      projectScopeOf(PROJECT_1),
    );

    // Every edge carries its producing event: id, name, stream, sequence,
    // correlation, causation, timestamp, actor — nothing stored, all derived.
    const edgeA3OnA2 = index.relationships.find(
      (edge) => edge.from.entityId === ACTIVITY_3 && edge.to.entityId === ACTIVITY_2,
    );
    expect(edgeA3OnA2?.provenance.eventId).toBe(dependencyA3OnA2.eventId);
    expect(edgeA3OnA2?.provenance.eventName).toBe('schedule.dependencyAdded');
    expect(edgeA3OnA2?.provenance.aggregate).toStrictEqual(scheduleAggregate);
    expect(edgeA3OnA2?.provenance.sequence).toBe(dependencyA3OnA2.sequence);
    expect(edgeA3OnA2?.provenance.correlationId).toBe(testCorrelationId(6));
    expect(edgeA3OnA2?.provenance.causationId).toBe(testKey(6));
    expect(edgeA3OnA2?.scope).toStrictEqual(projectScopeOf(PROJECT_1));

    const edgeA2OnA1 = index.relationships.find(
      (edge) => edge.from.entityId === ACTIVITY_2 && edge.to.entityId === ACTIVITY_1,
    );
    expect(edgeA2OnA1?.provenance.eventId).toBe(dependencyA2OnA1.eventId);

    expect(index.derivation).toStrictEqual({
      projectedEventCount: 6,
      entityCount: 4,
      relationshipCount: 2,
      recognizedEventNames: [
        { eventName: 'schedule.activityAdded', count: 3 },
        { eventName: 'schedule.dependencyAdded', count: 2 },
        { eventName: 'schedule.scheduleCreated', count: 1 },
      ],
      skippedEventNames: [],
    });
  });

  it('derives the change-event cross-domain edges across all five kinds', async () => {
    const source = createInMemoryEventSource();
    await buildChangeEventChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    const counts = new Map<string, number>();
    for (const edge of index.relationships) {
      counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toStrictEqual({
      affects: 1,
      'derives-from': 6,
      'evidenced-by': 2,
      impacts: 4,
    });

    // The named acceptance edges: change event evidenced-by revision R2 and
    // impacting budget + cost item + activities; change order derived from
    // the change event; field-issue claim derived from the change order.
    const edgeKeys = index.relationships.map(
      (edge) => `${edge.kind} ${edge.from.entityId} > ${edge.to.entityId}`,
    );
    expect(edgeKeys).toContain(`evidenced-by ${CHANGE_EVENT_ID} > ${REVISION_2}`);
    expect(edgeKeys).toContain(`impacts ${CHANGE_EVENT_ID} > ${BUDGET_ID}`);
    expect(edgeKeys).toContain(`impacts ${CHANGE_EVENT_ID} > ${COST_ITEM_ID}`);
    expect(edgeKeys).toContain(`derives-from ${CHANGE_ORDER_ID} > ${CHANGE_EVENT_ID}`);
    expect(edgeKeys).toContain(`derives-from ${CLAIM_ENTITY_ID} > ${CHANGE_ORDER_ID}`);

    expect(index.derivation.projectedEventCount).toBe(13);
    expect(index.derivation.entityCount).toBe(13);
    expect(index.derivation.relationshipCount).toBe(13);
    expect(index.derivation.skippedEventNames).toStrictEqual([]);
  });

  it('derives the field evidence edge from the captured field event', async () => {
    const source = createInMemoryEventSource();
    await buildFieldEvidenceChainStream(source);
    const index = unwrap(projectRelationships(unwrap(await source.readEvents())));

    expect(
      index.relationships.map((edge) => [edge.kind, edge.from.entityId, edge.to.entityId]),
    ).toStrictEqual([
      ['derives-from', REVISION_1, DOCUMENT_ID],
      ['evidenced-by', FIELD_EVENT_ID, DOCUMENT_ID],
    ]);
    const evidenceEdge = index.relationships.find(
      (edge) => edge.kind === 'evidenced-by' && edge.from.entityId === FIELD_EVENT_ID,
    );
    expect(evidenceEdge?.provenance.eventName).toBe('field.fieldEventCaptured');
    expect(index.derivation.projectedEventCount).toBe(3);
    expect(index.derivation.entityCount).toBe(3);
  });

  it('skips unknown event names deterministically without inventing data', async () => {
    const baselineSource = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(baselineSource);
    const baseline = unwrap(
      projectRelationships(unwrap(await baselineSource.readEvents())),
    );

    const source = createInMemoryEventSource();
    await buildScheduleDependencyChainStream(source);
    const futureAggregateId = testId('ftr', 1);
    const futureTargetId = testId('fta', 1);
    const scope = projectScopeOf(PROJECT_1);
    await appendCommandEvent(source, {
      command: testCommand({
        commandName: 'future.shipFeature',
        scope,
        idempotencyKey: testKey(50),
        correlationId: testCorrelationId(50),
        issuedAt: T4,
      }),
      eventName: 'future.featureShipped',
      scope,
      occurredAt: T4,
      aggregate: { entityKind: SCHEDULE_KIND, entityId: futureAggregateId },
      payload: { scheduleId: futureAggregateId, someTargetId: futureTargetId },
    });
    await appendCommandEvent(source, {
      command: testCommand({
        commandName: 'future.shipFeature',
        scope,
        idempotencyKey: testKey(51),
        correlationId: testCorrelationId(51),
        issuedAt: T4,
      }),
      eventName: 'future.featureShipped',
      scope,
      occurredAt: T4,
      aggregate: { entityKind: SCHEDULE_KIND, entityId: futureAggregateId },
      payload: { scheduleId: futureAggregateId, someTargetId: futureTargetId },
    });

    const events = unwrap(await source.readEvents());
    const withUnknown = unwrap(projectRelationships(events));
    const withUnknownAgain = unwrap(projectRelationships(events));

    // No crash, fully deterministic across repeated projections.
    expect(indexDataOf(withUnknownAgain)).toStrictEqual(indexDataOf(withUnknown));
    // The unknown event contributed nothing but its skip tally — no edges,
    // no nodes, no invented relationships (fail-open name, fail-closed data).
    expect(withUnknown.relationships).toStrictEqual(baseline.relationships);
    expect(withUnknown.entities).toStrictEqual(baseline.entities);
    expect(JSON.stringify(indexDataOf(withUnknown))).not.toContain(futureTargetId);
    expect(withUnknown.derivation.projectedEventCount).toBe(8);
    expect(withUnknown.derivation.recognizedEventNames).toStrictEqual(
      baseline.derivation.recognizedEventNames,
    );
    expect(withUnknown.derivation.skippedEventNames).toStrictEqual([
      { eventName: 'future.featureShipped', count: 2 },
    ]);
  });

  it('fails closed on a recognized event name with a malformed payload', async () => {
    const source = createInMemoryEventSource();
    const scope = projectScopeOf(PROJECT_1);
    await appendCommandEvent(source, {
      command: testCommand({
        commandName: 'schedule.addDependency',
        scope,
        idempotencyKey: testKey(60),
        correlationId: testCorrelationId(60),
        issuedAt: T0,
      }),
      eventName: 'schedule.dependencyAdded',
      scope,
      occurredAt: T1,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: SCHEDULE_ID,
        dependencyId: DEPENDENCY_1,
        predecessorId: 'not-an-entity-id',
        successorId: ACTIVITY_2,
        linkType: 'finish-to-start',
        lagDays: 0,
        version: 1,
      },
    });

    const result = projectRelationships(unwrap(await source.readEvents()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('relationship-payload-valid');
      expect(result.error.details[0]?.path).toBe('schedule.dependencyAdded.predecessorId');
    }
  });

  it('honors explicit dependency removals and re-assertions in ledger order', async () => {
    const source = createInMemoryEventSource();
    const scope = projectScopeOf(PROJECT_1);
    const add = (key: number) =>
      appendCommandEvent(source, {
        command: testCommand({
          commandName: 'schedule.addDependency',
          scope,
          idempotencyKey: testKey(key),
          correlationId: testCorrelationId(key),
          issuedAt: T0,
        }),
        eventName: 'schedule.dependencyAdded',
        scope,
        occurredAt: T1,
        aggregate: scheduleAggregate,
        payload: {
          scheduleId: SCHEDULE_ID,
          dependencyId: DEPENDENCY_1,
          predecessorId: ACTIVITY_1,
          successorId: ACTIVITY_2,
          linkType: 'finish-to-start',
          lagDays: 0,
          version: key,
        },
      });
    const remove = (key: number) =>
      appendCommandEvent(source, {
        command: testCommand({
          commandName: 'schedule.removeDependency',
          scope,
          idempotencyKey: testKey(key),
          correlationId: testCorrelationId(key),
          issuedAt: T0,
        }),
        eventName: 'schedule.dependencyRemoved',
        scope,
        occurredAt: T1,
        aggregate: scheduleAggregate,
        payload: {
          scheduleId: SCHEDULE_ID,
          dependencyId: DEPENDENCY_1,
          predecessorId: ACTIVITY_1,
          successorId: ACTIVITY_2,
          version: key,
        },
      });

    await add(70);
    await remove(71);
    const reassertion = await add(72);
    const events = unwrap(await source.readEvents());

    const afterRemoval = unwrap(projectRelationships(events.slice(0, 2)));
    expect(afterRemoval.derivation.relationshipCount).toBe(0);
    expect(afterRemoval.relationshipsOf(activityRef(ACTIVITY_2))).toStrictEqual([]);
    expect(afterRemoval.derivation.projectedEventCount).toBe(2);
    expect(afterRemoval.derivation.entityCount).toBe(3);

    // Re-asserted in ledger order: the edge returns carrying the MOST
    // RECENT asserting event's provenance (never last-write-wins opinion).
    const afterReassertion = unwrap(projectRelationships(events));
    expect(afterReassertion.derivation.relationshipCount).toBe(1);
    expect(afterReassertion.relationships[0]?.provenance.eventId).toBe(reassertion.eventId);
    expect(afterReassertion.relationships[0]?.provenance.causationId).toBe(testKey(72));
  });
});
