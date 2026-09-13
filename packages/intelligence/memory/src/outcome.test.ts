import { describe, expect, it } from 'vitest';
import { deriveOutcome } from './outcome';
import { MEMORY_ENGINE, OUTCOME_SCHEMA_VERSION } from './model';
import type { OutcomeRecord } from './model';
import {
  GOLDEN_PROJECT_B1,
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  TENANT_A,
  TENANT_B,
  T5,
  USER_ACTOR,
  memoryReaderOf,
  outcomeOfRun,
  projectOneScope,
  projectTwoScope,
  runCompletedProject,
  testOutcomeId,
  tenantAWideScope,
  tenantBWideScope,
  unwrap,
} from './test-support';
import type { CompletedProjectRun } from './test-support';

// OFF-015 outcome derivation — THE deterministic outcome capture. The golden
// completed projects run through the REAL landed engines (ledger-shaped
// streams → relationship traversal → margin facts + assessments) and every
// derived number is pinned exactly: schedule variance, the cost margin
// position, the entitlement outcomes, and change pressure — each carrying
// its SOURCE EVENT/ASSESSMENT references (A4 provenance). Determinism is
// byte-identical: the same inputs always derive the same outcome, and the
// assessments' input order never matters.

const runOne = async (): Promise<CompletedProjectRun> => runCompletedProject(GOLDEN_PROJECT_ONE);
const runTwo = async (): Promise<CompletedProjectRun> => runCompletedProject(GOLDEN_PROJECT_TWO);
const runThree = async (): Promise<CompletedProjectRun> =>
  runCompletedProject(GOLDEN_PROJECT_THREE);
const runB1 = async (): Promise<CompletedProjectRun> => runCompletedProject(GOLDEN_PROJECT_B1);

const comparableOf = (outcome: OutcomeRecord): string => JSON.stringify(outcome);

describe('deriveOutcome golden values (OFF-015, A4 provenance)', () => {
  it('derives project one exactly: +3 days, 12M contracted, margin 1/2, one approved order', async () => {
    const outcome = outcomeOfRun(await runOne());

    expect(outcome.outcomeId).toBe(testOutcomeId(1));
    expect(outcome.outcomeVersion).toBe(OUTCOME_SCHEMA_VERSION);
    expect(outcome.engine).toBe(MEMORY_ENGINE);
    expect(outcome.recordedAt).toBe(T5);
    expect(outcome.actor).toStrictEqual(USER_ACTOR);
    expect(outcome.scope).toStrictEqual(projectOneScope());

    expect(outcome.schedule).toMatchObject({
      baselineDurationDays: 10,
      finalDurationDays: 13,
      varianceDays: 3,
    });
    expect(outcome.margin).toMatchObject({
      currency: 'USD',
      originalContractedValueMinor: 10000000,
      contractedValueMinor: 12000000,
      committedCostMinor: 5000000,
      projectedCostMinor: 6000000,
      marginMinor: 6000000,
      marginRatio: { numerator: 1, denominator: 2 },
    });
    expect(outcome.margin.perContract).toHaveLength(1);
    expect(outcome.entitlement).toMatchObject({
      approvedCount: 1,
      executedCount: 0,
      rejectedCount: 0,
      pendingCount: 0,
      approvedValueMinor: 2000000,
      rejectedValueMinor: 0,
      pendingValueMinor: 0,
      approvalRate: { numerator: 1, denominator: 1 },
    });
    expect(outcome.entitlement.orders).toHaveLength(1);
    expect(outcome.entitlement.orders[0]?.status).toBe('approved');
    expect(outcome.changePressure).toMatchObject({
      changeEventCount: 1,
      changeOrderCount: 1,
      contractCount: 1,
    });
    expect(outcome.consumed).toStrictEqual({ projectedEventCount: 13, assessmentCount: 2 });
  });

  it('derives project two exactly: no schedule change, margin 13/20, one rejected order', async () => {
    const outcome = outcomeOfRun(await runTwo());

    expect(outcome.schedule).toMatchObject({
      baselineDurationDays: 10,
      finalDurationDays: 10,
      varianceDays: 0,
    });
    expect(outcome.margin).toMatchObject({
      originalContractedValueMinor: 20000000,
      contractedValueMinor: 20000000, // the rejected order never entered the contracted value
      marginMinor: 13000000,
      marginRatio: { numerator: 13, denominator: 20 },
    });
    expect(outcome.entitlement).toMatchObject({
      rejectedCount: 1,
      approvalRate: { numerator: 0, denominator: 1 },
    });
    expect(outcome.changePressure.changeEventCount).toBe(2);
    expect(outcome.scope).toStrictEqual(projectTwoScope());
  });

  it('derives project three exactly: +2 days, margin 5/16, one pending order', async () => {
    const outcome = outcomeOfRun(await runThree());

    expect(outcome.schedule.varianceDays).toBe(2);
    expect(outcome.margin).toMatchObject({
      contractedValueMinor: 8000000, // a pending order never entered the contracted value
      marginMinor: 2500000,
      marginRatio: { numerator: 5, denominator: 16 },
    });
    expect(outcome.entitlement).toMatchObject({
      pendingCount: 1,
      pendingValueMinor: 1000000,
      approvalRate: { numerator: 0, denominator: 1 },
    });
  });

  it('derives the tenant-B probe project exactly (executed order resolves)', async () => {
    const outcome = outcomeOfRun(await runB1());

    expect(outcome.scope.tenantId).toBe(TENANT_B);
    expect(outcome.margin).toMatchObject({
      contractedValueMinor: 5500000, // contract 5M + executed order 0.5M
      marginMinor: 3000000,
      marginRatio: { numerator: 6, denominator: 11 },
    });
    expect(outcome.entitlement).toMatchObject({
      executedCount: 1,
      approvalRate: { numerator: 1, denominator: 1 }, // executed counts as resolved
    });
  });
});

describe('deriveOutcome provenance spine (OFF-015, A4)', () => {
  it('every outcome fact carries its source event/assessment references', async () => {
    const run = await runOne();
    const outcome = outcomeOfRun(run);

    // The evidence spine is non-empty, canonically ordered (assessments
    // first, then events), and cites exactly the consumed assessments plus
    // the recorded events behind the numbers.
    expect(outcome.evidence.length).toBeGreaterThanOrEqual(6);
    const assessmentEvidence = outcome.evidence.filter((entry) => entry.kind === 'assessment');
    const eventEvidence = outcome.evidence.filter((entry) => entry.kind === 'event');
    expect(assessmentEvidence).toHaveLength(run.assessments.length);
    expect(
      outcome.evidence
        .slice()
        .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'assessment' ? -1 : 1)),
    ).toStrictEqual(outcome.evidence);

    // The schedule's boundary assessments are cited by identity.
    for (const source of outcome.schedule.sources) {
      expect(run.assessments.map((assessment) => assessment.assessmentId)).toContain(
        source.assessmentId,
    );
    }
    // The margin cites the latest-per-contract assessment + the recorded
    // contract events; the entitlement cites the submission + decision
    // events; the change pressure cites the raised change events.
    expect(outcome.margin.sources.length).toBeGreaterThanOrEqual(1);
    expect(outcome.margin.eventSources.length).toBe(1); // one contractCreated event
    expect(outcome.entitlement.eventSources.length).toBe(2); // submission + decision
    expect(outcome.changePressure.eventSources.length).toBe(1); // one changeEventRaised
    for (const entry of eventEvidence) {
      expect(run.stream.map((event) => event.eventId)).toContain(entry.eventId);
    }
  });
});

describe('deriveOutcome determinism (OFF-015)', () => {
  it('the same inputs derive the byte-identical outcome (run twice)', async () => {
    const run = await runOne();

    const first = deriveOutcome(
      { facts: run.facts, assessments: run.assessments },
      {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      },
    );
    const second = deriveOutcome(
      { facts: run.facts, assessments: run.assessments },
      {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toStrictEqual(first.value);
      expect(comparableOf(second.value)).toBe(comparableOf(first.value));
    }
  });

  it('the assessments arrive shuffled — the derived outcome is identical', async () => {
    const run = await runOne();
    const identity = {
      outcomeId: testOutcomeId(1),
      recordedAt: T5,
      actor: USER_ACTOR,
      scope: run.spec.scope,
    };

    const straight = unwrap(deriveOutcome({ facts: run.facts, assessments: run.assessments }, identity));
    const shuffled = unwrap(
      deriveOutcome({ facts: run.facts, assessments: [...run.assessments].reverse() }, identity),
    );

    expect(comparableOf(shuffled)).toBe(comparableOf(straight));
  });

  it('different injected identity parts produce a different record (no hidden identity)', async () => {
    const run = await runOne();
    const first = unwrap(
      deriveOutcome({ facts: run.facts, assessments: run.assessments }, {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      }),
    );
    const second = unwrap(
      deriveOutcome({ facts: run.facts, assessments: run.assessments }, {
        outcomeId: testOutcomeId(99),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      }),
    );

    expect(second.outcomeId).toBe(testOutcomeId(99));
    expect(comparableOf(second)).not.toBe(comparableOf(first));
  });
});

describe('deriveOutcome fail-closed rejections (OFF-015, A12)', () => {
  it('typed-rejects a non-project scope (an outcome records a completed project)', async () => {
    const run = await runOne();
    const result = deriveOutcome(
      { facts: run.facts, assessments: run.assessments },
      {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('outcome-scope-project');
    }
  });

  it('typed-rejects an empty assessment set (the close-out position is required)', async () => {
    const run = await runOne();
    const result = deriveOutcome(
      { facts: run.facts, assessments: [] },
      {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('outcome-assessment-required');
    }
  });

  it('typed-rejects cross-scope assessment inputs BEFORE any derivation (A12)', async () => {
    const runA = await runOne();
    const runB = await runB1();
    // A tenant-B assessment folded into a tenant-A outcome: typed rejection,
    // never a derivation.
    const result = deriveOutcome(
      { facts: runA.facts, assessments: [...runA.assessments, ...runB.assessments] },
      {
        outcomeId: testOutcomeId(1),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: runA.spec.scope,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('outcome-input-scope');
    }
  });

  it('authorization precedes derivation inputs in the query pipeline (reader scoping)', () => {
    // The query surface the outcome set is read through enforces A12 before
    // any record is served — the tenant-B-wide reader can never even see the
    // tenant-A project's outcome (see authorization.test.ts for the full
    // probe); here we pin the scope pairing the golden runs derive under.
    const readerA = memoryReaderOf(tenantAWideScope());
    const readerB = memoryReaderOf(tenantBWideScope());
    expect(readerA.context.scope.tenantId).toBe(TENANT_A);
    expect(readerB.context.scope.tenantId).toBe(TENANT_B);
    expect(readerA.context.scope.tenantId).not.toBe(readerB.context.scope.tenantId);
  });
});
