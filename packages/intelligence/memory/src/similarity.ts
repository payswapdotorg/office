// Office intelligence — the typed project similarity contracts (OFF-015).
//
// Deterministic similarity over TYPED feature vectors derived from recorded
// outcomes (+ the relationship engine's authorization-filtered traversal
// subgraphs): NO embeddings, NO opaque models, NO floats — every score is
// an exact rational and every component is attributable to a named typed
// feature with both compared values, the carried weight, and the exact
// per-feature similarity (the composition is EXPOSED, never a black box).
//
// Per-feature similarity (documented, deterministic, symmetric):
//   similarity(a, b) = max(|a|,|b|) / (max(|a|,|b|) + |a − b|)
// — 1/1 when the values are equal, approaching 0/1 as the relative distance
// grows, always inside [0,1] (exact rational arithmetic throughout).
// The total score is the weight-normalized sum over the SHARED features;
// features present on only one side are attributed skips (missingKinds),
// never silently dropped.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { TraversalSubgraph } from '@office/intelligence-relationships';
import {
  FEATURE_KINDS,
  RATIONAL_COMPONENT_MAX,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  compareRationals,
  reduceRational,
} from './model';
import type {
  FeatureKind,
  FeatureValue,
  OutcomeRecord,
  ProjectFeatureVector,
  Rational,
  SimilarityCandidate,
  SimilarityComponent,
  SimilarityQuery,
  SimilarityWeight,
} from './model';

// ---------------------------------------------------------------------------
// The default weights + the feature extraction.
// ---------------------------------------------------------------------------

/** The default similarity weights: every feature kind carries weight 1 (equal). */
export const DEFAULT_SIMILARITY_WEIGHTS: readonly SimilarityWeight[] = FEATURE_KINDS.map(
  (kind) => ({ kind, weight: 1 }),
);

/** The default result limit of a similarity query. */
export const DEFAULT_SIMILARITY_LIMIT = 10;

const weightOfKind = (
  weights: readonly SimilarityWeight[],
  kind: FeatureKind,
): number => weights.find((weight) => weight.kind === kind)?.weight ?? 1;

// ---------------------------------------------------------------------------
// Exact BigInt accumulation (module-private — the score arithmetic core).
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

const bigScale = (value: BigRational, weight: number): BigRational =>
  weight === 1 ? value : bigReduce({ numerator: value.numerator * BigInt(weight), denominator: value.denominator });

const RATIONAL_COMPONENT_MAX_BIG = BigInt(RATIONAL_COMPONENT_MAX);

const rationalFromBig = (where: string, value: BigRational): Result<Rational, DomainError> => {
  const reduced = bigReduce(value);
  if (
    reduced.denominator <= 0n ||
    (reduced.numerator < 0n ? -reduced.numerator : reduced.numerator) > RATIONAL_COMPONENT_MAX_BIG ||
    reduced.denominator > RATIONAL_COMPONENT_MAX_BIG
  ) {
    return fail(
      domainError(
        'invariant-violation',
        `the exact similarity score at ${where} does not fit the serializable rational domain`,
        [
          {
            code: 'similarity-rational-domain',
            message: `exact value ${reduced.numerator}/${reduced.denominator} exceeds the Rational component bound`,
            path: where,
          },
        ],
      ),
    );
  }
  return ok({ numerator: Number(reduced.numerator), denominator: Number(reduced.denominator) });
};

// ---------------------------------------------------------------------------
// The per-feature similarity (exact, symmetric, documented).
// ---------------------------------------------------------------------------

/**
 * The exact per-feature similarity of two values:
 * max(|left|,|right|) / (max(|left|,|right|) + |left − right|) — 1/1 when
 * equal, monotonically approaching 0/1 as the relative distance grows,
 * always inside [0,1]. Computed over the common denominator so the
 * arithmetic stays exact (BigInt — the components cross-multiply) and the
 * attribution stays trivial. Fail-closed when the exact reduced value
 * does not fit the serializable Rational domain.
 */
const featureSimilarity = (
  where: string,
  left: Rational,
  right: Rational,
): Result<Rational, DomainError> => {
  // Common denominator D = left.denominator × right.denominator (> 0):
  // left = l / D, right = r / D, and D cancels inside the formula.
  const l = BigInt(left.numerator) * BigInt(right.denominator);
  const r = BigInt(right.numerator) * BigInt(left.denominator);
  const absL = l < 0n ? -l : l;
  const absR = r < 0n ? -r : r;
  const max = absL >= absR ? absL : absR;
  const delta = l - r;
  const diff = delta < 0n ? -delta : delta;
  if (max === 0n) {
    return ok(RATIONAL_ONE); // both values are zero — identical by definition
  }
  const numerator = max;
  const denominator = max + diff;
  const g = bigGcd(numerator, denominator);
  const reducedNumerator = numerator / g;
  const reducedDenominator = denominator / g;
  if (
    (reducedNumerator < 0n ? -reducedNumerator : reducedNumerator) > RATIONAL_COMPONENT_MAX_BIG ||
    reducedDenominator > RATIONAL_COMPONENT_MAX_BIG
  ) {
    return fail(
      domainError(
        'invariant-violation',
        `the exact similarity at ${where} does not fit the serializable rational domain`,
        [
          {
            code: 'similarity-rational-domain',
            message: `exact value ${reducedNumerator}/${reducedDenominator} exceeds the Rational component bound`,
            path: where,
          },
        ],
      ),
    );
  }
  return ok({ numerator: Number(reducedNumerator), denominator: Number(reducedDenominator) });
};

// ---------------------------------------------------------------------------
// THE feature vector derivation.
// ---------------------------------------------------------------------------

/**
 * Derive ONE project's typed feature vector from its recorded outcome —
 * plus, optionally, its authorization-filtered relationship subgraph (the
 * traversal output of @office/intelligence-relationships, whose
 * edge/node density becomes the 'relationship-density' feature). The
 * vector is pure typed data: every value is an exact rational attributed
 * to a named feature kind. Features the outcome lacks (e.g. a
 * zero-contracted-value outcome has no margin ratio) are absent — never
 * invented.
 */
export function projectFeatureVector(parts: {
  readonly outcome: OutcomeRecord;
  /** The project's authorization-filtered relationship subgraph (optional). */
  readonly subgraph?: TraversalSubgraph;
}): Result<ProjectFeatureVector, DomainError> {
  const outcome = parts.outcome;
  const features: FeatureValue[] = [];
  const push = (kind: FeatureKind, value: Rational | null): void => {
    if (value !== null) {
      features.push({ kind, value });
    }
  };
  push(
    'schedule-variance',
    reduceRational({ numerator: outcome.schedule.varianceDays, denominator: 1 }),
  );
  push('margin-ratio', outcome.margin.marginRatio);
  push('approval-rate', outcome.entitlement.approvalRate);
  push(
    'change-activity',
    reduceRational({
      numerator: outcome.changePressure.changeEventCount,
      denominator: 1,
    }),
  );
  push(
    'contracted-scale',
    outcome.margin.contractedValueMinor === 0
      ? null
      : reduceRational({
          numerator: outcome.margin.contractedValueMinor,
          denominator: 1,
        }),
  );
  if (parts.subgraph !== undefined) {
    const nodeCount = parts.subgraph.nodes.length;
    if (nodeCount === 0) {
      return fail(
        domainError(
          'invariant-violation',
          'the relationship subgraph carries no nodes: the relationship-density feature requires a non-empty subgraph',
          [
            {
              code: 'similarity-subgraph-nonempty',
              message: 'subgraph.nodes is empty',
              path: 'subgraph',
            },
          ],
        ),
      );
    }
    push(
      'relationship-density',
      reduceRational({
        numerator: parts.subgraph.edges.length,
        denominator: nodeCount,
      }),
    );
  }
  return ok({
    projectId: outcome.projectId,
    outcomeId: outcome.outcomeId,
    features,
  } satisfies ProjectFeatureVector);
}

// ---------------------------------------------------------------------------
// THE ranking.
// ---------------------------------------------------------------------------

const compareCandidates = (left: SimilarityCandidate, right: SimilarityCandidate): number => {
  const comparison = compareRationals(right.score, left.score); // score DESC
  if (comparison !== 0) return comparison;
  if (left.projectId !== right.projectId) {
    return left.projectId < right.projectId ? -1 : 1; // project id ASC (ties)
  }
  return 0;
};

/**
 * Rank the similar-project candidates of one subject vector — THE typed
 * similarity query. Every candidate carries its EXPOSED score composition:
 * one attributable component per SHARED typed feature (both values, the
 * weight, the exact per-feature similarity), the exact total score, and
 * the attributed skips for features present on only one side. Ranking is
 * deterministic: score descending, then project id ascending.
 *
 * Determinism: the candidate array's order never matters (candidates are
 * ranked by (score, project id)); the same inputs always produce the
 * byte-identical ranked list.
 */
export function rankSimilarProjects(
  subject: ProjectFeatureVector,
  candidates: readonly ProjectFeatureVector[],
  query: SimilarityQuery = {},
): Result<readonly SimilarityCandidate[], DomainError> {
  // The weights (default: every kind weight 1) + the limit (default 10).
  const weights = query.weights === undefined ? DEFAULT_SIMILARITY_WEIGHTS : query.weights;
  const limit = query.limit === undefined ? DEFAULT_SIMILARITY_LIMIT : query.limit;

  // Fail-closed weight validation (the trusted constructor re-checks what
  // parseSimilarityQuery already enforces for untrusted input).
  const seenKinds = new Set<string>();
  for (const weight of weights) {
    if (
      (FEATURE_KINDS as readonly string[]).includes(weight.kind) === false ||
      !Number.isInteger(weight.weight) ||
      weight.weight < 1 ||
      weight.weight > 100
    ) {
      return fail(
        domainError(
          'invariant-violation',
          'the similarity query weights must be declared feature kinds with integer weights 1..100',
          [
            {
              code: 'similarity-weights-valid',
              message: `invalid weight: kind ${String(weight.kind)}, weight ${String(weight.weight)}`,
              path: 'weights',
            },
          ],
        ),
      );
    }
    if (seenKinds.has(weight.kind)) {
      return fail(
        domainError(
          'invariant-violation',
          `the similarity query carries a duplicate weight for feature kind ${weight.kind}`,
          [
            {
              code: 'similarity-weights-distinct',
              message: `duplicate kind ${weight.kind}`,
              path: 'weights',
            },
          ],
        ),
      );
    }
    seenKinds.add(weight.kind);
  }

  const subjectFeatures = new Map<FeatureKind, Rational>();
  for (const feature of subject.features) {
    subjectFeatures.set(feature.kind, feature.value);
  }

  const ranked: SimilarityCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.projectId === subject.projectId) {
      continue; // the subject never ranks against itself
    }
    const candidateFeatures = new Map<FeatureKind, Rational>();
    for (const feature of candidate.features) {
      candidateFeatures.set(feature.kind, feature.value);
    }

    const components: SimilarityComponent[] = [];
    const missingKinds: { readonly kind: FeatureKind; readonly side: 'left' | 'right' }[] = [];
    let weightedSum: BigRational = { numerator: 0n, denominator: 1n };
    let weightTotal = 0;

    for (const kind of FEATURE_KINDS) {
      const left = subjectFeatures.get(kind);
      const right = candidateFeatures.get(kind);
      if (left === undefined && right === undefined) {
        continue; // the feature exists on neither side — no component at all
      }
      if (left === undefined || right === undefined) {
        missingKinds.push({
          kind,
          side: left === undefined ? 'left' : 'right',
        });
        continue; // attributed skip — the feature never enters the sums
      }
      const weight = weightOfKind(weights, kind);
      const similarity = featureSimilarity(
        `candidates.${candidate.projectId}.components.${kind}`,
        left,
        right,
      );
      if (!similarity.ok) return similarity;
      components.push({ featureKind: kind, left, right, weight, similarity: similarity.value });
      weightedSum = bigAdd(weightedSum, bigScale(bigOf(similarity.value), weight));
      weightTotal += weight;
    }

    let score: Rational;
    if (weightTotal === 0) {
      score = RATIONAL_ZERO; // no shared features — the lowest possible score
    } else {
      const total = rationalFromBig(
        `candidates.${candidate.projectId}.score`,
        bigReduce({ numerator: weightedSum.numerator, denominator: weightedSum.denominator * BigInt(weightTotal) }),
      );
      if (!total.ok) return total;
      score = total.value;
    }

    ranked.push({
      projectId: candidate.projectId,
      outcomeId: candidate.outcomeId,
      rank: 0, // assigned after the deterministic sort below
      score,
      components,
      missingKinds,
    });
  }

  ranked.sort(compareCandidates);
  const limited = ranked.slice(0, limit).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
  return ok(limited);
}
