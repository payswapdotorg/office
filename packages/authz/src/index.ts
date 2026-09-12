// Office authz — public surface (OFF-006).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-007+ domains, OFF-016 workflows, OFF-017 action gateway, OFF-026 app
// runtime) consume the package only through its root entry point, never
// through deeper paths. Anything not re-exported here is package-internal
// and may change without notice.
//
// The package imports exactly two dependencies — @office/contracts and
// @office/domain-kernel — and nothing else (dependency rule: domain modules
// depend only inward on shared kernel contracts). No persistence, no event
// ledger, no outbox, no provider vocabulary: those belong to other packages.
//
// Surface summary:
// - capability:  Capability (+ CapabilityName), Action, CAPABILITIES,
//                capability(), capabilityAction(), parse/isCapability
// - roles:       Role, RoleDefinition, ROLE_DEFINITIONS, defineRole(),
//                parse/isRole, roleCapabilities(), expandRoles()
// - scope:       ResourceScope, resourceScope(), parse/isResourceScope,
//                checkScopeCoversResource() (structural A12 isolation)
// - context:     AuthorizationContext, authorizationContext(),
//                parse/isAuthorizationContext
// - policy:      Policy, PolicyRule, PolicyEffect, AuthorizationDecision,
//                definePolicy()/definePolicyRule(), parse/isPolicy(Rule),
//                authorize() (deny-by-default evaluator)

// Declared capability vocabulary with the structural read/write action split.
export {
  CAPABILITIES,
  capability,
  capabilityAction,
  isCapability,
  parseCapability,
} from './capability';
export type { Action, Capability, CapabilityName } from './capability';

// Role/capability primitives (fail-closed role parsing, deterministic expansion).
export {
  ROLE_DEFINITIONS,
  defineRole,
  expandRoles,
  isRole,
  parseRole,
  roleCapabilities,
} from './roles';
export type { Role, RoleDefinition } from './roles';

// Resource scope + structural tenant/project isolation (freeze A12).
export {
  checkScopeCoversResource,
  isResourceScope,
  parseResourceScope,
  resourceScope,
} from './scope';
export type { ResourceScope } from './scope';

// Authorization context — who is asking (any actor kind, same shape).
export {
  authorizationContext,
  isAuthorizationContext,
  parseAuthorizationContext,
} from './context';
export type { AuthorizationContext } from './context';

// Deny-by-default policy evaluator.
export {
  authorize,
  definePolicy,
  definePolicyRule,
  isPolicy,
  isPolicyRule,
  parsePolicy,
  parsePolicyRule,
} from './policy';
export type { AuthorizationDecision, Policy, PolicyEffect, PolicyRule } from './policy';
