import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY_FILE,
  checkAppPermissions,
  CONFORMANCE_CLIENTS,
  extractCapabilityRegistry,
  loadRepoTree,
} from './rules';

// OFF-039 check 5 — app permission drift: the three clients' (apps/web,
// apps/field, apps/desktop) declared app permissions must EXACTLY match the
// canonical registry — the closed capability vocabulary of packages/authz
// (the registry the OFF-036 access-review surface audits declared baselines
// against). No undeclared permission (every capability literal and policy
// capability name is a registry member), no missing one (the registry
// declares both halves of every area), and each client's session baseline
// cannot drift between the capabilities it grants and the policy it allows.
describe('app permission drift (OFF-039 architecture conformance)', () => {
  const files = loadRepoTree();

  it('extracts the canonical closed capability registry (fail closed)', () => {
    const { names, violations } = extractCapabilityRegistry(files);
    expect(violations).toStrictEqual([]);
    // The landed registry: 13 bounded-context areas x read/write pairs.
    expect(names.length).toBeGreaterThanOrEqual(26);
    for (const expected of ['projects.read', 'projects.write', 'work.read', 'work.write', 'cost.write', 'schedule.write', 'contracts.write', 'workflows.write', 'organization.read']) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBe(new Set(names).size);
  });

  it('scopes the check to the three permission-declaring clients', () => {
    expect(CONFORMANCE_CLIENTS).toStrictEqual(['web', 'field', 'desktop']);
    for (const client of CONFORMANCE_CLIENTS) {
      expect(files.some((file) => file.path === `apps/${client}/src/session/session.ts`)).toBe(true);
    }
  });

  it('names both sides of the baseline: the registry and the client sessions', () => {
    // The clients' baselines are anchored in the registry: every session
    // documents "The closed vocabulary is @office/authz's; every name below
    // is declared there" — the drift rule holds both sides to that.
    const webSession = files.find((file) => file.path === 'apps/web/src/session/session.ts');
    expect(webSession?.text).toContain('SESSION_OPERATOR_CAPABILITIES');
    const fieldSession = files.find((file) => file.path === 'apps/field/src/session/session.ts');
    expect(fieldSession?.text).toContain('SESSION_FIELD_CAPABILITIES');
    const desktopSession = files.find((file) => file.path === 'apps/desktop/src/session/session.ts');
    expect(desktopSession?.text).toContain('SESSION_DESKTOP_CAPABILITIES');
    expect(files.some((file) => file.path === CAPABILITY_REGISTRY_FILE)).toBe(true);
  });

  it('passes on the entire current tree — zero drift, fail closed', () => {
    const violations = checkAppPermissions(files);
    expect(violations).toStrictEqual([]);
  });
});
