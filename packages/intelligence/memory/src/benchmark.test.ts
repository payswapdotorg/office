import { describe, expect, it } from 'vitest';
import { computeBenchmarks } from './benchmark';
import { BENCHMARK_SCHEMA_VERSION, MEMORY_ENGINE, compareRationals } from './model';
import type { Benchmark, OutcomeRecord, Rational } from './model';
import { projectMemory } from './store';
import { queryOutcomes } from './authorization';
import {
  GOLDEN_PROJECT_B1,
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  TENANT_A,
  T5,
  USER_ACTOR,
  memoryLedgerOf,
  memoryReaderOf,
  outcomeAppendOf,
  outcomeOfRun,
  runCompletedProject,
  tenantAWideScope,
  testBenchmarkId,
  testOutcomeId,
  unwrap,
} from './test-support';

// OFF-015 benchmarks — THE named acceptance: completed project outcomes can
// be queried and used to produce DETERMINISTIC benchmark facts. The outcome
// set is read through the permissioned query surface (queryOutcomes over the
// folded memory store), computeBenchmarks is the PURE function of that set,
// and re-running the identical query → outcome set → computation produces
// byte-identical benchmarks. Every benchmark value carries the outcome ids
// that produced it (per metric — an outcome that lacks a metric never enters
// that value's producing ids).
//
// The golden tenant-A outcome metrics (pinned in outcome.test.ts):
//   project 1: variance 3,  margin ratio 1/2,  approval 1/1, change events 1
//   project 2: variance 0,  margin ratio 13/20, approval 0/1, change events 2
//   project 3: variance 2,  margin ratio 5/16,  approval 0/1, change events 1

const r = (numerator: number, denominator: number): Rational => ({ numerator, denominator });

/** The golden tenant-A outcome set, queried through the store. */
const queriedTenantAOutcomes = async (): Promise<readonly OutcomeRecord[]> => {
  const outcomes = await Promise.all(
    [GOLDEN_PROJECT_ONE, GOLDEN_PROJECT_TWO, GOLDEN_PROJECT_THREE].map((spec) =>
      runCompletedProject(spec).then(outcomeOfRun),
    ),
  );
  const events = await memoryLedgerOf(outcomes.map(outcomeAppendOf));
  const store = unwrap(projectMemory(events));
  const reader = memoryReaderOf(tenantAWideScope());
  return unwrap(queryOutcomes(store, reader, {}));
};

const tenantABenchmarkParts = () => ({
  benchmarkId: testBenchmarkId(1),
  computedAt: T5,
  actor: USER_ACTOR,
  scope: tenantAWideScope(),
});

describe('THE named acceptance: queried outcomes → deterministic benchmark facts (OFF-015)', () => {
  it('query → outcome set → identical benchmarks on re-run (byte-identical)', async () => {
    // Two COMPLETE pipeline runs: fold the store, query the outcome set,
    // compute the benchmark — twice, from scratch.
    const first = unwrap(
      computeBenchmarks(await queriedTenantAOutcomes(), tenantABenchmarkParts()),
    );
    const second = unwrap(
      computeBenchmarks(await queriedTenantAOutcomes(), tenantABenchmarkParts()),
    );

    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.engine).toBe(MEMORY_ENGINE);
    expect(first.benchmarkVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(first.benchmarkId).toBe(testBenchmarkId(1));
    expect(first.computedAt).toBe(T5);
    expect(first.actor).toStrictEqual(USER_ACTOR);
    expect(first.scope).toStrictEqual(tenantAWideScope());
    expect(first.outcomeCount).toBe(3);
  });

  it('the outcome array arrives shuffled — the computed benchmark is identical', async () => {
    const outcomes = await queriedTenantAOutcomes();
    const straight = unwrap(computeBenchmarks(outcomes, tenantABenchmarkParts()));
    const shuffled = unwrap(
      computeBenchmarks([...outcomes].reverse(), tenantABenchmarkParts()),
    );

    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(straight));
  });

  it('every benchmark value carries the outcome ids that produced it', async () => {
    const benchmark = unwrap(
      computeBenchmarks(await queriedTenantAOutcomes(), tenantABenchmarkParts()),
    );

    expect(benchmark.metrics).toHaveLength(4); // all four metric kinds carry facts here
    for (const metric of benchmark.metrics) {
      expect(metric.outcomeIds.length).toBe(3);
      expect(metric.outcomeIds).toStrictEqual([
        testOutcomeId(1),
        testOutcomeId(2),
        testOutcomeId(3),
      ]);
    }
    // The positions name the positioned outcome per metric.
    for (const position of benchmark.positions) {
      expect([testOutcomeId(1), testOutcomeId(2), testOutcomeId(3)]).toContain(position.outcomeId);
    }
    expect(benchmark.positions).toHaveLength(12); // 4 metrics × 3 outcomes
  });

  it('computes the exact aggregate statistics (hand-checked rationals)', async () => {
    const benchmark = unwrap(
      computeBenchmarks(await queriedTenantAOutcomes(), tenantABenchmarkParts()),
    );

    // schedule-variance-days: values [3, 0, 2] → sorted [0, 2, 3].
    const schedule = benchmark.metrics[0];
    expect(schedule?.kind).toBe('schedule-variance-days');
    expect(schedule?.min).toStrictEqual(r(0, 1));
    expect(schedule?.max).toStrictEqual(r(3, 1));
    expect(schedule?.mean).toStrictEqual(r(5, 3)); // (0+2+3)/3
    expect(schedule?.median).toStrictEqual(r(2, 1));
    expect(schedule?.percentile90).toStrictEqual(r(3, 1)); // ceil(0.9×3) = 3rd smallest

    // margin-ratio: values [1/2, 13/20, 5/16] → sorted [5/16, 1/2, 13/20].
    const margin = benchmark.metrics[1];
    expect(margin?.kind).toBe('margin-ratio');
    expect(margin?.min).toStrictEqual(r(5, 16));
    expect(margin?.max).toStrictEqual(r(13, 20));
    expect(margin?.mean).toStrictEqual(r(39, 80)); // (25+40+52)/80/3
    expect(margin?.median).toStrictEqual(r(1, 2));
    expect(margin?.percentile90).toStrictEqual(r(13, 20));

    // entitlement-approval-rate: values [1/1, 0/1, 0/1] → sorted [0, 0, 1].
    const approval = benchmark.metrics[2];
    expect(approval?.kind).toBe('entitlement-approval-rate');
    expect(approval?.min).toStrictEqual(r(0, 1));
    expect(approval?.max).toStrictEqual(r(1, 1));
    expect(approval?.mean).toStrictEqual(r(1, 3));
    expect(approval?.median).toStrictEqual(r(0, 1));
    expect(approval?.percentile90).toStrictEqual(r(1, 1));

    // change-event-count: values [1, 2, 1] → sorted [1, 1, 2].
    const change = benchmark.metrics[3];
    expect(change?.kind).toBe('change-event-count');
    expect(change?.min).toStrictEqual(r(1, 1));
    expect(change?.max).toStrictEqual(r(2, 1));
    expect(change?.mean).toStrictEqual(r(4, 3));
    expect(change?.median).toStrictEqual(r(1, 1));
    expect(change?.percentile90).toStrictEqual(r(2, 1));
  });

  it('computes the exact percentile positions (ties counted half)', async () => {
    const benchmark = unwrap(
      computeBenchmarks(await queriedTenantAOutcomes(), tenantABenchmarkParts()),
    );
    const positionOf = (metricKind: string, outcomeId: string): Rational => {
      const position = benchmark.positions.find(
        (entry) => entry.metricKind === metricKind && entry.outcomeId === outcomeId,
      );
      if (position === undefined) throw new Error(`no position for ${metricKind}/${outcomeId}`);
      return position.position;
    };

    // schedule variance: 0 → 1/6, 2 → 3/6, 3 → 5/6.
    expect(positionOf('schedule-variance-days', testOutcomeId(2))).toStrictEqual(r(1, 6));
    expect(positionOf('schedule-variance-days', testOutcomeId(3))).toStrictEqual(r(1, 2));
    expect(positionOf('schedule-variance-days', testOutcomeId(1))).toStrictEqual(r(5, 6));
    // margin ratio: 5/16 → 1/6, 1/2 → 3/6, 13/20 → 5/6.
    expect(positionOf('margin-ratio', testOutcomeId(3))).toStrictEqual(r(1, 6));
    expect(positionOf('margin-ratio', testOutcomeId(1))).toStrictEqual(r(1, 2));
    expect(positionOf('margin-ratio', testOutcomeId(2))).toStrictEqual(r(5, 6));
    // approval rate: the tie (0, 0) ranks (0 + 2/2·2)/6 = 2/6 each; 1 → 5/6.
    expect(positionOf('entitlement-approval-rate', testOutcomeId(2))).toStrictEqual(r(1, 3));
    expect(positionOf('entitlement-approval-rate', testOutcomeId(3))).toStrictEqual(r(1, 3));
    expect(positionOf('entitlement-approval-rate', testOutcomeId(1))).toStrictEqual(r(5, 6));
    // change events: the tie (1, 1) ranks 2/6 each; 2 → 5/6.
    expect(positionOf('change-event-count', testOutcomeId(1))).toStrictEqual(r(1, 3));
    expect(positionOf('change-event-count', testOutcomeId(3))).toStrictEqual(r(1, 3));
    expect(positionOf('change-event-count', testOutcomeId(2))).toStrictEqual(r(5, 6));
  });
});

describe('benchmark purity and drift discipline (OFF-015, A2/A7)', () => {
  it('a different outcome set produces a DIFFERENT benchmark fact (never a mutation)', async () => {
    const outcomes = await queriedTenantAOutcomes();
    const subset = outcomes.filter((outcome) => outcome.outcomeId !== testOutcomeId(3));
    const full = unwrap(computeBenchmarks(outcomes, tenantABenchmarkParts()));
    const partial = unwrap(computeBenchmarks(subset, tenantABenchmarkParts()));

    expect(partial.outcomeCount).toBe(2);
    // The partial benchmark's producing ids are exactly its own outcome set.
    for (const metric of partial.metrics) {
      expect(metric.outcomeIds).toStrictEqual([testOutcomeId(1), testOutcomeId(2)]);
    }
    // The values differ: mean schedule variance (3+0)/2 vs (3+0+2)/3.
    const partialSchedule = partial.metrics[0];
    const fullSchedule = full.metrics[0];
    expect(partialSchedule?.mean).toStrictEqual(r(3, 2));
    expect(compareRationals(partialSchedule?.mean ?? r(0, 1), fullSchedule?.mean ?? r(0, 1))).not.toBe(
      0,
    );
    // An even count computes the exact mean of the middle two as the median.
    expect(partialSchedule?.median).toStrictEqual(r(3, 2)); // (0 + 3)/2
  });

  it('is a pure function of the outcome set: different identity, identical values', async () => {
    const outcomes = await queriedTenantAOutcomes();
    const first = unwrap(computeBenchmarks(outcomes, tenantABenchmarkParts()));
    const second = unwrap(
      computeBenchmarks(outcomes, {
        benchmarkId: testBenchmarkId(2),
        computedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );

    expect(second.benchmarkId).toBe(testBenchmarkId(2));
    expect(second.metrics).toStrictEqual(first.metrics);
    expect(second.positions).toStrictEqual(first.positions);
    expect(second.outcomeCount).toBe(first.outcomeCount);
  });

  it("an outcome lacking a metric never enters that value's producing ids", async () => {
    // Project one re-derived with a zero contracted value would carry no
    // margin ratio; simulate that by computing over a metric-stripped copy.
    const outcomes = await queriedTenantAOutcomes();
    const first = outcomes.find((outcome) => outcome.outcomeId === testOutcomeId(1));
    if (first === undefined) throw new Error('outcome one missing');
    const stripped: OutcomeRecord = {
      ...first,
      margin: { ...first.margin, marginRatio: null }, // zero contracted value → undefined ratio
    };
    const benchmark = unwrap(
      computeBenchmarks([stripped, ...outcomes.slice(1)], tenantABenchmarkParts()),
    );

    const marginMetric = benchmark.metrics.find((metric) => metric.kind === 'margin-ratio');
    expect(marginMetric?.outcomeIds).toStrictEqual([testOutcomeId(2), testOutcomeId(3)]);
    // The other metrics still carry all three producing outcomes.
    const scheduleMetric = benchmark.metrics.find(
      (metric) => metric.kind === 'schedule-variance-days',
    );
    expect(scheduleMetric?.outcomeIds).toHaveLength(3);
  });
});

describe('computeBenchmarks fail-closed rejections (OFF-015, A12)', () => {
  it('typed-rejects an empty outcome set', async () => {
    const result = computeBenchmarks([], tenantABenchmarkParts());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('benchmark-outcome-set-nonempty');
    }
  });

  it('typed-rejects a duplicate outcome id (an outcome set is a set)', async () => {
    const outcomes = await queriedTenantAOutcomes();
    const duplicate = [...outcomes, outcomes[0] as OutcomeRecord];
    const result = computeBenchmarks(duplicate, tenantABenchmarkParts());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('benchmark-outcome-ids-distinct');
    }
  });

  it('typed-rejects a mixed-tenant outcome set (A12: one tenant, never mixed)', async () => {
    const tenantAOutcomes = await queriedTenantAOutcomes();
    const tenantBOutcome = outcomeOfRun(await runCompletedProject(GOLDEN_PROJECT_B1));
    const result = computeBenchmarks([...tenantAOutcomes, tenantBOutcome], tenantABenchmarkParts());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('benchmark-tenant-scope');
      expect(result.error.details[0]?.message).toContain(TENANT_A);
    }
  });

  it('the benchmark identity is injected, never derived (no clock, no randomness)', async () => {
    const outcomes = await queriedTenantAOutcomes();
    const parts = tenantABenchmarkParts();
    const first = unwrap(computeBenchmarks(outcomes, parts));
    const again = unwrap(computeBenchmarks(outcomes, parts));
    // Nothing in the VALUES carries run identity — only the injected parts.
    const snapshot: Benchmark = { ...again };
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(first));
  });
});
