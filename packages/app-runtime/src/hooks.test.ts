// OFF-026 app-runtime — declared lifecycle hooks acceptance suite.
//
// The typed hook contracts (on-install/on-activate/on-suspend/on-revoke) as
// DECLARED descriptor records: fail-closed parse over the closed vocabulary,
// at most one hook per name, the trusted builder, the typed invocation
// records the host executes — and the structural no-arbitrary-code proof
// (every record is plain JSON data; no function values anywhere).
import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_HOOKS,
  appLifecycleHooks,
  isAppLifecycleHook,
  isLifecycleHookInvocation,
  lifecycleHookInvocationOf,
  parseAppLifecycleHook,
  parseAppLifecycleHooks,
  parseLifecycleHookInvocation,
} from './hooks';
import type { AppLifecycleHook } from './hooks';
import { INSTALLATION, T0, sampleHooks, unwrap } from './test-support';

const installHook = (): AppLifecycleHook => sampleHooks()[0] as AppLifecycleHook;

describe('the closed lifecycle-hook vocabulary', () => {
  it('is exactly the four declared transitions', () => {
    expect(LIFECYCLE_HOOKS).toStrictEqual([
      'on-install',
      'on-activate',
      'on-suspend',
      'on-revoke',
    ]);
  });
});

describe('AppLifecycleHook parse (fail-closed)', () => {
  it('round-trips a valid declared hook', () => {
    const hook = installHook();
    const parsed = parseAppLifecycleHook(hook);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(hook);
    expect(isAppLifecycleHook(hook)).toBe(true);
  });

  it('rejects hook names outside the closed vocabulary (no on-uninstall)', () => {
    for (const hook of ['on-uninstall', 'onReactivate', '']) {
      const parsed = parseAppLifecycleHook({ ...installHook(), hook });
      expect(parsed.ok, `hook '${hook}'`).toBe(false);
    }
  });

  it('rejects non-objects, unknown keys, and malformed handlers with exact paths', () => {
    expect(parseAppLifecycleHook(null).ok).toBe(false);
    const unknownKey = parseAppLifecycleHook({ ...installHook(), extra: true });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.error.code).toBe('unknown-field');
    const badHandler = parseAppLifecycleHook({
      ...installHook(),
      handler: { kind: 'app-handler', handlerId: 'NOT A SLUG', title: 'x' },
    });
    expect(badHandler.ok).toBe(false);
    if (!badHandler.ok) expect(badHandler.error.path).toBe('handler.handlerId');
  });

  it('rejects duplicate hook names in a declared list (never silently merged)', () => {
    const parsed = parseAppLifecycleHooks([installHook(), installHook()]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.path).toBe('hooks[1]');
    }
  });

  it('rejects malformed elements with nested element paths', () => {
    const parsed = parseAppLifecycleHooks([{ ...installHook(), hook: 'on-frobnicate' }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.path).toBe('hooks[0].hook');
  });
});

describe('appLifecycleHooks (trusted builder)', () => {
  it('composes the declared hooks in vocabulary order, skipping absent ones', () => {
    const hooks = appLifecycleHooks({
      'on-suspend': sampleHooks()[2]!.handler,
      'on-install': sampleHooks()[0]!.handler,
    });
    expect(hooks.map((hook) => hook.hook)).toStrictEqual(['on-install', 'on-suspend']);
  });

  it('throws loud TypeErrors on an invalid handler part', () => {
    expect(() =>
      appLifecycleHooks({
        'on-install': {
          kind: 'app-handler',
          handlerId: 'BAD HOOK' as never,
          title: 'x',
          description: null,
        },
      }),
    ).toThrow(TypeError);
  });
});

describe('LifecycleHookInvocation (the typed record the host executes)', () => {
  it('is derived from the installation\'s declared hook at the transition instant', () => {
    const invocation = lifecycleHookInvocationOf(
      { installationId: INSTALLATION, hooks: sampleHooks() },
      'on-suspend',
      T0,
    );
    expect(invocation).not.toBeNull();
    expect(invocation?.kind).toBe('app-lifecycle-hook-invocation');
    expect(invocation?.installationId).toBe(INSTALLATION);
    expect(invocation?.hook).toBe('on-suspend');
    expect(invocation?.handlerId).toBe('suspend-hook');
    expect(invocation?.occurredAt).toBe(T0);
    expect(isLifecycleHookInvocation(invocation)).toBe(true);
    expect(parseLifecycleHookInvocation(invocation as never).ok).toBe(true);
  });

  it('returns null when the installation declares no hook for the transition', () => {
    expect(lifecycleHookInvocationOf({ installationId: INSTALLATION, hooks: [] }, 'on-revoke', T0)).toBeNull();
  });

  it('parses fail-closed (strict keys, closed vocabulary, bad ids rejected)', () => {
    const invocation = lifecycleHookInvocationOf(
      { installationId: INSTALLATION, hooks: sampleHooks() },
      'on-install',
      T0,
    );
    expect(parseLifecycleHookInvocation({ ...invocation, extra: 1 }).ok).toBe(false);
    expect(parseLifecycleHookInvocation({ ...invocation, hook: 'on-frobnicate' }).ok).toBe(false);
    expect(parseLifecycleHookInvocation({ ...invocation, installationId: 'nope' }).ok).toBe(false);
    expect(parseLifecycleHookInvocation(null).ok).toBe(false);
  });
});

describe('the no-arbitrary-code discipline (structural)', () => {
  it('every hook and invocation record is plain JSON data — no function values', () => {
    const hooks = sampleHooks();
    for (const hook of hooks) {
      expect(JSON.parse(JSON.stringify(hook))).toStrictEqual(hook);
      expect(typeof (hook as unknown as Record<string, unknown>)['handler']).toBe('object');
    }
    const invocation = lifecycleHookInvocationOf(
      { installationId: INSTALLATION, hooks },
      'on-activate',
      T0,
    );
    const values = [...Object.values(invocation ?? {})];
    for (const value of values) {
      expect(typeof value === 'function').toBe(false);
    }
    expect(unwrap(parseAppLifecycleHooks(hooks))).toStrictEqual(hooks);
  });
});
