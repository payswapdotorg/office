import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@office/contracts';
import type { EvidenceSet } from '@office/agents';
import type { ImpactAssessment } from '@office/intelligence-margin';
import type { Benchmark, OutcomeRecord } from '@office/intelligence-memory';
import {
  CONSTRUCTIVE_ASSESSMENT,
  DELAY_ASSESSMENT,
  HISTORY_BENCHMARK,
  REBALANCE_ASSESSMENT,
  goldenInputsOf,
  runGoldenRecoveryScan,
} from './scenarios';
import {
  CONSTRUCTIVE_SHARE_THRESHOLDS,
  DELAY_IMPACT_MIN_DAYS,
  DELAY_IMPACT_THRESHOLDS_DAYS,
  ENTITLEMENT_SHARE_THRESHOLDS,
  REBALANCE_DIVERGENCE_APPROVAL_RATE,
  REBALANCE_MIN_APPROVAL_RATE,
  RECOVERY_DETECTION_TOOL,
  detectRecoveryCandidates,
  qualifyRecoveryEvidenceSet,
} from './detection';
import {
  ALL_RECOVERY_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  DETECTED_AT,
  EMPTY_POLICY,
  TENANT_A,
  projectOneScope,
  recoveryAuthorizationOf,
  tenantAScope,
  tenantBScope,
  testAssessmentId,
  testId,
  testScanId,
} from './test-support';
import { CHANGE_EVENT_KIND } from './model';

// OFF-033 detection — THE scan engine's gate order, its A12 typed
// rejections (both directions, authorization BEFORE scans), the policy
// exclusion, the typed threshold tables, and the A4 evidence-set
// qualification gate (the agents discipline).

const scan = (
  inputs: Parameters<typeof detectRecoveryCandidates>[0],
  authorization: Parameters<typeof detectRecoveryCandidates>[1],
) => detectRecoveryCandidates(inputs, authorization, { scanId: testScanId(7), detectedAt: DETECTED_AT });

describe('the scan gate order (authorization BEFORE scans)', () => {
  it('rejects a context missing any area read capability BEFORE reading any input', () => {
    // The caller is ALSO scope-poisoned (a tenant-B execution scope over
    // tenant-A records): if the capability gate did not run first, the
    // error would be the cross-scope rejection instead.
    const poisonedMissingCapability = recoveryAuthorizationOf(tenantBScope(), {
      capabilities: ALL_RECOVERY_CAPABILITIES.filter(
        (capability) => capability !== 'contracts.read',
      ),
    });
    const rejected = scan(
      goldenInputsOf(runGoldenRecoveryScan()),
      poisonedMissingCapability,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('missing-recovery-capability');
      expect(String(rejected.error.message)).toContain('contracts.read');
    }
  });

  it('names every missing capability when several are absent', () => {
    const missingTwo = recoveryAuthorizationOf(tenantAScope(), {
      capabilities: ['contracts.read'],
    });
    const rejected = scan(goldenInputsOf(runGoldenRecoveryScan()), missingTwo);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(String(rejected.error.message)).toContain('cost.read');
      expect(String(rejected.error.message)).toContain('schedule.read');
    }
  });
});

describe('structural scope coverage of every input (A12 — typed rejections both directions)', () => {
  it('rejects a tenant-B caller scanning tenant-A records (direction 1)', () => {
    const rejected = scan(
      goldenInputsOf(runGoldenRecoveryScan()),
      recoveryAuthorizationOf(tenantBScope()),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('recovery-input-scope');
      // The rejection never reveals the foreign scope (no existence oracle).
      expect(String(rejected.error.message)).not.toContain(String(TENANT_A));
    }
  });

  it('rejects a tenant-A caller scanning inputs that carry a tenant-B record (direction 2)', () => {
    const base = goldenInputsOf(runGoldenRecoveryScan());
    const foreignOutcome: OutcomeRecord = {
      ...at(base.outcomes, 0),
      scope: tenantBScope(),
    };
    const rejected = scan(
      { ...base, outcomes: [foreignOutcome, ...base.outcomes] },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('recovery-input-scope');
    }
  });

  it('rejects a tenant-A caller scanning a tenant-B assessment (direction 2, economic input)', () => {
    const base = goldenInputsOf(runGoldenRecoveryScan());
    const foreignAssessment: ImpactAssessment = {
      ...at(base.assessments, 0),
      assessmentId: testAssessmentId(41),
      scope: tenantBScope(),
    };
    const rejected = scan(
      { ...base, assessments: [...base.assessments, foreignAssessment] },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('recovery-input-scope');
    }
  });
});

describe('duplicate input identities are a typed invariant violation', () => {
  it('rejects a duplicated assessment id (an input set is a set)', () => {
    const base = goldenInputsOf(runGoldenRecoveryScan());
    const rejected = scan(
      { ...base, assessments: [...base.assessments, base.assessments[0]!] },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('duplicate-input');
    }
  });

  it('rejects a duplicated change-event id', () => {
    const base = goldenInputsOf(runGoldenRecoveryScan());
    const rejected = scan(
      { ...base, changeEvents: [...base.changeEvents, base.changeEvents[0]!] },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('duplicate-input');
      expect(String(rejected.error.details[0]?.message)).toBe(String(base.changeEvents[0]?.entityId));
    }
  });
});

describe('the policy gate (deny-by-default; denied records are invisible, never errors)', () => {
  it('an explicit-deny-every-read policy excludes every candidate (ok, empty)', () => {
    const denyAll = recoveryAuthorizationOf(tenantAScope(), {
      policy: DENY_ALL_READS_POLICY,
    });
    const rejected = scan(goldenInputsOf(runGoldenRecoveryScan()), denyAll);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) {
      expect(rejected.value).toStrictEqual([]);
    }
  });

  it('the empty policy denies by default (no allow rule, no candidates)', () => {
    const emptyPolicyReader = recoveryAuthorizationOf(tenantAScope(), {
      policy: EMPTY_POLICY,
    });
    const result = scan(goldenInputsOf(runGoldenRecoveryScan()), emptyPolicyReader);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });
});

describe('the typed threshold tables (the pinned detection thresholds)', () => {
  it('pins the constructive/entitlement share thresholds and the delay-day thresholds', () => {
    expect(CONSTRUCTIVE_SHARE_THRESHOLDS).toStrictEqual([
      { minShare: { numerator: 1, denominator: 2 }, level: 'critical' },
      { minShare: { numerator: 1, denominator: 5 }, level: 'major' },
      { minShare: { numerator: 1, denominator: 20 }, level: 'moderate' },
    ]);
    expect(ENTITLEMENT_SHARE_THRESHOLDS).toStrictEqual(CONSTRUCTIVE_SHARE_THRESHOLDS);
    expect(DELAY_IMPACT_THRESHOLDS_DAYS).toStrictEqual([
      { minDays: 20, level: 'critical' },
      { minDays: 10, level: 'major' },
      { minDays: 4, level: 'moderate' },
    ]);
    expect(DELAY_IMPACT_MIN_DAYS).toBe(1);
    expect(REBALANCE_MIN_APPROVAL_RATE).toStrictEqual({ numerator: 1, denominator: 2 });
    expect(REBALANCE_DIVERGENCE_APPROVAL_RATE).toStrictEqual({ numerator: 9, denominator: 10 });
    expect(RECOVERY_DETECTION_TOOL).toBe('recovery-candidate-detection');
  });

  it('a delay below the minimum slip raises no candidate', () => {
    const run = runGoldenRecoveryScan();
    const belowMin: ImpactAssessment = {
      ...DELAY_ASSESSMENT,
      scheduleImpact: {
        ...DELAY_ASSESSMENT.scheduleImpact,
        projectDurationDelta: 0,
      },
    };
    const result = scan(
      {
        ...goldenInputsOf(run),
        assessments: [CONSTRUCTIVE_ASSESSMENT, REBALANCE_ASSESSMENT, belowMin],
      },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((candidate) => candidate.kind)).toStrictEqual([
        'constructive-change',
        'entitlement-rebalance',
      ]);
    }
  });

  it('a constructive position with no recorded cost raises no candidate', () => {
    const run = runGoldenRecoveryScan();
    const noCost: ImpactAssessment = {
      ...CONSTRUCTIVE_ASSESSMENT,
      costImpact: {
        ...CONSTRUCTIVE_ASSESSMENT.costImpact,
        budgetRevisionDeltaMinor: 0,
      },
    };
    const result = scan(
      {
        ...goldenInputsOf(run),
        assessments: [noCost, REBALANCE_ASSESSMENT, DELAY_ASSESSMENT],
      },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((candidate) => candidate.kind)).toStrictEqual([
        'entitlement-rebalance',
        'delay-impact',
      ]);
    }
  });

  it('no benchmark context fail-closes the rebalance rule (the historical gate)', () => {
    const run = runGoldenRecoveryScan();
    const result = scan({ ...goldenInputsOf(run), benchmarks: [] }, recoveryAuthorizationOf(tenantAScope()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((candidate) => candidate.kind)).toStrictEqual([
        'constructive-change',
        'delay-impact',
      ]);
    }
  });

  it('a rejecting historical climate (mean approval < 1/2) suppresses the rebalance candidate', () => {
    const run = runGoldenRecoveryScan();
    const rejectingClimate: Benchmark = {
      ...HISTORY_BENCHMARK,
      metrics: HISTORY_BENCHMARK.metrics.map((metric) =>
        metric.kind === 'entitlement-approval-rate'
          ? { ...metric, mean: { numerator: 2, denominator: 5 } }
          : metric,
      ),
    };
    const result = scan(
      { ...goldenInputsOf(run), benchmarks: [rejectingClimate] },
      recoveryAuthorizationOf(tenantAScope()),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((candidate) => candidate.kind)).toStrictEqual([
        'constructive-change',
        'delay-impact',
      ]);
    }
  });
});

describe('THE evidence-set qualification gate (freeze A4 — the agents discipline)', () => {
  const entity: EntityRef = { entityKind: CHANGE_EVENT_KIND, entityId: testId('chg', 1) };
  const itemOf = (parts: {
    readonly scope: ReturnType<typeof projectOneScope>;
    readonly entity: EntityRef | null;
  }): EvidenceSet['items'][number] => ({
    kind: 'margin-assessment',
    ref: 'assessment-0001',
    entity: parts.entity,
    scope: parts.scope,
    confidence: 'high',
    retrieval: {
      tool: RECOVERY_DETECTION_TOOL,
      query: { kind: 'margin-assessment', assessmentId: testAssessmentId(1) },
      retrievedAt: DETECTED_AT,
    },
  });

  it('rejects an EMPTY evidence set (a typed rejection, never a silently-propagated candidate)', () => {
    const rejected = qualifyRecoveryEvidenceSet({ items: [] }, projectOneScope());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('empty-evidence-set');
    }
  });

  it('rejects an entity-less evidence item (nothing to scope-check)', () => {
    const rejected = qualifyRecoveryEvidenceSet(
      { items: [itemOf({ scope: projectOneScope(), entity: null })] },
      projectOneScope(),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('evidence-scope-violation');
    }
  });

  it('rejects an out-of-scope evidence item (freeze A12 — never silently trusted)', () => {
    const rejected = qualifyRecoveryEvidenceSet(
      { items: [itemOf({ scope: tenantBScope(), entity })] },
      projectOneScope(),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.details[0]?.code).toBe('evidence-scope-violation');
    }
  });

  it('accepts a non-empty, fully covered evidence set', () => {
    const qualified = qualifyRecoveryEvidenceSet(
      { items: [itemOf({ scope: projectOneScope(), entity })] },
      projectOneScope(),
    );
    expect(qualified).toStrictEqual({ ok: true, value: true });
  });

  it('a tenant-wide scan scope covers project evidence items (scope hierarchy)', () => {
    const qualified = qualifyRecoveryEvidenceSet(
      { items: [itemOf({ scope: projectOneScope(), entity })] },
      { kind: 'tenant', tenantId: TENANT_A },
    );
    expect(qualified.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Local probe helpers (deterministic, no environment).
// ---------------------------------------------------------------------------

const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`probe index ${index} out of bounds`);
  }
  return value;
};
