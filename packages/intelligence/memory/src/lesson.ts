// Office intelligence — the lesson capture (OFF-015).
//
// captureLesson() builds ONE reusable lesson record: a human-authored or
// machine-derived statement of what a completed project taught, with typed
// links (entity refs + evidence refs), applicability tags, and provenance
// (who/what derived it and from which outcomes). Lessons are DATA — the
// store serves them and nothing in this package ever branches on lesson
// content: applying a lesson is explicit downstream code, never silent
// behavior baked into storage.
//
// The capture is a PURE function of its typed inputs: no clock, no
// randomness, no environment. The injected identity carries the lesson id
// and capture time (the runtime's deterministic suppliers).
import { isEntityId, isEntityRef } from '@office/contracts';
import type { Actor, Scope, Timestamp } from '@office/contracts';
import { isLedgerEventId } from '@office/events';
import { domainError, fail, invariantViolation, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LessonId, OutcomeId } from './vocabulary';
import {
  LESSON_SCHEMA_VERSION,
  MEMORY_ENGINE,
  compareLessonLinks,
  compareLessonTags,
} from './model';
import type { Lesson, LessonArea, LessonLink, LessonProvenance, LessonTag } from './model';

// ---------------------------------------------------------------------------
// The typed inputs of one lesson capture.
// ---------------------------------------------------------------------------

/** The bounded grammar of a lesson title. */
export const LESSON_TITLE_GRAMMAR = 'non-empty string of 1..200 characters';

/** The bounded grammar of a lesson statement. */
export const LESSON_STATEMENT_GRAMMAR = 'non-empty string of 1..2000 characters';

/** The typed content of one captured lesson. */
export interface LessonContent {
  /** The lesson's title (1..200 characters). */
  readonly title: string;
  /** The lesson's statement — what the project taught (1..2000 characters). */
  readonly statement: string;
  /** The applicability tags (at least one; duplicates typed-rejected). */
  readonly applicability: readonly LessonTag[];
  /** The typed links (canonical order; duplicate entities typed-rejected). */
  readonly links: readonly LessonLink[];
  /** The provenance: who authored/derived it, and from which outcomes. */
  readonly provenance: LessonProvenanceInput;
}

/** The provenance input of one captured lesson. */
export interface LessonProvenanceInput {
  /** 'human' (authored by a person) or 'derived' (machine-derived from outcomes). */
  readonly origin: 'human' | 'derived';
  /** The author/deriving actor (A4 source identity). */
  readonly author: Actor;
  /**
   * The outcomes a derived lesson was derived from (REQUIRED non-empty for
   * 'derived'; REQUIRED empty for 'human').
   */
  readonly derivedFromOutcomeIds: readonly OutcomeId[];
}

/** The injected identity/clock of one lesson capture (never wall time). */
export interface LessonIdentity {
  /** The caller-supplied deterministic lesson identity. */
  readonly lessonId: LessonId;
  /** When the lesson is captured (injected clock). */
  readonly capturedAt: Timestamp;
  /** The actor the lesson is captured by/for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the lesson is captured under (A12). */
  readonly scope: Scope;
}

// ---------------------------------------------------------------------------
// Fail-closed capture errors.
// ---------------------------------------------------------------------------

const lessonFieldFailure = (
  code: string,
  field: string,
  expected: string,
  received: unknown,
): DomainError =>
  domainError(
    'invariant-violation',
    `the lesson cannot be captured: field '${field}' is not ${expected}`,
    [
      {
        code,
        message: `expected ${expected} at '${field}', received ${JSON.stringify(received)}`,
        path: field,
      },
    ],
  );

const lessonInvariantFailure = (name: string, statement: string): DomainError =>
  invariantViolation({ name, statement });

// ---------------------------------------------------------------------------
// THE capture.
// ---------------------------------------------------------------------------

/**
 * Capture ONE reusable lesson — THE deterministic lesson-capture function.
 * Validates the typed content fail-closed (bounded title/statement, at
 * least one applicability tag, no duplicate tags, no duplicate link
 * entities, paired document/revision evidence, provenance consistency:
 * a derived lesson names its outcomes, a human lesson names none) and
 * returns the canonical, canonically-ordered Lesson record.
 */
export function captureLesson(
  content: LessonContent,
  identity: LessonIdentity,
): Result<Lesson, DomainError> {
  // ----- title + statement (bounded, non-empty) ---------------------------
  if (typeof content.title !== 'string' || content.title.length < 1 || content.title.length > 200) {
    return fail(
      lessonFieldFailure('lesson-title-bounded', 'title', LESSON_TITLE_GRAMMAR, content.title),
    );
  }
  if (
    typeof content.statement !== 'string' ||
    content.statement.length < 1 ||
    content.statement.length > 2000
  ) {
    return fail(
      lessonFieldFailure(
        'lesson-statement-bounded',
        'statement',
        LESSON_STATEMENT_GRAMMAR,
        content.statement,
      ),
    );
  }

  // ----- applicability tags (at least one, no duplicates) ------------------
  if (!Array.isArray(content.applicability) || content.applicability.length === 0) {
    return fail(
      lessonInvariantFailure(
        'lesson-applicability-nonempty',
        'a lesson carries at least one applicability tag (lessons are found BY their applicability)',
      ),
    );
  }
  const tagKeys = new Set<string>();
  for (const tag of content.applicability) {
    const key = `${tag.area}:${tag.value}`;
    if (tagKeys.has(key)) {
      return fail(
        lessonInvariantFailure(
          'lesson-tags-distinct',
          `the applicability tag ${key} appears more than once`,
        ),
      );
    }
    tagKeys.add(key);
  }

  // ----- typed links (valid entities, paired evidence, no duplicates) ------
  if (!Array.isArray(content.links)) {
    return fail(
      lessonFieldFailure('lesson-links-array', 'links', 'an array of typed links', content.links),
    );
  }
  const linkEntities = new Set<string>();
  for (const [index, link] of content.links.entries()) {
    if (!isEntityRef(link.entity)) {
      return fail(
        lessonFieldFailure(
          `lesson-link-entity-valid-${index}`,
          `links[${index}].entity`,
          'a canonical EntityRef',
          link.entity,
        ),
      );
    }
    const entityKey = `${link.entity.entityKind}:${link.entity.entityId}`;
    if (linkEntities.has(entityKey)) {
      return fail(
        lessonInvariantFailure(
          'lesson-link-entities-distinct',
          `the lesson links entity ${entityKey} more than once`,
        ),
      );
    }
    linkEntities.add(entityKey);
    if (link.documentId !== null && !isEntityId(link.documentId)) {
      return fail(
        lessonFieldFailure(
          `lesson-link-document-valid-${index}`,
          `links[${index}].documentId`,
          'a canonical EntityId or null',
          link.documentId,
        ),
      );
    }
    if (link.revisionId !== null && !isEntityId(link.revisionId)) {
      return fail(
        lessonFieldFailure(
          `lesson-link-revision-valid-${index}`,
          `links[${index}].revisionId`,
          'a canonical EntityId or null',
          link.revisionId,
        ),
      );
    }
    if (link.revisionId !== null && link.documentId === null) {
      return fail(
        lessonInvariantFailure(
          'lesson-link-evidence-paired',
          `link ${entityKey} carries a revision without its document: evidence links pair documentId + revisionId`,
        ),
      );
    }
    if (link.sourceEventId !== null && !isLedgerEventId(link.sourceEventId)) {
      return fail(
        lessonFieldFailure(
          `lesson-link-source-valid-${index}`,
          `links[${index}].sourceEventId`,
          'a canonical LedgerEventId or null',
          link.sourceEventId,
        ),
      );
    }
  }

  // ----- provenance consistency (derived lessons name their outcomes) ------
  if (content.provenance.origin === 'derived' && content.provenance.derivedFromOutcomeIds.length === 0) {
    return fail(
      lessonInvariantFailure(
        'lesson-derived-outcomes-nonempty',
        "a 'derived' lesson names the outcomes it was derived from (A4 provenance)",
      ),
    );
  }
  if (content.provenance.origin === 'human' && content.provenance.derivedFromOutcomeIds.length > 0) {
    return fail(
      lessonInvariantFailure(
        'lesson-human-outcomes-empty',
        "a 'human' lesson carries no derived-from outcomes (it was authored, not derived)",
      ),
    );
  }
  const derivedIds = new Set<string>();
  for (const outcomeId of content.provenance.derivedFromOutcomeIds) {
    if (derivedIds.has(outcomeId)) {
      return fail(
        lessonInvariantFailure(
          'lesson-derived-outcomes-distinct',
          `the derived-from outcome ${outcomeId} appears more than once`,
        ),
      );
    }
    derivedIds.add(outcomeId);
  }

  // ----- the canonical record ----------------------------------------------
  const provenance: LessonProvenance = {
    origin: content.provenance.origin,
    author: content.provenance.author,
    derivedFromOutcomeIds: [...content.provenance.derivedFromOutcomeIds].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    ),
    engine: MEMORY_ENGINE,
  };

  return ok({
    lessonId: identity.lessonId,
    lessonVersion: LESSON_SCHEMA_VERSION,
    engine: MEMORY_ENGINE,
    capturedAt: identity.capturedAt,
    actor: identity.actor,
    scope: identity.scope,
    title: content.title,
    statement: content.statement,
    applicability: [...content.applicability].sort(compareLessonTags),
    links: [...content.links].sort(compareLessonLinks),
    provenance,
  } satisfies Lesson);
}

/** Does one lesson carry an applicability tag of the given area? (pure data filter) */
export const lessonAppliesToArea = (lesson: Lesson, area: LessonArea): boolean =>
  lesson.applicability.some((tag) => tag.area === area);
