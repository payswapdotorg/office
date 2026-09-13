import { describe, expect, it } from 'vitest';
import { checkProviderLeakage, loadRepoTree, providerNamePattern } from './rules';

// OFF-039 check 2 — provider leakage: the repo-wide vocabulary scan for real
// provider/vendor/cloud names across every source file. The platform must
// never hard-code provider-specific semantics (freeze A5) and the repo's
// vocabulary rule is generic-only — the real proper-noun names live ONLY as
// this scan's inputs (fragment-assembled, exactly as the landed per-package
// boundary tests already do) and inside the explicitly enumerated sanctioned
// exception files.
describe('provider leakage (OFF-039 architecture conformance)', () => {
  const files = loadRepoTree();

  it('assembles the forbidden-vocabulary scan inputs from fragments', () => {
    // The pattern is a live word-boundary scan over assembled names; it must
    // match every forbidden name (proof the inputs are real) and must never
    // appear verbatim in this suite's own source (the fragment discipline).
    expect(providerNamePattern.source).toMatch(/\\b\(/);
    expect(providerNamePattern.flags).toBe('gi');
    const assembled = ['pro' + 'core', 'auto' + 'desk', 'sa' + 'ge'];
    for (const name of assembled) {
      expect(providerNamePattern.test(`${name} integration`)).toBe(true);
      providerNamePattern.lastIndex = 0;
    }
    // Generic vocabulary stays legal: the landed SDK/domain words are not
    // forbidden by the repo-wide rule (they are banned inside the packages
    // whose own boundary tests carry them — see README.md).
    for (const generic of ['provider identity', 'vendor performance', 'erp-finance', 'existence oracle']) {
      expect(providerNamePattern.test(generic)).toBe(false);
      providerNamePattern.lastIndex = 0;
    }
  });

  it('scans the whole workspace source surface (the scan is never empty)', () => {
    const scanned = files.filter(
      (file) =>
        file.path.endsWith('.ts') &&
        (file.path.startsWith('packages/') ||
          file.path.startsWith('apps/') ||
          file.path.startsWith('tests/')),
    );
    expect(scanned.length).toBeGreaterThanOrEqual(600);
    // The sanctioned exceptions are exactly the enumerated files (the suite
    // itself, the three intelligence scanners carrying literal scan inputs,
    // and the adapter fixture-vocabulary homes) — a new exception needs a
    // README rule change, never a silent widening.
    const exceptionFiles = scanned.filter(
      (file) =>
        file.path.startsWith('tests/architecture/') ||
        /^packages\/intelligence\/(procurement|revenue|stack-analysis)\/src\/boundary\.test\.ts$/.test(
          file.path,
        ) ||
        /^packages\/adapter-(construction|finance|model|schedule)\/src\/(vocabulary|provider-fixture)\.ts$/.test(
          file.path,
        ),
    );
    expect(exceptionFiles.length).toBeGreaterThanOrEqual(12);
  });

  it('passes on the entire current tree — zero leaked names, fail closed', () => {
    const violations = checkProviderLeakage(files);
    expect(violations).toStrictEqual([]);
  });
});
