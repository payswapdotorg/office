import { describe, expect, it } from 'vitest';
import { parseEntityId } from '@office/contracts';
import { formatLedgerEventId } from '@office/events';
import { parseAssessmentId } from '@office/intelligence-margin';
import {
  BENCHMARK_METRIC_KINDS,
  FEATURE_KINDS,
  LESSON_AREAS,
  RATIONAL_ONE,
  RATIONAL_ZERO,
  canonicalOutcomeEvidence,
  compareAssessmentSources,
  compareLessonLinks,
  compareLessonTags,
  compareOutcomeEvidence,
  compareRationals,
  parseBenchmarkMetricKind,
  parseFeatureKind,
  parseLessonArea,
  parseLessonQuery,
  parseLessonTag,
  parseOutcomeQuery,
  parseRational,
  parseSimilarityQuery,
  rationalOf,
  rationalsEqual,
  reduceRational,
} from './model';
import { parseBenchmarkId, parseLessonId, parseOutcomeId } from './vocabulary';
import { testId, unwrap } from './test-support';
import type { OutcomeAssessmentSource, OutcomeEventSource } from './model';

// OFF-015 model — the exact-rational arithmetic (the deterministic number
// discipline of every benchmark statistic and similarity score) and the
// fail-closed parsers of the memory read queries. Every parse is total and
// strict: unknown fields, wrong types, and out-of-domain values are typed
// rejections, never silent coercions.

describe('exact rational arithmetic (OFF-015)', () => {
  it('constructs and reduces rationals (sign in the numerator)', () => {
    expect(unwrap(rationalOf(6, 4))).toStrictEqual({ numerator: 3, denominator: 2 });
    expect(unwrap(rationalOf(-6, 4))).toStrictEqual({ numerator: -3, denominator: 2 });
    expect(unwrap(rationalOf(0, 12))).toStrictEqual(RATIONAL_ZERO);
    expect(unwrap(rationalOf(7, 7))).toStrictEqual(RATIONAL_ONE);
    expect(reduceRational({ numerator: 2 * 7, denominator: 3 * 7 })).toStrictEqual({
      numerator: 2,
      denominator: 3,
    });
  });

  it('rejects out-of-domain rationals fail-closed', () => {
    for (const [numerator, denominator] of [
      [1, 0],
      [1, -2],
      [0.5, 2],
      [1, 0.5],
      [Number.NaN, 1],
    ] as const) {
      const result = rationalOf(numerator, denominator);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invariant-violation');
        expect(result.error.details[0]?.code).toBe('rational-domain');
      }
    }
  });

  it('compares rationals exactly across unlike denominators (no floats)', () => {
    // 1/3 < 2/5 < 1/2 — cross-multiplication decides, floats would agree
    // only approximately; the exact comparator is stable to the last digit.
    expect(compareRationals({ numerator: 1, denominator: 3 }, { numerator: 2, denominator: 5 })).toBe(-1);
    expect(compareRationals({ numerator: 2, denominator: 5 }, { numerator: 1, denominator: 3 })).toBe(1);
    expect(compareRationals({ numerator: 1, denominator: 3 }, { numerator: 2, denominator: 6 })).toBe(0);
    expect(rationalsEqual({ numerator: 22, denominator: 7 }, { numerator: 22, denominator: 7 })).toBe(true);
    // Negative values order exactly.
    expect(compareRationals({ numerator: -1, denominator: 2 }, { numerator: 1, denominator: 1000 })).toBe(-1);
  });

  it('parses serialized rationals strictly (fail-closed, strict keys)', () => {
    expect(unwrap(parseRational({ numerator: 4, denominator: 8 }))).toStrictEqual({
      numerator: 1,
      denominator: 2,
    });
    // Unknown field, non-object, bad denominator, missing field.
    for (const raw of [
      { numerator: 1, denominator: 1, extra: true },
      null,
      '1/2',
      { numerator: 1, denominator: 0 },
      { numerator: 1 },
      { numerator: 1.5, denominator: 2 },
    ]) {
      const result = parseRational(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) {
        expect(['invalid-type', 'unknown-field', 'invalid-value', 'missing-field']).toContain(
          result.error.code,
        );
      }
    }
  });
});

describe('outcome evidence canonicalization (OFF-015, A4 provenance)', () => {
  const ledgerId = (n: number) =>
    formatLedgerEventId({ version: 'v1', opaque: `a1b2c3d4e5f60718${String(n).padStart(16, '0')}`.slice(0, 32) });
  const assessmentSource = (n: number): OutcomeAssessmentSource => ({
    kind: 'assessment',
    assessmentId: unwrap(parseAssessmentId(`assessment-${String(n).padStart(4, '0')}`)),
    assessedAt: '2026-09-17T10:00:00.000Z' as OutcomeAssessmentSource['assessedAt'],
    sourceEventId: ledgerId(n),
    correlationId: `corr-${n}`,
    changeEventId: testId('chg', n),
    contractId: testId('con', n),
  });
  const eventSource = (n: number): OutcomeEventSource => ({
    kind: 'event',
    eventId: ledgerId(n),
    eventName: 'contracts.changeEventRaised' as OutcomeEventSource['eventName'],
    occurredAt: '2026-09-14T11:45:00.000Z' as OutcomeEventSource['occurredAt'],
  });

  it('orders assessments before events, then by id, and deduplicates', () => {
    const evidence = canonicalOutcomeEvidence([
      eventSource(2),
      assessmentSource(2),
      eventSource(1),
      assessmentSource(1),
      eventSource(1), // duplicate id — dropped
    ]);
    expect(evidence.map((entry) => entry.kind)).toStrictEqual([
      'assessment',
      'assessment',
      'event',
      'event',
    ]);
    expect(compareOutcomeEvidence(assessmentSource(1), eventSource(1))).toBe(-1);
    expect(compareOutcomeEvidence(assessmentSource(2), assessmentSource(1))).toBe(1);
    expect(compareAssessmentSources(assessmentSource(1), assessmentSource(1))).toBe(0);
  });
});

describe('the closed model vocabularies (OFF-015)', () => {
  it('parses declared metric/feature/area kinds and rejects unknown ones', () => {
    expect(unwrap(parseBenchmarkMetricKind('margin-ratio'))).toBe('margin-ratio');
    expect(unwrap(parseFeatureKind('relationship-density'))).toBe('relationship-density');
    expect(unwrap(parseLessonArea('entitlement'))).toBe('entitlement');
    expect(parseBenchmarkMetricKind('not-a-metric').ok).toBe(false);
    expect(parseFeatureKind('embedding').ok).toBe(false);
    expect(parseLessonArea('procurement').ok).toBe(false);
    expect(BENCHMARK_METRIC_KINDS).toHaveLength(4);
    expect(FEATURE_KINDS).toHaveLength(6);
    expect(LESSON_AREAS).toHaveLength(6);
  });

  it('parses lesson tags strictly (closed area, bounded value)', () => {
    expect(unwrap(parseLessonTag({ area: 'cost', value: 'wall-closing-sequence' }))).toStrictEqual({
      area: 'cost',
      value: 'wall-closing-sequence',
    });
    for (const raw of [
      { area: 'nope', value: 'x' },
      { area: 'cost' },
      { area: 'cost', value: '' },
      { area: 'cost', value: ' '.repeat(65) },
      { area: 'cost', value: 'x', extra: 1 },
    ]) {
      expect(parseLessonTag(raw).ok, JSON.stringify(raw)).toBe(false);
    }
    expect(compareLessonTags({ area: 'cost', value: 'b' }, { area: 'cost', value: 'a' })).toBe(1);
    // Canonical link order: entity kind ascending, then entity id — 'budget'
    // sorts before 'contract'.
    const budgetLink = {
      entity: { entityKind: 'budget' as never, entityId: unwrap(parseEntityId(testId('bud', 1))) },
      documentId: null,
      revisionId: null,
      sourceEventId: null,
    };
    const contractLink = {
      entity: { entityKind: 'contract' as never, entityId: unwrap(parseEntityId(testId('con', 1))) },
      documentId: null,
      revisionId: null,
      sourceEventId: null,
    };
    expect(compareLessonLinks(contractLink, budgetLink)).toBe(1);
    expect(compareLessonLinks(budgetLink, contractLink)).toBe(-1);
  });
});

describe('the memory read queries parse fail-closed (OFF-015)', () => {
  it('parses the outcome query strictly (projectId or nothing)', () => {
    expect(unwrap(parseOutcomeQuery({}))).toStrictEqual({});
    expect(unwrap(parseOutcomeQuery({ projectId: testId('prj', 1) }))).toStrictEqual({
      projectId: testId('prj', 1),
    });
    for (const raw of [
      { projectId: 'not-an-entity-id' },
      { projectId: testId('prj', 1), extra: true },
      [],
      null,
      'project',
    ]) {
      const result = parseOutcomeQuery(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) {
        expect(['invalid-type', 'unknown-field', 'invalid-value', 'missing-field']).toContain(
          result.error.code,
        );
      }
    }
  });

  it('parses the lesson query strictly (closed areas, no duplicates)', () => {
    expect(unwrap(parseLessonQuery({}))).toStrictEqual({});
    expect(unwrap(parseLessonQuery({ areas: ['cost', 'schedule'] }))).toStrictEqual({
      areas: ['cost', 'schedule'],
    });
    for (const raw of [
      { areas: ['cost', 'cost'] },
      { areas: ['cost', 'not-an-area'] },
      { areas: 'cost' },
      { areas: [], extra: 1 },
    ]) {
      expect(parseLessonQuery(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('parses the similarity query strictly (weights + limit domains)', () => {
    expect(unwrap(parseSimilarityQuery({}))).toStrictEqual({});
    expect(
      unwrap(parseSimilarityQuery({ weights: [{ kind: 'margin-ratio', weight: 3 }], limit: 2 })),
    ).toStrictEqual({ weights: [{ kind: 'margin-ratio', weight: 3 }], limit: 2 });
    for (const raw of [
      { weights: [{ kind: 'margin-ratio', weight: 0 }] },
      { weights: [{ kind: 'margin-ratio', weight: 1.5 }] },
      { weights: [{ kind: 'margin-ratio', weight: 1 }, { kind: 'margin-ratio', weight: 2 }] },
      { weights: [{ kind: 'not-a-kind', weight: 1 }] },
      { weights: [{ kind: 'margin-ratio', weight: 1, extra: true }] },
      { limit: 0 },
      { limit: 101 },
      { limit: 'ten' },
      { extra: true },
    ]) {
      expect(parseSimilarityQuery(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

describe('the record identity grammars (OFF-015)', () => {
  it('accepts canonical tokens and rejects malformed ones', () => {
    expect(unwrap(parseOutcomeId('outcome-000001'))).toBe('outcome-000001');
    expect(unwrap(parseBenchmarkId('benchmark-000001'))).toBe('benchmark-000001');
    expect(unwrap(parseLessonId('lesson-000001'))).toBe('lesson-000001');
    for (const bad of ['', 'short', 'x'.repeat(129), 'has space', 42, null]) {
      expect(parseOutcomeId(bad).ok, String(bad)).toBe(false);
      expect(parseBenchmarkId(bad).ok, String(bad)).toBe(false);
      expect(parseLessonId(bad).ok, String(bad)).toBe(false);
    }
  });
});
