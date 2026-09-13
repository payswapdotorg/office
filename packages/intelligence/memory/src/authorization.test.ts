import { describe, expect, it } from 'vitest';
import { projectMemory } from './store';
import type { MemoryStore } from './store';
import { queryLessons, queryOutcomes } from './authorization';
import { captureLesson } from './lesson';
import { computeBenchmarks } from './benchmark';
import { lessonCapturedEnvelope } from './memory-events';
import { parseOutcomeId } from './vocabulary';
import {
  ALL_MEMORY_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  GOLDEN_PROJECT_B1,
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  PROJECT_1,
  PROJECT_2,
  PROJECT_3,
  PROJECT_B1,
  TENANT_A,
  TENANT_B,
  T5,
  USER_ACTOR,
  captureLessonOk,
  memoryLedgerOf,
  memoryReaderOf,
  outcomeAppendOf,
  outcomeOfRun,
  runCompletedProject,
  testId,
  testLessonId,
  testBenchmarkId,
  tenantAWideScope,
  tenantBWideScope,
  projectOneScope,
  projectB1Scope,
  unwrap,
} from './test-support';
import type { MemoryAppend } from './test-support';

// OFF-015 memory authorization — freeze A12, enforced BEFORE any memory
// record is queried, deny-by-default across three layers:
//   1. the capability gate (contracts.read AND cost.read AND schedule.read)
//      fires before the store is touched — the poisoned-store probe proves
//      the gate runs first (any store access throws, the denial is returned);
//   2. structural scope coverage: a foreign-tenant outcome is INVISIBLE —
//      querying it is a typed not-found IDENTICAL to an absent project (no
//      existence oracle), in BOTH directions;
//   3. the policy gate: explicit deny wins, no allow rule denies.

/** The shared store: 3 tenant-A outcomes + 1 tenant-B outcome + 2 lessons. */
const sharedStore = async (): Promise<MemoryStore> => {
  const outcomes = await Promise.all(
    [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO, GOLDEN_PROJECT_THREE, GOLDEN_PROJECT_B1].map((spec) =>
      runCompletedProject(spec).then(outcomeOfRun),
    ),
  );
  const lessonA = captureLessonOk(
    {
      title: 'Close the wall sequence before fit-out starts',
      statement: 'Sequencing the close-out first avoids the schedule variance.',
      applicability: [{ area: 'schedule', value: 'wall-closing-sequence' }],
      links: [],
      provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
    },
    { lessonId: testLessonId(1), capturedAt: T5, actor: USER_ACTOR, scope: projectOneScope() },
  );
  const lessonB = captureLessonOk(
    {
      title: 'Tenant B procurement lesson',
      statement: 'A tenant-B-specific commercial lesson.',
      applicability: [{ area: 'contracts', value: 'procurement-window' }],
      links: [],
      provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
    },
    { lessonId: testLessonId(2), capturedAt: T5, actor: USER_ACTOR, scope: projectB1Scope() },
  );
  const appends: readonly MemoryAppend[] = [
    ...outcomes.map(outcomeAppendOf),
    {
      envelope: unwrap(
        lessonCapturedEnvelope(lessonA, {
          correlationId: 'corr-00000091',
          causationId: null,
        }),
      ),
      aggregate: { entityKind: 'project' as never, entityId: PROJECT_1 },
    },
    {
      envelope: unwrap(
        lessonCapturedEnvelope(lessonB, {
          correlationId: 'corr-00000092',
          causationId: null,
        }),
      ),
      aggregate: { entityKind: 'project' as never, entityId: PROJECT_B1 },
    },
  ];
  const events = await memoryLedgerOf(appends);
  return unwrap(projectMemory(events));
};

describe('the capability gate runs BEFORE any store access (OFF-015)', () => {
  for (const missing of ['contracts.read', 'cost.read', 'schedule.read'] as const) {
    it(`denies without the ${missing} capability (typed, naming it)`, async () => {
      const store = await sharedStore();
      const reader = memoryReaderOf(tenantAWideScope(), {
        capabilities: ALL_MEMORY_CAPABILITIES.filter((capability) => capability !== missing),
      });

      const result = queryOutcomes(store, reader, {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details[0]?.code).toBe('missing-memory-capability');
        expect(result.error.details[0]?.message).toContain(missing);
        // Denial context carries the REQUEST scope (A12), never a record's.
        expect(result.error.scope?.tenantId).toBe(TENANT_A);
      }
    });
  }

  it('the poisoned-store probe: a denied request never touches the store', async () => {
    // Every store access throws; the capability gate returns its typed
    // denial without tripping a single accessor — authorization BEFORE
    // queries, structurally.
    const poisoned: MemoryStore = {
      get derivation(): never {
        throw new Error('the store must not be touched by a denied request');
      },
      get outcomes(): never {
        throw new Error('the store must not be touched by a denied request');
      },
      get lessons(): never {
        throw new Error('the store must not be touched by a denied request');
      },
      get benchmarks(): never {
        throw new Error('the store must not be touched by a denied request');
      },
      outcomeOf: (): never => {
        throw new Error('the store must not be touched by a denied request');
      },
      outcomeOfProject: (): never => {
        throw new Error('the store must not be touched by a denied request');
      },
      lessonOf: (): never => {
        throw new Error('the store must not be touched by a denied request');
      },
      benchmarkOf: (): never => {
        throw new Error('the store must not be touched by a denied request');
      },
    };
    const reader = memoryReaderOf(tenantAWideScope(), {
      capabilities: ['contracts.read'], // missing cost.read + schedule.read
    });

    expect(() => queryOutcomes(poisoned, reader, {})).not.toThrow();
    const result = queryOutcomes(poisoned, reader, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
    }
    const lessons = queryLessons(poisoned, reader, {});
    expect(lessons.ok).toBe(false);
  });
});

describe('A12: cross-tenant memory access is typed-rejected BOTH directions (OFF-015)', () => {
  it('a tenant-A reader never sees the tenant-B outcome (set query: invisible)', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantAWideScope());

    const outcomes = unwrap(queryOutcomes(store, reader, {}));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((outcome) => outcome.scope.tenantId)).toStrictEqual([
      TENANT_A,
      TENANT_A,
      TENANT_A,
    ]);
  });

  it('a tenant-A reader querying the tenant-B project gets not-found (no oracle)', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantAWideScope());

    const foreign = queryOutcomes(store, reader, { projectId: PROJECT_B1 });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('memory-outcome-not-found');
    }

    // The denial is IDENTICAL to an absent project's: the memory surface is
    // never an existence oracle — same code, same details code.
    const absent = queryOutcomes(store, reader, { projectId: testId('prj', 999) });
    expect(absent.ok).toBe(false);
    if (!absent.ok && !foreign.ok) {
      expect(absent.error.code).toBe(foreign.error.code);
      expect(absent.error.details[0]?.code).toBe(foreign.error.details[0]?.code);
    }
  });

  it('a tenant-B reader querying the tenant-A project gets not-found (both directions)', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantBWideScope());

    const foreign = queryOutcomes(store, reader, { projectId: PROJECT_1 });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('memory-outcome-not-found');
      // The denial carries the REQUEST scope (the reader's own tenant) and
      // never leaks the foreign record's tenant or existence.
      expect(foreign.error.scope?.tenantId).toBe(TENANT_B);
      expect(JSON.stringify(foreign.error)).not.toContain(TENANT_A);
    }

    // The tenant-B reader's covered set serves exactly its own outcome.
    const visible = unwrap(queryOutcomes(store, reader, {}));
    expect(visible).toHaveLength(1);
    expect(visible[0]?.projectId).toBe(PROJECT_B1);
  });

  it("a project-scoped reader sees exactly its own project's outcome", async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(projectOneScope());

    const outcomes = unwrap(queryOutcomes(store, reader, {}));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.projectId).toBe(PROJECT_1);
    // A sibling project of the same tenant is outside the project scope.
    const sibling = queryOutcomes(store, reader, { projectId: PROJECT_2 });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) {
      expect(sibling.error.code).toBe('not-found');
    }
  });

  it('lessons are scope-isolated the same way (tenant-B lesson invisible to A)', async () => {
    const store = await sharedStore();
    const readerA = memoryReaderOf(tenantAWideScope());
    const readerB = memoryReaderOf(tenantBWideScope());

    const forA = unwrap(queryLessons(store, readerA, {}));
    expect(forA.map((lesson) => lesson.lessonId)).toStrictEqual([testLessonId(1)]);
    const forB = unwrap(queryLessons(store, readerB, {}));
    expect(forB.map((lesson) => lesson.lessonId)).toStrictEqual([testLessonId(2)]);
  });
});

describe('the policy gate (deny-by-default, OFF-015)', () => {
  it('an explicit deny excludes the outcome from every query shape', async () => {
    const store = await sharedStore();
    const denied = memoryReaderOf(tenantAWideScope(), { policy: DENY_ALL_READS_POLICY });

    const single = queryOutcomes(store, denied, { projectId: PROJECT_1 });
    expect(single.ok).toBe(false);
    if (!single.ok) {
      // The single-project denial is the no-oracle not-found (policy denials
      // never reveal existence either).
      expect(single.error.code).toBe('not-found');
    }
    expect(unwrap(queryOutcomes(store, denied, {}))).toStrictEqual([]);
    expect(unwrap(queryLessons(store, denied, {}))).toStrictEqual([]);
  });

  it('no allow rule at all denies by default (the empty policy)', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantAWideScope(), { policy: EMPTY_POLICY });

    expect(unwrap(queryOutcomes(store, reader, {}))).toStrictEqual([]);
    expect(queryOutcomes(store, reader, { projectId: PROJECT_3 }).ok).toBe(false);
  });
});

describe('lesson area filtering is pure data (OFF-015)', () => {
  it('filters by applicability area without touching behavior', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantAWideScope());

    const scheduleLessons = unwrap(queryLessons(store, reader, { areas: ['schedule'] }));
    expect(scheduleLessons.map((lesson) => lesson.lessonId)).toStrictEqual([testLessonId(1)]);
    const contractLessons = unwrap(queryLessons(store, reader, { areas: ['contracts'] }));
    expect(contractLessons).toStrictEqual([]);
  });
});

describe('A12 guards on the write-side constructors (OFF-015)', () => {
  it('computeBenchmarks typed-rejects a mixed-tenant outcome set', async () => {
    const tenantA = await Promise.all(
      [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO].map((spec) =>
        runCompletedProject(spec).then(outcomeOfRun),
      ),
    );
    const tenantB = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_B1));
    const result = computeBenchmarks([...tenantA, tenantB], {
      benchmarkId: testBenchmarkId(1),
      computedAt: T5,
      actor: USER_ACTOR,
      scope: tenantAWideScope(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('benchmark-tenant-scope');
    }
  });

  it('captureLesson stays a pure constructor (lessons are data, never behavior)', async () => {
    const lesson = captureLesson(
      {
        title: 'Derived lesson from the golden outcome',
        statement: 'The approved-order outcome taught the sequencing lesson.',
        applicability: [{ area: 'entitlement', value: 'approved-order-timing' }],
        links: [],
        provenance: { origin: 'derived', author: USER_ACTOR, derivedFromOutcomeIds: [unwrap(parseOutcomeId('outcome-000001'))] },
      },
      { lessonId: testLessonId(3), capturedAt: T5, actor: USER_ACTOR, scope: projectOneScope() },
    );

    expect(unwrap(lesson).provenance.origin).toBe('derived');
    expect(unwrap(lesson).provenance.derivedFromOutcomeIds).toStrictEqual(['outcome-000001']);
  });
});

describe('query result shape (OFF-015)', () => {
  it('the covered-set query returns canonical outcome-id order', async () => {
    const store = await sharedStore();
    const reader = memoryReaderOf(tenantAWideScope());

    const outcomes = unwrap(queryOutcomes(store, reader, {}));
    expect(outcomes.map((outcome) => outcome.projectId)).toStrictEqual([
      PROJECT_1,
      PROJECT_2,
      PROJECT_3,
    ]);
    // The single-project query returns exactly one record.
    const single = unwrap(queryOutcomes(store, reader, { projectId: PROJECT_2 }));
    expect(single).toHaveLength(1);
    expect(single[0]?.projectId).toBe(PROJECT_2);
  });
});
