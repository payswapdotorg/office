import { beforeAll, describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import {
  ASSESSED_AT,
  COMPUTED_AT,
  DETECTED_AT,
  RECORDED_AT,
  TENANT_A,
  T1,
  projectOneScope,
  tenantReader,
  testScanId,
  unwrap,
  USER_ACTOR,
} from './test-support';
import {
  CONSTRUCTIVE_ASSESSMENT,
  CONSTRUCTIVE_CHANGE_EVENT,
  CONSTRUCTIVE_CONTRACT,
  DELAY_ASSESSMENT,
  DELAY_CHANGE_EVENT,
  DELAY_CONTRACT,
  GOLDEN_PRIORITY_ORDER,
  HISTORY_BENCHMARK,
  HISTORY_OUTCOMES,
  REBALANCE_ASSESSMENT,
  REBALANCE_CHANGE_EVENT,
  REBALANCE_CONTRACT,
  REJECTED_ORDER,
  goldenInputsOf,
  rankedShapeOf,
  runGoldenRecoveryScan,
} from './scenarios';
import type { GoldenRecoveryRun } from './scenarios';
import { detectRecoveryCandidates } from './detection';
import { rankRecoveryCandidates } from './prioritization';
import { assertRecoveryClaim, proposeNextActions } from './proposal';
import type { CandidateRecovery } from './candidates';
import type { RecoveryPolicyDecision } from './model';
import { SUBMIT_CHANGE_ORDER_COMMAND } from './model';
import { createInMemoryRecoveryEventSink, emitRecoveryCandidateDetected, recoveryCandidateDetectedEnvelope } from './audit';
import type { RecoverySinkExecutor } from './audit';

// THE NAMED ACCEPTANCE of OFF-033: the golden seeded recovery portfolio —
// a CONSTRUCTIVE CHANGE (750,000 minor units of work recorded against a
// proposed change event with NO change order claiming it), an ENTITLEMENT
// REBALANCE (a 2,500,000-minor-unit documented change order rejected in a
// historically approving climate), and a DELAY IMPACT (a 12-day unconverted
// program delay beyond the benchmarked p90 schedule-variance envelope) —
// scanned together with the completed-project history (three outcome
// records + the tenant benchmark) produces typed CandidateRecovery records
// whose evidence chains resolve END TO END to the producing source records,
// the stable ranked order (identical across runs and input orderings, with
// the composition exposed), and NO automatic contractual assertion: the
// engine only PROPOSES typed ProposedNextAction records, and assertion
// without an explicit policy decision is a typed rejection.

let run: GoldenRecoveryRun;

beforeAll(() => {
  run = runGoldenRecoveryScan();
});

const scanAgain = (inputs = goldenInputsOf(run)): readonly CandidateRecovery[] =>
  unwrap(
    detectRecoveryCandidates(inputs, tenantReader(), {
      scanId: testScanId(1),
      detectedAt: DETECTED_AT,
    }),
  );

describe('THE golden seeded recovery scan (OFF-033 named acceptance)', () => {
  it('detects exactly one candidate per golden scenario, in canonical emission order', () => {
    expect(run.candidates.map((candidate) => candidate.kind)).toStrictEqual([
      'constructive-change',
      'entitlement-rebalance',
      'delay-impact',
    ]);
    // Each candidate is the typed projection of exactly ONE golden scenario.
    expect(run.candidates.map((candidate) => candidate.economicBasis.assessmentIds)).toStrictEqual([
      [CONSTRUCTIVE_ASSESSMENT.assessmentId],
      [REBALANCE_ASSESSMENT.assessmentId],
      [DELAY_ASSESSMENT.assessmentId],
    ]);
  });

  it('derives every candidate identity from the injected scan identity (no id supplier)', () => {
    expect(run.candidates.map((candidate) => candidate.candidateId)).toStrictEqual([
      'scan-0001#0001',
      'scan-0001#0002',
      'scan-0001#0003',
    ]);
    for (const candidate of run.candidates) {
      expect(candidate.provenance.scanId).toBe('scan-0001');
      expect(candidate.detectedAt).toBe(DETECTED_AT);
      expect(candidate.provenance.detectedAt).toBe(DETECTED_AT);
      expect(candidate.candidateVersion).toBe(1);
      expect(candidate.engine).toBe('intelligence-revenue');
      expect(candidate.actor).toStrictEqual(USER_ACTOR);
      expect(candidate.scope).toStrictEqual(projectOneScope());
      expect(candidate.provenance.consumed).toStrictEqual({
        contractCount: 3,
        changeEventCount: 3,
        changeOrderCount: 1,
        claimReferenceCount: 0,
        assessmentCount: 3,
        outcomeCount: 3,
        benchmarkCount: 1,
      });
    }
  });

  it('runs the whole pipeline byte-identically twice (A7 rebuildability)', () => {
    const second = runGoldenRecoveryScan();
    expect(second.candidates).toStrictEqual(run.candidates);
    expect(second.ranked).toStrictEqual(run.ranked);
    expect(second.ranked.map(rankedShapeOf)).toStrictEqual(run.ranked.map(rankedShapeOf));
  });

  it('scans run-twice into the byte-identical candidate set (determinism)', () => {
    const first = scanAgain();
    const second = scanAgain();
    expect(first).toStrictEqual(run.candidates);
    expect(second).toStrictEqual(first);
  });

  it('produces the identical candidate set under every input permutation', () => {
    const base = goldenInputsOf(run);
    const permutations = [
      { ...base, contracts: [...base.contracts].reverse(), changeEvents: [...base.changeEvents].reverse() },
      {
        ...base,
        assessments: rotate(base.assessments, 1),
        outcomes: rotate(base.outcomes, 2),
        benchmarks: [base.benchmarks[0]!],
      },
      {
        ...base,
        contracts: swap(rotate(base.contracts, 2), 0, 2),
        changeEvents: swap(rotate(base.changeEvents, 1), 0, 2),
        assessments: swap(rotate(base.assessments, 2), 0, 2),
        outcomes: [...base.outcomes].reverse(),
      },
    ];
    for (const [index, permutation] of permutations.entries()) {
      const scanned = scanAgain(permutation);
      expect(scanned, `permutation ${index}`).toStrictEqual(run.candidates);
    }
  });

  it('produces THE stable golden priority ordering (identical across runs + shuffles)', () => {
    expect(run.ranked.map(rankedShapeOf).map((shape) => shape.kind)).toStrictEqual(
      GOLDEN_PRIORITY_ORDER,
    );
    expect(run.ranked.map((ranked) => ranked.rank)).toStrictEqual([1, 2, 3]);
    // Re-ranking the identical set reproduces the identical order.
    const reRanked = unwrap(rankRecoveryCandidates(run.candidates));
    expect(reRanked).toStrictEqual(run.ranked);
    // Ranking a shuffle of the identical set reproduces the identical order.
    const shuffled = unwrap(rankRecoveryCandidates([...run.candidates].reverse()));
    expect(shuffled).toStrictEqual(run.ranked);
    expect(shuffled.map(rankedShapeOf)).toStrictEqual(run.ranked.map(rankedShapeOf));
  });
});

describe('THE evidence chains resolve end-to-end to producing source records (OFF-033)', () => {
  /** Every ledger event id the producing assessment's own evidence cites. */
  const scenarioEventIdsOf = (assessment: typeof CONSTRUCTIVE_ASSESSMENT): ReadonlySet<string> => {
    const ids = new Set<string>([
      assessment.source.eventId,
      ...assessment.evidence.map((reference) => reference.eventId),
      ...assessment.costImpact.evidence.map((reference) => reference.eventId),
      ...assessment.costImpact.revisionAnchors.map((anchor) => anchor.source.eventId),
      ...assessment.costImpact.itemDeltas.flatMap((delta) =>
        delta.source === null ? [] : [delta.source.eventId],
      ),
      ...assessment.scheduleImpact.evidence.map((reference) => reference.eventId),
      ...assessment.entitlementImpact.evidence.map((reference) => reference.eventId),
      ...assessment.entitlementImpact.orders.flatMap((order) => [
        order.submissionSource.eventId,
        ...(order.decisionSource === null ? [] : [order.decisionSource.eventId]),
      ]),
    ]);
    return ids;
  };

  const canonicalRecordRefs = (): ReadonlySet<string> =>
    new Set(
      [
        ...run.contracts.map((contract) => `contract:${String(contract.entityId)}`),
        ...run.changeEvents.map((changeEvent) => `change-event:${String(changeEvent.entityId)}`),
        ...run.changeOrders.map((order) => `change-order:${String(order.entityId)}`),
      ].sort(),
    );

  const outcomeIdsOf = (): ReadonlySet<string> =>
    new Set(run.outcomes.map((outcome) => String(outcome.outcomeId)));

  it('resolves every record reference to a golden canonical contracts-domain record', () => {
    const recordRefs = canonicalRecordRefs();
    for (const candidate of run.candidates) {
      for (const ref of candidate.referencedRecords) {
        expect(
          recordRefs.has(`${String(ref.entityKind)}:${String(ref.entityId)}`),
          `${candidate.candidateId} references ${String(ref.entityKind)} ${String(ref.entityId)} outside the golden records`,
        ).toBe(true);
      }
      const recordEvidence = candidate.evidence.filter((evidence) => evidence.kind === 'record');
      for (const evidence of recordEvidence) {
        if (evidence.kind !== 'record') continue;
        expect(
          recordRefs.has(`${String(evidence.ref.entityKind)}:${String(evidence.ref.entityId)}`),
          `record evidence ${String(evidence.ref.entityId)} resolves outside the golden records`,
        ).toBe(true);
      }
      // Referenced records are the canonical (kind, id) order, deduplicated.
      expect(candidate.referencedRecords).toStrictEqual(
        dedupeByKindId(candidate.referencedRecords),
      );
    }
  });

  it('resolves every event reference to a ledger event id of the producing assessment', () => {
    const inputAssessments = [CONSTRUCTIVE_ASSESSMENT, REBALANCE_ASSESSMENT, DELAY_ASSESSMENT];
    for (const candidate of run.candidates) {
      const assessment = inputAssessments.find(
        (input) => input.assessmentId === candidate.economicBasis.assessmentIds[0],
      );
      expect(assessment, `no producing assessment for ${candidate.candidateId}`).toBeDefined();
      if (assessment === undefined) continue;
      const scenarioEventIds = scenarioEventIdsOf(assessment);
      const eventEvidence = candidate.evidence.filter((evidence) => evidence.kind === 'event');
      expect(eventEvidence.length).toBeGreaterThan(0);
      for (const evidence of eventEvidence) {
        if (evidence.kind !== 'event') continue;
        expect(
          scenarioEventIds.has(String(evidence.eventId)),
          `evidence event ${String(evidence.eventId)} resolves outside the producing scenario`,
        ).toBe(true);
      }
      // THE primary producing source anchor (the A3 causation id).
      expect(candidate.primarySource.eventId).toBe(assessment.source.eventId);
      expect(candidate.primarySource.eventName).toBe('contracts.changeEventRaised');
      expect(candidate.primarySource.occurredAt).toBe(assessment.source.occurredAt);
      expect(candidate.primarySource.occurredAt).toBe(T1);
      expect(candidate.primarySource.correlationId).toBe(assessment.source.correlationId);
    }
  });

  it('resolves every assessment/outcome/benchmark reference to the scan inputs', () => {
    const inputAssessments = [CONSTRUCTIVE_ASSESSMENT, REBALANCE_ASSESSMENT, DELAY_ASSESSMENT];
    const assessmentIds = new Set(inputAssessments.map((assessment) => String(assessment.assessmentId)));
    const outcomeIds = outcomeIdsOf();
    const benchmarkId = String(HISTORY_BENCHMARK.benchmarkId);
    for (const candidate of run.candidates) {
      const assessment = inputAssessments.find(
        (input) => input.assessmentId === candidate.economicBasis.assessmentIds[0],
      );
      expect(assessment, `no producing assessment for ${candidate.candidateId}`).toBeDefined();
      if (assessment === undefined) continue;
      const assessmentEvidence = candidate.evidence.filter((evidence) => evidence.kind === 'assessment');
      expect(assessmentEvidence).toHaveLength(1);
      for (const evidence of assessmentEvidence) {
        if (evidence.kind !== 'assessment') continue;
        expect(assessmentIds.has(String(evidence.assessmentId))).toBe(true);
        expect(evidence.assessedAt).toBe(ASSESSED_AT);
        expect(evidence.sourceEventId).toBe(assessment.source.eventId);
        expect(evidence.changeEventId).toBe(assessment.source.changeEventId);
        expect(evidence.contractId).toBe(assessment.source.contractId);
      }
      for (const evidence of candidate.evidence) {
        if (evidence.kind === 'outcome') {
          expect(outcomeIds.has(String(evidence.outcomeId))).toBe(true);
          expect(evidence.recordedAt).toBe(RECORDED_AT);
        }
        if (evidence.kind === 'benchmark') {
          expect(String(evidence.benchmarkId)).toBe(benchmarkId);
          expect(evidence.computedAt).toBe(COMPUTED_AT);
        }
      }
      // The historical basis references the same producing facts.
      for (const outcomeId of candidate.historicalBasis.outcomeIds) {
        expect(outcomeIds.has(String(outcomeId))).toBe(true);
      }
      for (const fact of candidate.historicalBasis.benchmarks) {
        expect(String(fact.benchmarkId)).toBe(benchmarkId);
      }
    }
  });

  it('carries a complete, qualified EvidenceSet (the agents discipline — never empty)', () => {
    for (const candidate of run.candidates) {
      expect(candidate.evidenceSet.items.length).toBeGreaterThan(0);
      // The assessment item + one item per historical outcome, canonical order.
      const refs = candidate.evidenceSet.items.map((item) => item.ref);
      expect(refs[0]).toBe(candidate.economicBasis.assessmentIds[0]);
      expect(refs.slice(1)).toStrictEqual([...candidate.historicalBasis.outcomeIds].sort());
      for (const item of candidate.evidenceSet.items) {
        expect(item.retrieval.tool).toBe('recovery-candidate-detection');
        expect(item.retrieval.retrievedAt).toBe(DETECTED_AT);
      }
    }
  });
});

describe('the pinned golden candidate claims (OFF-033)', () => {
  const ref = (entityKind: string, entityId: string): EntityRef =>
    ({ entityKind, entityId }) as EntityRef;

  it('claims the typed severities with their deterministic reasons', () => {
    expect(run.candidates.map((candidate) => candidate.severity)).toStrictEqual([
      // 750,000 of 8,000,000 contracted (3/32): moderate.
      { level: 'moderate', reasons: ['constructive-cost-share'] },
      // 2,500,000 of 12,500,000 contracted (1/5): major; the benchmarked mean
      // approval rate 49/60 diverges from rejection but stays below 9/10 (no escalation).
      { level: 'major', reasons: ['entitlement-rejected-share'] },
      // 12-day slip (major) beyond the benchmarked p90 of 9 days: escalated critical.
      {
        level: 'critical',
        reasons: ['benchmark-beyond-percentile90', 'delay-impact-days'],
      },
    ]);
  });

  it('claims the economic bases by CITING the producing numbers (never re-derived)', () => {
    expect(run.candidates.map((candidate) => candidate.economicBasis)).toStrictEqual([
      {
        amountMinor: 750_000,
        currency: 'USD',
        citedFrom: 'assessment-cost-impact-budget-revision-delta',
        assessmentIds: ['assessment-0001'],
      },
      {
        amountMinor: 2_500_000,
        currency: 'USD',
        citedFrom: 'change-order-submitted-value',
        assessmentIds: ['assessment-0002'],
      },
      { amountMinor: null, currency: null, citedFrom: 'none', assessmentIds: ['assessment-0003'] },
    ]);
    // The cited numbers ARE the producing sources' own numbers.
    expect(CONSTRUCTIVE_ASSESSMENT.costImpact.budgetRevisionDeltaMinor).toBe(750_000);
    expect(REBALANCE_ASSESSMENT.entitlementImpact.orders[0]?.valueMinor).toBe(2_500_000);
    expect(DELAY_ASSESSMENT.scheduleImpact.projectDurationDelta).toBe(12);
  });

  it('claims the historical bases (referenced outcome + benchmark facts)', () => {
    expect(run.candidates.map((candidate) => candidate.historicalBasis)).toStrictEqual([
      {
        outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'],
        benchmarks: [],
      },
      {
        outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'],
        benchmarks: [{ benchmarkId: 'benchmark-0001', metricKind: 'entitlement-approval-rate' }],
      },
      {
        outcomeIds: ['outcome-0001', 'outcome-0002', 'outcome-0003'],
        benchmarks: [{ benchmarkId: 'benchmark-0001', metricKind: 'schedule-variance-days' }],
      },
    ]);
    expect(HISTORY_OUTCOMES.map((outcome) => outcome.entitlement.approvedValueMinor)).toStrictEqual([
      300_000,
      1_200_000,
      2_000_000,
    ]);
  });

  it('claims the referenced canonical records (deduplicated, canonical order)', () => {
    expect(run.candidates.map((candidate) => candidate.referencedRecords)).toStrictEqual([
      [ref('change-event', CONSTRUCTIVE_CHANGE_EVENT), ref('contract', CONSTRUCTIVE_CONTRACT)],
      [
        ref('change-event', REBALANCE_CHANGE_EVENT),
        ref('change-order', REJECTED_ORDER),
        ref('contract', REBALANCE_CONTRACT),
      ],
      [ref('change-event', DELAY_CHANGE_EVENT), ref('contract', DELAY_CONTRACT)],
    ]);
  });

  it('carries the deterministic titles', () => {
    expect(run.candidates.map((candidate) => candidate.title)).toStrictEqual([
      `Constructive change indicator: 750000 minor units of work recorded on change event ${CONSTRUCTIVE_CHANGE_EVENT} with no change order`,
      `Entitlement rebalance candidate: rejected change order ${REJECTED_ORDER} of 2500000 minor units with documented evidence`,
      `Delay impact candidate: 12-day program delay on change event ${DELAY_CHANGE_EVENT} with no change order`,
    ]);
  });

  it('carries the scan tenant on every candidate (A12)', () => {
    for (const candidate of run.candidates) {
      expect(candidate.scope.kind).toBe('project');
      if (candidate.scope.kind === 'project') {
        expect(candidate.scope.tenantId).toBe(TENANT_A);
      }
    }
  });
});

describe('THE suggestion-only discipline (no automatic contractual assertion)', () => {
  it('PROPOSES typed next actions only — every proposal is a suggestion with NO policy decision', () => {
    for (const candidate of run.candidates) {
      const actions = proposeNextActions(candidate);
      expect(actions.length).toBe(2);
      for (const action of actions) {
        expect(action.policyDecision).toBeNull();
        expect(action.scope).toStrictEqual(candidate.scope);
        expect(action.evidence.length).toBeGreaterThan(0);
        // Every justifying evidence reference is part of the candidate's chain.
        const chain = new Set(candidate.evidence.map((evidence) => JSON.stringify(evidence)));
        for (const evidence of action.evidence) {
          expect(chain.has(JSON.stringify(evidence))).toBe(true);
        }
      }
      // The proposals are deterministic (run-twice identical).
      expect(proposeNextActions(candidate)).toStrictEqual(actions);
    }
  });

  it('assertion WITHOUT an explicit policy decision is a typed rejection (the engine never asserts)', () => {
    for (const candidate of run.candidates) {
      const rejected = assertRecoveryClaim(candidate, null);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('forbidden');
        expect(rejected.error.details[0]?.code).toBe('assertion-requires-policy-decision');
      }
    }
  });

  it('assertion WITH an explicit policy decision still only PROPOSES (a ProposedNextAction record)', () => {
    const decision: RecoveryPolicyDecision = {
      decision: 'assert-recovery-claim',
      decidedBy: USER_ACTOR,
      decidedAt: DETECTED_AT,
      rationale: 'The commercial controller accepts the recovery position.',
    };
    for (const candidate of run.candidates) {
      const proposal = unwrap(assertRecoveryClaim(candidate, decision));
      expect(proposal.policyDecision).toStrictEqual(decision);
      expect(proposal.command.commandName).toBe(SUBMIT_CHANGE_ORDER_COMMAND);
      expect(proposal.command.payload).toStrictEqual({
        changeEventId: candidate.referencedRecords.find(
          (record) => record.entityKind === 'change-event',
        )?.entityId,
      });
      expect(proposal.confidence.reasons).toContain('human-decision-required');
      // Deterministic: the same decision reproduces the same proposal.
      expect(unwrap(assertRecoveryClaim(candidate, decision))).toStrictEqual(proposal);
    }
  });
});

describe('THE golden audit envelopes through an injected sink (A3)', () => {
  const executor: RecoverySinkExecutor = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  it('emits exactly one typed envelope per candidate through the injected in-memory sink', async () => {
    const sink = createInMemoryRecoveryEventSink();
    for (const candidate of run.candidates) {
      const emitted = await emitRecoveryCandidateDetected(sink, executor, candidate);
      expect(emitted.ok).toBe(true);
    }
    expect(sink.appends).toHaveLength(3);
    expect(sink.appends.map((append) => append.executor)).toStrictEqual([
      executor,
      executor,
      executor,
    ]);
    expect(sink.events.map((event) => event.eventName)).toStrictEqual([
      'intelligence.recoveryCandidateDetected',
      'intelligence.recoveryCandidateDetected',
      'intelligence.recoveryCandidateDetected',
    ]);
  });

  it('causes every envelope by the primary producing event (A3 causality carries over)', () => {
    const expectedCauses = [
      CONSTRUCTIVE_ASSESSMENT.source.eventId,
      REBALANCE_ASSESSMENT.source.eventId,
      DELAY_ASSESSMENT.source.eventId,
    ];
    run.candidates.forEach((candidate, index) => {
      const envelope = unwrap(recoveryCandidateDetectedEnvelope(candidate));
      expect(envelope.causality.causationId).toBe(expectedCauses[index]);
      expect(envelope.causality.correlationId).toBe(candidate.primarySource.correlationId);
      expect(envelope.occurredAt).toBe(DETECTED_AT);
      expect(envelope.actor).toStrictEqual(USER_ACTOR);
    });
  });

  it('round-trips the emitted envelopes through the contracts parser (fail-closed)', () => {
    for (const candidate of run.candidates) {
      const envelope = unwrap(recoveryCandidateDetectedEnvelope(candidate));
      expect(unwrap(recoveryCandidateDetectedEnvelope(candidate))).toStrictEqual(envelope);
      // The payload carries the JSON-safe candidate summary + the proposals.
      const payload = envelope.payload as Record<string, unknown>;
      expect(payload['candidateId']).toBe(candidate.candidateId);
      expect(payload['proposedNextActions']).toBeDefined();
      expect(Array.isArray(payload['proposedNextActions'])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic permutation helpers (fixed rotations/swaps — no randomness).
// ---------------------------------------------------------------------------

/** Deduplicate referenced records by (kind, id), preserving canonical order. */
const dedupeByKindId = (
  refs: readonly EntityRef[],
): readonly EntityRef[] => {
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
