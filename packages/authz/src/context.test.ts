import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseEntityId,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type { Actor, ParseResult, Scope } from '@office/contracts';
import {
  authorizationContext,
  isAuthorizationContext,
  parseAuthorizationContext,
  parseCapability,
} from './index';

// OFF-006 authz — authorization context tests. Deterministic: fixed actors
// and scopes; the service-to-service actor kinds prove the context shape is
// uniform across actor kinds.

const TENANT_A_OPAQUE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PROJECT_A_OPAQUE = '4f9d2c81a7e34b5d90c1f2e3a4b5c6d7';
const USER_OPAQUE = 'b2c3d4e5f60718293a4b5c6d7e8f9a1';
const APP_OPAQUE = 'd4e5f60718293a4b5c6d7e8f9a1b2c3';
const AGENT_OPAQUE = 'e5f60718293a4b5c6d7e8f9a1b2c3d4';
const ADAPTER_OPAQUE = '5f60718293a4b5c6d7e8f9a1b2c3d4';

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const failure = <T>(result: ParseResult<T>) => {
  if (result.ok) throw new Error('expected a parse failure');
  return result.error;
};

const tenantA = unwrap(parseTenantId(formatTenantId({ version: 'v1', opaque: TENANT_A_OPAQUE })));
const projectA = unwrap(parseProjectId(formatProjectId({ version: 'v1', opaque: PROJECT_A_OPAQUE })));
const userId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: USER_OPAQUE })));
const appId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: APP_OPAQUE })));
const agentId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: AGENT_OPAQUE })));
const adapterId = unwrap(parseEntityId(formatEntityId({ version: 'v1', opaque: ADAPTER_OPAQUE })));

const tenantScopeA: Scope = { kind: 'tenant', tenantId: tenantA };
const projectScopeA1: Scope = { kind: 'project', tenantId: tenantA, projectId: projectA };

const userActor: Actor = { kind: 'user', actorId: userId };
const appActor: Actor = { kind: 'app', actorId: appId };
const agentActor: Actor = { kind: 'agent', actorId: agentId };
const adapterActor: Actor = { kind: 'adapter', actorId: adapterId };
const systemActor: Actor = { kind: 'system' };

describe('AuthorizationContext parsing (fail-closed)', () => {
  it('parses a user context with granted capabilities', () => {
    const context = unwrap(
      parseAuthorizationContext({
        actor: { kind: 'user', actorId: userId },
        scope: { kind: 'project', tenantId: tenantA, projectId: projectA },
        capabilities: ['projects.read', 'documents.read'],
      }),
    );
    expect(context.actor).toStrictEqual(userActor);
    expect(context.scope).toStrictEqual(projectScopeA1);
    expect(context.capabilities).toStrictEqual([
      unwrap(parseCapability('projects.read')),
      unwrap(parseCapability('documents.read')),
    ]);
  });

  it('parses service-to-service contexts for app, agent, adapter, and system actors (same shape)', () => {
    for (const actor of [appActor, agentActor, adapterActor, systemActor]) {
      const context = unwrap(
        parseAuthorizationContext({ actor, scope: tenantScopeA, capabilities: [] }),
      );
      expect(context.actor, actor.kind).toStrictEqual(actor);
      expect(context.scope).toStrictEqual(tenantScopeA);
      expect(context.capabilities).toStrictEqual([]);
    }
  });

  it('rejects non-object input and unknown keys', () => {
    expect(parseAuthorizationContext(null).ok).toBe(false);
    expect(parseAuthorizationContext(42).ok).toBe(false);
    const error = failure(
      parseAuthorizationContext({ actor: userActor, scope: tenantScopeA, capabilities: [], roles: [] }),
    );
    expect(error.code).toBe('unknown-field');
    expect(error.path).toBe('roles');
  });

  it('nests actor and scope failures under their fields', () => {
    expect(
      failure(parseAuthorizationContext({ actor: { kind: 'user' }, scope: tenantScopeA, capabilities: [] }))
        .path,
    ).toBe('actor.actorId');
    expect(
      failure(
        parseAuthorizationContext({
          actor: userActor,
          scope: { kind: 'project', tenantId: tenantA },
          capabilities: [],
        }),
      ).path,
    ).toBe('scope.projectId');
  });

  it('rejects undeclared capabilities with element paths', () => {
    const error = failure(
      parseAuthorizationContext({
        actor: userActor,
        scope: tenantScopeA,
        capabilities: ['projects.read', 'projects.admin'],
      }),
    );
    expect(error.code).toBe('invalid-value');
    expect(error.path).toBe('capabilities[1]');
    expect(error.received).toContain('projects.admin');
  });

  it('rejects duplicate capabilities (fail-closed)', () => {
    const error = failure(
      parseAuthorizationContext({
        actor: userActor,
        scope: tenantScopeA,
        capabilities: ['projects.read', 'projects.read'],
      }),
    );
    expect(error.code).toBe('invalid-value');
    expect(error.path).toBe('capabilities[1]');
  });

  it('rejects non-array capabilities', () => {
    const error = failure(
      parseAuthorizationContext({ actor: userActor, scope: tenantScopeA, capabilities: 'projects.read' }),
    );
    expect(error.code).toBe('invalid-type');
    expect(error.path).toBe('capabilities');
  });

  it('accepts an empty capability set (deny-by-default handles the rest)', () => {
    expect(
      parseAuthorizationContext({ actor: systemActor, scope: tenantScopeA, capabilities: [] }).ok,
    ).toBe(true);
  });

  it('isAuthorizationContext guards', () => {
    expect(isAuthorizationContext({ actor: userActor, scope: tenantScopeA, capabilities: [] })).toBe(
      true,
    );
    expect(isAuthorizationContext({ actor: userActor, scope: tenantScopeA })).toBe(false);
    expect(isAuthorizationContext(null)).toBe(false);
  });

  it('authorizationContext() composes trusted contexts and validates loudly', () => {
    const context = authorizationContext({
      actor: appActor,
      scope: projectScopeA1,
      capabilities: ['documents.read'],
    });
    expect(context.actor).toStrictEqual(appActor);
    expect(context.scope).toStrictEqual(projectScopeA1);
    expect(context.capabilities).toStrictEqual([unwrap(parseCapability('documents.read'))]);
    expect(() =>
      authorizationContext({ actor: appActor, scope: projectScopeA1, capabilities: ['documents.admin'] }),
    ).toThrow(TypeError);
    expect(() =>
      authorizationContext({
        actor: appActor,
        scope: projectScopeA1,
        capabilities: ['documents.read', 'documents.read'],
      }),
    ).toThrow(TypeError);
  });
});
