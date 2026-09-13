// Office intelligence — exception authorization (OFF-019).
//
// Authorization is enforced BEFORE any exception is scanned or served
// (exception reads are permissioned), deny-by-default across the same three
// layers the landed intelligence peers use (the relationship engine's
// traversal, the margin engine's assessment, the memory engine's queries):
//
//   1. AREA READ CAPABILITIES: an exception spans the same three bounded
//      contexts the assessments it consumes span (the contract/commercial
//      position, the cost position, the schedule position), so the
//      requesting context must hold contracts.read AND cost.read AND
//      schedule.read before anything is read or detected. A missing
//      capability is a typed 'forbidden' naming exactly the missing
//      capabilities, returned WITHOUT scanning a single input (the
//      poisoned-set probe proves the gates run first).
//   2. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      every scanned input and every served exception must live inside the
//      caller's tenant/project scope — no rule can ever override this. An
//      exception outside the caller's scope is INVISIBLE: querying a
//      foreign exception is a typed 'not-found' IDENTICAL to an absent one
//      (the exception surface is never an existence oracle — cross-tenant
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
import { EXCEPTION_REQUIRED_CAPABILITIES, EXCEPTION_REQUIRED_CAPABILITY_NAMES } from './vocabulary';
import type { ExceptionId, ExceptionKind } from './vocabulary';
import { PROJECT_KIND } from './model';
import type { Exception } from './model';

// ---------------------------------------------------------------------------
// The authorization context of one exception scan/read.
// ---------------------------------------------------------------------------

/** Who is scanning/reading exceptions: the caller's policy and request context. */
export interface ExceptionAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

const exceptionContext = (authorization: ExceptionAuthorization): DomainErrorContext => ({
  scope: authorization.context.scope,
});

// ---------------------------------------------------------------------------
// Layer 1 — the capability gate (BEFORE any scan input or served record).
// ---------------------------------------------------------------------------

const missingCapabilityDenial = (
  authorization: ExceptionAuthorization,
  missing: readonly string[],
): DomainError =>
  domainError(
    'forbidden',
    `an exception scan/read requires the area read capabilities ${EXCEPTION_REQUIRED_CAPABILITY_NAMES.join(', ')}: this context is missing ${missing.join(', ')}`,
    [
      {
        code: 'missing-exception-capability',
        message: `missing capabilities: ${missing.join(', ')}`,
        path: 'capabilities',
      },
    ],
    exceptionContext(authorization),
  );

/**
 * Layer 1 — the capability gate: does the requesting context hold every
 * area read capability an exception scan/read spans? Checked BEFORE any
 * input is read. Deny-by-default: any missing capability is a typed
 * forbidden naming exactly the missing capabilities.
 */
export function checkExceptionCapabilities(
  authorization: ExceptionAuthorization,
): Result<true, DomainError> {
  const held = new Set<string>(authorization.context.capabilities);
  const missing = EXCEPTION_REQUIRED_CAPABILITIES.filter((required) => !held.has(required));
  if (missing.length > 0) {
    return fail(missingCapabilityDenial(authorization, missing));
  }
  return ok(true);
}

// ---------------------------------------------------------------------------
// Layer 2 — structural scope coverage (freeze A12).
// ---------------------------------------------------------------------------

/** The authorization resource of one canonical entity (its scope + identity). */
export const exceptionResource = (parts: {
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
 * every served exception (a foreign exception is invisible: the denial is
 * translated to the typed not-found by the single-exception query).
 */
export function checkExceptionScopeCovers(
  authorization: ExceptionAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  return checkScopeCoversResource(
    authorization.context.scope,
    exceptionResource(parts),
  );
}

// ---------------------------------------------------------------------------
// Layer 3 — the policy gate (deny-by-default).
// ---------------------------------------------------------------------------

/**
 * Layer 3 — the policy gate: may this request READ the given resource?
 * Explicit deny wins; first allow grants; otherwise deny.
 */
export function checkExceptionPolicy(
  authorization: ExceptionAuthorization,
  parts: {
    readonly scope: Scope;
    readonly entityKind: EntityKind;
    readonly entityId: EntityId | null;
  },
): Result<true, DomainError> {
  const decision = authorize(
    authorization.policy,
    authorization.context,
    exceptionResource(parts),
    'read',
  );
  if (!decision.ok) return decision;
  return ok(true);
}

// ---------------------------------------------------------------------------
// THE queries (authorization BEFORE queries — the gates run first).
// ---------------------------------------------------------------------------

/** The resource an exception is served under (its own project/scope). */
const exceptionOwnResource = (exception: Exception): {
  readonly scope: Scope;
  readonly entityKind: EntityKind;
  readonly entityId: EntityId | null;
} => ({
  scope: exception.scope,
  entityKind: PROJECT_KIND,
  entityId: exception.scope.kind === 'project' ? exception.scope.projectId : null,
});

/** The typed not-found for an exception invisible to this request (no oracle). */
export const exceptionNotFound = (
  exceptionId: string,
  authorization: ExceptionAuthorization,
): DomainError =>
  domainError(
    'not-found',
    `no exception ${exceptionId} is visible to this request`,
    [{ code: 'exception-not-found', message: exceptionId, path: null }],
    exceptionContext(authorization),
  );

/** One exception query: optional kind filter (a pure tag filter — data, never behavior). */
export interface ExceptionQuery {
  /** Restrict the served set to one exception kind (default: every kind). */
  readonly kind?: ExceptionKind;
}

const scopeVisible = (authorization: ExceptionAuthorization, exception: Exception): boolean =>
  checkExceptionScopeCovers(authorization, exceptionOwnResource(exception)).ok;

const policyReadable = (authorization: ExceptionAuthorization, exception: Exception): boolean =>
  checkExceptionPolicy(authorization, exceptionOwnResource(exception)).ok;

/**
 * Query THE exception set — the permissioned control-tower read the
 * downstream consumers (OFF-030 views, OFF-033 agent runtime, OFF-035
 * chips) consume. Authorization runs BEFORE the set is touched:
 *
 * 1. the capability gate (a denied request never reads an exception —
 *    proven by the poisoned-set probe in the test suite);
 * 2. with an exceptionId: the exception is served only when it is
 *    scope-covered AND policy-readable — otherwise a typed not-found
 *    IDENTICAL to an absent one (no existence oracle, A12 both directions);
 * 3. without an exceptionId: every scope-covered, policy-readable
 *    exception in the given set, canonical exception-id order (foreign
 *    exceptions are invisible, never errors — the set query leaks
 *    nothing), optionally filtered by kind.
 */
export function queryExceptions(
  exceptions: readonly Exception[],
  authorization: ExceptionAuthorization,
  query: ExceptionQuery = {},
): Result<readonly Exception[], DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkExceptionCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const kind = query.kind;

  if (kind === undefined) {
    return ok(
      exceptions
        .filter((exception) => scopeVisible(authorization, exception))
        .filter((exception) => policyReadable(authorization, exception))
        .sort((left, right) =>
          left.exceptionId < right.exceptionId ? -1 : left.exceptionId > right.exceptionId ? 1 : 0,
        ),
    );
  }

  return ok(
    exceptions
      .filter((exception) => exception.kind === kind)
      .filter((exception) => scopeVisible(authorization, exception))
      .filter((exception) => policyReadable(authorization, exception))
      .sort((left, right) =>
        left.exceptionId < right.exceptionId ? -1 : left.exceptionId > right.exceptionId ? 1 : 0,
      ),
  );
}

/** Query ONE exception by identity (invisible == absent, A12 both directions). */
export function queryExceptionById(
  exceptions: readonly Exception[],
  authorization: ExceptionAuthorization,
  exceptionId: ExceptionId,
): Result<Exception, DomainError> {
  // 1. Capability gate — before ANY record is touched.
  const capabilities = checkExceptionCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  const found = exceptions.find((exception) => exception.exceptionId === exceptionId);
  if (
    found === undefined ||
    !scopeVisible(authorization, found) ||
    !policyReadable(authorization, found)
  ) {
    return fail(exceptionNotFound(exceptionId, authorization));
  }
  return ok(found);
}
