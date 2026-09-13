// Office intelligence — the deterministic benchmark computation (OFF-015).
//
// computeBenchmarks() is THE pure function of an outcome set: per-metric
// aggregate statistics (min/max/mean/median/percentile90 as exact
// rationals), per-metric percentile positions, and — the named acceptance
// — every value carries the outcome ids that produced it. The same outcome
// set ALWAYS produces the identical benchmark: no clock, no randomness, no
// environment, and the outcomes are consumed in canonical outcome-id order
// (the input array's order never matters — shuffled inputs compute the
// identical benchmark).
//
// All rational arithmetic is exact: sums accumulate in BigInt and convert
// back to the serializable Rational domain fail-closed (a statistic whose
// exact value does not fit the domain is a typed invariant violation,
// never a silent float approximation).
//
// THE drift discipline (A2/A7): a recorded benchmark is an immutable
// snapshot of one pure computation; the store fold rejects any recorded
// benchmark whose values do not equal the pure recomputation over exactly
// its named outcome ids. Benchmarks never silently drift from the outcome
// set: a different outcome set produces a DIFFERENT benchmark fact, never
// a mutation of the old one.
import type { Actor, Scope, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { BenchmarkId } from './vocabulary';
import {
  BENCHMARK_METRIC_KINDS,
  BENCHMARK_SCHEMA_VERSION,
  MEMORY_ENGINE,
  RATIONAL_COMPONENT_MAX,
  RATIONAL_GRAMMAR,
  compareRationals,
  reduceRational,
} from './model';
import type {
  Benchmark,
  BenchmarkMetricKind,
  BenchmarkMetricStats,
  BenchmarkPosition,
  OutcomeRecord,
  Rational,
} from './model';

// ---------------------------------------------------------------------------
// The injected identity of one benchmark computation.
// ---------------------------------------------------------------------------

/** The injected identity/clock of one benchmark computation (never wall time). */
export interface BenchmarkParts {
  /** The caller-supplied deterministic benchmark identity. */
  readonly benchmarkId: BenchmarkId;
  /** When the benchmark is computed (injected clock). */
  readonly computedAt: Timestamp;
  /** The actor the benchmark is computed for (A4 source identity). */
  readonly actor: Actor;
  /** The tenant scope the benchmark spans (A12: one tenant, never mixed). */
  readonly scope: Scope;
}

// ---------------------------------------------------------------------------
// Fail-closed computation errors.
// ---------------------------------------------------------------------------

const emptyOutcomeSetFailure = (scope: Scope): DomainError =>
  domainError(
    'invariant-violation',
    'a benchmark is computed over a non-empty outcome set: an empty set produces no facts',
    [{ code: 'benchmark-outcome-set-nonempty', message: 'the outcome set is empty', path: null }],
    { scope },
  );

const duplicateOutcomeFailure = (outcomeId: string, scope: Scope): DomainError =>
  domainError(
    'invariant-violation',
    `the outcome set carries a duplicate outcome id ${outcomeId}`,
    [
      {
        code: 'benchmark-outcome-ids-distinct',
        message: `duplicate outcome id ${outcomeId}`,
        path: null,
      },
    ],
    { scope },
  );

const mixedTenantFailure = (tenantIds: readonly string[]): DomainError =>
  domainError(
    'unauthorized',
    'a benchmark spans ONE tenant\u2019s outcomes (freeze A12): the outcome set carries mixed tenants ' +
      tenantIds.join(', '),
    [
      {
        code: 'benchmark-tenant-scope',
        message: `tenants: ${tenantIds.join(', ')}`,
        path: null,
      },
    ],
  );

const rationalDomainFailure = (where: string, numerator: bigint, denominator: bigint): DomainError =>
  domainError(
    'invariant-violation',
    `the exact benchmark statistic at ${where} does not fit the serializable rational domain`,
    [
      {
        code: 'benchmark-rational-domain',
        message: `exact value ${numerator}/${denominator} exceeds the Rational component bound`,
        path: where,
      },
      { code: 'rational-grammar', message: RATIONAL_GRAMMAR, path: null },
    ],
  );

// ---------------------------------------------------------------------------
// Exact BigInt rational arithmetic (module-private — the accumulation core).
// ---------------------------------------------------------------------------

interface BigRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const bigOf = (value: Rational): BigRational => ({
  numerator: BigInt(value.numerator),
  denominator: BigInt(value.denominator),
});

const bigGcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
};

const bigReduce = (value: BigRational): BigRational => {
  const g = bigGcd(value.numerator, value.denominator);
  return { numerator: value.numerator / g, denominator: value.denominator / g };
};

const bigAdd = (left: BigRational, right: BigRational): BigRational =>
  bigReduce({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });

const bigDivideBy = (value: BigRational, divisor: bigint): BigRational =>
  bigReduce({ numerator: value.numerator, denominator: value.denominator * divisor });

const RATIONAL_COMPONENT_MAX_BIG = BigInt(RATIONAL_COMPONENT_MAX);

const rationalFromBig = (where: string, value: BigRational): Result<Rational, DomainError> => {
  const reduced = bigReduce(value);
  if (reduced.denominator <= 0n) {
    return fail(rationalDomainFailure(where, reduced.numerator, reduced.denominator));
  }
  if (
    (reduced.numerator < 0n ? -reduced.numerator : reduced.numerator) > RATIONAL_COMPONENT_MAX_BIG ||
    reduced.denominator > RATIONAL_COMPONENT_MAX_BIG
  ) {
    return fail(rationalDomainFailure(where, reduced.numerator, reduced.denominator));
  }
  return ok({
    numerator: Number(reduced.numerator),
    denominator: Number(reduced.denominator),
  });
};

// ---------------------------------------------------------------------------
// Deterministic statistics over exact rationals.
// ---------------------------------------------------------------------------

/** One outcome's value for one metric (null when the outcome lacks it). */
const metricValueOf = (
  outcome: OutcomeRecord,
  kind: BenchmarkMetricKind,
): Rational | null => {
  switch (kind) {
    case 'schedule-variance-days':
      return reduceRational({ numerator: outcome.schedule.varianceDays, denominator: 1 });
    case 'margin-ratio':
      return outcome.margin.marginRatio;
    case 'entitlement-approval-rate':
      return outcome.entitlement.approvalRate;
    case 'change-event-count':
      return reduceRational({
        numerator: outcome.changePressure.changeEventCount,
        denominator: 1,
      });
  }
};

/** The percentile rank of one value in a sorted value set (exact rational). */
const percentileRankOf = (
  value: Rational,
  sortedValues: readonly Rational[],
): Rational => {
  const total = sortedValues.length;
  let strictlyBelow = 0;
  let ties = 0;
  for (const other of sortedValues) {
    const comparison = compareRationals(other, value);
    if (comparison < 0) strictlyBelow += 1;
    else if (comparison === 0) ties += 1;
  }
  return reduceRational({
    numerator: strictlyBelow * 2 + ties,
    denominator: total * 2,
  });
};

// ---------------------------------------------------------------------------
// THE computation.
// ---------------------------------------------------------------------------

/**
 * Compute THE benchmark facts of one outcome set — the PURE function the
 * named acceptance is judged by: query → outcome set → identical
 * benchmarks on re-run, every value carrying the outcome ids that produced
 * it. Metrics are aggregated per kind; an outcome that lacks a metric
 * (e.g. a zero-contracted-value outcome has no margin ratio) simply does
 * not contribute to that metric — its id is absent from that value's
 * producing ids, which is exactly what the attribution means.
 */
export function computeBenchmarks(
  outcomes: readonly OutcomeRecord[],
  parts: BenchmarkParts,
): Result<Benchmark, DomainError> {
  // 1. A benchmark is computed over a non-empty outcome set.
  if (outcomes.length === 0) {
    return fail(emptyOutcomeSetFailure(parts.scope));
  }

  // 2. Distinct outcome ids (an outcome set is a set).
  const seenIds = new Set<string>();
  for (const outcome of outcomes) {
    if (seenIds.has(outcome.outcomeId)) {
      return fail(duplicateOutcomeFailure(outcome.outcomeId, parts.scope));
    }
    seenIds.add(outcome.outcomeId);
  }

  // 3. A12: one tenant, never mixed.
  const tenantIds = new Set<string>(outcomes.map((outcome) => outcome.scope.tenantId));
  if (tenantIds.size > 1) {
    return fail(mixedTenantFailure([...tenantIds].sort()));
  }

  // Canonical consumption order — the computation's only ordering input.
  const canonical = [...outcomes].sort((left, right) =>
    left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0,
  );

  const metrics: BenchmarkMetricStats[] = [];
  const positions: BenchmarkPosition[] = [];

  for (const kind of BENCHMARK_METRIC_KINDS) {
    // The producing outcomes of THIS metric (canonical outcome-id order).
    const producing: readonly OutcomeRecord[] = canonical.filter(
      (outcome) => metricValueOf(outcome, kind) !== null,
    );
    if (producing.length === 0) {
      continue; // no outcome carries this metric — the metric carries no fact
    }
    const values = producing.map((outcome) => metricValueOf(outcome, kind) as Rational);
    const sorted = [...values].sort(compareRationals);
    const min = sorted[0] as Rational;
    const max = sorted[sorted.length - 1] as Rational;

    // mean = Σvalue / count — exact BigInt accumulation, fail-closed convert.
    let bigSum: BigRational = { numerator: 0n, denominator: 1n };
    for (const value of values) {
      bigSum = bigAdd(bigSum, bigOf(value));
    }
    const mean = rationalFromBig(`metrics.${kind}.mean`, bigDivideBy(bigSum, BigInt(values.length)));
    if (!mean.ok) return mean;

    // median: odd count → the middle value; even → the exact mean of the
    // middle two (BigInt, fail-closed convert).
    const middle = Math.floor(sorted.length / 2);
    let median: Rational;
    if (sorted.length % 2 === 1) {
      median = sorted[middle] as Rational;
    } else {
      const middleMean = bigDivideBy(
        bigAdd(bigOf(sorted[middle - 1] as Rational), bigOf(sorted[middle] as Rational)),
        2n,
      );
      const converted = rationalFromBig(`metrics.${kind}.median`, middleMean);
      if (!converted.ok) return converted;
      median = converted.value;
    }

    // percentile90: nearest-rank (ceil(0.9 × count)-th smallest value).
    const rank = Math.max(1, Math.ceil((90 * sorted.length) / 100));
    const percentile90 = sorted[rank - 1] as Rational;

    metrics.push({
      kind,
      outcomeIds: producing.map((outcome) => outcome.outcomeId),
      min,
      max,
      mean: mean.value,
      median,
      percentile90,
    });
    for (const [index, outcome] of producing.entries()) {
      const value = values[index] as Rational;
      positions.push({
        metricKind: kind,
        outcomeId: outcome.outcomeId,
        position: percentileRankOf(value, sorted),
      });
    }
  }

  return ok({
    benchmarkId: parts.benchmarkId,
    benchmarkVersion: BENCHMARK_SCHEMA_VERSION,
    engine: MEMORY_ENGINE,
    computedAt: parts.computedAt,
    actor: parts.actor,
    scope: parts.scope,
    outcomeCount: canonical.length,
    metrics,
    positions,
  } satisfies Benchmark);
}
