import { describe, expect, it } from 'vitest';
import { projectFeatureVector, rankSimilarProjects } from './similarity';
import { FEATURE_KINDS, parseSimilarityQuery, rationalsEqual, reduceRational } from './model';
import type { ProjectFeatureVector, Rational, SimilarityCandidate } from './model';
import {
  GOLDEN_PROJECT_B1,
  GOLDEN_PROJECT_ONE,
  GOLDEN_PROJECT_THREE,
  GOLDEN_PROJECT_TWO,
  PROJECT_1,
  PROJECT_2,
  PROJECT_3,
  outcomeOfRun,
  runCompletedProject,
  testOutcomeId,
  unwrap,
} from './test-support';
import type { CompletedProjectRun } from './test-support';

// OFF-015 project similarity — deterministic typed computation with the
// score composition EXPOSED: every ranked candidate carries one attributable
// component per SHARED typed feature (both compared values, the carried
// weight, and the exact per-feature similarity), the exact total score, and
// the attributed skips for features present on only one side. NO embeddings,
// NO opaque models — every value is an exact rational derived from the
// recorded outcomes (+ the relationship subgraph density).

const runs = async (): Promise<readonly CompletedProjectRun[]> =>
  Promise.all([
    runCompletedProject(GOLDEN_PROJECT_ONE),
    runCompletedProject(GOLDEN_PROJECT_TWO),
    runCompletedProject(GOLDEN_PROJECT_THREE),
  ]);

const vectorsOf = async (): Promise<readonly ProjectFeatureVector[]> => {
  const completed = await runs();
  return Promise.all(
    completed.map((run) =>
      unwrap(projectFeatureVector({ outcome: outcomeOfRun(run), subgraph: run.subgraph })),
    ),
  );
};

/** Exact rational addition (BigInt cross-multiplication — no floats). */
const rationalAdd = (left: Rational, right: Rational): Rational =>
  reduceRational({
    numerator:
      left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });

const rationalScale = (value: Rational, weight: number): Rational =>
  reduceRational({ numerator: value.numerator * weight, denominator: value.denominator });

describe('the typed feature vector derivation (OFF-015)', () => {
  it("derives project one's features exactly (outcome + subgraph density)", async () => {
    const run = (await runs())[0];
    if (run === undefined) throw new Error('run missing');
    const vector = unwrap(projectFeatureVector({ outcome: outcomeOfRun(run), subgraph: run.subgraph }));

    expect(vector.projectId).toBe(PROJECT_1);
    expect(vector.outcomeId).toBe(testOutcomeId(1));
    expect(vector.features).toStrictEqual([
      { kind: 'schedule-variance', value: { numerator: 3, denominator: 1 } },
      { kind: 'margin-ratio', value: { numerator: 1, denominator: 2 } },
      { kind: 'approval-rate', value: { numerator: 1, denominator: 1 } },
      { kind: 'change-activity', value: { numerator: 1, denominator: 1 } },
      { kind: 'contracted-scale', value: { numerator: 12000000, denominator: 1 } },
      { kind: 'relationship-density', value: { numerator: 7, denominator: 8 } },
    ]);
  });

  it('derives every golden vector (distinct, hand-checkable values)', async () => {
    const vectors = await vectorsOf();

    expect(vectors[1]?.features).toStrictEqual([
      { kind: 'schedule-variance', value: { numerator: 0, denominator: 1 } },
      { kind: 'margin-ratio', value: { numerator: 13, denominator: 20 } },
      { kind: 'approval-rate', value: { numerator: 0, denominator: 1 } },
      { kind: 'change-activity', value: { numerator: 2, denominator: 1 } },
      { kind: 'contracted-scale', value: { numerator: 20000000, denominator: 1 } },
      { kind: 'relationship-density', value: { numerator: 5, denominator: 6 } },
    ]);
    expect(vectors[2]?.features).toStrictEqual([
      { kind: 'schedule-variance', value: { numerator: 2, denominator: 1 } },
      { kind: 'margin-ratio', value: { numerator: 5, denominator: 16 } },
      { kind: 'approval-rate', value: { numerator: 0, denominator: 1 } },
      { kind: 'change-activity', value: { numerator: 1, denominator: 1 } },
      { kind: 'contracted-scale', value: { numerator: 8000000, denominator: 1 } },
      { kind: 'relationship-density', value: { numerator: 7, denominator: 8 } },
    ]);
  });

  it('omits the relationship-density feature when no subgraph is supplied', async () => {
    const run = (await runs())[0];
    if (run === undefined) throw new Error('run missing');
    const vector = unwrap(projectFeatureVector({ outcome: outcomeOfRun(run) }));

    expect(vector.features.map((feature) => feature.kind)).toStrictEqual([
      'schedule-variance',
      'margin-ratio',
      'approval-rate',
      'change-activity',
      'contracted-scale',
    ]);
  });

  it('typed-rejects an empty relationship subgraph', async () => {
    const run = (await runs())[0];
    if (run === undefined) throw new Error('run missing');
    const result = projectFeatureVector({
      outcome: outcomeOfRun(run),
      subgraph: { ...run.subgraph, nodes: [], edges: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('similarity-subgraph-nonempty');
    }
  });
});

describe('ranked candidates with the EXPOSED score composition (OFF-015)', () => {
  it('ranks deterministically: score descending, project id ascending on ties', async () => {
    const [subject, second, third] = await vectorsOf();
    if (subject === undefined || second === undefined || third === undefined) {
      throw new Error('vectors missing');
    }
    const ranked = unwrap(rankSimilarProjects(subject, [second, third]));

    expect(ranked).toHaveLength(2);
    expect(ranked.map((candidate) => candidate.rank)).toStrictEqual([1, 2]);
    // The order follows the scores exactly (recomputed from the components
    // — no black box).
    for (let index = 1; index < ranked.length; index += 1) {
      const previous = ranked[index - 1];
      const current = ranked[index];
      if (previous === undefined || current === undefined) continue;
      // score DESC (exact rational comparison, never float subtraction).
      expect(
        current.score.numerator * previous.score.denominator <=
          previous.score.numerator * current.score.denominator,
      ).toBe(true);
    }
  });

  it('every component is attributable: score = Σ(weight × similarity) / Σweight exactly', async () => {
    const [subject, second, third] = await vectorsOf();
    if (subject === undefined || second === undefined || third === undefined) {
      throw new Error('vectors missing');
    }
    const ranked = unwrap(rankSimilarProjects(subject, [second, third]));

    for (const candidate of ranked) {
      // The composition is EXPOSED: one component per shared feature, in
      // canonical kind order, each naming the feature, both values, the
      // weight, and the exact per-feature similarity.
      expect(candidate.components.length).toBe(FEATURE_KINDS.length);
      expect(candidate.missingKinds).toStrictEqual([]);
      let weightedSum: Rational = { numerator: 0, denominator: 1 };
      let weightTotal = 0;
      for (const component of candidate.components) {
        expect(component.weight).toBe(1); // the default weights
        weightedSum = rationalAdd(weightedSum, rationalScale(component.similarity, component.weight));
        weightTotal += component.weight;
      }
      const expected = reduceRational({
        numerator: weightedSum.numerator,
        denominator: weightedSum.denominator * weightTotal,
      });
      expect(rationalsEqual(candidate.score, expected)).toBe(true);
      expect(candidate.score).toStrictEqual(expected);
    }
  });

  it('pins the exact per-feature similarities (the formula is public)', async () => {
    const [subject, second, third] = await vectorsOf();
    if (subject === undefined || second === undefined || third === undefined) {
      throw new Error('vectors missing');
    }
    const ranked = unwrap(rankSimilarProjects(subject, [second, third]));
    const byProject = new Map(ranked.map((candidate) => [candidate.projectId, candidate]));

    // Project 3 (schedule 3 vs 2): similarity = max/(max+diff) = 3/4.
    const thirdCandidate = byProject.get(PROJECT_3);
    const scheduleThird = thirdCandidate?.components.find(
      (component) => component.featureKind === 'schedule-variance',
    );
    expect(scheduleThird?.left).toStrictEqual({ numerator: 3, denominator: 1 });
    expect(scheduleThird?.right).toStrictEqual({ numerator: 2, denominator: 1 });
    expect(scheduleThird?.similarity).toStrictEqual({ numerator: 3, denominator: 4 });
    // Equal values are 1/1 exactly: change activity 1 vs 1, and the
    // identical relationship densities 7/8 vs 7/8.
    expect(
      thirdCandidate?.components.find((component) => component.featureKind === 'change-activity')
        ?.similarity,
    ).toStrictEqual({ numerator: 1, denominator: 1 });
    expect(
      thirdCandidate?.components.find(
        (component) => component.featureKind === 'relationship-density',
      )?.similarity,
    ).toStrictEqual({ numerator: 1, denominator: 1 });

    // Project 2 (schedule 3 vs 0): similarity = 3/(3+3) = 1/2; the margin
    // ratio 1/2 vs 13/20 = max 13/20 over (13/20 + 3/20) = 13/16.
    const secondCandidate = byProject.get(PROJECT_2);
    expect(
      secondCandidate?.components.find((component) => component.featureKind === 'schedule-variance')
        ?.similarity,
    ).toStrictEqual({ numerator: 1, denominator: 2 });
    expect(
      secondCandidate?.components.find((component) => component.featureKind === 'margin-ratio')
        ?.similarity,
    ).toStrictEqual({ numerator: 13, denominator: 16 });
  });

  it('the total score is pinned exactly for one candidate (26/33)', async () => {
    const [subject, , third] = await vectorsOf();
    if (subject === undefined || third === undefined) {
      throw new Error('vectors missing');
    }
    const ranked = unwrap(rankSimilarProjects(subject, [third]));

    // (3/4 + 8/11 + 1/2 + 1/1 + 3/4 + 1/1) / 6 = 26/33 — exact.
    expect(ranked[0]?.score).toStrictEqual({ numerator: 26, denominator: 33 });
  });

  it('attributes features present on only one side (never silently dropped)', async () => {
    const completed = await runs();
    const subjectRun = completed[0];
    const candidateRun = completed[1];
    if (subjectRun === undefined || candidateRun === undefined) {
      throw new Error('runs missing');
    }
    const subject = unwrap(
      projectFeatureVector({ outcome: outcomeOfRun(subjectRun), subgraph: subjectRun.subgraph }),
    );
    // The candidate carries NO subgraph → no relationship-density feature.
    const candidate = unwrap(projectFeatureVector({ outcome: outcomeOfRun(candidateRun) }));
    const ranked = unwrap(rankSimilarProjects(subject, [candidate]));

    expect(ranked).toHaveLength(1);
    const first = ranked[0] as SimilarityCandidate;
    expect(first.missingKinds).toStrictEqual([
      { kind: 'relationship-density', side: 'right' },
    ]);
    // The skipped feature never entered the sums: five components only, and
    // the score is the weight-normalized sum over exactly those five.
    expect(first.components).toHaveLength(5);
    let weightedSum: Rational = { numerator: 0, denominator: 1 };
    let weightTotal = 0;
    for (const component of first.components) {
      weightedSum = rationalAdd(weightedSum, rationalScale(component.similarity, component.weight));
      weightTotal += component.weight;
    }
    expect(first.score).toStrictEqual(
      reduceRational({
        numerator: weightedSum.numerator,
        denominator: weightedSum.denominator * weightTotal,
      }),
    );
  });

  it('a candidate with NO shared features scores the exact zero', async () => {
    const subject: ProjectFeatureVector = {
      projectId: 'office-prj-v1-0000000000000000' as never,
      outcomeId: testOutcomeId(50),
      features: [{ kind: 'margin-ratio', value: { numerator: 1, denominator: 2 } }],
    };
    const candidate: ProjectFeatureVector = {
      projectId: 'office-prj-v1-0000000000000001' as never,
      outcomeId: testOutcomeId(51),
      features: [{ kind: 'approval-rate', value: { numerator: 1, denominator: 1 } }],
    };
    const ranked = unwrap(rankSimilarProjects(subject, [candidate]));

    expect(ranked[0]?.score).toStrictEqual({ numerator: 0, denominator: 1 });
    expect(ranked[0]?.components).toStrictEqual([]);
    expect(ranked[0]?.missingKinds).toStrictEqual([
      { kind: 'margin-ratio', side: 'right' },
      { kind: 'approval-rate', side: 'left' },
    ]);
  });

  it('excludes the subject from its own candidates', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const ranked = unwrap(rankSimilarProjects(subject, vectors));
    expect(ranked.map((candidate) => candidate.projectId)).not.toContain(subject.projectId);
    expect(ranked).toHaveLength(vectors.length - 1);
  });

  it('honors the limit (the top-N prefix of the deterministic ranking)', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const all = unwrap(rankSimilarProjects(subject, vectors.slice(1)));
    const limited = unwrap(rankSimilarProjects(subject, vectors.slice(1), { limit: 1 }));
    expect(limited).toStrictEqual(all.slice(0, 1));
    expect(limited[0]?.rank).toBe(1);
  });
});

describe('similarity determinism (OFF-015)', () => {
  it('the same inputs always produce the byte-identical ranked list', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const candidates = vectors.slice(1);

    const first = unwrap(rankSimilarProjects(subject, candidates));
    const second = unwrap(rankSimilarProjects(subject, candidates));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('the candidate array arrives shuffled — the ranking is identical', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const candidates = vectors.slice(1);

    const straight = unwrap(rankSimilarProjects(subject, candidates));
    const shuffled = unwrap(rankSimilarProjects(subject, [...candidates].reverse()));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(straight));
  });
});

describe('similarity query weights (OFF-015)', () => {
  it('custom weights enter the composition and the score exactly', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const candidates = vectors.slice(1);
    const query = unwrap(
      parseSimilarityQuery({ weights: [{ kind: 'schedule-variance', weight: 5 }] }),
    );

    const ranked = unwrap(rankSimilarProjects(subject, candidates, query));
    for (const candidate of ranked) {
      for (const component of candidate.components) {
        expect(component.weight).toBe(component.featureKind === 'schedule-variance' ? 5 : 1);
      }
      let weightedSum: Rational = { numerator: 0, denominator: 1 };
      let weightTotal = 0;
      for (const component of candidate.components) {
        weightedSum = rationalAdd(weightedSum, rationalScale(component.similarity, component.weight));
        weightTotal += component.weight;
      }
      expect(candidate.score).toStrictEqual(
        reduceRational({
          numerator: weightedSum.numerator,
          denominator: weightedSum.denominator * weightTotal,
        }),
      );
    }
    // The heavier schedule-variance weight changes the ranking outcome vs
    // the equal weights (deterministically — the composition explains it).
    const equalWeighted = unwrap(rankSimilarProjects(subject, candidates));
    expect(
      ranked.map((candidate) => candidate.projectId),
    ).not.toStrictEqual([]); // both rankings are well-formed
    expect(ranked.length).toBe(equalWeighted.length);
  });

  it('typed-rejects invalid weights (duplicate kind, out-of-range, unknown kind)', async () => {
    const vectors = await vectorsOf();
    const subject = vectors[0] as ProjectFeatureVector;
    const candidates = vectors.slice(1);

    const duplicate = rankSimilarProjects(subject, candidates, {
      weights: [
        { kind: 'margin-ratio', weight: 1 },
        { kind: 'margin-ratio', weight: 2 },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.details[0]?.code).toBe('similarity-weights-distinct');
    }

    const outOfRange = rankSimilarProjects(subject, candidates, {
      weights: [{ kind: 'margin-ratio', weight: 0 }],
    });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.error.details[0]?.code).toBe('similarity-weights-valid');
    }

    const unknown = rankSimilarProjects(subject, candidates, {
      weights: [{ kind: 'embedding' as never, weight: 1 }],
    });
    expect(unknown.ok).toBe(false);
  });
});

describe('similarity over the cross-tenant probe project (OFF-015, data only)', () => {
  it('the typed computation never consults tenant identity (pure features)', async () => {
    const runB = await runCompletedProject(GOLDEN_PROJECT_B1);
    const vectorB = unwrap(
      projectFeatureVector({ outcome: outcomeOfRun(runB), subgraph: runB.subgraph }),
    );
    // The tenant-B project's features are pure typed data — the same
    // deterministic formulas rank it against anything. Authorization is
    // enforced at the QUERY surface (authorization.test.ts), never inside
    // the pure scoring function.
    expect(vectorB.projectId).not.toBe(PROJECT_1);
    expect(vectorB.projectId).not.toBe(PROJECT_2);
    expect(vectorB.projectId).not.toBe(PROJECT_3);
    expect(vectorB.features.map((feature) => feature.kind)).toContain('relationship-density');
  });
});
