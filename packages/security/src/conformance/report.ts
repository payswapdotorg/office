// Office security — the composed conformance report (OFF-036).
//
// runSecurityConformance() runs ALL FOUR conformance checks — tenant
// isolation, authorization boundaries, audit completeness, revocation —
// each against a FRESH harness from the supplied factory (so the checks
// never observe each other's state), and composes the typed
// SecurityAuditReport: which checks passed, which failed with what typed
// failures, and the deterministic totals. THE release-gate surface: OFF-038
// runs this one function and reads `passed`.
//
// Determinism: no clock, no randomness anywhere — the same factory produces
// the same report on every run (the run-twice proofs rely on it).
import type { ConformanceCheckResult } from './evidence';
import { CONFORMANCE_CHECK_IDS } from './evidence';
import type { ConformanceHarness } from './harness';
import {
  driveTenantIsolationProbes,
  evaluateTenantIsolation,
} from './tenant-isolation';
import {
  driveAuthorizationBoundaryProbes,
  evaluateAuthorizationBoundaries,
} from './authorization';
import {
  auditLedgerSnapshot,
  driveConsequentialMutations,
  evaluateAuditCompleteness,
} from './completeness';
import { driveRevocationProbes, evaluateRevocation } from './revocation';

/** The composed conformance report of one scenario. */
export interface SecurityAuditReport {
  /** The scenario name (the harness factory's name). */
  readonly scenario: string;
  /** Every check's typed result, in canonical order. */
  readonly checks: readonly ConformanceCheckResult[];
  /** True iff every check passed (THE release gate boolean). */
  readonly passed: boolean;
  /** Deterministic totals over the whole report. */
  readonly totals: {
    readonly checks: number;
    readonly checksPassed: number;
    readonly checksFailed: number;
    readonly probes: number;
    readonly failures: number;
  };
}

/** Compose the typed report over check results (pure, deterministic). */
const composeReport = (
  scenario: string,
  checks: readonly ConformanceCheckResult[],
): SecurityAuditReport => ({
  scenario,
  checks: [...checks],
  passed: checks.every((check) => check.passed),
  totals: {
    checks: checks.length,
    checksPassed: checks.filter((check) => check.passed).length,
    checksFailed: checks.filter((check) => !check.passed).length,
    probes: checks.reduce((sum, check) => sum + check.probes, 0),
    failures: checks.reduce((sum, check) => sum + check.failures.length, 0),
  },
});

/**
 * Run the FULL security conformance suite against the harnesses a factory
 * builds: every check drives its own fresh harness through the REAL action
 * gateway and the REAL app runtime, evaluates the recorded evidence purely,
 * and the typed report composes the results in canonical order.
 */
export async function runSecurityConformance(
  build: () => ConformanceHarness,
): Promise<SecurityAuditReport> {
  // The scenario name comes from the first harness (the factory's name is
  // constant across its builds).
  const scenario = build().name;
  const tenantIsolation = evaluateTenantIsolation(
    await driveTenantIsolationProbes(build()),
  );
  const authorizationBoundaries = evaluateAuthorizationBoundaries(
    await driveAuthorizationBoundaryProbes(build()),
  );
  const completenessHarness = build();
  const completeness = evaluateAuditCompleteness({
    mutations: await driveConsequentialMutations(completenessHarness),
    ledger: auditLedgerSnapshot(completenessHarness),
  });
  const revocation = evaluateRevocation(await driveRevocationProbes(build()));
  const byId = new Map<string, ConformanceCheckResult>([
    ['tenant-isolation', tenantIsolation],
    ['authorization-boundaries', authorizationBoundaries],
    ['audit-completeness', completeness],
    ['revocation', revocation],
  ]);
  const checks = CONFORMANCE_CHECK_IDS.map((id) => {
    const check = byId.get(id);
    if (check === undefined) {
      throw new TypeError(`conformance check '${id}' produced no result`);
    }
    return check;
  });
  return composeReport(scenario, checks);
}
