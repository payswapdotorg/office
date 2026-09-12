// Office authz — authorization context (OFF-006).
//
// AuthorizationContext: WHO is asking — the Actor (user, agent, app,
// adapter, or system) and the tenant/project Scope under which the request
// executes, plus the capability set granted FOR THIS REQUEST.
//
// Service-to-service callers (apps, agents, adapters) carry the SAME shape
// with their own actor kinds: an app installation carries its
// manifest-declared capabilities (A7), an agent run the capabilities granted
// to the run (A8), a user the expansion of their assigned roles (roles.ts).
// There is no service-to-service special case in the evaluator — only
// actor-kind matching in policy rules.
import { isActor, isScope, parseActor, parseFail, parseOk, parseScope } from '@office/contracts';
import type { Actor, ParseResult, Scope } from '@office/contracts';
import { parseCapabilityList } from './capability';
import type { Capability } from './capability';
import { describeValue, isPlainObject, requireFieldWith, unknownKeyFailure } from './parse';

/** Who is asking: actor, execution scope, and granted capabilities. */
export interface AuthorizationContext {
  /** The actor the request executes for (user/agent/app/adapter/system). */
  readonly actor: Actor;
  /** The tenant/project scope the request executes under (freeze A12). */
  readonly scope: Scope;
  /** Capabilities granted to the actor for this request (declared, no duplicates). */
  readonly capabilities: readonly Capability[];
}

/** Shape description used in parse failures. */
export const AUTHORIZATION_CONTEXT_GRAMMAR =
  'AuthorizationContext: { actor, scope, capabilities: Capability[] (declared, no duplicates) }';

const AUTHORIZATION_CONTEXT_KEYS = ['actor', 'scope', 'capabilities'] as const;

/**
 * Parse an untrusted value as an AuthorizationContext (total, fail-closed,
 * strict keys). Every actor kind is accepted — including service-to-service
 * actors — and every capability must be declared and unique.
 */
export function parseAuthorizationContext(raw: unknown): ParseResult<AuthorizationContext> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', AUTHORIZATION_CONTEXT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    AUTHORIZATION_CONTEXT_KEYS,
    '',
    AUTHORIZATION_CONTEXT_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const capabilities = parseCapabilityList(raw['capabilities'], 'capabilities');
  if (!capabilities.ok) return capabilities;
  return parseOk(
    {
      actor: actor.value,
      scope: scope.value,
      capabilities: capabilities.value,
    } satisfies AuthorizationContext,
  );
}

/** Type guard for structurally valid AuthorizationContext values. */
export function isAuthorizationContext(raw: unknown): raw is AuthorizationContext {
  return parseAuthorizationContext(raw).ok;
}

/**
 * Compose an AuthorizationContext from validated parts (trusted path; loud
 * TypeError). `capabilities` accepts plain declared names — validated here,
 * so a typo can never silently upgrade or downgrade a grant.
 */
export function authorizationContext(parts: {
  readonly actor: Actor;
  readonly scope: Scope;
  readonly capabilities: readonly string[];
}): AuthorizationContext {
  if (!isActor(parts.actor)) {
    throw new TypeError(`invalid actor: ${JSON.stringify(parts.actor)}`);
  }
  if (!isScope(parts.scope)) {
    throw new TypeError(`invalid scope: ${JSON.stringify(parts.scope)}`);
  }
  const capabilities = parseCapabilityList(parts.capabilities, 'capabilities');
  if (!capabilities.ok) {
    throw new TypeError(
      `invalid capabilities: ${capabilities.error.code} — ${capabilities.error.received}`,
    );
  }
  return { actor: parts.actor, scope: parts.scope, capabilities: capabilities.value };
}
