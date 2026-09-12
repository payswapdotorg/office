// Office intelligence — traversal-time authorization (OFF-013).
//
// Authorization is enforced AT TRAVERSAL TIME, never baked into the stored
// index: the projection is scope-blind (it derives what the envelopes
// assert), and every node/edge a query would reveal passes through this
// module's deny-by-default check against the caller's policy + context.
// Three layers, in order (mirroring @office/authz's own evaluator order):
//
//   1. STRUCTURAL scope coverage (freeze A12, checkScopeCoversResource):
//      a node outside the caller's tenant/project scope is a typed
//      'unauthorized' denial — no rule can ever override it. At traversal
//      time this makes cross-tenant/cross-project nodes INVISIBLE (filtered
//      from the subgraph; the start node denial is translated to a typed
//      not-found so the graph is never an existence oracle, in either
//      direction).
//   2. AREA READ CAPABILITY: the context must hold the read capability of
//      the node kind's bounded-context area (cost.read for budget nodes,
//      schedule.read for activity nodes, ...). Kinds outside the engine's
//      vocabulary have NO determinable area — no capability can ever grant
//      them, so they are denied by default (fail-closed).
//   3. POLICY RULES: the caller-supplied policy through authorize() —
//      explicit deny wins, first allow grants, otherwise deny-by-default.
//
// Any layer's denial filters the node from a traversal subgraph (scope-
// filtered subgraph); for the START node the denial surfaces as a typed
// error instead (not-found for layer 1 — no existence oracle; the typed
// forbidden error for layers 2–3).
import { checkScopeCoversResource, authorize, resourceScope } from '@office/authz';
import type { AuthorizationContext, Policy, ResourceScope } from '@office/authz';
import type { DomainError, Result } from '@office/domain-kernel';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import type { EntityNode } from './model';
import { readCapabilityOfKind } from './vocabulary';

/** Who is traversing: the caller's policy and request authorization context. */
export interface TraversalAuthorization {
  /** The caller's static, data-driven policy (deny-by-default evaluator). */
  readonly policy: Policy;
  /** The actor, execution scope, and granted capabilities of this request. */
  readonly context: AuthorizationContext;
}

/** The authorization resource of one entity node (its scope + identity). */
export const nodeResource = (node: EntityNode): ResourceScope =>
  resourceScope({
    scope: node.scope,
    resourceKind: node.entity.entityKind,
    resourceId: node.entity.entityId,
    ownerId: null,
  });

const missingCapabilityDenial = (
  node: EntityNode,
  reason: 'unknown-entity-kind' | 'missing-read-capability',
  required: string,
): DomainError =>
  domainError(
    'forbidden',
    `a relationship traversal cannot reveal ${node.entity.entityKind} ${node.entity.entityId}: ${reason}`,
    [
      {
        code: reason,
        message: `reading ${node.entity.entityKind} requires capability '${required}'`,
        path: null,
      },
    ],
    { scope: node.scope },
  );

/**
 * May this traversal request READ one entity node? Deny-by-default across
 * the three layers above; cross-scope nodes fail with typed 'unauthorized'
 * (layer 1), everything else with typed 'forbidden'.
 */
export function checkNodeReadable(
  authorization: TraversalAuthorization,
  node: EntityNode,
): Result<true, DomainError> {
  const resource = nodeResource(node);
  // 1. Structural isolation first (freeze A12) — before any capability or rule.
  const coverage = checkScopeCoversResource(authorization.context.scope, resource);
  if (!coverage.ok) return coverage;

  // 2. Area read capability — deny-by-default, including unknown kinds.
  const required = readCapabilityOfKind(node.entity.entityKind);
  if (required === null) {
    return fail(missingCapabilityDenial(node, 'unknown-entity-kind', '<none: kind outside the engine vocabulary>'));
  }
  if (!authorization.context.capabilities.includes(required)) {
    return fail(missingCapabilityDenial(node, 'missing-read-capability', required));
  }

  // 3. Policy rules — explicit deny wins; first allow grants; default deny.
  const decision = authorize(authorization.policy, authorization.context, resource, 'read');
  if (!decision.ok) return fail(decision.error);
  return ok(true);
}

/**
 * May this traversal request SEE one ledger event (a causal-chain link)?
 * The event is readable exactly when its aggregate entity is: scope
 * coverage of the event's own scope plus the aggregate kind's area
 * capability plus the policy rules over the aggregate as resource.
 */
export function checkEventReadable(
  authorization: TraversalAuthorization,
  event: LedgerEvent,
): Result<true, DomainError> {
  return checkNodeReadable(authorization, {
    entity: event.aggregate,
    scope: event.envelope.scope,
  });
}
