import { beforeAll, describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import {
  DETECTED_AT,
  projectOneReader,
  projectOneScope,
  testScanId,
  unwrap,
} from './test-support';
import {
  COST_BUDGET,
  COST_CHANGE_EVENT,
  COST_CONTRACT,
  ENTITLEMENT_CHANGE_EVENT,
  ENTITLEMENT_CONTRACT,
  ENTITLEMENT_ORDER_3,
  GAP_CHANGE_EVENT,
  GAP_CONTRACT,
  GOLDEN_PRIORITY_ORDER,
  SCHEDULE_CHANGE_EVENT,
  SLIP_ACTIVITY_2,
  SLIP_ACTIVITY_3,
  runPortfolioScan,
  rankedShapeOf,
} from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import { detectExceptions } from './scan';
import type { ExceptionScanInputs } from './scan';
import { rankExceptions } from './rank';
import type { Exception, RankedException } from './model';

// THE NAMED ACCEPTANCE of OFF-019: the golden seeded portfolio — a schedule
// slip (with a downstream dependency chain), a cost overrun, an entitlement
// exposure, and an evidence gap, scanned together with the completed-project
// calibration benchmark — produces the IDENTICAL exception set and the
// IDENTICAL stable priority ordering across runs and across input
// orderings, and every exception's evidence chain resolves to the producing
// source ids (the scenario's ledger event ids, the producing assessment id,
// and the calibration benchmark id).

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

const inputsOf = (source: PortfolioScanRun): ExceptionScanInputs => ({
  assessments: source.assessments,
  subgraphs: source.subgraphs,
  benchmarks: [source.benchmark],
});

const scanAgain = (): readonly Exception[] =>
  unwrap(
    detectExceptions(inputsOf(run), projectOneReader(), {
      scanId: testScanId(1),
      detectedAt: DETECTED_AT,
    }),
  );

describe('THE golden seeded portfolio scan (OFF-019 named acceptance)', () => {
  it('detects exactly one exception per kind, in canonical emission order', () => {
    expect(run.exceptions.map((exception) => exception.kind)).toStrictEqual([
      'schedule-slip',
      'cost-overrun',
      'entitlement-exposure',
      'dependency-risk',
      'evidence-gap',
    ]);
  });

  it('derives every exception identity from the injected scan identity', () => {
    expect(run.exceptions.map((exception) => exception.exceptionId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
      'scan-0001#0004',
      'scan-0001#0005',
    ]);
    for (const exception of run.exceptions) {
      expect(exception.provenance.scanId).toBe('scan-0001');
      expect(exception.detectedAt).toBe(DETECTED_AT);
      expect(exception.provenance.detectedAt).toBe(DETECTED_AT);
      expect(exception.provenance.consumed).toStrictEqual({
        assessmentCount: 4,
        subgraphCount: 4,
        benchmarkCount: 1,
      });
    }
  });

  it('runs the whole pipeline byte-identically twice (A7 rebuildability)', async () => {
    const second = await runPortfolioScan();
    expect(second.exceptions).toStrictEqual(run.exceptions);
    expect(second.ranked).toStrictEqual(run.ranked);
    expect(rankedShapeOfEach(second.ranked)).toStrictEqual(rankedShapeOfEach(run.ranked));
  });

  it('scans run-twice into the byte-identical exception set (determinism)', () => {
    const first = scanAgain();
    const second = scanAgain();
    expect(first).toStrictEqual(run.exceptions);
    expect(second).toStrictEqual(first);
  });

  it('produces the identical exception set under every input permutation', () => {
    const permutations: readonly ExceptionScanInputs[] = [
      // reversed
      {
        assessments: [...run.assessments].reverse(),
        subgraphs: [...run.subgraphs].reverse(),
        benchmarks: [run.benchmark],
      },
      // rotated by one and by two
      {
        assessments: rotate(run.assessments, 1),
        subgraphs: rotate(run.subgraphs, 2),
        benchmarks: [run.benchmark],
      },
      // interleaved (first/last swap + middle swap)
      {
        assessments: swap(rotate(run.assessments, 2), 0, 3),
        subgraphs: swap(rotate(run.subgraphs, 1), 1, 2),
        benchmarks: [run.benchmark],
      },
    ];
    for (const [index, permutation] of permutations.entries()) {
      const scanned = unwrap(
        detectExceptions(permutation, projectOneReader(), {
          scanId: testScanId(1),
          detectedAt: DETECTED_AT,
        }),
      );
      expect(scanned, `permutation ${index}`).toStrictEqual(run.exceptions);
    }
  });

  it('produces THE stable golden priority ordering (identical across runs)', () => {
    expect(run.ranked.map(rankedShapeOf)).toStrictEqual(GOLDEN_PRIORITY_ORDER);
    // Rank positions are dense, 1-based, and stable.
    expect(run.ranked.map((ranked) => ranked.rank)).toStrictEqual([1, 2, 3, 4, 5]);
    // Re-ranking the identical set reproduces the identical order.
    const reRanked = unwrap(rankExceptions(run.exceptions));
    expect(reRanked).toStrictEqual(run.ranked);
    // Ranking a permutation of the identical set reproduces the identical order.
    const permuted = unwrap(rankExceptions([...run.exceptions].reverse()));
    expect(permuted.map(rankedShapeOf)).toStrictEqual(GOLDEN_PRIORITY_ORDER);
  });
});

describe('THE evidence chains resolve to the producing source ids (OFF-019)', () => {
  const scenarioOf = (exception: Exception) => {
    const assessmentId = exception.economicImpact.assessmentIds[0];
    const scenario = run.scenarios.find((built) => built.assessmentId === assessmentId);
    expect(scenario, `no producing scenario for assessment ${String(assessmentId)}`).toBeDefined();
    return scenario!;
  };

  it('carries the producing assessment + its source event in every chain', () => {
    for (const exception of run.exceptions) {
      const scenario = scenarioOf(exception);
      const assessmentEvidence = exception.evidence.filter((evidence) => evidence.kind === 'assessment');
      expect(assessmentEvidence).toHaveLength(1);
      if (assessmentEvidence[0]?.kind === 'assessment') {
        expect(assessmentEvidence[0].assessmentId).toBe(scenario.assessmentId);
      }
      // The primary producing event is the scenario's changeEventRaised event.
      expect(exception.primarySource.eventId).toBe(scenario.sourceEventId);
      expect(exception.primarySource.eventName).toBe('contracts.changeEventRaised');
      const sourceEvent = scenario.events.find(
        (event) => event.eventId === scenario.sourceEventId,
      );
      expect(sourceEvent).toBeDefined();
      if (sourceEvent !== undefined) {
        expect(exception.primarySource.occurredAt).toBe(sourceEvent.envelope.occurredAt);
        expect(exception.primarySource.correlationId).toBe(
          sourceEvent.envelope.causality.correlationId,
        );
      }
      // Every economic impact references its producing assessment id.
      expect(exception.economicImpact.assessmentIds).toStrictEqual([scenario.assessmentId]);
    }
  });

  it('resolves every event reference to a ledger event id of the producing scenario', () => {
    for (const exception of run.exceptions) {
      const scenario = scenarioOf(exception);
      const scenarioEventIds = new Set(scenario.events.map((event) => event.eventId));
      const eventEvidence = exception.evidence.filter((evidence) => evidence.kind === 'event');
      expect(eventEvidence.length).toBeGreaterThan(0);
      for (const evidence of eventEvidence) {
        if (evidence.kind !== 'event') continue;
        expect(
          scenarioEventIds.has(evidence.eventId),
          `evidence event ${String(evidence.eventId)} resolves outside the producing scenario`,
        ).toBe(true);
        expect(evidence.eventName).toBe(
          scenario.events.find((event) => event.eventId === evidence.eventId)?.envelope.eventName,
        );
      }
    }
  });

  it('resolves every benchmark reference to the calibration benchmark that fired', () => {
    for (const exception of run.exceptions) {
      const benchmarkEvidence = exception.evidence.filter((evidence) => evidence.kind === 'benchmark');
      for (const evidence of benchmarkEvidence) {
        if (evidence.kind !== 'benchmark') continue;
        expect(evidence.benchmarkId).toBe(run.benchmark.benchmarkId);
        expect(evidence.metricKind).toBe(
          exception.kind === 'cost-overrun' ? 'margin-ratio' : 'schedule-variance-days',
        );
      }
      // A benchmark is cited ONLY through the severity calibration.
      expect(
        benchmarkEvidence.map((evidence) =>
          evidence.kind === 'benchmark' ? evidence.benchmarkId : null,
        ),
      ).toStrictEqual(exception.provenance.calibrationBenchmarkIds);
    }
  });

  it('carries the scan\'s scope on every exception (A12)', () => {
    for (const exception of run.exceptions) {
      expect(exception.scope).toStrictEqual(projectOneScope());
    }
  });
});

describe('the pinned golden exception claims (OFF-019)', () => {
  const ref = (entityKind: string, entityId: string): EntityRef =>
    ({ entityKind, entityId }) as EntityRef;

  it('claims the typed severities with their deterministic reasons', () => {
    expect(run.exceptions.map((exception) => exception.severity)).toStrictEqual([
      // 2-day slip beyond the benchmarked p90 of 1 day: minor escalated to moderate.
      { level: 'moderate', reasons: ['benchmark-beyond-percentile90', 'schedule-slip-days'] },
      // 3M over 8M contracted (3/8, major) with margin -3/8 below the benchmarked minimum: critical.
      { level: 'critical', reasons: ['benchmark-below-minimum', 'cost-overrun-share'] },
      // 1M pending over the 14.5M contracted position (2/29): moderate.
      { level: 'moderate', reasons: ['entitlement-pending-share'] },
      // One downstream activity gated: minor.
      { level: 'minor', reasons: ['dependency-downstream-count'] },
      // One low-confidence reason: minor.
      { level: 'minor', reasons: ['evidence-confidence-reasons'] },
    ]);
  });

  it('claims the economic impacts with their producing assessment ids', () => {
    expect(run.exceptions.map((exception) => exception.economicImpact)).toStrictEqual([
      { amountMinor: null, currency: null, assessmentIds: ['assessment-0001'] },
      { amountMinor: 3_000_000, currency: 'USD', assessmentIds: ['assessment-0002'] },
      { amountMinor: 1_000_000, currency: 'USD', assessmentIds: ['assessment-0003'] },
      // The dependency risk is detected over the schedule scenario's
      // assessment + subgraph (the same producing assessment).
      { amountMinor: null, currency: null, assessmentIds: ['assessment-0001'] },
      { amountMinor: null, currency: null, assessmentIds: ['assessment-0004'] },
    ]);
  });

  it('claims the affected entities (deduplicated, canonical order)', () => {
    expect(run.exceptions.map((exception) => exception.affected)).toStrictEqual([
      [
        ref('activity', SLIP_ACTIVITY_2),
        ref('activity', SLIP_ACTIVITY_3),
        ref('change-event', SCHEDULE_CHANGE_EVENT),
      ],
      [
        ref('budget', COST_BUDGET),
        ref('change-event', COST_CHANGE_EVENT),
        ref('contract', COST_CONTRACT),
      ],
      [
        ref('change-event', ENTITLEMENT_CHANGE_EVENT),
        ref('change-order', ENTITLEMENT_ORDER_3),
        ref('contract', ENTITLEMENT_CONTRACT),
      ],
      [
        ref('activity', SLIP_ACTIVITY_2),
        ref('activity', SLIP_ACTIVITY_3),
        ref('change-event', SCHEDULE_CHANGE_EVENT),
      ],
      [
        ref('change-event', GAP_CHANGE_EVENT),
        ref('contract', GAP_CONTRACT),
      ],
    ]);
  });

  it('carries the deterministic titles', () => {
    expect(run.exceptions.map((exception) => exception.title)).toStrictEqual([
      `Schedule slip of 2 days on change event ${SCHEDULE_CHANGE_EVENT}`,
      `Cost overrun of 3000000 minor units on contract ${COST_CONTRACT}`,
      `Entitlement exposure of 1000000 minor units across 1 undecided change order`,
      `Dependency risk: 1 downstream activity gated by slipped activities of change event ${SCHEDULE_CHANGE_EVENT}`,
      `Evidence gap: the impact assessment of change event ${GAP_CHANGE_EVENT} carries low confidence (1 reason)`,
    ]);
  });
});

const rankedShapeOfEach = (ranked: readonly RankedException[]) => ranked.map(rankedShapeOf);

/** Rotate an array left by `by` (a fixed, deterministic permutation). */
const rotate = <T>(values: readonly T[], by: number): readonly T[] => {
  if (values.length === 0) return values;
  const offset = ((by % values.length) + values.length) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
};

/** Swap two positions of an array (a fixed, deterministic permutation). */
const swap = <T>(values: readonly T[], left: number, right: number): readonly T[] => {
  const copy = [...values];
  const a = copy[left];
  const b = copy[right];
  if (a !== undefined) copy[right] = a;
  if (b !== undefined) copy[left] = b;
  return copy;
};
