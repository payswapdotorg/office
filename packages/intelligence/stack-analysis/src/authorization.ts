// Office intelligence — stack analysis authorization (OFF-035).
//
// Authorization is enforced BEFORE any portfolio is scanned or any
// assessment is served (stack reads are permissioned), deny-by-default
// across the same three layers the landed intelligence peers use:
//
//   1. AREA READ CAPABILITIES: a stack analysis scan reads the scanned
//      tenant's marketplace/app surface (the releases, entitlements, and
//      installation links — apps.read) AND the intelligence memory facts
//      that form the observed-performance basis (the memory engine's own
//      read gate spans contracts.read + cost.read + schedule.read), so the
//      requesting context must hold all four before anything is read or
//      measured. A missing capability is a typed 'forbidden' naming exactly
//      the missing capabilities, returned WITHOUT reading a single input
//      (the poisoned-input probe proves the gate runs first).
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      every scanned input record and every served assessment must live
//      inside the caller's tenant/project scope — no rule can ever override
//      this. Cross-scope scan INPUTS are typed-rejected (they are the
//      caller's own wiring error — the rejection names the input's path,
//      never the foreign scope); a foreign assessment is INVISIBLE to
//      queries: a typed 'not-found' IDENTICAL to an absent one (no
//      existence oracle, both directions). Releases are CATALOG records
//      (publisher-tenant-scoped by design) resolved through the tenant's
//      own links, so the gate applies to the LINK — not the catalog record
//      it pins.
//   3. POLICY RULES: the caller-supplied policy through authorize() over
//      the record's resource — explicit deny wins, first allow grants,
//      otherwise deny-by-default. Policy-denied SUBJECT records (observed
//      systems, installation links) are EXCLUDED from the measured
//      portfolio — invisible, tallied, never errors; policy-denied
//      assessments are excluded from set queries, never silently served.
import { authorize, checkScopeCoversResource, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import type { EntityId, EntityKind, Scope, TenantId } from '@office/contracts';
import type { InstallationLink } from '@office/marketplace';
import type { ObservedExternalSystem } from './coverage';
import {
  APP_INSTALLATION_KIND,
  EXTERNAL_SYSTEM_KIND,
  STACK_REQUIRED_CAPABILITIES,
  STACK_REQUIRED_CAPABILITY_NAMES,
} from './vocabulary';
import type { AssessmentId, AssessmentKind } from './vocabulary';
import type { ReplacementAssessment } from './replacement';

// ---------------------------------------------------------------------------
// The authorization context of one stack analysis scan/read.
// ---------------------------------------------------------------------------

/** Who is scanning/reading stack assessments: the caller's policy and request context. */
export interface StackAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const stackContext = (authorization: StackAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

// ---------------------------------------------------------------------------
// Layer 1 — the capability gate (BEFORE any scan input or served record).
// ---------------------------------------------------------------------------

const missingCapabilityDenial = (
  authorization: StackAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `a stack analysis scan/read requires the area read capabilities ${STACK_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-stack-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    stackContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability a stack analysis scan/read spans? Checked BEFORE any
 * input is read. Deny-by-default: any missing capability is a typed
 * forbidden naming exactly the missing capabilities.
 */
export function checkStackCapabilities(
  authorization: StackAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = STACK_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Layer 2 — structural scope coverage (freeze A12).
// ---------------------------------------------------------------------------

/** The authorization resource of one record (its scope + identity). */
export const stackResource = (parts: {
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

/** The tenant-scope resource of one tenant-owned input record. */
const tenantRecordResource = (tenantId: TenantId, entityKind: EntityKind): ResourceScope =>
  stackResource({
    scope: { kind: 'tenant', tenantId },
    entityKind,
    entityId: null,
  });

/** The authorization resource of one observed external system. */
export const observedSystemResource = (system: ObservedExternalSystem): ResourceScope =>
  tenantRecordResource(system.tenantId, EXTERNAL_SYSTEM_KIND);

/** The authorization resource of one installation link (the installed app). */
export const installationLinkResource = (link: InstallationLink): ResourceScope =>
  stackResource({
    scope: { kind: 'tenant', tenantId: link.tenantId },
    entityKind: APP_INSTALLATION_KIND,
    entityId: link.installationId,
  });

/**
 * Layer 2 — structural scope coverage (freeze A12): is the given resource
 * inside the caller's execution scope? Applied to every scan INPUT (the
 * typed cross-scope rejection — cross-tenant inputs never compute) and to
 * every served assessment (a foreign assessment is invisible: the denial is
 * translated to the typed not-found by the single-assessment query).
 */
export function checkStackScopeCovers(
  authorization: StackAuthorization,
  resource: ResourceScope,
): Result<true, DomainError> {
  return checkScopeCoversResource(authorization.context.scope, resource);
}

/** The typed cross-scope scan-input rejection (names the path, never the foreign scope). */
export const stackInputScopeFailure = (path: string): DomainError =>
  domainError(
    'unauthorized',
    `a stack analysis scan input at '${path}' lives outside the requesting execution scope (supply only the caller's own tenant records)`,
    [
      {
        code: 'stack-input-scope',
        message: `input record outside the requesting execution scope at '${path}'`,
        path,
      },
    ],
  );

// ---------------------------------------------------------------------------
// Layer 3 — the policy gate (deny-by-default).
// ---------------------------------------------------------------------------

/**
 * Layer 3 — the policy gate: may this request READ the given resource?
 * Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkStackPolicy(
  authorization: StackAuthorization,
  resource: ResourceScope,
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    resource,
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE queries (authorization BEFORE queries — the gates run first).
// ---------------------------------------------------------------------------

/** The resource an assessment is served under (its own subject's resource). */
const assessmentOwnResource = (assessment: ReplacementAssessment): ResourceScope => {
  if (assessment.coverage.kind === 'external-system-coverage') {
    return tenantRecordResource(assessment.coverage.tenantId, EXTERNAL_SYSTEM_KIND);
  }
  return stackResource({
    scope: { kind: 'tenant', tenantId: assessment.coverage.tenantId },
    entityKind: APP_INSTALLATION_KIND,
    entityId: assessment.coverage.installationId,
  });
};

/** The typed not-found for an assessment invisible to this request (no oracle). */
export const stackAssessmentNotFound = (
  assessmentId: string,
  authorization: StackAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `no stack replacement assessment ${assessmentId} is visible to this request`,
    [{ code: 'stack-assessment-not-found', message: assessmentId, path: null }],
    stackContext(authorization),
  );

/** One stack query: optional kind filter (a pure tag filter — data, never behavior). */
export interface StackQuery {
  /** Restrict the served set to one assessment kind (default: every kind). */
  readonly kind?: AssessmentKind;
}

const scopeVisible = (
  authorization: StackAuthorization,
  assessment: ReplacementAssessment,
): boolean =>
  checkStackScopeCovers(authorization, assessmentOwnResource(assessment)).ok;

const policyReadable = (
  authorization: StackAuthorization,
  assessment: ReplacementAssessment,
): boolean => checkStackPolicy(authorization, assessmentOwnResource(assessment)).ok;

const byAssessmentId = (
  left: ReplacementAssessment,
  right: ReplacementAssessment,
): number =>
  left.assessmentId < right.assessmentId
    ? -1
    : left.assessmentId > right.assessmentId
      ? 1
      : 0;

/**
 * Query THE stack assessment set — the permissioned stack read the
 * downstream consumers (OFF-038 release gates, OFF-040 analytics) consume.
 * Authorization runs BEFORE the set is touched:
 *
 * 1. the capability gate (a denied request never reads an assessment —
 *    proven by the poisoned-set probe in the test suite);
 * 2. without a kind: every scope-covered, policy-readable assessment in
 *    canonical assessment-id order (foreign assessments are invisible,
 *    never errors — the set query leaks nothing);
 * 3. with a kind: the same, restricted to that measurement direction.
 */
export function queryReplacementAssessments(
  assessments: readonly ReplacementAssessment[],
  authorization: StackAuthorization,
  query: StackQuery = {},
): Result<readonly ReplacementAssessment[], DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkStackCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const kind = query.kind;
  const visible = assessments
    .filter((assessment) => scopeVisible(authorization, assessment))
    .filter((assessment) => policyReadable(authorization, assessment))
    .filter((assessment) => kind === undefined || assessment.kind === kind)
    .sort(byAssessmentId);

  return ok(visible);
}

/** Query ONE stack assessment by identity (invisible == absent, A12 both directions). */
export function queryReplacementAssessmentById(
  assessments: readonly ReplacementAssessment[],
  authorization: StackAuthorization,
  assessmentId: AssessmentId,
): Result<ReplacementAssessment, DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkStackCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const found = assessments.find((assessment) => assessment.assessmentId === assessmentId);
  if (
    found === undefined ||
    !scopeVisible(authorization, found) ||
    !policyReadable(authorization, found)
  ) {
    return fail(stackAssessmentNotFound(assessmentId, authorization));
  }
  return ok(found);
}
