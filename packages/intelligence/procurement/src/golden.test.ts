import { beforeAll, describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import { committedAmountMinorOf } from '@office/domain-cost';
import {
  DETECTED_AT,
  TENANT_A,
  T1,
  projectOneScope,
  tenantBReader,
  tenantBScope,
  tenantReader,
  testOutcomeId,
  testScanId,
  unwrap,
  USER_ACTOR,
} from './test-support';
import {
  GOLDEN_PREFERENCE_ORDER,
  HISTORY_BENCHMARK,
  HISTORY_OUTCOMES,
  SPLIT_COMMITMENT,
  SWITCH_COMMITMENT,
  TIMING_COMMITMENT,
  goldenInputsOf,
  rankedShapeOf,
  runGoldenProcurementScan,
  splitScenario,
  switchScenario,
  timingScenario,
} from './scenarios';
import type { GoldenProcurementRun } from './scenarios';
import { detectProcurementRecommendations } from './recommendation';
import type { ProcurementRecommendation } from './recommendation';
import { rankProcurementRecommendations } from './ranking';
import { commitProcurementDecision, proposeNextActions } from './proposal';
import type { ProcurementPolicyDecision } from './model';
import { CREATE_COMMITMENT_COMMAND, DEFAULT_PREFERENCE_WEIGHTS, PREFERENCE_FORMULA } from './model';
import {
  createInMemoryProcurementEventSink,
  emitProcurementRecommendationProposed,
  procurementRecommendationProposedEnvelope,
} from './audit';
import type { ProcurementSinkExecutor } from './audit';

// THE NAMED ACCEPTANCE of OFF-034: the golden seeded sourcing portfolio —
// a VENDOR SWITCH (vendor-02 quotes 7,800,000 minor units against the
// 8,500,000-minor-unit incumbent path: an exact 7/85 saving share over the
// 1/40 noise threshold), an ORDER SPLITTING (two vendors cover the 8,000
// milli-unit scope for 7,100,000 against the 7,400,000-minor-unit incumbent
// path), and a LEAD-TIME-DRIVEN TIMING SHIFT (vendor-07 delivers 20 days
// faster than the incumbent's own re-quote while paying a 600,000 premium
// over it, still undercutting the 10,600,000-minor-unit incumbent path and
// avoiding a 12-day assessed delay beyond the benchmarked p90 of 3 days) —
// scanned together with the completed-project history (six outcome records
// + the tenant benchmark) produces typed ProcurementRecommendation records
// whose historical basis resolves to referenced OutcomeRecord/benchmark
// facts and whose projected economic impact resolves to referenced
// ImpactAssessment values with the composition exposed and recomputable BY
// HAND, with the stable ranked order (identical across runs and input
// orderings) and NO automatic commitment: the engine only PROPOSES typed
// ProposedNextAction records, and commitment without an explicit policy
// decision is a typed rejection.

let run: GoldenProcurementRun;

beforeAll(() => {
  run = runGoldenProcurementScan();
});

const scanAgain = (inputs = goldenInputsOf(run)): readonly ProcurementRecommendation[] =>
  unwrap(
    detectProcurementRecommendations(inputs, tenantReader(), {
      scanId: testScanId(1),
      detectedAt: DETECTED_AT,
    }),
  );

describe('THE golden seeded procurement scan (OFF-034 named acceptance)', () => {
  it('detects exactly one typed recommendation per golden scenario, in canonical emission order', () => {
    expect(run.recommendations.map((recommendation) => recommendation.kind)).toStrictEqual([
      'vendor-switch',
      'order-splitting',
      'timing-shift',
    ]);
    // Each recommendation is the typed projection of exactly ONE golden need.
    expect(
      run.recommendations.map((recommendation) => recommendation.projectedImpact.assessmentIds),
    ).toStrictEqual([
      [switchScenario().assessment.assessmentId],
      [splitScenario().assessment.assessmentId],
      [timingScenario().assessment.assessmentId],
    ]);
  });

  it('derives every identity from the injected scan identity (no id supplier, no clock)', () => {
    expect(run.recommendations.map((recommendation) => recommendation.recommendationId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
    ]);
    expect(
      run.recommendations.map((recommendation) => recommendation.comparison.comparisonId),
    ).toStrictEqual(['scan-0001#c0001', 'scan-0001#c0002', 'scan-0001#c0003']);
    for (const recommendation of run.recommendations) {
      expect(recommendation.provenance.scanId).toBe('scan-0001');
      expect(recommendation.detectedAt).toBe(DETECTED_AT);
      expect(recommendation.provenance.detectedAt).toBe(DETECTED_AT);
      expect(recommendation.recommendationVersion).toBe(1);
      expect(recommendation.comparison.comparisonVersion).toBe(1);
      expect(recommendation.engine).toBe('intelligence-procurement');
      expect(recommendation.comparison.engine).toBe('intelligence-procurement');
      expect(recommendation.actor).toStrictEqual(USER_ACTOR);
      expect(recommendation.comparison.actor).toStrictEqual(USER_ACTOR);
      expect(recommendation.scope).toStrictEqual(projectOneScope());
      expect(recommendation.provenance.consumed).toStrictEqual({
        budgetCount: 3,
        commitmentCount: 3,
        alternativeCount: 7,
        assessmentCount: 3,
        outcomeCount: 6,
        benchmarkCount: 1,
      });
    }
  });

  it('runs the whole pipeline byte-identically twice (A7 rebuildability)', () => {
    const second = runGoldenProcurementScan();
    expect(second.recommendations).toStrictEqual(run.recommendations);
    expect(second.ranked).toStrictEqual(run.ranked);
    expect(second.ranked.map(rankedShapeOf)).toStrictEqual(run.ranked.map(rankedShapeOf));
  });

  it('scans run-twice into the byte-identical recommendation set (determinism)', () => {
    const first = scanAgain();
    const second = scanAgain();
    expect(first).toStrictEqual(run.recommendations);
    expect(second).toStrictEqual(first);
  });

  it('produces the identical recommendation set under every input permutation', () => {
    const base = goldenInputsOf(run);
    const permutations = [
      {
        ...base,
        budgets: [...base.budgets].reverse(),
        commitments: [...base.commitments].reverse(),
      },
      {
        ...base,
        alternatives: rotate(base.alternatives, 3),
        assessments: rotate(base.assessments, 1),
        outcomes: rotate(base.outcomes, 2),
      },
      {
        ...base,
        budgets: swap(rotate(base.budgets, 2), 0, 2),
        commitments: swap(rotate(base.commitments, 1), 0, 2),
        alternatives: [...base.alternatives].reverse(),
        assessments: swap(rotate(base.assessments, 2), 0, 2),
        outcomes: [...base.outcomes].reverse(),
      },
    ];
    for (const [index, permutation] of permutations.entries()) {
      const scanned = scanAgain(permutation);
      expect(scanned, `permutation ${index}`).toStrictEqual(run.recommendations);
    }
  });

  it('typed-rejects cross-tenant scans in BOTH directions (A12, never an existence oracle)', () => {
    // A tenant-B caller over the tenant-A golden inputs: typed rejection.
    const foreign = detectProcurementRecommendations(goldenInputsOf(run), tenantBReader(), {
      scanId: testScanId(2),
      detectedAt: DETECTED_AT,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('unauthorized');
      expect(foreign.error.details[0]?.code).toBe('procurement-input-scope');
      // The rejection never names the foreign scope (no tenant/project leak).
      expect(JSON.stringify(foreign.error)).not.toContain(String(TENANT_A));
    }
    // A tenant-A caller with ONE tenant-B-poisoned input: typed rejection
    // too. (The poisoned outcome carries a NEW outcome id — the duplicate-
    // identity gate runs before the scope gate by the documented scan order,
    // so re-using an existing id would trip the duplicate gate instead.)
    const poisoned = {
      ...goldenInputsOf(run),
      outcomes: [
        ...run.outcomes,
        { ...HISTORY_OUTCOMES[0]!, outcomeId: testOutcomeId(90), scope: tenantBScope() },
      ],
    };
    const rejected = detectProcurementRecommendations(poisoned, tenantReader(), {
      scanId: testScanId(3),
      detectedAt: DETECTED_AT,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('procurement-input-scope');
    }
  });
});

describe('THE evidence chains resolve end-to-end to producing source records (A4)', () => {
  /** Every ledger event id the producing assessment's own evidence cites. */
  const scenarioEventIdsOf = (
    assessment: GoldenProcurementRun['assessments'][number],
  ): ReadonlySet<string> =>
    new Set<string>([
      assessment.source.eventId,
      ...assessment.evidence.map((reference) => reference.eventId),
      ...assessment.costImpact.evidence.map((reference) => reference.eventId),
      ...assessment.costImpact.itemDeltas.map((delta) => delta.source.eventId),
      ...assessment.scheduleImpact.evidence.map((reference) => reference.eventId),
      ...assessment.scheduleImpact.activityDeltas.flatMap((delta) =>
        delta.drivers.map((driver) => driver.eventId),
      ),
    ]);

  const canonicalRecordRefs = (): ReadonlySet<string> =>
    new Set([
      ...run.budgets.map((budget) => `budget:${String(budget.entityId)}`),
      ...run.commitments.map((commitment) => `commitment:${String(commitment.entityId)}`),
      ...run.budgets.flatMap((budget) =>
        Object.values(budget.costItems).map(
          (item) => `cost-item:${String(item.entityId)}`,
        ),
      ),
    ]);

  it('resolves every record reference to a golden canonical cost-domain record', () => {
    const recordRefs = canonicalRecordRefs();
    for (const recommendation of run.recommendations) {
      for (const ref of recommendation.referencedRecords) {
        expect(
          recordRefs.has(`${String(ref.entityKind)}:${String(ref.entityId)}`),
          `${recommendation.recommendationId} references ${String(ref.entityKind)} ${String(ref.entityId)} outside the golden records`,
        ).toBe(true);
      }
      const recordEvidence = recommendation.evidence.filter((evidence) => evidence.kind === 'record');
      for (const evidence of recordEvidence) {
        if (evidence.kind !== 'record') continue;
        expect(
          recordRefs.has(`${String(evidence.ref.entityKind)}:${String(evidence.ref.entityId)}`),
          `record evidence ${String(evidence.ref.entityId)} resolves outside the golden records`,
        ).toBe(true);
        // The version and createdAt cite the referenced record's own read surface.
        const budget = run.budgets.find((candidate) => candidate.entityId === evidence.ref.entityId);
        const commitment = run.commitments.find(
          (candidate) => candidate.entityId === evidence.ref.entityId,
        );
        const costItem = run.budgets
          .flatMap((candidate) => Object.values(candidate.costItems))
          .find((candidate) => candidate.entityId === evidence.ref.entityId);
        if (budget !== undefined) {
          expect(evidence.version).toBe(budget.version);
          expect(evidence.createdAt).toBe(budget.createdAt);
        }
        if (commitment !== undefined) {
          expect(evidence.version).toBe(commitment.version);
          expect(evidence.createdAt).toBe(commitment.createdAt);
        }
        if (costItem !== undefined) {
          // The cost item rides its OWNING budget root's version.
          const owning = run.budgets.find((candidate) =>
            Object.values(candidate.costItems).some((item) => item.entityId === costItem.entityId),
          );
          expect(evidence.version).toBe(owning?.version);
          expect(evidence.createdAt).toBe(costItem.createdAt);
        }
      }
      // Referenced records are the canonical (kind, id) order, deduplicated.
      expect(recommendation.referencedRecords).toStrictEqual(
        dedupeByKindId(recommendation.referencedRecords),
      );
    }
  });

  it('resolves every event reference to a ledger event id of the producing assessment', () => {
    for (const recommendation of run.recommendations) {
      const assessment = run.assessments.find(
        (input) => input.assessmentId === recommendation.projectedImpact.assessmentIds[0],
      );
      expect(assessment, `no producing assessment for ${recommendation.recommendationId}`).toBeDefined();
      if (assessment === undefined) continue;
      const scenarioEventIds = scenarioEventIdsOf(assessment);
      const eventEvidence = recommendation.evidence.filter((evidence) => evidence.kind === 'event');
      expect(eventEvidence.length).toBeGreaterThan(0);
      for (const evidence of eventEvidence) {
        if (evidence.kind !== 'event') continue;
        expect(
          scenarioEventIds.has(String(evidence.eventId)),
          `evidence event ${String(evidence.eventId)} resolves outside the producing scenario`,
        ).toBe(true);
      }
      // THE primary producing source anchor (the A3 causation id).
      expect(recommendation.primarySource.eventId).toBe(assessment.source.eventId);
      expect(recommendation.primarySource.eventName).toBe('contracts.changeEventRaised');
      expect(recommendation.primarySource.occurredAt).toBe(assessment.source.occurredAt);
      expect(recommendation.primarySource.occurredAt).toBe(T1);
      expect(recommendation.primarySource.correlationId).toBe(assessment.source.correlationId);
    }
  });

  it('resolves every assessment/outcome/benchmark reference to the scan inputs', () => {
    const assessmentIds = new Set(run.assessments.map((assessment) => String(assessment.assessmentId)));
    const outcomeIds = new Set(run.outcomes.map((outcome) => String(outcome.outcomeId)));
    const benchmarkId = String(HISTORY_BENCHMARK.benchmarkId);
    for (const recommendation of run.recommendations) {
      const assessmentEvidence = recommendation.evidence.filter(
        (evidence) => evidence.kind === 'assessment',
      );
      expect(assessmentEvidence).toHaveLength(1);
      for (const evidence of assessmentEvidence) {
        if (evidence.kind !== 'assessment') continue;
        expect(assessmentIds.has(String(evidence.assessmentId))).toBe(true);
        expect(evidence.sourceEventId).toBe(
          run.assessments.find(
            (input) => input.assessmentId === evidence.assessmentId,
          )?.source.eventId,
        );
        expect(evidence.changeEventId).toBe(
          run.assessments.find((input) => input.assessmentId === evidence.assessmentId)?.source
            .changeEventId,
        );
      }
      for (const evidence of recommendation.evidence) {
        if (evidence.kind === 'outcome') {
          expect(outcomeIds.has(String(evidence.outcomeId))).toBe(true);
        }
        if (evidence.kind === 'benchmark') {
          expect(String(evidence.benchmarkId)).toBe(benchmarkId);
        }
      }
      // The historical basis references the same producing facts.
      for (const outcomeId of recommendation.historicalBasis.outcomeIds) {
        expect(outcomeIds.has(String(outcomeId))).toBe(true);
      }
      for (const fact of recommendation.historicalBasis.benchmarks) {
        expect(String(fact.benchmarkId)).toBe(benchmarkId);
      }
    }
  });

  it('carries a complete, qualified EvidenceSet (the agents discipline — never empty)', () => {
    for (const recommendation of run.recommendations) {
      expect(recommendation.evidenceSet.items.length).toBeGreaterThan(0);
      // The assessment item + one item per historical outcome, canonical order.
      const refs = recommendation.evidenceSet.items.map((item) => item.ref);
      expect(refs[0]).toBe(recommendation.projectedImpact.assessmentIds[0]);
      expect(refs.slice(1)).toStrictEqual([...recommendation.historicalBasis.outcomeIds].sort());
      for (const item of recommendation.evidenceSet.items) {
        expect(item.retrieval.tool).toBe('procurement-recommendation-detection');
        expect(item.retrieval.retrievedAt).toBe(DETECTED_AT);
        expect(item.entity).not.toBeNull();
      }
    }
  });
});

describe('THE pinned golden recommendation claims (OFF-034)', () => {
  const ref = (entityKind: string, entityId: string): EntityRef =>
    ({ entityKind, entityId }) as EntityRef;

  it('claims the selected alternatives with their cited normalized prices', () => {
    expect(
      run.recommendations.map((recommendation) => recommendation.selectedAlternatives),
    ).toStrictEqual([
      [
        {
          alternativeId: 'quote-a2',
          vendorKey: 'vendor-02',
          normalizedAmountMinor: 7_800_000,
        },
      ],
      [
        {
          alternativeId: 'quote-b2',
          vendorKey: 'vendor-04',
          normalizedAmountMinor: 3_500_000,
        },
        {
          alternativeId: 'quote-b3',
          vendorKey: 'vendor-05',
          normalizedAmountMinor: 3_600_000,
        },
      ],
      [
        {
          alternativeId: 'quote-c2',
          vendorKey: 'vendor-07',
          normalizedAmountMinor: 10_200_000,
        },
      ],
    ]);
  });

  it('claims the projected economic impact with the composition exposed and recomputed BY HAND', () => {
    // THE hand recomputation: every component cites a referenced record's
    // OWN number (the incumbent commitment's current amount, the producing
    // assessment's own budget-revision delta, each selected quote's own
    // terms), and the components' signed sum IS the projected delta.
    const switchAssessment = switchScenario().assessment;
    const splitAssessment = splitScenario().assessment;
    const timingAssessment = timingScenario().assessment;
    const incumbentAmounts = run.commitments.map((commitment) =>
      committedAmountMinorOf(commitment),
    );
    expect(incumbentAmounts).toStrictEqual([8_000_000, 7_000_000, 10_000_000]);

    expect(
      run.recommendations.map((recommendation) => recommendation.projectedImpact.components),
    ).toStrictEqual([
      [
        {
          role: 'incumbent-commitment-release',
          amountMinor: -8_000_000,
          citedFrom: 'commitment-current-amount',
          assessmentId: null,
          alternativeId: null,
        },
        {
          role: 'assessed-delta-adjustment',
          amountMinor: -500_000,
          citedFrom: 'assessment-cost-impact-budget-revision-delta',
          assessmentId: switchAssessment.assessmentId,
          alternativeId: null,
        },
        {
          role: 'alternative-engage',
          amountMinor: 7_800_000,
          citedFrom: 'alternative-normalized-price',
          assessmentId: null,
          alternativeId: 'quote-a2',
        },
      ],
      [
        {
          role: 'incumbent-commitment-release',
          amountMinor: -7_000_000,
          citedFrom: 'commitment-current-amount',
          assessmentId: null,
          alternativeId: null,
        },
        {
          role: 'assessed-delta-adjustment',
          amountMinor: -400_000,
          citedFrom: 'assessment-cost-impact-budget-revision-delta',
          assessmentId: splitAssessment.assessmentId,
          alternativeId: null,
        },
        {
          role: 'alternative-engage',
          amountMinor: 3_500_000,
          citedFrom: 'alternative-normalized-price',
          assessmentId: null,
          alternativeId: 'quote-b2',
        },
        {
          role: 'alternative-engage',
          amountMinor: 3_600_000,
          citedFrom: 'alternative-normalized-price',
          assessmentId: null,
          alternativeId: 'quote-b3',
        },
      ],
      [
        {
          role: 'incumbent-commitment-release',
          amountMinor: -10_000_000,
          citedFrom: 'commitment-current-amount',
          assessmentId: null,
          alternativeId: null,
        },
        {
          role: 'assessed-delta-adjustment',
          amountMinor: -600_000,
          citedFrom: 'assessment-cost-impact-budget-revision-delta',
          assessmentId: timingAssessment.assessmentId,
          alternativeId: null,
        },
        {
          role: 'alternative-engage',
          amountMinor: 10_200_000,
          citedFrom: 'alternative-normalized-price',
          assessmentId: null,
          alternativeId: 'quote-c2',
        },
      ],
    ]);

    // THE BY-HAND recomputation of every projected delta: the incumbent
    // release cites the commitment's OWN committed amount (the domain's
    // derived read), the assessed delta cites the assessment's OWN recorded
    // value, and each engaged price is the quote's OWN exact extension
    // quantityMilli x unitRateMinor / 1000.
    const handComputed = [
      -committedAmountMinorOf(run.commitments[0]!) -
        switchAssessment.costImpact.budgetRevisionDeltaMinor +
        (10_000 * 780_000) / 1000,
      -committedAmountMinorOf(run.commitments[1]!) -
        splitAssessment.costImpact.budgetRevisionDeltaMinor +
        (5_000 * 700_000) / 1000 +
        (5_000 * 720_000) / 1000,
      -committedAmountMinorOf(run.commitments[2]!) -
        timingAssessment.costImpact.budgetRevisionDeltaMinor +
        (12_000 * 850_000) / 1000,
    ];
    expect(run.recommendations.map((recommendation) => recommendation.projectedImpact.projectedDeltaMinor)).toStrictEqual(
      handComputed,
    );
    expect(handComputed).toStrictEqual([-700_000, -300_000, -400_000]);
    // The components' signed sum IS the projected delta (the composition is total).
    for (const recommendation of run.recommendations) {
      const sum = recommendation.projectedImpact.components.reduce(
        (total, component) => total + component.amountMinor,
        0,
      );
      expect(sum).toBe(recommendation.projectedImpact.projectedDeltaMinor);
      expect(recommendation.projectedImpact.currency).toBe('USD');
      expect(recommendation.projectedImpact.assessmentIds).toStrictEqual(
        recommendation.projectedImpact.components.flatMap((component) =>
          component.assessmentId === null ? [] : [component.assessmentId],
        ),
      );
    }
    // The cited numbers ARE the producing sources' own numbers.
    expect(switchAssessment.costImpact.budgetRevisionDeltaMinor).toBe(500_000);
    expect(splitAssessment.costImpact.budgetRevisionDeltaMinor).toBe(400_000);
    expect(timingAssessment.costImpact.budgetRevisionDeltaMinor).toBe(600_000);
    expect(timingAssessment.scheduleImpact.projectDurationDelta).toBe(12);
  });

  it('claims the historical bases (referenced outcome + benchmark facts)', () => {
    expect(
      run.recommendations.map((recommendation) => recommendation.historicalBasis),
    ).toStrictEqual([
      // The vendor-switch challenger's own completed-project history.
      { outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'], benchmarks: [] },
      // The split composition's histories (vendor-04 only; vendor-05 unrated).
      { outcomeIds: ['outcome-0004'], benchmarks: [] },
      // The timing challenger's history + the benchmark calibration (12 > p90 3).
      {
        outcomeIds: ['outcome-0005', 'outcome-0006'],
        benchmarks: [{ benchmarkId: 'benchmark-0001', metricKind: 'schedule-variance-days' }],
      },
    ]);
    expect(HISTORY_BENCHMARK.metrics[0]?.percentile90).toStrictEqual({
      numerator: 3,
      denominator: 1,
    });
  });

  it('claims the typed risk factors of the selections (derived, never manual)', () => {
    expect(
      run.recommendations.map((recommendation) => recommendation.riskFactors),
    ).toStrictEqual([
      // A single-vendor switch concentrates the source.
      [
        {
          kind: 'single-source-concentration',
          vendorKey: 'vendor-02',
          derivedFrom: [{ entityKind: 'commitment', entityId: SWITCH_COMMITMENT }],
        },
      ],
      // The split diversifies the sources: no concentration factor.
      [],
      [
        {
          kind: 'single-source-concentration',
          vendorKey: 'vendor-07',
          derivedFrom: [{ entityKind: 'commitment', entityId: TIMING_COMMITMENT }],
        },
      ],
    ]);
  });

  it('claims the referenced canonical records (deduplicated, canonical order)', () => {
    expect(
      run.recommendations.map((recommendation) => recommendation.referencedRecords),
    ).toStrictEqual([
      [
        ref('budget', switchScenario().budget.entityId),
        ref('commitment', SWITCH_COMMITMENT),
        ref('cost-item', switchScenario().budget.costItems[String(switchScenario().assessment.costImpact.itemDeltas[0]?.costItemId)]?.entityId ?? ''),
      ],
      [
        ref('budget', splitScenario().budget.entityId),
        ref('commitment', SPLIT_COMMITMENT),
        ref('cost-item', splitScenario().assessment.costImpact.itemDeltas[0]?.costItemId ?? ''),
      ],
      [
        ref('budget', timingScenario().budget.entityId),
        ref('commitment', TIMING_COMMITMENT),
        ref('cost-item', timingScenario().assessment.costImpact.itemDeltas[0]?.costItemId ?? ''),
      ],
    ]);
  });

  it('carries the deterministic titles', () => {
    expect(run.recommendations.map((recommendation) => recommendation.title)).toStrictEqual([
      `Vendor switch: vendor-02 quotes 7800000 minor units against the 8500000 minor-unit incumbent path on commitment ${String(SWITCH_COMMITMENT)}`,
      `Order splitting: 2 alternatives of 2 vendors fulfill the scope of commitment ${String(SPLIT_COMMITMENT)} for 7100000 minor units against the 7400000 minor-unit incumbent path`,
      `Timing shift: vendor-07 delivers 25 days against the incumbent re-quote\u2019s 45, avoiding 400000 minor units of the assessed impact on commitment ${String(TIMING_COMMITMENT)}`,
    ]);
  });

  it('carries the four comparison dimensions on every row (price/delivery/performance/risk)', () => {
    for (const recommendation of run.recommendations) {
      const comparison = recommendation.comparison;
      expect(comparison.rows.length).toBeGreaterThan(1);
      const incumbentRow = comparison.rows.find((row) => row.incumbentVendor);
      expect(incumbentRow).toBeDefined();
      for (const row of comparison.rows) {
        // Price: the normalized comparable amount is the quote's exact extension.
        expect(row.price.normalizedAmountMinor).toBe(
          (row.price.quotedQuantityMilli * row.price.quotedUnitRateMinor) / 1000,
        );
        expect(row.price.currency).toBe('USD');
        // Delivery: the lead-time comparison against the incumbent re-quote.
        expect(row.delivery.incumbentLeadTimeDays).toBe(incumbentRow?.delivery.leadTimeDays);
        expect(row.delivery.leadGainDays).toBe(
          (incumbentRow?.delivery.leadTimeDays ?? 0) - row.delivery.leadTimeDays,
        );
        // Performance: the outcome-derived rating with its exact share.
        expect(row.performance.totalCount).toBe(row.performance.outcomeIds.length);
        if (row.performance.outcomeIds.length === 0) {
          expect(row.performance.level).toBe('unrated');
          expect(row.performance.onTimeShare).toBeNull();
        } else {
          expect(row.performance.onTimeShare).toStrictEqual({
            numerator: row.performance.onTimeCount,
            denominator: row.performance.totalCount,
          });
        }
        // Risk: every factor is typed and vendor-scoped.
        for (const factor of row.riskFactors) {
          expect(factor.vendorKey).toBe(row.vendorKey);
        }
      }
    }
    // The pinned performance ratings of the golden quotes.
    const ratings = run.recommendations.flatMap((recommendation) =>
      recommendation.comparison.rows.map((row) => [row.alternativeId, row.performance.level]),
    );
    expect(ratings).toStrictEqual([
      ['quote-a1', 'unrated'],
      ['quote-a2', 'strong'],
      ['quote-b1', 'unrated'],
      ['quote-b2', 'strong'],
      ['quote-b3', 'unrated'],
      ['quote-c1', 'unrated'],
      ['quote-c2', 'acceptable'],
    ]);
  });

  it('carries the scan tenant on every recommendation (A12)', () => {
    for (const recommendation of run.recommendations) {
      expect(recommendation.scope.kind).toBe('project');
      if (recommendation.scope.kind === 'project') {
        expect(recommendation.scope.tenantId).toBe(TENANT_A);
      }
      expect(recommendation.comparison.scope).toStrictEqual(recommendation.scope);
    }
  });
});

describe('THE stable golden preference ranking (identical across runs + shuffles)', () => {
  it('produces THE pinned stable preference order with the exposed composition', () => {
    expect(run.ranked.map(rankedShapeOf).map((shape) => shape.kind)).toStrictEqual(
      GOLDEN_PREFERENCE_ORDER,
    );
    expect(run.ranked.map((ranked) => ranked.rank)).toStrictEqual([1, 2, 3]);
    // The formula is exposed as a documentation constant.
    expect(PREFERENCE_FORMULA).toBe(
      'preference = economicWeight x min(1, |projectedDelta| / economicScale) + deliveryWeight x min(1, leadGainDays / deliveryScaleDays)',
    );
    expect(DEFAULT_PREFERENCE_WEIGHTS.economicWeight).toStrictEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(DEFAULT_PREFERENCE_WEIGHTS.deliveryWeight).toStrictEqual({
      numerator: 1,
      denominator: 2,
    });
    expect(DEFAULT_PREFERENCE_WEIGHTS.economicScale).toStrictEqual({
      amountMinor: 10_000_000,
      currency: 'USD',
    });
    expect(DEFAULT_PREFERENCE_WEIGHTS.deliveryScale).toStrictEqual({ days: 30 });
  });

  it('recomputes every preference score BY HAND from the model alone', () => {
    // THE hand recomputation (the named acceptance): with the default seed
    //   preference = 1/2 x min(1, |projectedDelta| / 10,000,000)
    //              + 1/2 x min(1, leadGainDays / 30)
    // the three golden scores are:
    //   vendor switch:  1/2 x 7/100 + 1/2 x 2/30  = 7/200 + 1/30 = 41/600
    //   order splitting: 1/2 x 3/100 + 1/2 x 5/30 = 3/200 + 1/12 = 59/600
    //   timing shift:   1/2 x 1/25 + 1/2 x 20/30  = 1/50 + 1/3   = 53/150
    expect(run.ranked.map((ranked) => ranked.score.total)).toStrictEqual([
      { numerator: 53, denominator: 150 },
      { numerator: 59, denominator: 600 },
      { numerator: 41, denominator: 600 },
    ]);
    // The exposure and contribution of every component, recomputed by hand.
    expect(run.ranked.map((ranked) => ranked.score.economic.exposure)).toStrictEqual([
      { numerator: 1, denominator: 25 },
      { numerator: 3, denominator: 100 },
      { numerator: 7, denominator: 100 },
    ]);
    expect(run.ranked.map((ranked) => ranked.score.economic.contribution)).toStrictEqual([
      { numerator: 1, denominator: 50 },
      { numerator: 3, denominator: 200 },
      { numerator: 7, denominator: 200 },
    ]);
    expect(run.ranked.map((ranked) => ranked.score.delivery.exposure)).toStrictEqual([
      { numerator: 2, denominator: 3 },
      { numerator: 1, denominator: 6 },
      { numerator: 1, denominator: 15 },
    ]);
    expect(run.ranked.map((ranked) => ranked.score.delivery.contribution)).toStrictEqual([
      { numerator: 1, denominator: 3 },
      { numerator: 1, denominator: 12 },
      { numerator: 1, denominator: 30 },
    ]);
    // The measured inputs are the recommendation's own cited numbers.
    expect(run.ranked.map((ranked) => ranked.score.economic.projectedDeltaMinor)).toStrictEqual([
      -400_000,
      -300_000,
      -700_000,
    ]);
    expect(run.ranked.map((ranked) => ranked.score.delivery.leadGainDays)).toStrictEqual([
      20, 5, 2,
    ]);
    // The total is the sum of the two contributions (the composition is total).
    for (const ranked of run.ranked) {
      expect(ranked.score.total.numerator / ranked.score.total.denominator).toBeCloseTo(
        ranked.score.economic.contribution.numerator / ranked.score.economic.contribution.denominator +
          ranked.score.delivery.contribution.numerator / ranked.score.delivery.contribution.denominator,
        12,
      );
    }
  });

  it('is stable across re-ranks and set shuffles (the total order)', () => {
    const reRanked = unwrap(rankProcurementRecommendations(run.recommendations));
    expect(reRanked).toStrictEqual(run.ranked);
    const shuffled = unwrap(
      rankProcurementRecommendations([...run.recommendations].reverse()),
    );
    expect(shuffled).toStrictEqual(run.ranked);
    expect(shuffled.map(rankedShapeOf)).toStrictEqual(run.ranked.map(rankedShapeOf));
    // Ranking the scan of a shuffled input set reproduces the identical order.
    const reScanned = scanAgain({
      ...goldenInputsOf(run),
      commitments: [...run.commitments].reverse(),
      alternatives: [...run.alternatives].reverse(),
      assessments: [...run.assessments].reverse(),
      outcomes: [...run.outcomes].reverse(),
    });
    expect(unwrap(rankProcurementRecommendations(reScanned))).toStrictEqual(run.ranked);
  });
});

describe('THE suggestion-only discipline (no automatic procurement commitment)', () => {
  it('PROPOSES typed next actions only — every proposal is a suggestion with NO policy decision', () => {
    for (const recommendation of run.recommendations) {
      const actions = proposeNextActions(recommendation);
      expect(actions.length).toBe(2);
      for (const action of actions) {
        expect(action.policyDecision).toBeNull();
        expect(action.scope).toStrictEqual(recommendation.scope);
        expect(action.evidence.length).toBeGreaterThan(0);
        // Every justifying evidence reference is part of the recommendation's chain.
        const chain = new Set(recommendation.evidence.map((evidence) => JSON.stringify(evidence)));
        for (const evidence of action.evidence) {
          expect(chain.has(JSON.stringify(evidence))).toBe(true);
        }
        // The suggested command is a typed REFERENCE (name + reference payload only).
        expect(action.command.payload).not.toHaveProperty('version');
        expect(action.command.payload).not.toHaveProperty('actorId');
        expect(action.command.payload).not.toHaveProperty('idempotencyKey');
      }
      // The proposals are deterministic (run-twice identical).
      expect(proposeNextActions(recommendation)).toStrictEqual(actions);
    }
  });

  it('commitment WITHOUT an explicit policy decision is a typed rejection (the engine never commits)', () => {
    for (const recommendation of run.recommendations) {
      const rejected = commitProcurementDecision(recommendation, null);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('forbidden');
        expect(rejected.error.details[0]?.code).toBe('commitment-requires-policy-decision');
      }
    }
  });

  it('commitment WITH an explicit policy decision still only PROPOSES (a ProposedNextAction record)', () => {
    const decision: ProcurementPolicyDecision = {
      decision: 'commit-procurement-decision',
      decidedBy: USER_ACTOR,
      decidedAt: DETECTED_AT,
      rationale: 'The procurement lead accepts the sourcing position.',
    };
    for (const recommendation of run.recommendations) {
      const proposal = unwrap(commitProcurementDecision(recommendation, decision));
      expect(proposal.policyDecision).toStrictEqual(decision);
      expect(proposal.command.commandName).toBe(CREATE_COMMITMENT_COMMAND);
      expect(proposal.command.commandName).toBe('cost.createCommitment');
      expect(proposal.command.payload).toStrictEqual({
        budgetId: recommendation.comparison.need.budgetId,
      });
      expect(proposal.confidence.reasons).toContain('human-decision-required');
      // Deterministic: the same decision reproduces the same proposal.
      expect(unwrap(commitProcurementDecision(recommendation, decision))).toStrictEqual(proposal);
    }
  });
});

describe('THE golden audit envelopes through an injected sink (A3)', () => {
  const executor: ProcurementSinkExecutor = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  it('emits exactly one typed envelope per recommendation through the injected in-memory sink', async () => {
    const sink = createInMemoryProcurementEventSink();
    for (const recommendation of run.recommendations) {
      const emitted = await emitProcurementRecommendationProposed(sink, executor, recommendation);
      expect(emitted.ok).toBe(true);
    }
    expect(sink.appends).toHaveLength(3);
    expect(sink.appends.map((append) => append.executor)).toStrictEqual([
      executor,
      executor,
      executor,
    ]);
    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      'intelligence.procurementProposed',
      'intelligence.procurementProposed',
      'intelligence.procurementProposed',
    ]);
  });

  it('causes every envelope by the primary producing event (A3 causality carries over)', () => {
    const expectedCauses = [
      switchScenario().assessment.source.eventId,
      splitScenario().assessment.source.eventId,
      timingScenario().assessment.source.eventId,
    ];
    run.recommendations.forEach((recommendation, index) => {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      expect(envelope.causality.causationId).toBe(expectedCauses[index]);
      expect(envelope.causality.correlationId).toBe(recommendation.primarySource.correlationId);
      expect(envelope.occurredAt).toBe(DETECTED_AT);
      expect(envelope.actor).toStrictEqual(USER_ACTOR);
      expect(envelope.source).toBe('system');
    });
  });

  it('round-trips the emitted envelopes deterministically (the contracts parser)', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      expect(unwrap(procurementRecommendationProposedEnvelope(recommendation))).toStrictEqual(
        envelope,
      );
      // The payload carries the JSON-safe summary + the exposed impact + the suggestions.
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload['recommendationId']).toBe(recommendation.recommendationId);
      expect(payload['projectedImpact']).toBeDefined();
      const impact = payload['projectedImpact'] as Record<string, unknown>;
      expect(Array.isArray(impact['components'])).toBe(true);
      expect(impact['projectedDeltaMinor']).toBe(
        recommendation.projectedImpact.projectedDeltaMinor,
      );
      expect(payload['proposedNextActions']).toBeDefined();
      expect(Array.isArray(payload['proposedNextActions'])).toBe(true);
    }
  });

  it('carries the evidence-chain ids and the evidence-set refs across the event boundary', () => {
    for (const recommendation of run.recommendations) {
      const envelope = unwrap(procurementRecommendationProposedEnvelope(recommendation));
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload['evidenceAssessmentIds']).toStrictEqual(
        recommendation.evidence
          .filter((evidence) => evidence.kind === 'assessment')
          .map((evidence) => (evidence.kind === 'assessment' ? evidence.assessmentId : null)),
      );
      expect(payload['evidenceOutcomeIds']).toStrictEqual(
        recommendation.evidence
          .filter((evidence) => evidence.kind === 'outcome')
          .map((evidence) => (evidence.kind === 'outcome' ? evidence.outcomeId : null)),
      );
      expect(payload['evidenceSetRefs']).toStrictEqual(
        recommendation.evidenceSet.items.map((item) => item.ref),
      );
      expect(payload['historicalBasis']).toStrictEqual({
        outcomeIds: [...recommendation.historicalBasis.outcomeIds],
        benchmarkIds: recommendation.historicalBasis.benchmarks.map((fact) => fact.benchmarkId),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic permutation helpers (fixed rotations/swaps — no randomness).
// ---------------------------------------------------------------------------

/** Deduplicate referenced records by (kind, id), preserving canonical order. */
const dedupeByKindId = (refs: readonly EntityRef[]): readonly EntityRef[] => {
  const seen = new Set<string>();
  const unique: EntityRef[] = [];
  for (const ref of refs) {
    const key = `${String(ref.entityKind)}:${String(ref.entityId)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ref);
    }
  }
  return unique;
};

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
