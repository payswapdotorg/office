import { describe, expect, it } from 'vitest';
import { captureLesson, lessonAppliesToArea } from './lesson';
import { LESSON_SCHEMA_VERSION, MEMORY_ENGINE } from './model';
import {
  T4,
  T5,
  USER_ACTOR,
  projectOneScope,
  tenantAWideScope,
  testId,
  testLessonId,
  testOutcomeId,
  unwrap,
} from './test-support';
import type { LessonContent } from './lesson';

// OFF-015 lesson capture — a reusable, human-authored-or-derived record:
// typed links (entity refs + evidence refs), applicability tags, and
// provenance (who/what derived it and from which outcomes). Lessons are
// DATA: captureLesson validates fail-closed and canonicalizes; nothing in
// the package ever branches on lesson content.

const humanContent = (): LessonContent => ({
  title: 'Close the wall sequence before fit-out starts',
  statement:
    'Project one recorded a +3 day schedule variance because the wall-closing sequence overlapped the fit-out package; sequencing the close-out first avoids the variance.',
  applicability: [
    { area: 'cost', value: 'fit-out-package' },
    { area: 'schedule', value: 'wall-closing-sequence' },
  ],
  links: [
    {
      entity: { entityKind: 'budget' as never, entityId: testId('bud', 2) },
      documentId: null,
      revisionId: null,
      sourceEventId: null,
    },
    {
      entity: { entityKind: 'contract' as never, entityId: testId('con', 1) },
      documentId: testId('doc', 1),
      revisionId: testId('rev', 1),
      sourceEventId: null,
    },
  ],
  provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [] },
});

const identity = () => ({
  lessonId: testLessonId(1),
  capturedAt: T5,
  actor: USER_ACTOR,
  scope: projectOneScope(),
});

describe('captureLesson canonicalization (OFF-015)', () => {
  it('captures the lesson with canonically ordered tags, links, and provenance', () => {
    const lesson = unwrap(captureLesson(humanContent(), identity()));

    expect(lesson.lessonId).toBe(testLessonId(1));
    expect(lesson.lessonVersion).toBe(LESSON_SCHEMA_VERSION);
    expect(lesson.engine).toBe(MEMORY_ENGINE);
    expect(lesson.capturedAt).toBe(T5);
    expect(lesson.actor).toStrictEqual(USER_ACTOR);
    expect(lesson.scope).toStrictEqual(projectOneScope());
    // Tags: canonical (area, value) order — 'cost' sorts before 'schedule'
    // (the input order here is already canonical; the shuffle test below
    // proves the sort).
    expect(lesson.applicability.map((tag) => `${tag.area}:${tag.value}`)).toStrictEqual([
      'cost:fit-out-package',
      'schedule:wall-closing-sequence',
    ]);
    // Links: canonical (entity kind, entity id) order — budget before contract.
    expect(lesson.links.map((link) => link.entity.entityKind)).toStrictEqual([
      'budget',
      'contract',
    ]);
    // Provenance: a human lesson names no derived-from outcomes.
    expect(lesson.provenance).toStrictEqual({
      origin: 'human',
      author: USER_ACTOR,
      derivedFromOutcomeIds: [],
      engine: MEMORY_ENGINE,
    });
  });

  it('sorts shuffled tags and links into the canonical order', () => {
    const content = humanContent();
    const shuffled = {
      ...content,
      applicability: [...content.applicability].reverse(),
      links: [...content.links].reverse(),
    };
    const lesson = unwrap(captureLesson(shuffled, identity()));

    expect(lesson.applicability.map((tag) => tag.area)).toStrictEqual(['cost', 'schedule']);
    expect(lesson.links.map((link) => link.entity.entityKind)).toStrictEqual([
      'budget',
      'contract',
    ]);
  });

  it('derives a lesson: the outcome ids are sorted + the origin is derived', () => {
    const content: LessonContent = {
      ...humanContent(),
      provenance: {
        origin: 'derived',
        author: USER_ACTOR,
        derivedFromOutcomeIds: [testOutcomeId(3), testOutcomeId(1)],
      },
    };
    const lesson = unwrap(captureLesson(content, identity()));

    expect(lesson.provenance.origin).toBe('derived');
    expect(lesson.provenance.derivedFromOutcomeIds).toStrictEqual([
      testOutcomeId(1),
      testOutcomeId(3),
    ]);
  });

  it('is deterministic: the same inputs capture the byte-identical lesson', () => {
    const first = unwrap(captureLesson(humanContent(), identity()));
    const second = unwrap(captureLesson(humanContent(), identity()));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('captureLesson fail-closed validation (OFF-015)', () => {
  const expectCapturedToFail = (content: unknown): { code: string; statement: string } => {
    const result = captureLesson(content as LessonContent, identity());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      const detail = result.error.details[0];
      expect(detail).toBeDefined();
      return { code: String(detail?.code), statement: result.error.message };
    }
    throw new Error('expected a failure');
  };

  it('rejects an empty title and an over-long statement', () => {
    const noTitle = { ...humanContent(), title: '' };
    expect(expectCapturedToFail(noTitle).code).toBe('lesson-title-bounded');

    const longStatement = { ...humanContent(), statement: 'x'.repeat(2001) };
    expect(expectCapturedToFail(longStatement).code).toBe('lesson-statement-bounded');
  });

  it('rejects lessons without applicability tags (found BY their applicability)', () => {
    const noTags = { ...humanContent(), applicability: [] };
    expect(expectCapturedToFail(noTags).code).toBe('lesson-applicability-nonempty');
  });

  it('rejects duplicate applicability tags', () => {
    const duplicated = {
      ...humanContent(),
      applicability: [
        { area: 'cost', value: 'fit-out-package' },
        { area: 'cost', value: 'fit-out-package' },
      ],
    };
    expect(expectCapturedToFail(duplicated).code).toBe('lesson-tags-distinct');
  });

  it('rejects duplicate link entities', () => {
    const link = humanContent().links[0];
    if (link === undefined) throw new Error('link missing');
    const duplicated = {
      ...humanContent(),
      links: [link, { ...link }],
    };
    expect(expectCapturedToFail(duplicated).code).toBe('lesson-link-entities-distinct');
  });

  it('rejects a revision without its document (evidence pairs)', () => {
    const content = humanContent();
    const unpaired = {
      ...content,
      links: [
        {
          entity: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          documentId: null,
          revisionId: testId('rev', 1),
          sourceEventId: null,
        },
      ],
    };
    expect(expectCapturedToFail(unpaired).code).toBe('lesson-link-evidence-paired');
  });

  it('rejects invalid entity refs and ids in links', () => {
    const badEntity = {
      ...humanContent(),
      links: [
        {
          entity: { entityKind: 'contract', entityId: 'not-an-entity-id' } as never,
          documentId: null,
          revisionId: null,
          sourceEventId: null,
        },
      ],
    };
    expect(expectCapturedToFail(badEntity).code).toContain('lesson-link-entity-valid');

    const badDocument = {
      ...humanContent(),
      links: [
        {
          entity: { entityKind: 'contract' as never, entityId: testId('con', 1) },
          documentId: 'not-an-entity-id',
          revisionId: null,
          sourceEventId: null,
        },
      ],
    };
    expect(expectCapturedToFail(badDocument).code).toContain('lesson-link-document-valid');
  });

  it('rejects provenance inconsistencies (derived names outcomes; human names none)', () => {
    const derivedWithoutOutcomes = {
      ...humanContent(),
      provenance: { origin: 'derived', author: USER_ACTOR, derivedFromOutcomeIds: [] },
    };
    expect(expectCapturedToFail(derivedWithoutOutcomes).code).toBe(
      'lesson-derived-outcomes-nonempty',
    );

    const humanWithOutcomes = {
      ...humanContent(),
      provenance: { origin: 'human', author: USER_ACTOR, derivedFromOutcomeIds: [testOutcomeId(1)] },
    };
    expect(expectCapturedToFail(humanWithOutcomes).code).toBe('lesson-human-outcomes-empty');

    const duplicatedOutcomes = {
      ...humanContent(),
      provenance: {
        origin: 'derived',
        author: USER_ACTOR,
        derivedFromOutcomeIds: [testOutcomeId(1), testOutcomeId(1)],
      },
    };
    expect(expectCapturedToFail(duplicatedOutcomes).code).toBe('lesson-derived-outcomes-distinct');
  });
});

describe('lesson applicability is pure data (OFF-015)', () => {
  it('lessonAppliesToArea filters by tag area (never behavior)', () => {
    const lesson = unwrap(captureLesson(humanContent(), identity()));

    expect(lessonAppliesToArea(lesson, 'schedule')).toBe(true);
    expect(lessonAppliesToArea(lesson, 'cost')).toBe(true);
    expect(lessonAppliesToArea(lesson, 'contracts')).toBe(false);
    expect(lessonAppliesToArea(lesson, 'entitlement')).toBe(false);
  });

  it('the lesson carries its tenant scope (A12 data, not enforcement)', () => {
    const scoped = unwrap(
      captureLesson(humanContent(), {
        lessonId: testLessonId(2),
        capturedAt: T4,
        actor: USER_ACTOR,
        scope: tenantAWideScope(),
      }),
    );
    expect(scoped.scope).toStrictEqual(tenantAWideScope());
    expect(scoped.capturedAt).toBe(T4);
  });
});
