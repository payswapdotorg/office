import { describe, expect, it } from 'vitest';
import { definePolicy } from '@office/authz';
import {
  SWITCH_MIN_SAVING_SHARE,
  TIMING_MIN_ASSESSED_DELAY_DAYS,
  TIMING_MIN_LEAD_GAIN_DAYS,
  detectProcurementRecommendations,
  qualifyProcurementEvidenceSet,
} from './recommendation';
import type { ProcurementScanInputs } from './recommendation';
import { parseProcurementAlternative } from './comparison';
import { HISTORY_OUTCOMES, goldenInputsOf, needScenarioOf, runGoldenProcurementScan } from './scenarios';
import {
  ALL_PROCUREMENT_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  DETECTED_AT,
  EMPTY_POLICY,
  TENANT_B,
  procurementAuthorizationOf,
  projectOneScope,
  tenantAScope,
  tenantBScope,
  tenantReader,
  testId,
  testScanId,
  unwrap,
} from './test-support';
import type { ProcurementAuthorization } from './authorization';

// OFF-034 recommendation — THE deterministic detection pass: the fixed gate
// order (capability BEFORE any input byte is read, duplicate identities,
// A12 scope coverage of every input, policy exclusion, fail-closed wiring),
// the three typed rules with their pinned thresholds (the noise thresholds
// of SWITCH_MIN_SAVING_SHARE / TIMING_MIN_LEAD_GAIN_DAYS /
// TIMING_MIN_ASSESSED_DELAY_DAYS), and the A4 evidence-set qualification
// gate (an empty or out-of-scope set is a typed rejection).

const run = runGoldenProcurementScan();
const scanOf = (
  inputs: ProcurementScanInputs,
  authorization: ProcurementAuthorization = tenantReader(),
  n = 41,
) => detectProcurementRecommendations(inputs, authorization, {
  scanId: testScanId(n),
  detectedAt: DETECTED_AT,
});

/** One variant scenario's scan inputs (vendor-41-family quotes, no history). */
const variantInputsOf = (parts: Parameters<typeof needScenarioOf>[0]): ProcurementScanInputs => {
  const scenario = needScenarioOf(parts);
  return {
    budgets: [scenario.budget],
    commitments: [scenario.commitment],
    alternatives: scenario.alternatives,
    assessments: [scenario.assessment],
    outcomes: [],
    benchmarks: [],
  };
};

/** Parse one extra quoted alternative appended to the golden inputs. */
const extraQuoteOf = (overrides: Record<string, unknown>): ProcurementScanInputs['alternatives'][number] =>
  unwrap(
    parseProcurementAlternative({
      alternativeId: 'quote-x01',
      vendorKey: 'vendor-41',
      scope: projectOneScope(),
      incumbentCommitmentId: testId('com', 11),
      incumbentVendor: false,
      quotedQuantityMilli: 1_000,
      quotedUnitRateMinor: 100_000,
      currency: 'USD',
      leadTimeDays: 10,
      outcomeIds: [],
      ...overrides,
    }),
  );

describe('the scan gate order (authorization BEFORE any comparison)', () => {
  it('the capability gate rejects BEFORE any input byte is read (poisoned-input probe)', () => {
    const missing = procurementAuthorizationOf(tenantAScope(), {
      capabilities: ALL_PROCUREMENT_CAPABILITIES.filter(
        (capability) => capability !== 'cost.read',
      ),
    });
    // The inputs are POISONED with a cross-tenant record: the capability
    // gate must fire first (a scope violation would prove inputs were read).
    const poisoned = {
      ...goldenInputsOf(run),
      budgets: [{ ...run.budgets[0]!, scope: tenantBScope() }],
    };
    const rejected = scanOf(poisoned, missing);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('forbidden');
      expect(rejected.error.details[0]?.code).toBe('missing-procurement-capability');
      expect(String(rejected.error.message)).toContain('cost.read');
    }
  });

  it('duplicate input identities are typed invariant violations (an input set is a set)', () => {
    const base = goldenInputsOf(run);
    const duplicates: readonly [string, ProcurementScanInputs][] = [
      ['budget', { ...base, budgets: [...base.budgets, base.budgets[0]!] }],
      ['commitment', { ...base, commitments: [...base.commitments, base.commitments[0]!] }],
      ['alternative', { ...base, alternatives: [...base.alternatives, base.alternatives[0]!] }],
      ['assessment', { ...base, assessments: [...base.assessments, base.assessments[0]!] }],
      ['outcome', { ...base, outcomes: [...base.outcomes, base.outcomes[0]!] }],
      ['benchmark', { ...base, benchmarks: [...base.benchmarks, base.benchmarks[0]!] }],
    ];
    for (const [family, inputs] of duplicates) {
      const rejected = scanOf(inputs);
      expect(rejected.ok, family).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('invariant-violation');
        expect(rejected.error.details[0]?.code).toBe('duplicate-input');
        expect(rejected.error.details[0]?.path).toBe(family);
      }
    }
  });

  it('cross-scope INPUTS are typed-rejected (A12 — never an existence oracle)', () => {
    const base = goldenInputsOf(run);
    const poisoned = { ...base, budgets: [{ ...base.budgets[0]!, scope: tenantBScope() }] };
    const rejected = scanOf(poisoned);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('procurement-input-scope');
      // The rejection never names the foreign scope (no tenant leak — the
    // caller's own scope is the only one the context carries).
      expect(JSON.stringify(rejected.error)).not.toContain(String(TENANT_B));
    }
  });

  it('policy-denied records are EXCLUDED from the scan (never errors, counted in consumed)', () => {
    // Every read denied: nothing is admitted, nothing is detected.
    const deniedAll = scanOf(
      goldenInputsOf(run),
      procurementAuthorizationOf(tenantAScope(), { policy: DENY_ALL_READS_POLICY }),
    );
    expect(unwrap(deniedAll)).toStrictEqual([]);
    // Deny-by-default (no rules at all): equally nothing.
    const emptyPolicy = scanOf(
      goldenInputsOf(run),
      procurementAuthorizationOf(tenantAScope(), { policy: EMPTY_POLICY }),
    );
    expect(unwrap(emptyPolicy)).toStrictEqual([]);
    // A scoped denial (budgets only): the needs lose their basis, the scan
    // still succeeds with an empty set.
    const deniedBudgets = scanOf(
      goldenInputsOf(run),
      procurementAuthorizationOf(tenantAScope(), {
        policy: definePolicy([
          { effect: 'deny', actions: ['read'], resourceKinds: ['budget'] },
          { effect: 'allow', actions: ['read'] },
        ]),
      }),
    );
    expect(unwrap(deniedBudgets)).toStrictEqual([]);
  });
});

describe('the fail-closed structural wiring (never a silent drop)', () => {
  it('rejects an alternative naming an unknown incumbent commitment', () => {
    const inputs = {
      ...goldenInputsOf(run),
      alternatives: [...run.alternatives, extraQuoteOf({ incumbentCommitmentId: testId('com', 99) })],
    };
    const rejected = scanOf(inputs);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('unknown-incumbent-commitment');
    }
  });

  it('rejects an alternative quoting a currency the addressed budget does not carry', () => {
    const inputs = {
      ...goldenInputsOf(run),
      alternatives: [...run.alternatives, extraQuoteOf({ currency: 'EUR' })],
    };
    const rejected = scanOf(inputs);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('alternative-currency-mismatch');
    }
  });

  it('rejects an alternative referencing a vendor-history outcome outside the input set', () => {
    // The golden scan inputs carry the golden vendor-history outcome set, so
    // the probe's 'outcome-9999' is genuinely OUTSIDE a NON-EMPTY input set
    // (the rejection is proven against real history, not against a vacuum).
    expect(goldenInputsOf(run).outcomes).toStrictEqual(HISTORY_OUTCOMES);
    const inputs = {
      ...goldenInputsOf(run),
      alternatives: [...run.alternatives, extraQuoteOf({ outcomeIds: ['outcome-9999'] })],
    };
    const rejected = scanOf(inputs);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('unknown-vendor-history-outcome');
    }
  });

  it('rejects a need carrying more than one incumbent vendor re-quote', () => {
    const inputs = {
      ...goldenInputsOf(run),
      alternatives: [...run.alternatives, extraQuoteOf({ incumbentVendor: true })],
    };
    const rejected = scanOf(inputs);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('duplicate-incumbent-quote');
    }
  });
});

describe('THE three recommendation rules and their pinned thresholds', () => {
  it('a vendor switch at EXACTLY the 1/40 saving share is recommended (the noise floor)', () => {
    // Incumbent path 2,040,000; the challenger saves exactly 51,000 = 1/40.
    const detected = unwrap(
      scanOf(
        variantInputsOf({
          n: 41,
          costItemQuantityMilli: 2_000,
          costItemUnitRateMinor: 1_000_000,
          commitmentAmountMinor: 2_000_000,
          assessedDeltaMinor: 40_000,
          assessedDurationDelta: 0,
          quotes: [
            {
              alternativeId: 'quote-f1',
              vendorKey: 'vendor-42',
              incumbentVendor: true,
              quantityMilli: 2_000,
              unitRateMinor: 1_020_000,
              leadTimeDays: 30,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-f2',
              vendorKey: 'vendor-43',
              incumbentVendor: false,
              quantityMilli: 2_000,
              unitRateMinor: 994_500,
              leadTimeDays: 28,
              outcomeIds: [],
            },
          ],
        }),
      ),
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]?.kind).toBe('vendor-switch');
    expect(SWITCH_MIN_SAVING_SHARE).toStrictEqual({ numerator: 1, denominator: 40 });
  });

  it('a vendor switch BELOW the saving share is noise — no recommendation at all', () => {
    // Saving 50,000 of 2,040,000 = 25/1020 < 1/40: under the noise floor.
    const detected = unwrap(
      scanOf(
        variantInputsOf({
          n: 42,
          costItemQuantityMilli: 2_000,
          costItemUnitRateMinor: 1_000_000,
          commitmentAmountMinor: 2_000_000,
          assessedDeltaMinor: 40_000,
          assessedDurationDelta: 0,
          quotes: [
            {
              alternativeId: 'quote-g1',
              vendorKey: 'vendor-44',
              incumbentVendor: true,
              quantityMilli: 2_000,
              unitRateMinor: 1_020_000,
              leadTimeDays: 30,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-g2',
              vendorKey: 'vendor-45',
              incumbentVendor: false,
              quantityMilli: 2_000,
              unitRateMinor: 995_000,
              leadTimeDays: 28,
              outcomeIds: [],
            },
          ],
        }),
      ),
    );
    expect(detected).toStrictEqual([]);
  });

  it('an order split that does NOT undercut the incumbent path is not a recommendation', () => {
    // Combined 3,500,000 + 3,600,000 = 7,100,000 >= the 7,100,000 path.
    const detected = unwrap(
      scanOf(
        variantInputsOf({
          n: 43,
          costItemQuantityMilli: 8_000,
          costItemUnitRateMinor: 1_000_000,
          commitmentAmountMinor: 7_000_000,
          assessedDeltaMinor: 100_000,
          assessedDurationDelta: 0,
          quotes: [
            {
              alternativeId: 'quote-h1',
              vendorKey: 'vendor-46',
              incumbentVendor: true,
              quantityMilli: 8_000,
              unitRateMinor: 1_000_000,
              leadTimeDays: 40,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-h2',
              vendorKey: 'vendor-47',
              incumbentVendor: false,
              quantityMilli: 5_000,
              unitRateMinor: 700_000,
              leadTimeDays: 35,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-h3',
              vendorKey: 'vendor-48',
              incumbentVendor: false,
              quantityMilli: 5_000,
              unitRateMinor: 720_000,
              leadTimeDays: 33,
              outcomeIds: [],
            },
          ],
        }),
      ),
    );
    expect(detected).toStrictEqual([]);
  });

  it('a same-vendor accumulation is NOT an order split (multi-vendor required)', () => {
    const detected = unwrap(
      scanOf(
        variantInputsOf({
          n: 44,
          costItemQuantityMilli: 8_000,
          costItemUnitRateMinor: 1_000_000,
          commitmentAmountMinor: 7_000_000,
          assessedDeltaMinor: 400_000,
          assessedDurationDelta: 0,
          quotes: [
            {
              alternativeId: 'quote-i1',
              vendorKey: 'vendor-49',
              incumbentVendor: true,
              quantityMilli: 8_000,
              unitRateMinor: 925_000,
              leadTimeDays: 40,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-i2',
              vendorKey: 'vendor-50',
              incumbentVendor: false,
              quantityMilli: 5_000,
              unitRateMinor: 700_000,
              leadTimeDays: 35,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-i3',
              vendorKey: 'vendor-50',
              incumbentVendor: false,
              quantityMilli: 5_000,
              unitRateMinor: 720_000,
              leadTimeDays: 33,
              outcomeIds: [],
            },
          ],
        }),
      ),
    );
    expect(detected).toStrictEqual([]);
  });

  it('a timing shift needs BOTH the assessed delay and the lead-time gain thresholds', () => {
    expect(TIMING_MIN_LEAD_GAIN_DAYS).toBe(10);
    expect(TIMING_MIN_ASSESSED_DELAY_DAYS).toBe(1);
    const timingQuote = (n: number, leadTimeDays: number, assessedDurationDelta: number) =>
      variantInputsOf({
        n,
        costItemQuantityMilli: 12_000,
        costItemUnitRateMinor: 1_000_000,
        commitmentAmountMinor: 10_000_000,
        assessedDeltaMinor: 600_000,
        assessedDurationDelta,
        quotes: [
          {
            alternativeId: 'quote-j1',
            vendorKey: 'vendor-51',
            incumbentVendor: true,
            quantityMilli: 12_000,
            unitRateMinor: 800_000,
            leadTimeDays: 45,
            outcomeIds: [],
          },
          {
            alternativeId: 'quote-j2',
            vendorKey: 'vendor-52',
            incumbentVendor: false,
            quantityMilli: 12_000,
            unitRateMinor: 850_000,
            leadTimeDays,
            outcomeIds: [],
          },
        ],
      });
    // Lead gain 5 days (< 10): no timing shift.
    expect(unwrap(scanOf(timingQuote(45, 40, 12)))).toStrictEqual([]);
    // Assessed delay 0 days (< 1): no timing angle at all.
    expect(unwrap(scanOf(timingQuote(46, 25, 0)))).toStrictEqual([]);
    // Both thresholds met: the timing shift is detected.
    const detected = unwrap(scanOf(timingQuote(47, 25, 12)));
    expect(detected).toHaveLength(1);
    expect(detected[0]?.kind).toBe('timing-shift');
  });

  it('the kind precedence: a price-driven challenger is a vendor switch, never a timing shift', () => {
    // The challenger undercuts the incumbent re-quote AND delivers faster:
    // the price-driven rule wins the precedence.
    const detected = unwrap(
      scanOf(
        variantInputsOf({
          n: 48,
          costItemQuantityMilli: 12_000,
          costItemUnitRateMinor: 1_000_000,
          commitmentAmountMinor: 10_000_000,
          assessedDeltaMinor: 600_000,
          assessedDurationDelta: 12,
          quotes: [
            {
              alternativeId: 'quote-k1',
              vendorKey: 'vendor-53',
              incumbentVendor: true,
              quantityMilli: 12_000,
              unitRateMinor: 800_000,
              leadTimeDays: 45,
              outcomeIds: [],
            },
            {
              alternativeId: 'quote-k2',
              vendorKey: 'vendor-54',
              incumbentVendor: false,
              quantityMilli: 12_000,
              unitRateMinor: 790_000,
              leadTimeDays: 25,
              outcomeIds: [],
            },
          ],
        }),
      ),
    );
    expect(detected).toHaveLength(1);
    expect(detected[0]?.kind).toBe('vendor-switch');
  });
});

describe('qualifyProcurementEvidenceSet (THE A4 gate — the agents discipline)', () => {
  const goldenItem = run.recommendations[0]!.evidenceSet.items[0]!;
  // The golden scan runs under the tenant-A scope (it covers the project-1
  // needs AND the project-2 completed history the evidence items carry).
  const scanScope = tenantAScope();
  const projectScope = projectOneScope();

  it('accepts the golden evidence sets (non-empty and scope-covered)', () => {
    for (const recommendation of run.recommendations) {
      expect(qualifyProcurementEvidenceSet(recommendation.evidenceSet, scanScope)).toStrictEqual({
        ok: true,
        value: true,
      });
    }
  });

  it('typed-rejects an EMPTY evidence set', () => {
    const rejected = qualifyProcurementEvidenceSet({ items: [] }, scanScope);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('empty-evidence-set');
    }
  });

  it('typed-rejects an entity-less evidence item', () => {
    const rejected = qualifyProcurementEvidenceSet(
      { items: [{ ...goldenItem, entity: null }] },
      scanScope,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('evidence-scope-violation');
    }
  });

  it('typed-rejects an out-of-scope evidence item (A12 inside the A4 gate)', () => {
    const rejected = qualifyProcurementEvidenceSet(
      { items: [{ ...goldenItem, scope: tenantBScope() }] },
      scanScope,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('evidence-scope-violation');
    }
  });

  it('typed-rejects an evidence item outside a NARROWER project scan scope', () => {
    // A project-one scan scope cannot ground a recommendation on the
    // project-two completed history: structural A12 inside the A4 gate.
    const rejected = qualifyProcurementEvidenceSet(run.recommendations[2]!.evidenceSet, projectScope);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('unauthorized');
      expect(rejected.error.details[0]?.code).toBe('evidence-scope-violation');
    }
  });
});
