// OFF-036 security — the composed conformance report (THE release-gate
// surface). runSecurityConformance runs ALL FOUR checks — tenant isolation,
// authorization boundaries, audit completeness, revocation — each against a
// FRESH harness from the supplied factory (the checks never observe each
// other's state) and composes the typed SecurityAuditReport OFF-038 reads:
// `passed` is the release-gate boolean. This suite proves the composition,
// the canonical check order, the deterministic totals, run-twice
// determinism (byte-identical reports), and that a failing check fails the
// composed report.
import { describe, expect, it } from 'vitest';
import { CONFORMANCE_CHECK_IDS } from './evidence';
import { makeConformanceHarness } from './harness';
import { runSecurityConformance } from './report';

describe('the composed security conformance report (OFF-036)', () => {
  it('runs the FULL suite against fresh harnesses and every check passes', async () => {
    const report = await runSecurityConformance(() => makeConformanceHarness());
    expect(report.scenario).toBe('office-security-conformance');
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.check)).toStrictEqual([
      ...CONFORMANCE_CHECK_IDS,
    ]);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.totals).toStrictEqual({
      checks: 4,
      checksPassed: 4,
      checksFailed: 0,
      probes: 58,
      failures: 0,
    });
  });

  it('runs each check against a FRESH harness — checks never observe each other state', async () => {
    const report = await runSecurityConformance(() => makeConformanceHarness());
    // Each check's probe count matches a single-check drive exactly (the
    // driver-observed fixtures: 7 + 27 + 10 + 14); a shared, polluted
    // harness would change the completeness counting at minimum.
    expect(report.checks.map((check) => check.probes)).toStrictEqual([7, 27, 10, 14]);
  });

  it('is deterministic run-twice: two runs produce deep-equal reports', async () => {
    const first = await runSecurityConformance(() => makeConformanceHarness());
    const second = await runSecurityConformance(() => makeConformanceHarness());
    expect(second).toStrictEqual(first);
    // The determinism reaches the identifiers: every probe-driven audit row
    // (derived ledger ids, dense sequences) reproduces byte-identically.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('fails the composed report when any check fails (the release-gate boolean)', async () => {
    // A factory whose harness is degraded BEFORE any probe runs: the
    // installation store starts empty, so every app-surface probe sees an
    // unknown installation and the tenant-isolation check fails typed.
    const degradedFactory = () => {
      const harness = makeConformanceHarness();
      const installations = harness.store.installations.installations();
      for (const installation of installations) {
        harness.store.installations.put({
          ...installation,
          state: 'installing',
          activatedAt: null,
        });
      }
      return harness;
    };
    const report = await runSecurityConformance(degradedFactory);
    expect(report.passed).toBe(false);
    expect(report.totals.checksFailed).toBeGreaterThan(0);
    expect(report.totals.failures).toBeGreaterThan(0);
  });
});
