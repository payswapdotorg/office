import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCorrelationId,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type { Actor, ParseResult, Scope } from '@office/contracts';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  authorize,
  authorizationContext,
  definePolicy,
  definePolicyRule,
  expandRoles,
  isPolicy,
  isPolicyRule,
  parsePolicy,
  parsePolicyRule,
  parseRole,
  resourceScope,
} from './index';
import type { AuthorizationDecision, Policy, ResourceScope } from './index';

// OFF-006 authz — policy evaluator regression tests. Deterministic: fixed
// actors, scopes, policies; no I/O, no clock, no randomness.
//
// The work item's acceptance gate — denied cross-tenant/project READS and
// WRITES — is covered by the first three describe blocks below, each under
// an allow-all policy to prove the denial is structural (before any rule).

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const TENANT_B_OPAQUE = 'f9e8d7c6b5a493827160f5e4d3c2b1a0';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const PROJECT_B_OPAQUE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9';
const USER_A_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const USER_B_OPAQUE = 'c3d4e5f60718293a4b5c6d7e8f9a1b2';
const APP_OPAQUE = 'd4e5f60718293a4b5c6d7e8f9a1b2c3';
const AGENT_OPAQUE = 'e5f60718293a4b5c6d7e8f9a1b2c3d4';
const ADAPTER_OPAQUE = '5f60718293a4b5c6d7e8f9a1b2c3d4';
const DOC_OPAQUE = '6f60718293a4b5c6d7e8f9a1b2c3d4';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const failure = <T>(result: ParseResult<T>) => {
  if (result.ok) throw new Error('expected a parse failure');
  return result.error;
};

const denial = (result: Result<AuthorizationDecision, DomainError>): DomainError => {
  if (result.ok) throw new Error('expected a denial');
  return result.error;
};

const allowance = (result: Result<AuthorizationDecision, DomainError>): AuthorizationDecision => {
  if (!result.ok) throw new Error(`expected an allowance, got: ${result.error.message}`);
  return result.value;
};

const tenantA = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })));
const tenantB = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_B_OPAQUE })));
const projectA = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_A_OPAQUE })));
const projectB = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_B_OPAQUE })));
const userAId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_A_OPAQUE })));
const userBId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_B_OPAQUE })));
const appId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: APP_OPAQUE })));
const agentId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: AGENT_OPAQUE })));
const adapterId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: ADAPTER_OPAQUE })));
const documentId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: DOC_OPAQUE })));

const kindProject = unwrap(parseEntityKind('project'));
const kindDocument = unwrap(parseEntityKind('document'));

const tenantScopeA: Scope = { kind: 'tenant', tenantId: tenantA };
const tenantScopeB: Scope = { kind: 'tenant', tenantId: tenantB };
const projectScopeA1: Scope = { kind: 'project', tenantId: tenantA, projectId: projectA };
const projectScopeA2: Scope = { kind: 'project', tenantId: tenantA, projectId: projectB };
const projectScopeB: Scope = { kind: 'project', tenantId: tenantB, projectId: projectB };

const userActor: Actor = { kind: 'user', actorId: userAId };
const otherUserActor: Actor = { kind: 'user', actorId: userBId };
const appActor: Actor = { kind: 'app', actorId: appId };
const agentActor: Actor = { kind: 'agent', actorId: agentId };
const adapterActor: Actor = { kind: 'adapter', actorId: adapterId };
const systemActor: Actor = { kind: 'system' };

const readerContext = authorizationContext({
  actor: userActor,
  scope: projectScopeA1,
  capabilities: ['projects.read'],
});
const writerContext = authorizationContext({
  actor: userActor,
  scope: projectScopeA1,
  capabilities: ['projects.read', 'projects.write'],
});

const projectInA1: ResourceScope = resourceScope({
  scope: projectScopeA1,
  resourceKind: kindProject,
  resourceId: projectA,
});
const projectInA2: ResourceScope = resourceScope({
  scope: projectScopeA2,
  resourceKind: kindProject,
  resourceId: projectB,
});
const projectInB: ResourceScope = resourceScope({
  scope: projectScopeB,
  resourceKind: kindProject,
});
const tenantResourceB: ResourceScope = resourceScope({
  scope: tenantScopeB,
  resourceKind: kindProject,
});
const documentInA1: ResourceScope = resourceScope({
  scope: projectScopeA1,
  resourceKind: kindDocument,
  resourceId: documentId,
  ownerId: userAId,
});

/** A policy with one wildcard allow rule: matches every context/action/resource. */
const allowAllPolicy: Policy = definePolicy([{ effect: 'allow' }]);
/** The deny-by-default policy: no rules at all. */
const emptyPolicy: Policy = definePolicy([]);

describe('cross-tenant denial is structural (OFF-006 acceptance gate)', () => {
  it("denies a READ of another tenant's resource even under an allow-all policy", () => {
    const error = denial(authorize(allowAllPolicy, readerContext, tenantResourceB, 'read'));
    expect(error.kind).toBe('domain-error');
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
    expect(error.message).toBe(
      `request tenant ${tenantA} cannot access a resource owned by tenant ${tenantB}`,
    );
  });

  it("denies a WRITE of another tenant's resource even under an allow-all policy", () => {
    const error = denial(authorize(allowAllPolicy, writerContext, tenantResourceB, 'write'));
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('denies cross-tenant access before consulting any rule (empty policy still yields the scope violation)', () => {
    const error = denial(authorize(emptyPolicy, readerContext, tenantResourceB, 'read'));
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('denies project-scoped cross-tenant resources for project-scoped requests', () => {
    const error = denial(authorize(allowAllPolicy, readerContext, projectInB, 'read'));
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('carries the request scope, never the foreign tenant, on the denial', () => {
    const error = denial(authorize(allowAllPolicy, readerContext, tenantResourceB, 'read'));
    expect(error.scope).toStrictEqual(projectScopeA1);
  });

  it('attaches the supplied correlation id', () => {
    const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
    const error = denial(
      authorize(allowAllPolicy, readerContext, tenantResourceB, 'read', { correlationId }),
    );
    expect(error.correlationId).toBe(correlationId);
  });
});

describe('cross-project denial is structural (OFF-006 acceptance gate)', () => {
  it('denies a READ of a different project within the same tenant even under an allow-all policy', () => {
    const error = denial(authorize(allowAllPolicy, readerContext, projectInA2, 'read'));
    expect(error.kind).toBe('domain-error');
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
    expect(error.message).toBe(
      `request project ${projectA} cannot access a resource bound to project ${projectB}`,
    );
  });

  it('denies a WRITE of a different project within the same tenant even under an allow-all policy', () => {
    const error = denial(authorize(allowAllPolicy, writerContext, projectInA2, 'write'));
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
  });

  it('denies cross-project access before consulting any rule', () => {
    const error = denial(authorize(emptyPolicy, writerContext, projectInA2, 'write'));
    expect(error.code).toBe('unauthorized');
    expect(error.details[0]?.code).toBe('project-scope-violation');
  });

  it('allows the same project under the same policy (control case)', () => {
    const decision = allowance(authorize(allowAllPolicy, readerContext, projectInA1, 'read'));
    expect(decision.effect).toBe('allow');
    expect(decision.ruleIndex).toBe(0);
  });

  it('allows a project-scoped request on a tenant-wide resource of the same tenant (control case)', () => {
    const tenantResourceA = resourceScope({ scope: tenantScopeA, resourceKind: kindProject });
    expect(authorize(allowAllPolicy, readerContext, tenantResourceA, 'read').ok).toBe(true);
  });

  it('allows a tenant-scoped request on a project-scoped resource of the same tenant (control case)', () => {
    const tenantReader = authorizationContext({
      actor: userActor,
      scope: tenantScopeA,
      capabilities: ['projects.read'],
    });
    expect(authorize(allowAllPolicy, tenantReader, projectInA1, 'read').ok).toBe(true);
  });
});

describe('deny-by-default (OFF-006 acceptance gate)', () => {
  it('denies reads under an empty policy', () => {
    const error = denial(authorize(emptyPolicy, writerContext, projectInA1, 'read'));
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('denies writes under an empty policy', () => {
    const error = denial(authorize(emptyPolicy, writerContext, projectInA1, 'write'));
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('denies when rules exist but none match the request', () => {
    const policy = definePolicy([
      { effect: 'allow', resourceKinds: ['document'] },
      { effect: 'allow', actorKinds: ['app'] },
    ]);
    const error = denial(authorize(policy, writerContext, projectInA1, 'read'));
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it("reads and writes are distinct actions: a read rule never grants writes", () => {
    const policy = definePolicy([{ effect: 'allow', actions: ['read'] }]);
    expect(allowance(authorize(policy, writerContext, projectInA1, 'read')).ruleIndex).toBe(0);
    const error = denial(authorize(policy, writerContext, projectInA1, 'write'));
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('denies when the actor lacks the capability a rule requires', () => {
    const policy = definePolicy([{ effect: 'allow', capabilities: ['projects.write'] }]);
    expect(allowance(authorize(policy, writerContext, projectInA1, 'write')).ruleIndex).toBe(0);
    const error = denial(authorize(policy, readerContext, projectInA1, 'write'));
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('requires every listed capability (all-of semantics)', () => {
    const policy = definePolicy([
      { effect: 'allow', capabilities: ['projects.read', 'documents.read'] },
    ]);
    const documentsOnly = authorizationContext({
      actor: userActor,
      scope: projectScopeA1,
      capabilities: ['documents.read'],
    });
    expect(authorize(policy, documentsOnly, projectInA1, 'read').ok).toBe(false);
    const both = authorizationContext({
      actor: userActor,
      scope: projectScopeA1,
      capabilities: ['documents.read', 'projects.read'],
    });
    expect(authorize(policy, both, projectInA1, 'read').ok).toBe(true);
  });

  it('an explicit deny rule overrides any matching allow rule', () => {
    const policy = definePolicy([
      { effect: 'allow' },
      { effect: 'deny', resourceKinds: ['project'] },
    ]);
    const error = denial(authorize(policy, writerContext, projectInA1, 'read'));
    expect(error.code).toBe('forbidden');
    expect(error.details[0]?.code).toBe('explicit-deny');
    expect(error.message).toContain('index 1');
  });

  it('a lone deny rule denies', () => {
    const policy = definePolicy([{ effect: 'deny' }]);
    const error = denial(authorize(policy, writerContext, projectInA1, 'read'));
    expect(error.details[0]?.code).toBe('explicit-deny');
  });

  it('denials are typed values, never silent allowances', () => {
    const result = authorize(emptyPolicy, readerContext, projectInA1, 'read');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('domain-error');
      expect(result.error.details.length).toBeGreaterThan(0);
      expect(result.error.scope).toStrictEqual(projectScopeA1);
    }
  });
});

describe('service-to-service authorization (same evaluator, no special cases)', () => {
  const appReadDocuments = definePolicy([
    {
      effect: 'allow',
      actorKinds: ['app'],
      capabilities: ['documents.read'],
      resourceKinds: ['document'],
      actions: ['read'],
    },
  ]);
  const appReader = authorizationContext({
    actor: appActor,
    scope: projectScopeA1,
    capabilities: ['documents.read'],
  });

  it('authorizes an app actor holding the declared capability', () => {
    const decision = allowance(authorize(appReadDocuments, appReader, documentInA1, 'read'));
    expect(decision.ruleIndex).toBe(0);
  });

  it('denies the app actor the write action (the rule grants read only)', () => {
    const error = denial(authorize(appReadDocuments, appReader, documentInA1, 'write'));
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('denies the app actor when it lacks the required capability', () => {
    const bareApp = authorizationContext({ actor: appActor, scope: projectScopeA1, capabilities: [] });
    const error = denial(authorize(appReadDocuments, bareApp, documentInA1, 'read'));
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('denies a user actor under an app-only rule (actor-kind matching)', () => {
    const userReader = authorizationContext({
      actor: userActor,
      scope: projectScopeA1,
      capabilities: ['documents.read'],
    });
    const error = denial(authorize(appReadDocuments, userReader, documentInA1, 'read'));
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('authorizes agent and adapter actors through the same rule shape', () => {
    const policy = definePolicy([
      { effect: 'allow', actorKinds: ['agent'], capabilities: ['projects.read'], actions: ['read'] },
      { effect: 'allow', actorKinds: ['adapter'], capabilities: ['projects.write'], actions: ['write'] },
    ]);
    const agentReader = authorizationContext({
      actor: agentActor,
      scope: projectScopeA1,
      capabilities: ['projects.read'],
    });
    const adapterWriter = authorizationContext({
      actor: adapterActor,
      scope: projectScopeA1,
      capabilities: ['projects.write'],
    });
    expect(allowance(authorize(policy, agentReader, projectInA1, 'read')).ruleIndex).toBe(0);
    expect(allowance(authorize(policy, adapterWriter, projectInA1, 'write')).ruleIndex).toBe(1);
    expect(authorize(policy, agentReader, projectInA1, 'write').ok).toBe(false);
    expect(authorize(policy, adapterWriter, projectInA1, 'read').ok).toBe(false);
  });

  it('denies service-to-service actors cross-tenant access like any other actor', () => {
    expect(authorize(allowAllPolicy, appReader, tenantResourceB, 'read').ok).toBe(false);
    const error = denial(authorize(allowAllPolicy, appReader, tenantResourceB, 'read'));
    expect(error.details[0]?.code).toBe('tenant-scope-violation');
  });

  it('authorizes the system actor through an actor-kind rule', () => {
    const policy = definePolicy([{ effect: 'allow', actorKinds: ['system'] }]);
    const system = authorizationContext({ actor: systemActor, scope: tenantScopeA, capabilities: [] });
    expect(authorize(policy, system, projectInA1, 'read').ok).toBe(true);
  });

  it('actor-id rules never match the id-less system actor', () => {
    const policy = definePolicy([{ effect: 'allow', actorIds: [userAId] }]);
    const system = authorizationContext({ actor: systemActor, scope: tenantScopeA, capabilities: [] });
    expect(authorize(policy, system, projectInA1, 'read').ok).toBe(false);
  });

  it('actor-id rules match only the listed actor', () => {
    const policy = definePolicy([{ effect: 'allow', actorIds: [userAId] }]);
    const sameUser = authorizationContext({ actor: userActor, scope: projectScopeA1, capabilities: [] });
    const otherUser = authorizationContext({
      actor: otherUserActor,
      scope: projectScopeA1,
      capabilities: [],
    });
    expect(authorize(policy, sameUser, projectInA1, 'read').ok).toBe(true);
    expect(authorize(policy, otherUser, projectInA1, 'read').ok).toBe(false);
  });
});

describe('resource-owner matching', () => {
  const ownerWritesPolicy = definePolicy([
    {
      effect: 'allow',
      ownedByActor: true,
      capabilities: ['documents.write'],
      resourceKinds: ['document'],
      actions: ['write'],
    },
  ]);
  const ownerContext = authorizationContext({
    actor: userActor,
    scope: projectScopeA1,
    capabilities: ['documents.write'],
  });
  const otherOwnerContext = authorizationContext({
    actor: otherUserActor,
    scope: projectScopeA1,
    capabilities: ['documents.write'],
  });

  it('allows the owner to write their own document', () => {
    expect(authorize(ownerWritesPolicy, ownerContext, documentInA1, 'write').ok).toBe(true);
  });

  it('denies a different actor holding the same capability', () => {
    expect(authorize(ownerWritesPolicy, otherOwnerContext, documentInA1, 'write').ok).toBe(false);
  });

  it('denies ownerless resources under an ownedByActor rule', () => {
    const unowned = resourceScope({
      scope: projectScopeA1,
      resourceKind: kindDocument,
      resourceId: documentId,
    });
    expect(authorize(ownerWritesPolicy, ownerContext, unowned, 'write').ok).toBe(false);
  });
});

describe('role expansion feeding the evaluator', () => {
  const projectPolicy = definePolicy([
    { effect: 'allow', resourceKinds: ['project'], capabilities: ['projects.read'], actions: ['read'] },
    { effect: 'allow', resourceKinds: ['project'], capabilities: ['projects.write'], actions: ['write'] },
  ]);
  const viewer = unwrap(parseRole('viewer'));
  const manager = unwrap(parseRole('project-manager'));
  const viewerContext = authorizationContext({
    actor: userActor,
    scope: projectScopeA1,
    capabilities: expandRoles([viewer]),
  });
  const managerContext = authorizationContext({
    actor: userActor,
    scope: projectScopeA1,
    capabilities: expandRoles([manager]),
  });

  it('a viewer-role context may read projects but cannot write them', () => {
    expect(authorize(projectPolicy, viewerContext, projectInA1, 'read').ok).toBe(true);
    const error = denial(authorize(projectPolicy, viewerContext, projectInA1, 'write'));
    expect(error.details[0]?.code).toBe('no-allow-rule');
  });

  it('a project-manager-role context may read and write projects', () => {
    expect(authorize(projectPolicy, managerContext, projectInA1, 'read').ok).toBe(true);
    expect(authorize(projectPolicy, managerContext, projectInA1, 'write').ok).toBe(true);
  });
});

describe('decisions and determinism', () => {
  it('reports the first matching allow rule index', () => {
    const policy = definePolicy([
      { effect: 'allow', actorKinds: ['app'] },
      { effect: 'allow', actions: ['read'] },
      { effect: 'allow' },
    ]);
    const decision = allowance(authorize(policy, readerContext, projectInA1, 'read'));
    expect(decision.effect).toBe('allow');
    expect(decision.ruleIndex).toBe(1);
  });

  it('is deterministic: identical inputs produce identical results', () => {
    const first = authorize(allowAllPolicy, readerContext, projectInA1, 'read');
    const second = authorize(allowAllPolicy, readerContext, projectInA1, 'read');
    expect(first).toStrictEqual(second);
    const deniedFirst = authorize(emptyPolicy, readerContext, projectInA1, 'read');
    const deniedSecond = authorize(emptyPolicy, readerContext, projectInA1, 'read');
    expect(deniedFirst).toStrictEqual(deniedSecond);
  });

  it('forbidden denials carry the request scope and the supplied correlation id', () => {
    const correlationId = unwrap(parseCorrelationId('corr-0f1e2d3c4b5a'));
    const error = denial(
      authorize(emptyPolicy, readerContext, projectInA1, 'read', { correlationId }),
    );
    expect(error.code).toBe('forbidden');
    expect(error.scope).toStrictEqual(projectScopeA1);
    expect(error.correlationId).toBe(correlationId);
  });
});

describe('parsePolicy (fail-closed)', () => {
  it('round-trips a full policy', () => {
    const policy: Policy = definePolicy([
      {
        effect: 'allow',
        actorKinds: ['user', 'agent'],
        actorIds: [userAId],
        resourceKinds: ['project', 'document'],
        actions: ['read', 'write'],
        capabilities: ['projects.read', 'documents.write'],
      },
      { effect: 'deny', resourceKinds: ['document'], ownedByActor: true },
    ]);
    const parsed = unwrap(parsePolicy(JSON.parse(JSON.stringify(policy))));
    expect(parsed).toStrictEqual(policy);
  });

  it('accepts an empty rules array (the deny-by-default policy)', () => {
    expect(parsePolicy({ rules: [] }).ok).toBe(true);
  });

  it('rejects non-object policies and unknown keys', () => {
    expect(parsePolicy(null).ok).toBe(false);
    expect(parsePolicy([]).ok).toBe(false);
    expect(parsePolicy('policy').ok).toBe(false);
    const error = failure(parsePolicy({ rules: [], version: 2 }));
    expect(error.code).toBe('unknown-field');
    expect(error.path).toBe('version');
  });

  it('requires rules to be an array and nests rule failures', () => {
    expect(failure(parsePolicy({})).path).toBe('rules');
    expect(failure(parsePolicy({ rules: 'all' })).code).toBe('invalid-type');
    const nested = failure(parsePolicy({ rules: [{ effect: 'allow' }, { effect: 'maybe' }] }));
    expect(nested.path).toBe('rules[1].effect');
  });

  it('rejects unknown actor kinds, invalid actions, and undeclared capabilities', () => {
    expect(
      failure(parsePolicy({ rules: [{ effect: 'allow', actorKinds: ['robot'] }] })).path,
    ).toBe('rules[0].actorKinds[0]');
    expect(
      failure(parsePolicy({ rules: [{ effect: 'allow', actions: ['delete'] }] })).path,
    ).toBe('rules[0].actions[0]');
    expect(
      failure(parsePolicy({ rules: [{ effect: 'allow', capabilities: ['projects.admin'] }] })).path,
    ).toBe('rules[0].capabilities[0]');
  });

  it('rejects invalid actor ids and resource kinds with nested paths', () => {
    expect(failure(parsePolicy({ rules: [{ effect: 'deny', actorIds: ['nope'] }] })).path).toBe(
      'rules[0].actorIds[0]',
    );
    expect(
      failure(parsePolicy({ rules: [{ effect: 'deny', resourceKinds: ['Bad Kind'] }] })).path,
    ).toBe('rules[0].resourceKinds[0]');
  });

  it('rejects duplicate entries in the set-like rule arrays', () => {
    expect(
      failure(parsePolicy({ rules: [{ effect: 'allow', actorKinds: ['user', 'user'] }] })).code,
    ).toBe('invalid-value');
    expect(
      failure(
        parsePolicy({ rules: [{ effect: 'allow', capabilities: ['projects.read', 'projects.read'] }] }),
      ).code,
    ).toBe('invalid-value');
  });

  it('rejects ownedByActor values other than true', () => {
    const error = failure(parsePolicy({ rules: [{ effect: 'allow', ownedByActor: false }] }));
    expect(error.code).toBe('invalid-value');
    expect(error.path).toBe('rules[0].ownedByActor');
  });

  it('isPolicy and isPolicyRule guard', () => {
    expect(isPolicy({ rules: [] })).toBe(true);
    expect(isPolicy({})).toBe(false);
    expect(isPolicyRule({ effect: 'allow' })).toBe(true);
    expect(isPolicyRule({ effect: 'maybe' })).toBe(false);
  });

  it('definePolicyRule and definePolicy throw loudly on invalid input', () => {
    expect(() => definePolicyRule({ effect: 'allow', capabilities: ['projects.admin'] })).toThrow(
      TypeError,
    );
    expect(() => definePolicy(['nope'])).toThrow(TypeError);
    expect(definePolicy([])).toStrictEqual({ rules: [] });
    expect(parsePolicyRule({ effect: 'deny' }).ok).toBe(true);
  });
});
