// Office intelligence — assessment authorization (OFF-014).
//
// Authorization is enforced BEFORE calculation (the named acceptance: a
// denied request never computes a single number), deny-by-default across
// the same three layers the relationship engine's traversal uses:
//
//   1. AREA READ CAPABILITIES: an impact assessment spans three bounded
//      contexts at once — the contract/commercial position, the cost
//      position, and the schedule position — so the requesting context
//      must hold contracts.read AND cost.read AND schedule.read before
//      anything is read or computed. A missing capability is a typed
//      'forbidden' naming exactly the missing capabilities.
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      the source change event and every input fact/subgraph edge must
//      live inside the caller's tenant/project scope — no rule can ever
//      override this. A source event outside the caller's scope is a typed
//      'not-found' IDENTICAL to an absent one (the assessment surface is
//      never an existence oracle); mixed-scope INPUTS are typed-rejected
//      instead (they are the caller's own wiring error, not a probe, and
//      cross-scope inputs never compute).
//   3. POLICY RULES: the caller-supplied policy through authorize() over
//      the source change event as the resource — explicit deny wins, first
//      allow grants, otherwise deny-by-default.
import { authorize, checkScopeCoversResource, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind, Scope } from '@office/contracts';
import { ASSESSMENT_REQUIRED_CAPABILITIES, ASSESSMENT_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import { CHANGE_EVENT_KIND } from './model';

/** Who is assessing: the caller's policy and request authorization context. */
export interface AssessmentAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const assessmentContext = (authorization: AssessmentAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

const missingCapabilityDenial = (
  authorization: AssessmentAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `an impact assessment requires the area read capabilities ${ASSESSMENT_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-assessment-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    assessmentContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability an assessment spans? Checked BEFORE any input is
 * read or computed. Deny-by-default: any missing capability is a typed
 * forbidden naming exactly the missing capabilities.
 */
export function checkAssessmentCapabilities(
  authorization: AssessmentAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = ASSESSMENT_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

/** The authorization resource of one canonical entity (its scope + identity). */
export const assessmentResource = (parts: {
  readonly scope: Scope;
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
}): ResourceScope =>
  resourceScope({
    scope: parts.scope,
    resourceKind: parts.entityKind,
    resourceId: parts.entityId,
    ownerId: null,
  });

/**
 * Layer 2 — structural scope coverage (freeze A12): is the given scope
 * inside the caller's execution scope? Applied to the SOURCE change event
 * (the denial is translated to the typed not-found by the caller so a
 * foreign change event is indistinguishable from a nonexistent one) and to
 * every INPUT fact (typed-rejected: cross-tenant inputs never compute).
 */
export function checkAssessmentScopeCovers(
  authorization: AssessmentAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId;
  },
): Result<true, DomainError> {
  return checkScopeCoversResource(
    authorization.context.scope,
    assessmentResource(parts),
  );
}

/** The typed rejection for cross-scope assessment inputs (A12, no oracle). */
export const crossScopeInputRejection = (
  authorization: AssessmentAuthorization,
): DomainError =>
  domainError(
    'unauthorized',
    'impact assessment inputs carry events outside the caller\u2019s scope: cross-scope inputs are typed-rejected before any calculation',
    [
      {
        code: 'assessment-input-scope',
        message: 'cross-scope input events are typed-rejected (freeze A12)',
        path: null,
      },
    ],
    assessmentContext(authorization),
  );

/**
 * Layer 3 — the policy gate: may this request READ the assessed change
 * event? Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkAssessmentPolicy(
  authorization: AssessmentAuthorization,
  parts: {
    readonly scope: Scope;
    readonly changeEventId: EntityId;
  },
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    assessmentResource({
      scope: parts.scope,
      entityKind: CHANGE_EVENT_KIND,
      entityId: parts.changeEventId,
    }),
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

/** The typed not-found for a source event absent from the caller's scope. */
export const sourceEventNotFound = (
  sourceEventId: string,
  authorization: AssessmentAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `source ledger event ${sourceEventId} not found`,
    [{ code: 'source-event-not-found', message: sourceEventId, path: null }],
    assessmentContext(authorization),
  );
