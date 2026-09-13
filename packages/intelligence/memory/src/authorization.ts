// Office intelligence — memory authorization (OFF-015).
//
// Authorization is enforced BEFORE any memory record is queried (memory
// reads are permissioned), deny-by-default across the same three layers
// the relationship engine's traversal and the margin engine's assessment
// use:
//
//   1. AREA READ CAPABILITIES: a memory outcome/benchmark spans the same
//      three bounded contexts the assessments it derives from span (the
//      contract/commercial position, the cost position, the schedule
//      position) — the requesting context must hold contracts.read AND
//      cost.read AND schedule.read before anything is served. A missing
//      capability is a typed 'forbidden' naming exactly the missing ones,
//      returned WITHOUT touching the store (the poisoned-store probe
//      proves the gates run first).
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      every served record must live inside the caller's tenant/project
//      scope — no rule can ever override this. An outcome outside the
//      caller's scope is INVISIBLE: querying a foreign project is a typed
//      'not-found' IDENTICAL to an absent one (the memory surface is never
//      an existence oracle — cross-tenant probes fail closed both ways).
//   3. POLICY RULES: the caller-supplied policy through authorize() over
//      the record's resource — explicit deny wins, first allow grants,
//      otherwise deny-by-default. Denied records are excluded from set
//      queries (the traversal precedent: scope-filtered subgraphs exclude
//      unreadable nodes), never silently served.
import { authorize, checkScopeCoversResource, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind } from '@office/contracts';
import { MEMORY_REQUIRED_CAPABILITIES, MEMORY_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import { PROJECT_KIND } from './model';
import type { Lesson, LessonArea, LessonQuery, OutcomeQuery, OutcomeRecord } from './model';
import type { MemoryStore } from './store';
import { lessonAppliesToArea } from './lesson';

// ---------------------------------------------------------------------------
// The authorization context of one memory read.
// ---------------------------------------------------------------------------

/** Who is reading memory: the caller's policy and request authorization context. */
export interface MemoryAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const memoryContext = (authorization: MemoryAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

// ---------------------------------------------------------------------------
// Layer 1 — the capability gate (BEFORE any store access).
// ---------------------------------------------------------------------------

const missingCapabilityDenial = (
  authorization: MemoryAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `a memory read requires the area read capabilities ${MEMORY_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-memory-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    memoryContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability a memory read spans? Checked BEFORE the store is
 * touched. Deny-by-default: any missing capability is a typed forbidden
 * naming exactly the missing capabilities.
 */
export function checkMemoryCapabilities(
  authorization: MemoryAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = MEMORY_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Layer 2 — structural scope coverage (freeze A12).
// ---------------------------------------------------------------------------

/** The authorization resource of one canonical entity (its scope + identity). */
export const memoryResource = (parts: {
  readonly scope: Parameters<typeof resourceScope>[0]['scope'];
  readonly entityKind: EntityKind;
  readonly entityId: EntityId | null;
}): ResourceScope =>
  resourceScope({
    scope: parts.scope,
    resourceKind: parts.entityKind,
    resourceId: parts.entityId,
    ownerId: null,
  });

/**
 * Layer 2 — structural scope coverage (freeze A12): is the given scope
 * inside the caller's execution scope? Applied to every record the query
 * would serve; a record outside the caller's scope is invisible (the
 * denial is translated to the typed not-found by the single-project query
 * so a foreign project is indistinguishable from a nonexistent one).
 */
export function checkMemoryScopeCovers(
  authorization: MemoryAuthorization,
  parts: {
    readonly scope: Parameters<typeof resourceScope>[0]['scope'];
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  return checkScopeCoversResource(
    authorization.context.scope,
    memoryResource(parts),
  );
}

/** The typed not-found for a project with no visible outcome (no oracle). */
export const memoryOutcomeNotFound = (
  projectId: EntityId,
  authorization: MemoryAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `no recorded outcome for project ${projectId} is visible to this request`,
    [{ code: 'memory-outcome-not-found', message: projectId, path: null }],
    memoryContext(authorization),
  );

// ---------------------------------------------------------------------------
// Layer 3 — the policy gate (deny-by-default).
// ---------------------------------------------------------------------------

/**
 * Layer 3 — the policy gate: may this request READ the given record's
 * resource? Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkMemoryPolicy(
  authorization: MemoryAuthorization,
  parts: {
    readonly scope: Parameters<typeof resourceScope>[0]['scope'];
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    memoryResource(parts),
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE queries (authorization BEFORE queries — the gates run first).
// ---------------------------------------------------------------------------

const scopeVisible = (
  authorization: MemoryAuthorization,
  outcome: OutcomeRecord,
): boolean =>
  checkMemoryScopeCovers(authorization, {
    scope: outcome.scope,
    entityKind: PROJECT_KIND,
    entityId: outcome.projectId,
  }).ok;

const policyReadable = (
  authorization: MemoryAuthorization,
  outcome: OutcomeRecord,
): boolean =>
  checkMemoryPolicy(authorization, {
    scope: outcome.scope,
    entityKind: PROJECT_KIND,
    entityId: outcome.projectId,
  }).ok;

/**
 * Query THE outcome set — the permissioned memory read the benchmark
 * computation and the similarity ranking consume. Authorization runs
 * BEFORE any store access:
 *
 * 1. the capability gate (a denied request never reads a record — proven
 *    by the poisoned-store probe in the test suite);
 * 2. with a projectId: the project's outcome is served only when it is
 *    scope-covered AND policy-readable — otherwise a typed not-found
 *    IDENTICAL to an absent project (no existence oracle, A12);
 * 3. without a projectId: every scope-covered, policy-readable outcome in
 *    the store, canonical outcome-id order (foreign-scope records are
 *    invisible, never errors — the set query leaks nothing).
 */
export function queryOutcomes(
  store: MemoryStore,
  authorization: MemoryAuthorization,
  query: OutcomeQuery = {},
): Result<readonly OutcomeRecord[], DomainError> {
  // 1. Capability gate — before ANY store access.
  const capabilities = checkMemoryCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  if (query.projectId !== undefined) {
    // 2. The single-project query: invisible == absent (no oracle).
    const outcome = store.outcomeOfProject(query.projectId);
    if (outcome === null || !scopeVisible(authorization, outcome)) {
      return fail(memoryOutcomeNotFound(query.projectId, authorization));
    }
    if (!policyReadable(authorization, outcome)) {
      return fail(memoryOutcomeNotFound(query.projectId, authorization));
    }
    return ok([outcome]);
  }

  // 3. The covered-set query: exactly what the caller may see.
  return ok(store.outcomes.filter((outcome) => scopeVisible(authorization, outcome) && policyReadable(authorization, outcome)));
}

/**
 * Query THE lesson set — the permissioned lesson read (same three layers,
 * same invisible-not-absent discipline). Lessons are DATA: the area filter
 * is a pure tag filter, never behavior.
 */
export function queryLessons(
  store: MemoryStore,
  authorization: MemoryAuthorization,
  query: LessonQuery = {},
): Result<readonly Lesson[], DomainError> {
  // 1. Capability gate — before ANY store access.
  const capabilities = checkMemoryCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const lessonResource = (lesson: Lesson): {
    readonly scope: Parameters<typeof resourceScope>[0]['scope'];
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  } => ({
    scope: lesson.scope,
    entityKind: PROJECT_KIND,
    entityId: lesson.scope.kind === 'project' ? lesson.scope.projectId : null,
  });

  const areas: readonly LessonArea[] | undefined = query.areas;
  const covered = store.lessons.filter(
    (lesson) =>
      checkMemoryScopeCovers(authorization, lessonResource(lesson)).ok &&
      checkMemoryPolicy(authorization, lessonResource(lesson)).ok,
  );
  const filtered =
    areas === undefined
      ? covered
      : covered.filter((lesson) => areas.some((area) => lessonAppliesToArea(lesson, area)));
  return ok(filtered);
}
