// Office intelligence — THE vendor comparison contracts (OFF-034).
//
// The typed comparison surface of the procurement optimization engine:
// the quoted fulfillment ALTERNATIVES (the fail-closed parsed input
// contract), the NEED derivation (the incumbent cost-domain position each
// comparison measures against — the incumbent commitment's current
// committed amount plus the producing assessment's own budget-revision
// delta, both CITED through the cost domain's derived READ surface only),
// and the VendorComparison record: one per compared need, carrying one row
// per quoted alternative with the four typed comparison dimensions —
// price (normalized comparable amounts), delivery (lead-time comparisons),
// vendor performance (historical outcome-derived ratings), and risk (typed
// risk factors) — plus the evidence refs, the historical basis (referenced
// outcome/benchmark ids), and the referenced assessments (the projected
// economic impact's producing basis).
//
// Everything here is PURE typed computation: no clock, no randomness, no
// environment, no AI — the same inputs always produce the byte-identical
// comparison (A7 rebuildability discipline). The cost domain is consumed
// through its DERIVED READS only (committedAmountMinorOf, currentLineSetOf,
// budgetBasisOf): no pure transition, no command handler, and no sink is
// ever called here (the boundary self-gate proves it).
import { parseEntityId, parseFail, parseOk, parseScope } from '@office/contracts';
import type { Actor, EntityId, EntityRef, ParseResult, Scope, Timestamp } from '@office/contracts';
import { CHANGE_EVENT_RAISED_EVENT, parseCurrencyCode } from '@office/intelligence-margin';
import type { AssessmentId, CurrencyCode, ImpactAssessment } from '@office/intelligence-margin';
import type { Benchmark, OutcomeRecord, Rational } from '@office/intelligence-memory';
import { AMOUNT_MINOR_MAX, QUANTITY_MILLI_MAX, UNIT_RATE_MINOR_MAX } from '@office/domain-cost';
import type { BudgetState, CommitmentState, CostItemState } from '@office/domain-cost';
import { budgetBasisOf, committedAmountMinorOf, currentLineSetOf } from '@office/domain-cost';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import {
  BUDGET_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  PROJECT_KIND,
  canonicalProcurementEvidence,
  procurementRationalOf,
  rationalCompare,
} from './model';
import type {
  DeliveryComparison,
  HistoricalBenchmarkFact,
  PriceComparison,
  ProcurementEvidence,
  ProcurementHistoricalBasis,
  VendorPerformanceRating,
  VendorPerformanceReason,
} from './model';
import { parseAlternativeId, parseAlternativeOutcomeIds, parseVendorKey } from './vocabulary';
import type { AlternativeId, ComparisonId, VendorKey, VendorPerformanceLevel } from './vocabulary';

// ---------------------------------------------------------------------------
// The quoted fulfillment alternative — the engine's typed INPUT contract.
// ---------------------------------------------------------------------------

/** The largest representable lead time (whole days). */
export const LEAD_TIME_DAYS_MAX = 10_000;

/**
 * The cost domain's own branded currency re-validated through the
 * intelligence layer's typed currency grammar. Both grammars are the same
 * ISO-4217 three-uppercase-letter pattern, so a cost-validated currency
 * always parses — the bridge is an explicit fail-closed parse (never a
 * cast), and a value that somehow fails is a loud invariant, never a silent
 * drop or a re-derived code.
 */
export const procurementCurrencyOf = (currency: CommitmentState['currency']): CurrencyCode => {
  const parsed = parseCurrencyCode(currency);
  if (!parsed.ok) {
    throw new TypeError(
      `the cost domain reports a currency the intelligence currency grammar rejects: ${currency}`,
    );
  }
  return parsed.value;
};

const ALTERNATIVE_KEYS = [
  'alternativeId',
  'vendorKey',
  'scope',
  'incumbentCommitmentId',
  'incumbentVendor',
  'quotedQuantityMilli',
  'quotedUnitRateMinor',
  'currency',
  'leadTimeDays',
  'outcomeIds',
] as const;

const ALTERNATIVE_GRAMMAR =
  'ProcurementAlternative: { alternativeId, vendorKey, scope, incumbentCommitmentId | null, incumbentVendor, quotedQuantityMilli, quotedUnitRateMinor, currency, leadTimeDays, outcomeIds } — a quoted fulfillment alternative whose normalized amount is the EXACT extension quantityMilli x unitRateMinor / 1000 (money is never rounded)';

const describeValue = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return `string ${JSON.stringify(raw)}`;
  return typeof raw;
};

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const unknownKeyFailure = (
  raw: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  grammar: string,
): ParseResult<never> | null => {
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) {
      return parseFail(
        'unknown-field',
        path === '' ? key : `${path}.${key}`,
        grammar,
        `unexpected key '${key}' (strict keys — no extra fields are accepted)`,
      ) as ParseResult<never>;
    }
  }
  return null;
};

/**
 * One quoted fulfillment alternative: a vendor's typed quote for (part of)
 * a procurement need — the price terms (quantity in integer milli-units x
 * unit rate in integer minor units, normalized onto the EXACT extension),
 * the delivery terms (lead time in whole days), and the vendor's referenced
 * completed-project history (the outcome ids the performance rating
 * derives from). The incumbent vendor's OWN current quote is a quoted
 * alternative too (`incumbentVendor: true`) — the honest price-only and
 * lead-time baseline the comparison measures against.
 */
export interface ProcurementAlternative {
  /** The quote's caller-supplied identity (deterministic token). */
  readonly alternativeId: AlternativeId;
  /** The quoting vendor's generic key ('vendor-01'-style — never a real vendor name). */
  readonly vendorKey: VendorKey;
  /** The scope the quote was issued under (A12: the caller's own project). */
  readonly scope: Scope;
  /** The incumbent commitment this quote competes with, or null for a new procurement. */
  readonly incumbentCommitmentId: EntityId | null;
  /** True when this quote is the incumbent vendor's own current quote (the baseline). */
  readonly incumbentVendor: boolean;
  /** The quoted quantity (integer milli-units, 1..10^9). */
  readonly quotedQuantityMilli: number;
  /** The quoted unit rate (integer minor units per whole unit, 0..10^12). */
  readonly quotedUnitRateMinor: number;
  /** The quote's currency (must equal the addressed budget's currency). */
  readonly currency: CurrencyCode;
  /** The quoted lead time (whole days, 1..10_000). */
  readonly leadTimeDays: number;
  /** The vendor's referenced completed-project history (memory outcome ids). */
  readonly outcomeIds: readonly OutcomeRecord['outcomeId'][];
}

/**
 * The normalized comparable amount of one quoted alternative: the EXACT
 * extension `quantityMilli x unitRateMinor / 1000` (the cost domain's own
 * exactness discipline — an extension that does not divide evenly is a
 * typed invariant violation; money is never rounded).
 */
export const normalizedAmountMinorOf = (alternative: {
  readonly quotedQuantityMilli: number;
  readonly quotedUnitRateMinor: number;
}): number => {
  const product = BigInt(alternative.quotedQuantityMilli) * BigInt(alternative.quotedUnitRateMinor);
  return Number(product / 1000n);
};

/** Parse an untrusted value as a ProcurementAlternative (total, fail-closed, strict keys). */
export function parseProcurementAlternative(
  raw: unknown,
): ParseResult<ProcurementAlternative> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ALTERNATIVE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ALTERNATIVE_KEYS, '', ALTERNATIVE_GRAMMAR);
  if (unknownKey) return unknownKey;

  const alternativeId = parseAlternativeId(raw['alternativeId']);
  if (!alternativeId.ok) {
    return parseFail(
      alternativeId.error.code,
      'alternativeId',
      alternativeId.error.expected,
      alternativeId.error.received,
    );
  }
  const vendorKey = parseVendorKey(raw['vendorKey']);
  if (!vendorKey.ok) {
    return parseFail(vendorKey.error.code, 'vendorKey', vendorKey.error.expected, vendorKey.error.received);
  }
  const scope = parseScope(raw['scope']);
  if (!scope.ok) {
    return parseFail(scope.error.code, 'scope', scope.error.expected, scope.error.received);
  }
  const incumbentCommitmentRaw = raw['incumbentCommitmentId'];
  let incumbentCommitmentId: EntityId | null = null;
  if (incumbentCommitmentRaw !== null && incumbentCommitmentRaw !== undefined) {
    const incumbent = parseEntityId(incumbentCommitmentRaw);
    if (!incumbent.ok) {
      return parseFail(
        incumbent.error.code,
        'incumbentCommitmentId',
        incumbent.error.expected,
        incumbent.error.received,
      );
    }
    incumbentCommitmentId = incumbent.value;
  }
  if (typeof raw['incumbentVendor'] !== 'boolean') {
    return parseFail(
      'invalid-type',
      'incumbentVendor',
      'boolean: true when the quote is the incumbent vendor\u2019s own current quote',
      describeValue(raw['incumbentVendor']),
    );
  }
  const quotedQuantityMilli = raw['quotedQuantityMilli'];
  if (
    typeof quotedQuantityMilli !== 'number' ||
    !Number.isInteger(quotedQuantityMilli) ||
    quotedQuantityMilli < 1 ||
    quotedQuantityMilli > QUANTITY_MILLI_MAX
  ) {
    return parseFail(
      'invalid-value',
      'quotedQuantityMilli',
      `integer milli-units 1..${String(QUANTITY_MILLI_MAX)}`,
      describeValue(quotedQuantityMilli),
    );
  }
  const quotedUnitRateMinor = raw['quotedUnitRateMinor'];
  if (
    typeof quotedUnitRateMinor !== 'number' ||
    !Number.isInteger(quotedUnitRateMinor) ||
    quotedUnitRateMinor < 0 ||
    quotedUnitRateMinor > UNIT_RATE_MINOR_MAX
  ) {
    return parseFail(
      'invalid-value',
      'quotedUnitRateMinor',
      `integer minor units 0..${String(UNIT_RATE_MINOR_MAX)}`,
      describeValue(quotedUnitRateMinor),
    );
  }
  const currency = parseCurrencyCode(raw['currency']);
  if (!currency.ok) {
    return parseFail(currency.error.code, 'currency', currency.error.expected, currency.error.received);
  }
  const leadTimeDays = raw['leadTimeDays'];
  if (
    typeof leadTimeDays !== 'number' ||
    !Number.isInteger(leadTimeDays) ||
    leadTimeDays < 1 ||
    leadTimeDays > LEAD_TIME_DAYS_MAX
  ) {
    return parseFail(
      'invalid-value',
      'leadTimeDays',
      `whole days 1..${String(LEAD_TIME_DAYS_MAX)}`,
      describeValue(leadTimeDays),
    );
  }
  const rawOutcomeIds = raw['outcomeIds'];
  if (!Array.isArray(rawOutcomeIds)) {
    return parseFail('invalid-type', 'outcomeIds', 'array of memory outcome ids', describeValue(rawOutcomeIds));
  }
  const outcomeIds = parseAlternativeOutcomeIds(rawOutcomeIds);
  if (!outcomeIds.ok) {
    return parseFail(
      outcomeIds.error.code,
      outcomeIds.error.path === '' ? 'outcomeIds' : outcomeIds.error.path,
      outcomeIds.error.expected,
      outcomeIds.error.received,
    );
  }
  // THE exactness gate: the normalized comparable amount must be exactly
  // representable in integer minor units (the cost domain's own rule — the
  // engine never rounds money).
  const product = BigInt(quotedQuantityMilli) * BigInt(quotedUnitRateMinor);
  if (product % 1000n !== 0n) {
    return parseFail(
      'invalid-value',
      'quotedQuantityMilli/quotedUnitRateMinor',
      'an exact extension: quantityMilli x unitRateMinor must divide evenly by 1000 (money is never rounded)',
      `inexact extension ${String(quotedQuantityMilli)} x ${String(quotedUnitRateMinor)}`,
    );
  }
  const normalized = Number(product / 1000n);
  if (normalized > AMOUNT_MINOR_MAX) {
    return parseFail(
      'invalid-value',
      'quotedQuantityMilli/quotedUnitRateMinor',
      `an extension of at most ${String(AMOUNT_MINOR_MAX)} minor units`,
      String(normalized),
    );
  }
  return parseOk(
    {
      alternativeId: alternativeId.value,
      vendorKey: vendorKey.value,
      scope: scope.value,
      incumbentCommitmentId,
      incumbentVendor: raw['incumbentVendor'],
      quotedQuantityMilli,
      quotedUnitRateMinor,
      currency: currency.value,
      leadTimeDays,
      outcomeIds: outcomeIds.value,
    } satisfies ProcurementAlternative,
  );
}

// ---------------------------------------------------------------------------
// The vendor performance rating — derived ONLY from referenced outcomes.
// ---------------------------------------------------------------------------

/** The on-time share at which the vendor performance rating is 'strong' (2/3). */
export const PERFORMANCE_STRONG_SHARE: Rational = { numerator: 2, denominator: 3 };
/** The on-time share at which the vendor performance rating is 'acceptable' (1/3). */
export const PERFORMANCE_ACCEPTABLE_SHARE: Rational = { numerator: 1, denominator: 3 };

/**
 * Derive one alternative's vendor-performance rating from its REFERENCED
 * memory outcome records: the on-time share (schedule variance <= 0 days)
 * of the vendor's completed-project history. Pure, deterministic, and
 * fully exposed — the rating cites exactly the outcome ids it derived
 * from (never a manual score, never invented history).
 */
export function vendorPerformanceOf(
  alternative: ProcurementAlternative,
  outcomesOf: ReadonlyMap<string, OutcomeRecord>,
): VendorPerformanceRating {
  const outcomes = alternative.outcomeIds
    .map((outcomeId) => outcomesOf.get(outcomeId))
    .filter((outcome): outcome is OutcomeRecord => outcome !== undefined)
    .sort((left, right) => (left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0));
  if (outcomes.length === 0) {
    return {
      level: 'unrated',
      reasons: ['no-referenced-outcomes'],
      outcomeIds: [],
      onTimeCount: 0,
      totalCount: 0,
      onTimeShare: null,
    };
  }
  const onTimeCount = outcomes.filter((outcome) => outcome.schedule.varianceDays <= 0).length;
  const share = procurementRationalOf(onTimeCount, outcomes.length);
  if (!share.ok) {
    // Unreachable for validated outcome counts; fail loudly rather than
    // silently inventing a rating.
    throw new TypeError('unreachable vendor-performance share');
  }
  const level: VendorPerformanceLevel =
    rationalCompare(share.value, PERFORMANCE_STRONG_SHARE) >= 0
      ? 'strong'
      : rationalCompare(share.value, PERFORMANCE_ACCEPTABLE_SHARE) >= 0
        ? 'acceptable'
        : 'underperforming';
  const reason: VendorPerformanceReason =
    level === 'strong'
      ? 'on-time-share-strong'
      : level === 'acceptable'
        ? 'on-time-share-acceptable'
        : 'on-time-share-underperforming';
  return {
    level,
    reasons: [reason],
    outcomeIds: outcomes.map((outcome) => outcome.outcomeId),
    onTimeCount,
    totalCount: outcomes.length,
    onTimeShare: share.value,
  };
}

// ---------------------------------------------------------------------------
// The procurement need — the incumbent position a comparison measures.
// ---------------------------------------------------------------------------

/**
 * One procurement need: the incumbent cost-domain position a vendor
 * comparison measures against — the incumbent commitment's CURRENT
 * committed amount (cited through the cost domain's own derived read) plus
 * the producing assessment's own budget-revision delta (cited, never
 * re-derived), whose sum is the INCUMBENT PATH (the do-nothing baseline
 * the projected economic impact measures against).
 */
export interface ProcurementNeed {
  /** The incumbent commitment (the canonical obligation being compared). */
  readonly incumbentCommitmentId: EntityId;
  /** The budget of record the commitment's lines reference. */
  readonly budgetId: EntityId;
  /** The commitment's canonical-first basis cost item (the need's scope anchor). */
  readonly costItemId: EntityId;
  /** The incumbent commitment's current committed amount (CITED: commitment-current-amount). */
  readonly incumbentAmountMinor: number;
  /** The producing assessment's own budget-revision delta (CITED: assessment-cost-impact-budget-revision-delta). */
  readonly assessedDeltaMinor: number;
  /** The incumbent path: incumbent amount + assessed delta (the do-nothing baseline). */
  readonly incumbentPathAmountMinor: number;
  /** The single currency of the need (the budget's own currency). */
  readonly currency: CurrencyCode;
  /** THE producing assessments of the need's projected impact basis (canonical order). */
  readonly assessmentIds: readonly AssessmentId[];
  /** The producing assessment record itself (the latest one wins). */
  readonly assessment: ImpactAssessment;
}

/**
 * The budget of record of one commitment: the budget whose basis of record
 * CONTAINS the commitment's current line cost items — the domain's own
 * wiring (a commitment's lines reference the budget's cost items, and
 * several budgets of record may live in one project, so the project alone
 * does not identify the budget of record). The resolution scans the
 * budgets in CANONICAL id order, so it is independent of the supplied
 * input ordering (the shuffled-input determinism discipline); a commitment
 * whose lines no admitted budget fully contains has no budget of record
 * (undefined — the caller skips the need, never inventing one).
 */
export const budgetOfRecordFor = (
  budgets: readonly BudgetState[],
  commitment: CommitmentState,
): BudgetState | undefined => {
  const lineCostItemIds = new Set<string>(
    currentLineSetOf(commitment).lines.map((line) => String(line.costItemId)),
  );
  if (lineCostItemIds.size === 0) return undefined;
  const ordered = [...budgets].sort((left, right) =>
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
  );
  return ordered.find((candidate) => {
    const basisIds = new Set(
      budgetBasisOf(candidate).map((item) => String(item.entityId)),
    );
    return [...lineCostItemIds].every((costItemId) => basisIds.has(costItemId));
  });
};

/**
 * Derive the procurement needs of one scan: every commitment that carries
 * (a) a producing assessment — an assessment whose cost impact touches one
 * of the commitment's line cost items — and is admitted by the caller. The
 * LATEST producing assessment wins (the greatest (assessedAt, assessmentId)
 * pair — the newest projection of the same need), mirroring the memory
 * engine's latest-per-contract idiom. Needs without a producing assessment
 * carry no referenced projected economic impact basis and are never
 * compared (the engine's discipline: no recommendation without its
 * assessment basis).
 */
export function procurementNeedsOf(
  budgets: readonly BudgetState[],
  commitments: readonly CommitmentState[],
  assessments: readonly ImpactAssessment[],
): readonly ProcurementNeed[] {
  const needs: ProcurementNeed[] = [];
  const orderedCommitments = [...commitments].sort((left, right) =>
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
  );
  for (const commitment of orderedCommitments) {
    // The budget of record is the budget whose basis of record CONTAINS the
    // commitment's current line cost items (see budgetOfRecordFor).
    const budget = budgetOfRecordFor(budgets, commitment);
    // The commitment's lines must reference the budget's basis of record.
    const lineCostItemIds = new Set<string>(
      currentLineSetOf(commitment).lines.map((line) => String(line.costItemId)),
    );
    const basisItems = budget === undefined ? [] : budgetBasisOf(budget);
    const basisItem =
      [...lineCostItemIds]
        .sort()
        .map((costItemId) => basisItems.find((item) => String(item.entityId) === costItemId))
        .find((item): item is CostItemState => item !== undefined) ?? undefined;
    if (budget === undefined || basisItem === undefined) continue;

    // The producing assessment: the LATEST assessment whose cost impact
    // touches one of the commitment's line cost items.
    const producing = assessments
      .filter((assessment) =>
        assessment.costImpact.itemDeltas.some((delta) =>
          lineCostItemIds.has(String(delta.costItemId)),
        ),
      )
      .sort((left, right) =>
        left.assessedAt !== right.assessedAt
          ? left.assessedAt < right.assessedAt
            ? 1
            : -1
          : left.assessmentId < right.assessmentId
            ? 1
            : -1,
      )[0];
    if (producing === undefined) continue;

    const incumbentAmountMinor = committedAmountMinorOf(commitment);
    const assessedDeltaMinor = producing.costImpact.budgetRevisionDeltaMinor;
    needs.push({
      incumbentCommitmentId: commitment.entityId,
      budgetId: budget.entityId,
      costItemId: basisItem.entityId,
      incumbentAmountMinor,
      assessedDeltaMinor,
      incumbentPathAmountMinor: incumbentAmountMinor + assessedDeltaMinor,
      currency: procurementCurrencyOf(commitment.currency),
      assessmentIds: [producing.assessmentId],
      assessment: producing,
    });
  }
  return needs;
}

// ---------------------------------------------------------------------------
// THE vendor comparison record.
// ---------------------------------------------------------------------------

/** The schema version of the VendorComparison model (bump on shape change). */
export const COMPARISON_SCHEMA_VERSION = 1;

/** The source identity of the procurement optimization engine (A4). */
export const PROCUREMENT_ENGINE = 'intelligence-procurement';

/** The price comparison part of one row (normalized comparable amounts). */
export interface VendorComparisonRow {
  /** The quoted alternative this row compares. */
  readonly alternativeId: AlternativeId;
  /** The quoting vendor's generic key. */
  readonly vendorKey: VendorKey;
  /** True when this row is the incumbent vendor's own current quote (the baseline). */
  readonly incumbentVendor: boolean;
  /** The price dimension: the normalized comparable amount (exact extension). */
  readonly price: PriceComparison;
  /** The delivery dimension: the lead-time comparison against the incumbent re-quote. */
  readonly delivery: DeliveryComparison;
  /** The vendor-performance dimension: the outcome-derived rating. */
  readonly performance: VendorPerformanceRating;
  /** The risk dimension: this row's typed risk factors (derived, evidence-chained). */
  readonly riskFactors: readonly ProcurementRowRisk[];
}

/** One typed risk factor of a comparison row (row-scoped kinds only). */
export interface ProcurementRowRisk {
  readonly kind: 'price-above-budget-basis' | 'underperforming-vendor-history' | 'no-vendor-history';
  /** The vendor the factor is about. */
  readonly vendorKey: VendorKey;
  /** The canonical entity refs of the records the factor was derived from. */
  readonly derivedFrom: readonly EntityRef[];
}

/**
 * THE vendor comparison: one typed comparison of the quoted fulfillment
 * alternatives of ONE procurement need across the four dimensions (price,
 * delivery, vendor performance, risk) — every row's every number derived
 * from referenced records (the quoted alternative, the cost-domain
 * commitment/budget records, the referenced outcomes), the comparison
 * carrying its evidence refs, its historical basis (the referenced
 * outcome ids + the cited benchmark fact), and the referenced assessments
 * (the projected economic impact's producing basis).
 */
export interface VendorComparison {
  /** The scan-derived identity (deterministic given the scan identity). */
  readonly comparisonId: ComparisonId;
  /** The model schema version of this comparison. */
  readonly comparisonVersion: typeof COMPARISON_SCHEMA_VERSION;
  /** The source identity of the comparing engine (A4). */
  readonly engine: typeof PROCUREMENT_ENGINE;
  /** When the comparison ran (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The actor the comparison ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the comparison was produced under (the need's scope, A12). */
  readonly scope: Scope;
  /** The compared need (the incumbent position + the producing assessment). */
  readonly need: ProcurementNeed;
  /** The compared rows — one per quoted alternative of the need, canonical id order. */
  readonly rows: readonly VendorComparisonRow[];
  /** THE referenced assessments (the projected economic impact's producing basis). */
  readonly assessmentIds: readonly AssessmentId[];
  /** The historical basis (referenced outcome + benchmark facts). */
  readonly historicalBasis: ProcurementHistoricalBasis;
  /** The evidence chain (every reference resolves to a producing source record, A4). */
  readonly evidence: readonly ProcurementEvidence[];
}

const benchmarkScheduleVarianceOf = (
  benchmarks: readonly Benchmark[],
): HistoricalBenchmarkFact | null => {
  const ordered = [...benchmarks].sort((left, right) =>
    left.benchmarkId < right.benchmarkId ? -1 : left.benchmarkId > right.benchmarkId ? 1 : 0,
  );
  for (const benchmark of ordered) {
    const metric = benchmark.metrics.find((candidate) => candidate.kind === 'schedule-variance-days');
    if (metric !== undefined) {
      return { benchmarkId: benchmark.benchmarkId, metricKind: metric.kind };
    }
  }
  return null;
};

const entityRefOf = (entityKind: EntityRef['entityKind'], entityId: EntityId): EntityRef => ({
  entityKind,
  entityId,
});

const budgetEntityKind: EntityRef['entityKind'] = BUDGET_KIND;
const commitmentEntityKind: EntityRef['entityKind'] = COMMITMENT_KIND;
const costItemEntityKind: EntityRef['entityKind'] = COST_ITEM_KIND;
const projectEntityKind: EntityRef['entityKind'] = PROJECT_KIND;

/**
 * Build ONE vendor comparison: the pure per-need computation. Deterministic:
 * the same need + alternatives + outcomes + benchmarks always produce the
 * byte-identical comparison (rows in canonical alternative-id order; every
 * rating derived from the referenced records; the evidence chain
 * deduplicated and canonically ordered).
 */
export function buildVendorComparison(parts: {
  readonly need: ProcurementNeed;
  readonly budget: BudgetState;
  readonly basisItem: CostItemState;
  readonly commitment: CommitmentState;
  readonly alternatives: readonly ProcurementAlternative[];
  readonly outcomesOf: ReadonlyMap<string, OutcomeRecord>;
  readonly benchmarks: readonly Benchmark[];
  readonly comparisonId: ComparisonId;
  readonly detectedAt: Timestamp;
  readonly actor: Actor;
}): Result<VendorComparison, DomainError> {
  const sortedAlternatives = [...parts.alternatives].sort((left, right) =>
    left.alternativeId < right.alternativeId ? -1 : left.alternativeId > right.alternativeId ? 1 : 0,
  );
  const incumbentRequote = sortedAlternatives.find((alternative) => alternative.incumbentVendor);
  if (incumbentRequote === undefined) {
    return fail(
      domainError(
        'invariant-violation',
        `the procurement need of commitment ${String(parts.commitment.entityId)} has no incumbent vendor re-quote: a comparison requires the incumbent\u2019s own current quote as its price and lead-time baseline`,
        [
          {
            code: 'incumbent-quote-required',
            message: String(parts.commitment.entityId),
            path: 'alternatives',
          },
        ],
      ),
    );
  }
  const incumbentLeadTimeDays = incumbentRequote.leadTimeDays;

  const rows: VendorComparisonRow[] = sortedAlternatives.map((alternative) => {
    const price: PriceComparison = {
      quotedQuantityMilli: alternative.quotedQuantityMilli,
      quotedUnitRateMinor: alternative.quotedUnitRateMinor,
      normalizedAmountMinor: normalizedAmountMinorOf(alternative),
      currency: alternative.currency,
    };
    const delivery: DeliveryComparison = {
      leadTimeDays: alternative.leadTimeDays,
      incumbentLeadTimeDays,
      leadGainDays: incumbentLeadTimeDays - alternative.leadTimeDays,
    };
    const performance = vendorPerformanceOf(alternative, parts.outcomesOf);
    const riskFactors: ProcurementRowRisk[] = [];
    if (price.normalizedAmountMinor > parts.basisItem.amountMinor) {
      riskFactors.push({
        kind: 'price-above-budget-basis',
        vendorKey: alternative.vendorKey,
        derivedFrom: [
          entityRefOf(budgetEntityKind, parts.budget.entityId),
          entityRefOf(costItemEntityKind, parts.basisItem.entityId),
        ],
      });
    }
    if (performance.level === 'underperforming') {
      riskFactors.push({
        kind: 'underperforming-vendor-history',
        vendorKey: alternative.vendorKey,
        derivedFrom: performance.outcomeIds.map((outcomeId) => {
          const outcome = parts.outcomesOf.get(outcomeId);
          return entityRefOf(projectEntityKind, outcome?.projectId ?? parts.budget.entityId);
        }),
      });
    }
    if (performance.level === 'unrated') {
      riskFactors.push({
        kind: 'no-vendor-history',
        vendorKey: alternative.vendorKey,
        derivedFrom: [],
      });
    }
    return {
      alternativeId: alternative.alternativeId,
      vendorKey: alternative.vendorKey,
      incumbentVendor: alternative.incumbentVendor,
      price,
      delivery,
      performance,
      riskFactors,
    };
  });

  // The historical basis: every referenced outcome of the compared rows +
  // the schedule-variance benchmark fact (the delivery dimension's
  // calibration context) when the scan carries one.
  const outcomeIds = [
    ...new Set(rows.flatMap((row) => row.performance.outcomeIds)),
  ].sort();
  const benchmarkFact = benchmarkScheduleVarianceOf(parts.benchmarks);
  const historicalBasis: ProcurementHistoricalBasis = {
    outcomeIds,
    benchmarks: benchmarkFact === null ? [] : [benchmarkFact],
  };

  // The evidence chain: the producing assessment, its producing events, the
  // cost-domain records, the referenced outcomes, and the calibration
  // benchmark — deduplicated and canonically ordered.
  const evidence: ProcurementEvidence[] = [
    {
      kind: 'assessment',
      assessmentId: parts.need.assessment.assessmentId,
      assessedAt: parts.need.assessment.assessedAt,
      sourceEventId: parts.need.assessment.source.eventId,
      changeEventId: parts.need.assessment.source.changeEventId,
      contractId: parts.need.assessment.source.contractId,
    },
    {
      kind: 'event',
      eventId: parts.need.assessment.source.eventId,
      eventName: CHANGE_EVENT_RAISED_EVENT,
      occurredAt: parts.need.assessment.source.occurredAt,
    },
    ...parts.need.assessment.costImpact.evidence.map((reference) => ({
      kind: 'event' as const,
      eventId: reference.eventId,
      eventName: reference.eventName,
      occurredAt: reference.occurredAt,
    })),
    ...parts.need.assessment.costImpact.itemDeltas.map((delta) => ({
      kind: 'event' as const,
      eventId: delta.source.eventId,
      eventName: delta.source.eventName,
      occurredAt: delta.source.occurredAt,
    })),
    {
      kind: 'record',
      ref: entityRefOf(commitmentEntityKind, parts.commitment.entityId),
      recordKind: 'commitment',
      version: parts.commitment.version,
      createdAt: parts.commitment.createdAt,
    },
    {
      kind: 'record',
      ref: entityRefOf(budgetEntityKind, parts.budget.entityId),
      recordKind: 'budget',
      version: parts.budget.version,
      createdAt: parts.budget.createdAt,
    },
    {
      kind: 'record',
      ref: entityRefOf(costItemEntityKind, parts.basisItem.entityId),
      recordKind: 'cost-item',
      // The cost item rides its OWNING budget root's version (aggregate-
      // versioned as a whole — the cost domain's own concurrency unit).
      version: parts.budget.version,
      createdAt: parts.basisItem.createdAt,
    },
    ...outcomeIds.map((outcomeId) => {
      const outcome = parts.outcomesOf.get(outcomeId);
      return {
        kind: 'outcome' as const,
        outcomeId,
        recordedAt: outcome?.recordedAt ?? parts.detectedAt,
        projectId: outcome?.projectId ?? parts.budget.entityId,
      };
    }),
    ...(benchmarkFact === null
      ? []
      : [
          {
            kind: 'benchmark' as const,
            benchmarkId: benchmarkFact.benchmarkId,
            computedAt:
              parts.benchmarks.find((benchmark) => benchmark.benchmarkId === benchmarkFact.benchmarkId)
                ?.computedAt ?? parts.detectedAt,
            metricKind: benchmarkFact.metricKind,
          },
        ]),
  ];

  return ok({
    comparisonId: parts.comparisonId,
    comparisonVersion: COMPARISON_SCHEMA_VERSION,
    engine: PROCUREMENT_ENGINE,
    detectedAt: parts.detectedAt,
    actor: parts.actor,
    scope: parts.commitment.scope,
    need: parts.need,
    rows,
    assessmentIds: [...parts.need.assessmentIds],
    historicalBasis,
    evidence: canonicalProcurementEvidence(evidence),
  });
}

/** The typed failure builder of an unbuildable comparison (scan-time wiring). */
export const comparisonFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `the vendor comparison cannot be built: ${reason}`,
    [{ code: 'comparison-valid', message: reason, path: null }],
    context,
  );
