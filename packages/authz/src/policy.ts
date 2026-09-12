// Office authz — policy evaluator (OFF-006).
//
// The deny-by-default evaluator. A Policy is a static, data-driven value —
// an ordered list of declarative rules — and authorize() is a PURE function
// (policy, context, resource, action) → Result. No global state, no I/O,
// no clock, no randomness: same inputs, same outputs, always.
//
// Evaluation order (never silently allows):
// 1. STRUCTURAL scope coverage (freeze A12): the context scope must cover
//    the resource scope — cross-tenant and cross-project accesses are typed
//    'unauthorized' denials BEFORE any rule is consulted, so no rule can
//    ever allow them (see scope.ts checkScopeCoversResource).
// 2. EXPLICIT DENY: any matching deny rule wins immediately — typed
//    'forbidden' ('explicit-deny').
// 3. ALLOW: the first matching allow rule grants access; the decision
//    carries its index (for audit trails).
// 4. DEFAULT DENY: no matching allow rule → typed 'forbidden'
//    ('no-allow-rule'). Reads and writes are distinct actions: a rule
//    matching only 'read' never grants 'write'.
//
// unauthorized-vs-forbidden (the kernel taxonomy refinement this package
// owns): scope denials are 'unauthorized' — the request's scope does not
// cover the target; policy denials are 'forbidden' — the actor is
// identified but no rule grants the access.
import { parseEntityId, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type { Actor, ActorKind, EntityId, EntityKind, ParseResult } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { parseCapabilityList } from './capability';
import type { Action, Capability } from './capability';
import { checkScopeCoversResource, resolveDenialContext } from './scope';
import type { ResourceScope } from './scope';
import type { AuthorizationContext } from './context';
import {
  describeValue,
  isPlainObject,
  joinPath,
  optionalField,
  parseLiteralArray,
  parseValueArray,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

/** Rule effect: 'allow' grants when matched; 'deny' always wins when matched. */
export type PolicyEffect = 'allow' | 'deny';

/** All actor kinds a rule may match on (the contracts Actor vocabulary). */
const ACTOR_KINDS: readonly string[] = ['user', 'agent', 'app', 'adapter', 'system'];

/** The two authorization actions (see capability.ts). */
const ACTIONS: readonly string[] = ['read', 'write'];

/**
 * One declarative policy rule. Every field besides `effect` is an optional,
 * conjunctive matcher — omitted fields match anything. A present field must
 * match:
 * - `actorKinds` — the context actor's kind is listed;
 * - `actorIds` — the context actor is identified and its id is listed (the
 *   system actor, which has no id, never matches an actorIds rule);
 * - `capabilities` — the context holds ALL the listed capabilities;
 * - `resourceKinds` — the resource's kind is listed;
 * - `actions` — the requested action is listed;
 * - `ownedByActor` (true only) — the resource is owned by the requesting
 *   actor (resource.ownerId equals the actor's id).
 */
export interface PolicyRule {
  readonly effect: PolicyEffect;
  readonly actorKinds?: readonly ActorKind[];
  readonly actorIds?: readonly EntityId[];
  readonly resourceKinds?: readonly EntityKind[];
  readonly actions?: readonly Action[];
  readonly capabilities?: readonly Capability[];
  readonly ownedByActor?: true;
}

/** A static, data-driven authorization policy: an ordered rule list. */
export interface Policy {
  readonly rules: readonly PolicyRule[];
}

/** A granted access: which allow rule matched (for audit trails). */
export interface AuthorizationDecision {
  readonly effect: 'allow';
  readonly ruleIndex: number;
}

/** Shape description used in parse failures. */
export const POLICY_GRAMMAR = 'Policy: { rules: PolicyRule[] }';

/** Shape description used in parse failures. */
export const POLICY_RULE_GRAMMAR =
  "PolicyRule: { effect: 'allow' | 'deny', actorKinds?, actorIds?, resourceKinds?, actions?, capabilities?, ownedByActor?: true }";

const POLICY_KEYS = ['rules'] as const;

const POLICY_RULE_KEYS = [
  'effect',
  'actorKinds',
  'actorIds',
  'resourceKinds',
  'actions',
  'capabilities',
  'ownedByActor',
] as const;

const describeActor = (actor: Actor): string =>
  actor.kind === 'system' ? 'the system actor' : `${actor.kind} actor ${actor.actorId}`;

/** Parse an untrusted value as a PolicyRule (total, fail-closed, strict keys). */
export function parsePolicyRule(raw: unknown): ParseResult<PolicyRule> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', POLICY_RULE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, POLICY_RULE_KEYS, '', POLICY_RULE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const effect = requireLiteral(raw, 'effect', '', ['allow', 'deny']);
  if (!effect.ok) return effect;
  const actorKinds = optionalField(
    raw,
    'actorKinds',
    (value) =>
      parseLiteralArray(
        value,
        'actorKinds',
        ACTOR_KINDS,
        "array of actor kinds ('user' | 'agent' | 'app' | 'adapter' | 'system'), no duplicates",
      ),
  );
  if (!actorKinds.ok) return actorKinds;
  const actions = optionalField(
    raw,
    'actions',
    (value) =>
      parseLiteralArray(
        value,
        'actions',
        ACTIONS,
        "array of actions ('read' | 'write'), no duplicates",
      ),
  );
  if (!actions.ok) return actions;
  const actorIds = optionalField(
    raw,
    'actorIds',
    (value) =>
      parseValueArray(
        value,
        'actorIds',
        parseEntityId,
        'array of canonical EntityId values (no duplicates)',
      ),
  );
  if (!actorIds.ok) return actorIds;
  const resourceKinds = optionalField(
    raw,
    'resourceKinds',
    (value) =>
      parseValueArray(
        value,
        'resourceKinds',
        parseEntityKind,
        'array of canonical EntityKind values (no duplicates)',
      ),
  );
  if (!resourceKinds.ok) return resourceKinds;
  const capabilities = optionalField(
    raw,
    'capabilities',
    (value) => parseCapabilityList(value, 'capabilities'),
  );
  if (!capabilities.ok) return capabilities;
  const ownedByActor = raw['ownedByActor'];
  if (ownedByActor !== undefined && ownedByActor !== true) {
    return parseFail('invalid-value', 'ownedByActor', 'true', describeValue(ownedByActor));
  }
  const rule: {
    effect: PolicyEffect;
    actorKinds?: readonly ActorKind[];
    actorIds?: readonly EntityId[];
    resourceKinds?: readonly EntityKind[];
    actions?: readonly Action[];
    capabilities?: readonly Capability[];
    ownedByActor?: true;
  } = { effect: effect.value as PolicyEffect };
  if (actorKinds.value !== undefined) {
    rule.actorKinds = actorKinds.value as readonly ActorKind[];
  }
  if (actorIds.value !== undefined) rule.actorIds = actorIds.value;
  if (resourceKinds.value !== undefined) rule.resourceKinds = resourceKinds.value;
  if (actions.value !== undefined) rule.actions = actions.value as readonly Action[];
  if (capabilities.value !== undefined) rule.capabilities = capabilities.value;
  if (ownedByActor === true) rule.ownedByActor = true;
  return parseOk(rule satisfies PolicyRule);
}

/** Type guard for structurally valid PolicyRule values. */
export function isPolicyRule(raw: unknown): raw is PolicyRule {
  return parsePolicyRule(raw).ok;
}

/** Parse an untrusted value as a Policy (total, fail-closed, strict keys). */
export function parsePolicy(raw: unknown): ParseResult<Policy> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', POLICY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, POLICY_KEYS, '', POLICY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const rulesRaw = raw['rules'];
  if (rulesRaw === undefined) {
    return parseFail('missing-field', 'rules', 'array of PolicyRule', 'undefined');
  }
  if (!Array.isArray(rulesRaw)) {
    return parseFail('invalid-type', 'rules', 'array of PolicyRule', describeValue(rulesRaw));
  }
  const rules: PolicyRule[] = [];
  for (const [index, ruleRaw] of rulesRaw.entries()) {
    const rule = parsePolicyRule(ruleRaw);
    if (!rule.ok) {
      return parseFail(
        rule.error.code,
        joinPath(`rules[${index}]`, rule.error.path),
        rule.error.expected,
        rule.error.received,
      );
    }
    rules.push(rule.value);
  }
  return parseOk({ rules } satisfies Policy);
}

/** Type guard for structurally valid Policy values. */
export function isPolicy(raw: unknown): raw is Policy {
  return parsePolicy(raw).ok;
}

/**
 * Compose a validated PolicyRule (trusted path): validates the input with
 * the same fail-closed checks as parsePolicyRule and throws a loud TypeError
 * instead of returning the failure. Accepts plain objects — declared
 * capability names, canonical ids/kinds as strings.
 */
export function definePolicyRule(raw: unknown): PolicyRule {
  const result = parsePolicyRule(raw);
  if (!result.ok) {
    throw new TypeError(
      `invalid policy rule: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

/** Compose a validated Policy from rule inputs (trusted path; loud TypeError). */
export function definePolicy(rules: readonly unknown[]): Policy {
  return { rules: rules.map(definePolicyRule) };
}

const actorMatchesIds = (rule: PolicyRule, actor: Actor): boolean => {
  if (rule.actorIds === undefined) return true;
  if (actor.kind === 'system') return false;
  return rule.actorIds.includes(actor.actorId);
};

const actorOwnsResource = (actor: Actor, resource: ResourceScope): boolean => {
  if (actor.kind === 'system') return false;
  return resource.ownerId !== null && resource.ownerId === actor.actorId;
};

/** Does this rule match this context × action × resource? (conjunctive) */
const ruleMatches = (
  rule: PolicyRule,
  context: AuthorizationContext,
  resource: ResourceScope,
  action: Action,
): boolean => {
  if (rule.actorKinds !== undefined && !rule.actorKinds.includes(context.actor.kind)) {
    return false;
  }
  if (!actorMatchesIds(rule, context.actor)) return false;
  if (rule.capabilities !== undefined) {
    for (const required of rule.capabilities) {
      if (!context.capabilities.includes(required)) return false;
    }
  }
  if (rule.resourceKinds !== undefined && !rule.resourceKinds.includes(resource.resourceKind)) {
    return false;
  }
  if (rule.actions !== undefined && !rule.actions.includes(action)) return false;
  if (rule.ownedByActor === true && !actorOwnsResource(context.actor, resource)) return false;
  return true;
};

const explicitDenial = (
  parts: {
    readonly action: Action;
    readonly resource: ResourceScope;
    readonly actor: Actor;
    readonly ruleIndex: number;
  },
  context: DomainErrorContext,
): DomainError =>
  domainError(
    'forbidden',
    `a deny rule (index ${parts.ruleIndex}) forbids '${parts.action}' on '${parts.resource.resourceKind}' by ${describeActor(parts.actor)}`,
    [
      {
        code: 'explicit-deny',
        message: `deny rule at index ${parts.ruleIndex} matches '${parts.action}' on '${parts.resource.resourceKind}'`,
        path: null,
      },
    ],
    context,
  );

const defaultDenial = (
  parts: {
    readonly action: Action;
    readonly resource: ResourceScope;
    readonly actor: Actor;
  },
  context: DomainErrorContext,
): DomainError =>
  domainError(
    'forbidden',
    `no allow rule in the policy grants '${parts.action}' on '${parts.resource.resourceKind}' to ${describeActor(parts.actor)}`,
    [
      {
        code: 'no-allow-rule',
        message: `no matching allow rule for '${parts.action}' on '${parts.resource.resourceKind}'`,
        path: null,
      },
    ],
    context,
  );

/**
 * The deny-by-default authorization evaluator (pure, deterministic).
 *
 * 1. Structural isolation first (A12): cross-tenant/cross-project access is
 *    a typed 'unauthorized' denial before any rule is consulted.
 * 2. Any matching deny rule → typed 'forbidden' ('explicit-deny').
 * 3. The first matching allow rule grants access (decision carries its index).
 * 4. No matching allow rule → typed 'forbidden' ('no-allow-rule').
 *
 * Reads and writes are distinct actions. Service-to-service actors
 * (app/agent/adapter) authorize through this same evaluator — their rules
 * simply match on actor kinds and capabilities. Denials carry the request
 * scope (never the foreign resource's) plus the supplied correlation id.
 */
export function authorize(
  policy: Policy,
  context: AuthorizationContext,
  resource: ResourceScope,
  action: Action,
  errorContext?: DomainErrorContext,
): Result<AuthorizationDecision, DomainError> {
  // 1. Structural isolation (freeze A12) — before any rule matching.
  const coverage = checkScopeCoversResource(context.scope, resource, errorContext);
  if (!coverage.ok) return coverage;

  // 2–4. Rule evaluation: explicit deny wins; first allow grants; otherwise
  // deny-by-default.
  const denialContext = resolveDenialContext(errorContext, context.scope);
  let firstAllowIndex: number | null = null;
  for (const [index, rule] of policy.rules.entries()) {
    if (!ruleMatches(rule, context, resource, action)) continue;
    if (rule.effect === 'deny') {
      return fail(
        explicitDenial(
          { action, resource, actor: context.actor, ruleIndex: index },
          denialContext,
        ),
      );
    }
    if (firstAllowIndex === null) firstAllowIndex = index;
  }
  if (firstAllowIndex !== null) {
    return ok({ effect: 'allow', ruleIndex: firstAllowIndex } satisfies AuthorizationDecision);
  }
  return fail(defaultDenial({ action, resource, actor: context.actor }, denialContext));
}
