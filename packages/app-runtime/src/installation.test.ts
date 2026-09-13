// OFF-026 app-runtime — the AppInstallation model + lifecycle acceptance suite.
//
// THE AppInstallation record: fail-closed parse matrix (strict keys, closed
// state vocabulary, lifecycle consistency), the trusted install builder,
// and the typed lifecycle state machine — installing → active → suspended
// → revoked / uninstalled, one-way revocation (idempotent terminal
// transitions; re-activation of a revoked installation typed-rejected).
import { describe, expect, it } from 'vitest';
import { parseTenantId } from '@office/contracts';
import { parseAppId, parseAppVersion } from '@office/app-sdk';
import type { AppId } from '@office/app-sdk';
import {
  activateInstallation,
  installInstallation,
  installationActor,
  isAppInstallation,
  isInstallationDispatchable,
  parseAppInstallation,
  revokeInstallation,
  suspendInstallation,
  uninstallInstallation,
} from './installation';
import type { AppInstallation } from './installation';
import {
  ADMIN,
  INSTALLATION,
  INSTALLATION_B,
  OPERATOR,
  SAMPLE_APP_ID,
  SAMPLE_APP_VERSION,
  T0,
  adminActor,
  operatorActor,
  sampleHooks,
  unwrap,
} from './test-support';

const parseTenantIdFixture = parseTenantId;
const parseAppIdFixture = parseAppId;
const parseAppVersionFixture = parseAppVersion;

const baseInstallation = (): AppInstallation =>
  installInstallation({
    installationId: INSTALLATION,
    tenantId: unwrap(parseTenantIdFixture('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9')),
    appId: unwrap(parseAppIdFixture(SAMPLE_APP_ID)),
    manifestVersion: unwrap(parseAppVersionFixture(SAMPLE_APP_VERSION)),
    hooks: sampleHooks(),
    installedAt: T0,
    installedBy: adminActor(),
  });

const activeInstallation = (): AppInstallation =>
  unwrap(activateInstallation(baseInstallation(), { at: T0 })).installation;

describe('AppInstallation parse (fail-closed)', () => {
  it('round-trips a structurally valid installing record', () => {
    const installation = baseInstallation();
    const parsed = parseAppInstallation(installation);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toStrictEqual(installation);
    expect(isAppInstallation(installation)).toBe(true);
  });

  it('rejects non-object roots, unknown kinds, unknown keys, and missing fields', () => {
    for (const raw of [null, 42, 'installation', []]) {
      const parsed = parseAppInstallation(raw);
      expect(parsed.ok).toBe(false);
    }
    const wrongKind = { ...baseInstallation(), kind: 'installation' };
    expect(parseAppInstallation(wrongKind).ok).toBe(false);
    const unknownKey = { ...baseInstallation(), extra: 1 };
    const unknown = parseAppInstallation(unknownKey);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown-field');
    const missing = { ...baseInstallation() } as Record<string, unknown>;
    delete missing['tenantId'];
    expect(parseAppInstallation(missing).ok).toBe(false);
  });

  it('rejects lifecycle states outside the closed vocabulary', () => {
    const bad = { ...baseInstallation(), state: 'paused' };
    const parsed = parseAppInstallation(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid-value');
      expect(parsed.error.path).toBe('state');
    }
  });

  it('rejects inconsistent lifecycle fields (fail-closed invariants)', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['installing with revocation fields', { revokedAt: T0, revokedBy: adminActor() }, 'activatedAt'],
      ['active without activatedAt', { state: 'active', activatedAt: null }, 'activatedAt'],
      ['active with suspension fields', { state: 'active', activatedAt: T0, suspendedAt: T0, suspendedBy: operatorActor() }, 'suspendedAt'],
      ['suspended without suspendedBy', { state: 'suspended', activatedAt: T0, suspendedAt: T0, suspendedBy: null }, 'suspendedAt'],
      ['revoked without revokedBy', { state: 'revoked', activatedAt: T0, revokedAt: T0, revokedBy: null }, 'revokedAt'],
      ['revoked with suspension snapshot', { state: 'revoked', activatedAt: T0, suspendedAt: T0, suspendedBy: operatorActor(), revokedAt: T0, revokedBy: operatorActor() }, 'suspendedAt'],
      ['uninstalled without uninstalledBy', { state: 'uninstalled', activatedAt: T0, uninstalledAt: T0, uninstalledBy: null }, 'uninstalledAt'],
      ['uninstalled with revocation fields', { state: 'uninstalled', activatedAt: T0, revokedAt: T0, revokedBy: operatorActor(), uninstalledAt: T0, uninstalledBy: operatorActor() }, 'revokedAt'],
    ];
    for (const [name, overrides, path] of cases) {
      const raw = { ...baseInstallation(), ...overrides };
      const parsed = parseAppInstallation(raw);
      expect(parsed.ok, name).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.path, name).toBe(path);
      }
    }
  });

  it('accepts every consistent state shape', () => {
    const suspended = unwrap(suspendInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(parseAppInstallation(suspended).ok).toBe(true);
    const revoked = unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(parseAppInstallation(revoked).ok).toBe(true);
    const uninstalled = unwrap(uninstallInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(parseAppInstallation(uninstalled).ok).toBe(true);
  });
});

describe('installInstallation (trusted builder)', () => {
  it('creates the installing record with the declared hooks and no transition fields', () => {
    const installation = baseInstallation();
    expect(installation.state).toBe('installing');
    expect(installation.hooks).toHaveLength(4);
    expect(installation.activatedAt).toBeNull();
    expect(installation.suspendedAt).toBeNull();
    expect(installation.revokedAt).toBeNull();
    expect(installation.uninstalledAt).toBeNull();
    expect(installation.installedBy).toStrictEqual({ kind: 'user', actorId: ADMIN });
  });

  it('throws loud TypeErrors on invalid parts (never silently coerces)', () => {
    expect(() =>
      installInstallation({
        installationId: INSTALLATION,
        tenantId: unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9')),
        // Intentionally-invalid app id (a raw string cast to the branded
        // type): the trusted builder must throw, never silently coerce.
        appId: 'NOT A SLUG' as AppId,
        manifestVersion: unwrap(parseAppVersionFixture(SAMPLE_APP_VERSION)),
        installedAt: T0,
        installedBy: adminActor(),
      }),
    ).toThrow(TypeError);
  });

  it('is deterministic: the same parts build the byte-identical record', () => {
    expect(baseInstallation()).toStrictEqual(baseInstallation());
  });
});

describe('the lifecycle state machine (typed transitions)', () => {
  it('activates an installing installation and emits the on-activate hook', () => {
    const result = unwrap(activateInstallation(baseInstallation(), { at: T0 }));
    expect(result.installation.state).toBe('active');
    expect(result.installation.activatedAt).toBe(T0);
    expect(result.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-activate']);
    expect(isInstallationDispatchable(result.installation)).toBe(true);
  });

  it('typed-rejects activating an active installation (no silent re-stamping)', () => {
    const active = activeInstallation();
    const result = activateInstallation(active, { at: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('already-active');
  });

  it('typed-rejects activating a revoked installation — revocation is one-way', () => {
    const revoked = unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    const result = activateInstallation(revoked, { at: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('revocation-terminal');
  });

  it('typed-rejects activating an uninstalled installation', () => {
    const uninstalled = unwrap(uninstallInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    const result = activateInstallation(uninstalled, { at: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details[0]?.code).toBe('uninstallation-terminal');
  });

  it('suspends an active installation and emits the on-suspend hook', () => {
    const result = unwrap(suspendInstallation(activeInstallation(), { by: operatorActor(), at: T0 }));
    expect(result.installation.state).toBe('suspended');
    expect(result.installation.suspendedBy).toStrictEqual({ kind: 'user', actorId: OPERATOR });
    expect(result.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-suspend']);
    expect(isInstallationDispatchable(result.installation)).toBe(false);
  });

  it('typed-rejects suspending a suspended / installing / terminal installation', () => {
    const suspended = unwrap(suspendInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(unwrapErrCode(suspendInstallation(suspended, { by: operatorActor(), at: T0 }))).toBe('already-suspended');
    expect(unwrapErrCode(suspendInstallation(baseInstallation(), { by: operatorActor(), at: T0 }))).toBe('not-suspendable');
    const revoked = unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(unwrapErrCode(suspendInstallation(revoked, { by: operatorActor(), at: T0 }))).toBe('not-suspendable');
  });

  it('re-activates a suspended installation — suspension is reversible', () => {
    const suspended = unwrap(suspendInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    const result = unwrap(activateInstallation(suspended, { at: T0 }));
    expect(result.installation.state).toBe('active');
    expect(result.installation.suspendedAt).toBeNull();
    expect(result.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-activate']);
    expect(isInstallationDispatchable(result.installation)).toBe(true);
  });

  it('revokes an active installation (terminal) and emits the on-revoke hook', () => {
    const result = unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 }));
    expect(result.installation.state).toBe('revoked');
    expect(result.installation.revokedAt).toBe(T0);
    expect(result.invokedHooks.map((invocation) => invocation.hook)).toStrictEqual(['on-revoke']);
    expect(isInstallationDispatchable(result.installation)).toBe(false);
  });

  it('revokes a suspended installation, clearing the suspension snapshot', () => {
    const suspended = unwrap(suspendInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    const revoked = unwrap(revokeInstallation(suspended, { by: operatorActor(), at: T0 })).installation;
    expect(revoked.state).toBe('revoked');
    expect(revoked.suspendedAt).toBeNull();
    expect(revoked.suspendedBy).toBeNull();
  });

  it('revocation is idempotent: revoking a revoked installation returns it unchanged', () => {
    const first = unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    const again = unwrap(revokeInstallation(first, { by: adminActor(), at: T0 }));
    expect(again.installation).toStrictEqual(first);
    expect(again.invokedHooks).toStrictEqual([]);
  });

  it('typed-rejects revoking an installing or uninstalled installation', () => {
    expect(unwrapErrCode(revokeInstallation(baseInstallation(), { by: operatorActor(), at: T0 }))).toBe('not-revocable');
    const uninstalled = unwrap(uninstallInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation;
    expect(unwrapErrCode(revokeInstallation(uninstalled, { by: operatorActor(), at: T0 }))).toBe('uninstallation-terminal');
  });

  it('uninstalls an active installation (terminal, no hook) and is idempotent', () => {
    const result = unwrap(uninstallInstallation(activeInstallation(), { by: operatorActor(), at: T0 }));
    expect(result.installation.state).toBe('uninstalled');
    expect(result.invokedHooks).toStrictEqual([]);
    const again = unwrap(uninstallInstallation(result.installation, { by: adminActor(), at: T0 }));
    expect(again.installation).toStrictEqual(result.installation);
    expect(unwrapErrCode(uninstallInstallation(unwrap(revokeInstallation(activeInstallation(), { by: operatorActor(), at: T0 })).installation, { by: operatorActor(), at: T0 }))).toBe('revocation-terminal');
  });

  it('typed-rejects uninstalling an installing installation', () => {
    expect(unwrapErrCode(uninstallInstallation(baseInstallation(), { by: operatorActor(), at: T0 }))).toBe('not-uninstallable');
  });
});

describe('the installation actor identity', () => {
  it("is the installation's own 'app' actor", () => {
    expect(installationActor(baseInstallation())).toStrictEqual({
      kind: 'app',
      actorId: INSTALLATION,
    });
    expect(installationActor({ installationId: INSTALLATION_B })).toStrictEqual({
      kind: 'app',
      actorId: INSTALLATION_B,
    });
  });
});

/** Extract the first detail code of a typed lifecycle failure (tests only). */
const unwrapErrCode = (result: { ok: boolean; error?: { details: readonly { code: string }[] } }): string => {
  if (result.ok || result.error === undefined) {
    throw new Error(`expected a typed lifecycle failure, got: ${JSON.stringify(result)}`);
  }
  return result.error.details[0]?.code ?? 'none';
};
