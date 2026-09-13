import { beforeAll, describe, expect, it } from 'vitest';
import { definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import type { ImpactAssessment } from '@office/intelligence-margin';
import type { Benchmark } from '@office/intelligence-memory';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import {
  ALL_EXCEPTION_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  DETECTED_AT,
  EMPTY_POLICY,
  exceptionAuthorizationOf,
  projectOneReader,
  projectOneScope,
  projectTwoScope,
  tenantBScope,
  testScanId,
  unwrap,
} from './test-support';
import { runPortfolioScan } from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import type { ExceptionAuthorization } from './authorization';
import {
  DEPENDENCY_THRESHOLDS_COUNT,
  ECONOMIC_SHARE_THRESHOLDS,
  SCHEDULE_SLIP_MIN_DAYS,
  SCHEDULE_SLIP_THRESHOLDS_DAYS,
  detectExceptions,
} from './scan';
import type { ExceptionScanInputs } from './scan';
import type { Exception } from './model';

// OFF-019 detection — THE deterministic scan pass. Authorization runs BEFORE
// any input is read (capability gate first, A12 structural scope coverage
// second, policy exclusion third — the poisoned-input probes prove the
// ordering), duplicate assessment ids are typed-rejected, and the scan
// identity is injected (exception ids derive from it, never from a clock).

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

const inputsOf = (source: PortfolioScanRun): ExceptionScanInputs => ({
  assessments: source.assessments,
  subgraphs: source.subgraphs,
  benchmarks: [source.benchmark],
});

const scanWith = (
  inputs: ExceptionScanInputs,
  options: {
    readonly reader?: ExceptionAuthorization;
    readonly scan?: number;
  } = {},
): ReturnType<typeof detectExceptions> =>
  detectExceptions(inputs, options.reader ?? projectOneReader(), {
    scanId: testScanId(options.scan ?? 1),
    detectedAt: DETECTED_AT,
  });

describe('the typed detection thresholds (OFF-019)', () => {
  it('pins the schedule-slip severity thresholds (days)', () => {
    expect(SCHEDULE_SLIP_THRESHOLDS_DAYS).toStrictEqual([
      { minDays: 20, level: 'critical' },
      { minDays: 10, level: 'major' },
      { minDays: 4, level: 'moderate' },
    ]);
    expect(SCHEDULE_SLIP_MIN_DAYS).toBe(1);
  });

  it('pins the economic-share severity thresholds (exact rationals)', () => {
    expect(ECONOMIC_SHARE_THRESHOLDS).toStrictEqual([
      { minShare: { numerator: 1, denominator: 2 }, level: 'critical' },
      { minShare: { numerator: 1, denominator: 5 }, level: 'major' },
      { minShare: { numerator: 1, denominator: 20 }, level: 'moderate' },
    ]);
  });

  it('pins the dependency-risk severity thresholds (downstream count)', () => {
    expect(DEPENDENCY_THRESHOLDS_COUNT).toStrictEqual([
      { minDownstream: 8, level: 'critical' },
      { minDownstream: 4, level: 'major' },
      { minDownstream: 2, level: 'moderate' },
    ]);
  });
});

describe('determinism + injected scan identity (OFF-019)', () => {
  it('reproduces the byte-identical exception set from the same inputs', () => {
    const first = unwrap(scanWith(inputsOf(run)));
    const second = unwrap(scanWith(inputsOf(run)));
    expect(first).toStrictEqual(second);
    expect(first).toStrictEqual(run.exceptions);
  });

  it('derives the exception identities from the injected scan identity', () => {
    const other = unwrap(scanWith(inputsOf(run), { scan: 2 }));
    expect(other.map((exception) => exception.exceptionId)).toStrictEqual([
      'scan-0002#0001',
      'scan-0002#0002',
      'scan-0002#0003',
      'scan-0002#0004',
      'scan-0002#0005',
    ]);
    // The CONTENT is identical: only the injected identity changed.
    expect(other.map(contentOf)).toStrictEqual(run.exceptions.map(contentOf));
  });

  it('carries the injected clock, never wall time', () => {
    for (const exception of run.exceptions) {
      expect(exception.detectedAt).toBe(DETECTED_AT);
      expect(exception.provenance.detectedAt).toBe(DETECTED_AT);
    }
  });
});

describe('authorization runs BEFORE any scan input is read (OFF-019)', () => {
  const poison = (): never => {
    throw new Error('poisoned scan input read — the gate must fire first');
  };
  const poisonedInputs = {
    get assessments(): readonly ImpactAssessment[] {
      return poison();
    },
    get subgraphs(): readonly TraversalSubgraph[] {
      return poison();
    },
    get benchmarks(): readonly Benchmark[] {
      return poison();
    },
  } satisfies ExceptionScanInputs;

  for (const missing of ['contracts.read', 'cost.read', 'schedule.read'] as const) {
    it(`denies a scan missing ${missing} without reading a single input`, () => {
      const reader = exceptionAuthorizationOf(projectOneScope(), {
        capabilities: ALL_EXCEPTION_CAPABILITIES.filter(
          (capability) => capability !== missing,
        ),
      });
      const result = detectExceptions(poisonedInputs, reader, {
        scanId: testScanId(1),
        detectedAt: DETECTED_AT,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details[0]?.code).toBe('missing-exception-capability');
        expect(result.error.details[0]?.message).toContain(missing);
        // The denial context carries the REQUEST scope (A12).
        expect(result.error.scope).toStrictEqual(projectOneScope());
      }
    });
  }

  it('denies the capability-less scan BEFORE the cross-scope input rejection', () => {
    // The inputs are cross-scope AND the reader is capability-less: the
    // capability gate must win (a scope-first wiring would return the
    // cross-scope rejection instead).
    const reader = exceptionAuthorizationOf(projectOneScope(), { capabilities: [] });
    const result = detectExceptions(
      { assessments: crossScopeAssessments(), subgraphs: [], benchmarks: [] },
      reader,
      { scanId: testScanId(1), detectedAt: DETECTED_AT },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('missing-exception-capability');
    }
  });
});

describe('cross-scope scan inputs are typed-rejected (freeze A12, both directions)', () => {
  it('rejects tenant-B assessments scanned by the tenant-A reader', () => {
    const result = detectExceptions(
      { assessments: crossScopeAssessments(), subgraphs: [], benchmarks: [] },
      projectOneReader(),
      { scanId: testScanId(1), detectedAt: DETECTED_AT },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('exception-input-scope');
      // Never an existence oracle: the rejection names no foreign scope.
      expect(result.error.message).not.toContain('office-tnt');
      expect(result.error.scope).toStrictEqual(projectOneScope());
    }
  });

  it('rejects tenant-A assessments scanned by the tenant-B reader (reverse direction)', () => {
    const reader = exceptionAuthorizationOf(tenantBScope());
    const result = scanWith(inputsOf(run), { reader });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('exception-input-scope');
    }
  });

  it('rejects project-two subgraph nodes scanned by the project-one reader', () => {
    const subgraphs: readonly TraversalSubgraph[] = run.subgraphs.map((subgraph, index) =>
      index === 0
        ? {
            ...subgraph,
            nodes: subgraph.nodes.map((node, nodeIndex) =>
              nodeIndex === 0 ? { ...node, scope: projectTwoScope() } : node,
            ),
          }
        : subgraph,
    );
    const result = scanWith({ assessments: run.assessments, subgraphs, benchmarks: [run.benchmark] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('exception-input-scope');
    }
  });

  it('rejects project-one inputs scanned by the project-two reader (project boundary)', () => {
    const reader = exceptionAuthorizationOf(projectTwoScope());
    const result = scanWith(inputsOf(run), { reader });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('exception-input-scope');
    }
  });

  it('rejects a cross-tenant benchmark input', () => {
    const benchmarks: readonly Benchmark[] = [{ ...run.benchmark, scope: tenantBScope() }];
    const result = scanWith({
      assessments: run.assessments,
      subgraphs: run.subgraphs,
      benchmarks,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('exception-input-scope');
    }
  });
});

describe('duplicate scan inputs are typed-rejected (OFF-019)', () => {
  it('rejects a duplicate assessment id (an input set is a set)', () => {
    const assessments: readonly ImpactAssessment[] = [...run.assessments, run.assessments[0]!];
    const result = scanWith({ assessments, subgraphs: run.subgraphs, benchmarks: [run.benchmark] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('duplicate-assessment');
      expect(result.error.details[0]?.path).toBe('assessments');
    }
  });
});

describe('policy-denied inputs are invisible to the scan (OFF-019)', () => {
  it('excludes every input under an explicit deny-all policy (empty set, no error)', () => {
    const reader = exceptionAuthorizationOf(projectOneScope(), {
      policy: DENY_ALL_READS_POLICY,
    });
    const result = scanWith(inputsOf(run), { reader });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });

  it('denies by default under the empty policy (no allow rule)', () => {
    const reader = exceptionAuthorizationOf(projectOneScope(), { policy: EMPTY_POLICY });
    const result = scanWith(inputsOf(run), { reader });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toStrictEqual([]);
    }
  });

  it('excludes only the denied resource kinds (benchmark-denying policy)', () => {
    // Reads of change-event resources are allowed; the tenant-level
    // benchmark resource is not — so the scan computes WITHOUT calibration.
    const benchmarkDenyingPolicy: Policy = definePolicy([
      { effect: 'allow', actions: ['read'], resourceKinds: ['change-event'] },
    ]);
    const reader = exceptionAuthorizationOf(projectOneScope(), {
      policy: benchmarkDenyingPolicy,
    });
    const result = scanWith(inputsOf(run), { reader });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Every rule still fires — but uncalibrated.
      expect(result.value.map((exception) => exception.kind)).toStrictEqual([
        'schedule-slip',
        'cost-overrun',
        'entitlement-exposure',
        'dependency-risk',
        'evidence-gap',
      ]);
      const byKind = new Map(result.value.map((exception) => [exception.kind, exception]));
      // The 2-day slip is minor without the p90 calibration (was moderate).
      expect(byKind.get('schedule-slip')?.severity).toStrictEqual({
        level: 'minor',
        reasons: ['schedule-slip-days'],
      });
      // The 3/8 overrun is major without the margin-ratio calibration (was critical).
      expect(byKind.get('cost-overrun')?.severity).toStrictEqual({
        level: 'major',
        reasons: ['cost-overrun-share'],
      });
      // No benchmark is consumed, cited, or carried anywhere.
      for (const exception of result.value) {
        expect(exception.provenance.consumed.benchmarkCount).toBe(0);
        expect(exception.provenance.calibrationBenchmarkIds).toStrictEqual([]);
        expect(
          exception.evidence.filter((evidence) => evidence.kind === 'benchmark'),
        ).toStrictEqual([]);
      }
    }
  });
});

/** The golden assessments with a tenant-B scope (a foreign wiring error). */
const crossScopeAssessments = (): readonly ImpactAssessment[] =>
  run.assessments.map((assessment) => ({ ...assessment, scope: tenantBScope() }));

/** One exception's content without its injected identity parts. */
const contentOf = (
  exception: Exception,
): Omit<Exception, 'exceptionId' | 'provenance' | 'detectedAt'> => {
  const {
    exceptionId: _exceptionId,
    provenance: _provenance,
    detectedAt: _detectedAt,
    ...content
  } = exception;
  return content;
};
