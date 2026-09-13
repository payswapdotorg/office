// Office intelligence — procurement authorization (OFF-034).
//
// Authorization is enforced BEFORE any comparison is scanned or any
// recommendation is served (procurement reads are permissioned),
// deny-by-default across the same three layers the landed intelligence
// peers use (the margin engine's assessment, the memory engine's queries,
// the revenue engine's scans):
//
//   1. AREA READ CAPABILITIES: a procurement comparison spans the same
//      three bounded contexts the assessments it consumes span (the
//      contract/commercial position, the cost position, the schedule
//      position), so the requesting context must hold contracts.read AND
//      cost.read AND schedule.read before anything is read or detected. A
//      missing capability is a typed 'forbidden' naming exactly the missing
//      capabilities, returned WITHOUT scanning a single input (the
//      poisoned-input probe proves the gates run first).
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      every scanned input and every served recommendation must live inside
//      the caller's tenant/project scope — no rule can ever override this.
//      A recommendation outside the caller's scope is INVISIBLE: querying a
//      foreign recommendation is a typed 'not-found' IDENTICAL to an absent
//      one (the procurement surface is never an existence oracle —
//      cross-tenant probes fail closed BOTH directions); cross-scope scan
//      INPUTS are typed-rejected instead (they are the caller's own wiring
//      error).
//   3. POLICY RULES: the caller-supplied policy through authorize() over
//      the record's resource — explicit deny wins, first allow grants,
//      otherwise deny-by-default. Denied records are excluded from set
//      queries, never silently served.
import { authorize, checkScopeCoversResource, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind, Scope } from '@office/contracts';
import { PROJECT_KIND } from './model';
import { PROCUREMENT_REQUIRED_CAPABILITIES, PROCUREMENT_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import type { ProcurementKind } from './vocabulary';
import type { ProcurementRecommendation } from './recommendation';

// ---------------------------------------------------------------------------
// The authorization context of one procurement scan/read.
// ---------------------------------------------------------------------------

/** Who is scanning/reading procurement recommendations: the caller's policy and request context. */
export interface ProcurementAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const procurementContext = (authorization: ProcurementAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

// ---------------------------------------------------------------------------
// Layer 1 — the capability gate (BEFORE any scan input or served record).
// ---------------------------------------------------------------------------

const missingCapabilityDenial = (
  authorization: ProcurementAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `a procurement scan/read requires the area read capabilities ${PROCUREMENT_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-procurement-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    procurementContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability a procurement scan/read spans? Checked BEFORE any
 * input is read. Deny-by-default: any missing capability is a typed
 * forbidden naming exactly the missing capabilities.
 */
export function checkProcurementCapabilities(
  authorization: ProcurementAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = PROCUREMENT_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Layer 2 — structural scope coverage (freeze A12).
// ---------------------------------------------------------------------------

/** The authorization resource of one canonical entity (its scope + identity). */
export const procurementResource = (parts: {
  readonly scope: Scope;
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
 * inside the caller's execution scope? Applied to every scan INPUT (the
 * typed cross-scope rejection — cross-tenant inputs never compute) and to
 * every served recommendation (a foreign recommendation is invisible: the
 * denial is translated to the typed not-found by the single-recommendation
 * query).
 */
export function checkProcurementScopeCovers(
  authorization: ProcurementAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  return checkScopeCoversResource(
    authorization.context.scope,
    procurementResource(parts),
  );
}

// ---------------------------------------------------------------------------
// Layer 3 — the policy gate (deny-by-default).
// ---------------------------------------------------------------------------

/**
 * Layer 3 — the policy gate: may this request READ the given resource?
 * Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkProcurementPolicy(
  authorization: ProcurementAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    procurementResource(parts),
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE queries (authorization BEFORE queries — the gates run first).
// ---------------------------------------------------------------------------

/** The resource a recommendation is served under (its own project/scope). */
const recommendationOwnResource = (recommendation: ProcurementRecommendation): {
  readonly scope: Scope;
  readonly entityKind: EntityKind;
  readonly entityId: EntityId | null;
} => ({
  scope: recommendation.scope,
  entityKind: PROJECT_KIND,
  entityId: recommendation.scope.kind === 'project' ? recommendation.scope.projectId : null,
});

/** The typed not-found for a recommendation invisible to this request (no oracle). */
export const procurementRecommendationNotFound = (
  recommendationId: string,
  authorization: ProcurementAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `no procurement recommendation ${recommendationId} is visible to this request`,
    [{ code: 'procurement-recommendation-not-found', message: recommendationId, path: null }],
    procurementContext(authorization),
  );

/** One procurement query: optional kind filter (a pure tag filter — data, never behavior). */
export interface ProcurementQuery {
  /** Restrict the served set to one recommendation kind (default: every kind). */
  readonly kind?: ProcurementKind;
}

const scopeVisible = (
  authorization: ProcurementAuthorization,
  recommendation: ProcurementRecommendation,
): boolean =>
  checkProcurementScopeCovers(authorization, recommendationOwnResource(recommendation)).ok;

const policyReadable = (
  authorization: ProcurementAuthorization,
  recommendation: ProcurementRecommendation,
): boolean =>
  checkProcurementPolicy(authorization, recommendationOwnResource(recommendation)).ok;

/**
 * Query THE procurement recommendation set — the permissioned procurement
 * read the downstream consumers (OFF-037 integration, OFF-040 analytics)
 * consume. Authorization runs BEFORE the set is touched:
 *
 * 1. the capability gate (a denied request never reads a recommendation —
 *    proven by the poisoned-set probe in the test suite);
 * 2. every scope-covered, policy-readable recommendation in the given set,
 *    canonical recommendation-id order (foreign recommendations are
 *    invisible, never errors — the set query leaks nothing), optionally
 *    filtered by kind.
 */
export function queryProcurementRecommendations(
  recommendations: readonly ProcurementRecommendation[],
  authorization: ProcurementAuthorization,
  query: ProcurementQuery = {},
): Result<readonly ProcurementRecommendation[], DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkProcurementCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const kind = query.kind;

  const visible = (recommendation: ProcurementRecommendation): boolean =>
    (kind === undefined || recommendation.kind === kind) &&
    scopeVisible(authorization, recommendation) &&
    policyReadable(authorization, recommendation);

  return ok(
    recommendations
      .filter(visible)
      .sort((left, right) =>
        left.recommendationId < right.recommendationId
          ? -1
          : left.recommendationId > right.recommendationId
            ? 1
            : 0,
      ),
  );
}

/** Query ONE procurement recommendation by identity (invisible == absent, A12 both directions). */
export function queryProcurementRecommendationById(
  recommendations: readonly ProcurementRecommendation[],
  authorization: ProcurementAuthorization,
  recommendationId: string,
): Result<ProcurementRecommendation, DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkProcurementCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const found = recommendations.find(
    (recommendation) => recommendation.recommendationId === recommendationId,
  );
  if (
    found === undefined ||
    !scopeVisible(authorization, found) ||
    !policyReadable(authorization, found)
  ) {
    return fail(procurementRecommendationNotFound(recommendationId, authorization));
  }
  return ok(found);
}
