// Office intelligence — recovery authorization (OFF-033).
//
// Authorization is enforced BEFORE any candidate is scanned or served
// (recovery reads are permissioned), deny-by-default across the same three
// layers the landed intelligence peers use (the margin engine's assessment,
// the memory engine's queries, the exception engine's scans):
//
//   1. AREA READ CAPABILITIES: a recovery candidate spans the same three
//      bounded contexts the assessments it consumes span (the
//      contract/commercial position, the cost position, the schedule
//      position), so the requesting context must hold contracts.read AND
//      cost.read AND schedule.read before anything is read or detected. A
//      missing capability is a typed 'forbidden' naming exactly the missing
//      capabilities, returned WITHOUT scanning a single input (the
//      poisoned-input probe proves the gates run first).
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      every scanned input and every served candidate must live inside the
//      caller's tenant/project scope — no rule can ever override this. A
//      candidate outside the caller's scope is INVISIBLE: querying a
//      foreign candidate is a typed 'not-found' IDENTICAL to an absent one
//      (the recovery surface is never an existence oracle — cross-tenant
//      probes fail closed BOTH directions); cross-scope scan INPUTS are
//      typed-rejected instead (they are the caller's own wiring error).
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
import type { CandidateRecovery } from './candidates';
import { RECOVERY_REQUIRED_CAPABILITIES, RECOVERY_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import type { CandidateId, RecoveryKind } from './vocabulary';

// ---------------------------------------------------------------------------
// The authorization context of one recovery scan/read.
// ---------------------------------------------------------------------------

/** Who is scanning/reading recovery candidates: the caller's policy and request context. */
export interface RecoveryAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const recoveryContext = (authorization: RecoveryAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

// ---------------------------------------------------------------------------
// Layer 1 — the capability gate (BEFORE any scan input or served record).
// ---------------------------------------------------------------------------

const missingCapabilityDenial = (
  authorization: RecoveryAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `a recovery scan/read requires the area read capabilities ${RECOVERY_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-recovery-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    recoveryContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability a recovery scan/read spans? Checked BEFORE any
 * input is read. Deny-by-default: any missing capability is a typed
 * forbidden naming exactly the missing capabilities.
 */
export function checkRecoveryCapabilities(
  authorization: RecoveryAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = RECOVERY_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Layer 2 — structural scope coverage (freeze A12).
// ---------------------------------------------------------------------------

/** The authorization resource of one canonical entity (its scope + identity). */
export const recoveryResource = (parts: {
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
 * every served candidate (a foreign candidate is invisible: the denial is
 * translated to the typed not-found by the single-candidate query).
 */
export function checkRecoveryScopeCovers(
  authorization: RecoveryAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  return checkScopeCoversResource(
    authorization.context.scope,
    recoveryResource(parts),
  );
}

// ---------------------------------------------------------------------------
// Layer 3 — the policy gate (deny-by-default).
// ---------------------------------------------------------------------------

/**
 * Layer 3 — the policy gate: may this request READ the given resource?
 * Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkRecoveryPolicy(
  authorization: RecoveryAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    recoveryResource(parts),
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE queries (authorization BEFORE queries — the gates run first).
// ---------------------------------------------------------------------------

/** The resource a candidate is served under (its own project/scope). */
const candidateOwnResource = (candidate: CandidateRecovery): {
  readonly scope: Scope;
  readonly entityKind: EntityKind;
  readonly entityId: EntityId | null;
} => ({
  scope: candidate.scope,
  entityKind: PROJECT_KIND,
  entityId: candidate.scope.kind === 'project' ? candidate.scope.projectId : null,
});

/** The typed not-found for a candidate invisible to this request (no oracle). */
export const recoveryCandidateNotFound = (
  candidateId: string,
  authorization: RecoveryAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `no recovery candidate ${candidateId} is visible to this request`,
    [{ code: 'recovery-candidate-not-found', message: candidateId, path: null }],
    recoveryContext(authorization),
  );

/** One recovery query: optional kind filter (a pure tag filter — data, never behavior). */
export interface RecoveryQuery {
  /** Restrict the served set to one recovery kind (default: every kind). */
  readonly kind?: RecoveryKind;
}

const scopeVisible = (authorization: RecoveryAuthorization, candidate: CandidateRecovery): boolean =>
  checkRecoveryScopeCovers(authorization, candidateOwnResource(candidate)).ok;

const policyReadable = (authorization: RecoveryAuthorization, candidate: CandidateRecovery): boolean =>
  checkRecoveryPolicy(authorization, candidateOwnResource(candidate)).ok;

/**
 * Query THE recovery candidate set — the permissioned recovery read the
 * downstream consumers (OFF-037 integration, OFF-040 analytics) consume.
 * Authorization runs BEFORE the set is touched:
 *
 * 1. the capability gate (a denied request never reads a candidate —
 *    proven by the poisoned-set probe in the test suite);
 * 2. with a candidateId: the candidate is served only when it is
 *    scope-covered AND policy-readable — otherwise a typed not-found
 *    IDENTICAL to an absent one (no existence oracle, A12 both directions);
 * 3. without a candidateId: every scope-covered, policy-readable candidate
 *    in the given set, canonical candidate-id order (foreign candidates
 *    are invisible, never errors — the set query leaks nothing),
 *    optionally filtered by kind.
 */
export function queryRecoveryCandidates(
  candidates: readonly CandidateRecovery[],
  authorization: RecoveryAuthorization,
  query: RecoveryQuery = {},
): Result<readonly CandidateRecovery[], DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkRecoveryCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const kind = query.kind;

  if (kind === undefined) {
    return ok(
      candidates
        .filter((candidate) => scopeVisible(authorization, candidate))
        .filter((candidate) => policyReadable(authorization, candidate))
        .sort((left, right) =>
          left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0,
        ),
    );
  }

  return ok(
    candidates
      .filter((candidate) => candidate.kind === kind)
      .filter((candidate) => scopeVisible(authorization, candidate))
      .filter((candidate) => policyReadable(authorization, candidate))
      .sort((left, right) =>
        left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0,
      ),
  );
}

/** Query ONE recovery candidate by identity (invisible == absent, A12 both directions). */
export function queryRecoveryCandidateById(
  candidates: readonly CandidateRecovery[],
  authorization: RecoveryAuthorization,
  candidateId: CandidateId,
): Result<CandidateRecovery, DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkRecoveryCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const found = candidates.find((candidate) => candidate.candidateId === candidateId);
  if (
    found === undefined ||
    !scopeVisible(authorization, found) ||
    !policyReadable(authorization, found)
  ) {
    return fail(recoveryCandidateNotFound(candidateId, authorization));
  }
  return ok(found);
}
