import { describe, expect, it } from 'vitest';
import { parsePermissionSpec, reviewAppManifest } from '@office/app-sdk';
import type { AppManifest } from '@office/app-sdk';
import { capability } from '@office/authz';
import {
  addsCapability,
  applyStagedUpdate,
  confirmationSummary,
  confirmationsCover,
  isInstallationUpdate,
  isPermissionConfirmation,
  isPermissionDelta,
  parseInstallationUpdate,
  parsePermissionConfirmation,
  parsePermissionDelta,
  permissionDeltaOf,
  permissionSummary,
  rollBackAppliedUpdate,
  stageInstallationUpdate,
} from './update';
import type { PermissionConfirmation } from './update';
import { installationLinkIdOf, releaseIdOf, updateIdOf } from './identity';
import {
  adminActor,
  knownFixtureActions,
  operatorActor,
  rawManifestPatch,
  rawManifestV1,
  rawManifestV2,
  T0,
  TENANT_A,
  unwrap,
  V1,
  V2,
} from './test-support';

// OFF-027 marketplace — updates with permission-delta review: the A9 delta
// computation keyed on (capability, scope kind), the fresh-grant confirmation
// discipline (added capabilities require EXACT coverage — none missing, none
// spurious, none duplicated), and the staged → applied → rolled-back record
// lifecycle with strict provenance consistency.
describe('marketplace updates (OFF-027)', () => {
  const manifest = (raw: unknown): AppManifest =>
    unwrap(
      reviewAppManifest(raw, {
        actions: knownFixtureActions(),
        apps: { versions: () => null },
      }),
    );

  const manifestV1 = (): AppManifest => manifest(rawManifestV1);
  const manifestV2 = (): AppManifest => manifest(rawManifestV2);
  const manifestPatch = (): AppManifest => manifest(rawManifestPatch);

  const linkId = installationLinkIdOf({
    tenantId: TENANT_A,
    installationId: 'office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2',
  });
  const releaseV1 = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V1 });
  const releaseV2 = releaseIdOf({ appId: 'progress-recorder', manifestVersion: V2 });

  const confirmation = (raw: {
    readonly capability: string;
    readonly scopeKind: 'tenant' | 'project';
  }): PermissionConfirmation =>
    unwrap(parsePermissionConfirmation({ kind: 'update-confirmation', ...raw }));

  const staged = () =>
    stageInstallationUpdate({
      linkId,
      tenantId: TENANT_A,
      appId: manifestV1().appId,
      fromReleaseId: releaseV1,
      fromVersion: V1,
      toReleaseId: releaseV2,
      toVersion: V2,
      permissionDelta: permissionDeltaOf(manifestV1(), manifestV2()),
      stagedAt: T0,
      stagedBy: adminActor(),
    });

  // ----- the permission delta (the A9 review) ---------------------------------------------

  it('computes the added/removed/unchanged footprint keyed on (capability, scope kind)', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    // v2 adds exactly the tenant-scoped cost.read spec; nothing is removed;
    // both v1 project-scoped specs carry over unchanged.
    expect(delta.added).toStrictEqual([
      { kind: 'app-permission', capability: 'cost.read', scopeKind: 'tenant', version: 1 },
    ]);
    expect(delta.removed).toStrictEqual([]);
    expect(delta.unchanged.map(permissionSummary)).toStrictEqual([
      'work.read@project',
      'work.write@project',
    ]);
    expect(addsCapability(delta)).toBe(true);
  });

  it('an unchanged-capability patch release has an empty added list (no confirmation needed)', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestPatch());
    expect(delta.added).toStrictEqual([]);
    expect(delta.removed).toStrictEqual([]);
    expect(delta.unchanged.map(permissionSummary)).toStrictEqual([
      'work.read@project',
      'work.write@project',
    ]);
    expect(addsCapability(delta)).toBe(false);
  });

  it('a capability drop lands in removed; a declaration-version bump stays unchanged', () => {
    // v1.6.0 keeps work.write (bumped to declaration version 2) and drops work.read.
    const reduced = {
      ...rawManifestV1,
      manifestVersion: '1.6.0',
      permissions: [
        { kind: 'app-permission', capability: 'work.write', scopeKind: 'project', version: 2 },
      ],
    };
    const delta = permissionDeltaOf(manifestV1(), manifest(reduced));
    expect(delta.added).toStrictEqual([]);
    expect(delta.removed.map(permissionSummary)).toStrictEqual(['work.read@project']);
    expect(delta.unchanged).toStrictEqual([
      { kind: 'app-permission', capability: 'work.write', scopeKind: 'project', version: 2 },
    ]);
    // the version bump within the same key does NOT add capability footprint
    expect(addsCapability(delta)).toBe(false);
  });

  it('the delta is pure and canonically ordered (run-twice identical)', () => {
    const first = permissionDeltaOf(manifestV1(), manifestV2());
    const second = permissionDeltaOf(manifestV1(), manifestV2());
    expect(first).toStrictEqual(second);
    expect(first.added.map(permissionSummary)).toStrictEqual(['cost.read@tenant']);
  });

  it('parses a permission delta round-trip and rejects malformed ones', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    expect(unwrap(parsePermissionDelta(delta))).toStrictEqual(delta);
    expect(isPermissionDelta(delta)).toBe(true);
    expect(parsePermissionDelta({ ...delta, extra: true }).ok).toBe(false);
    expect(parsePermissionDelta({ added: 'nope', removed: [], unchanged: [] }).ok).toBe(false);
    expect(
      parsePermissionDelta({
        added: [{ kind: 'app-permission', capability: 'nope.read', scopeKind: 'project', version: 1 }],
        removed: [],
        unchanged: [],
      }).ok,
    ).toBe(false);
    expect(parsePermissionDelta(null).ok).toBe(false);
  });

  // ----- the fresh grant confirmations -----------------------------------------------------

  it('parses confirmations against the CLOSED authz vocabulary (fail-closed)', () => {
    expect(unwrap(parsePermissionConfirmation(confirmation({ capability: 'cost.read', scopeKind: 'tenant' })))).toStrictEqual({
      kind: 'update-confirmation',
      capability: capability('cost.read'),
      scopeKind: 'tenant',
    });
    expect(isPermissionConfirmation(confirmation({ capability: 'cost.read', scopeKind: 'tenant' }))).toBe(true);
    // not a declared capability → typed rejection
    expect(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'nope.read', scopeKind: 'tenant' }).ok).toBe(false);
    expect(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'cost.read', scopeKind: 'global' }).ok).toBe(false);
    expect(parsePermissionConfirmation({ kind: 'grant', capability: 'cost.read', scopeKind: 'tenant' }).ok).toBe(false);
    expect(parsePermissionConfirmation({ kind: 'update-confirmation', capability: 'cost.read', scopeKind: 'tenant', extra: 1 }).ok).toBe(false);
    expect(parsePermissionConfirmation(null).ok).toBe(false);
  });

  it('an added-capability update without confirmation is typed-rejected (confirmation-required)', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    const rejected = confirmationsCover(delta, []);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('confirmation-required');
    }
  });

  it('a confirmation for a capability not being added is typed-rejected (unexpected-confirmation)', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    const spurious = confirmationsCover(delta, [
      confirmation({ capability: 'work.read', scopeKind: 'project' }),
    ]);
    expect(spurious.ok).toBe(false);
    if (!spurious.ok) {
      expect(spurious.error.details[0]?.code).toBe('unexpected-confirmation');
    }
  });

  it('duplicate confirmations are typed-rejected (duplicate-confirmation)', () => {
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    const duplicated = confirmationsCover(delta, [
      confirmation({ capability: 'cost.read', scopeKind: 'tenant' }),
      confirmation({ capability: 'cost.read', scopeKind: 'tenant' }),
    ]);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.details[0]?.code).toBe('duplicate-confirmation');
    }
  });

  it('an unchanged-capability update proceeds without confirmation; exact coverage applies', () => {
    const patchDelta = permissionDeltaOf(manifestV1(), manifestPatch());
    expect(confirmationsCover(patchDelta, []).ok).toBe(true);
    // a spurious confirmation on an unchanged-capability update is still rejected
    const spurious = confirmationsCover(patchDelta, [
      confirmation({ capability: 'work.read', scopeKind: 'project' }),
    ]);
    expect(spurious.ok).toBe(false);
    // the full exact coverage of an added-capability delta applies
    const delta = permissionDeltaOf(manifestV1(), manifestV2());
    expect(confirmationsCover(delta, [confirmation({ capability: 'cost.read', scopeKind: 'tenant' })]).ok).toBe(true);
  });

  it('renders audit summaries', () => {
    const addedSpec = unwrap(
      parsePermissionSpec({ kind: 'app-permission', capability: 'cost.read', scopeKind: 'tenant', version: 1 }),
    );
    expect(permissionSummary(addedSpec)).toBe('cost.read@tenant');
    expect(confirmationSummary(confirmation({ capability: 'cost.read', scopeKind: 'tenant' }))).toBe('cost.read@tenant');
  });

  // ----- the staged/applied/rolled-back record lifecycle ------------------------------------

  it('stages an update with a derived id and no apply/rollback provenance', () => {
    const update = staged();
    expect(update.kind).toBe('installation-update');
    expect(update.state).toBe('staged');
    expect(update.updateId).toBe(
      updateIdOf({ linkId, fromReleaseId: releaseV1, toReleaseId: releaseV2 }),
    );
    expect(update.confirmations).toStrictEqual([]);
    expect(update.appliedAt).toBeNull();
    expect(update.appliedBy).toBeNull();
    expect(update.rolledBackAt).toBeNull();
    expect(update.rolledBackBy).toBeNull();
    expect(staged().updateId).toBe(staged().updateId);
    expect(isInstallationUpdate(update)).toBe(true);
  });

  it('parses an update record round-trip and rejects provenance inconsistencies', () => {
    const update = staged();
    expect(unwrap(parseInstallationUpdate(update))).toStrictEqual(update);
    expect(parseInstallationUpdate({ ...update, extra: true }).ok).toBe(false);
    expect(parseInstallationUpdate({ ...update, state: 'committed' }).ok).toBe(false);
    // a staged record carrying apply provenance
    expect(parseInstallationUpdate({ ...update, appliedAt: T0 }).ok).toBe(false);
    // an applied record without apply provenance
    const applied = applyStagedUpdate(update, {
      confirmations: [confirmation({ capability: 'cost.read', scopeKind: 'tenant' })],
      at: T0,
      by: operatorActor(),
    });
    expect(parseInstallationUpdate({ ...applied, appliedAt: null }).ok).toBe(false);
    // a rolled-back record without rollback provenance
    const rolledBack = rollBackAppliedUpdate(applied, { at: T0, by: adminActor() });
    expect(parseInstallationUpdate({ ...rolledBack, rolledBackAt: null }).ok).toBe(false);
    // a non-rolled-back record carrying rollback provenance
    expect(parseInstallationUpdate({ ...update, rolledBackAt: T0 }).ok).toBe(false);
    expect(parseInstallationUpdate(null).ok).toBe(false);
  });

  it('applies a staged update: the accepted confirmations are recorded on the update', () => {
    const confirmations = [confirmation({ capability: 'cost.read', scopeKind: 'tenant' })];
    const applied = applyStagedUpdate(staged(), {
      confirmations,
      at: T0,
      by: operatorActor(),
    });
    expect(applied.state).toBe('applied');
    expect(applied.confirmations).toStrictEqual(confirmations);
    expect(applied.appliedAt).toBe(T0);
    expect(applied.appliedBy).toEqual(operatorActor());
    expect(applied.rolledBackAt).toBeNull();
    // applying a non-staged update throws loudly
    expect(() =>
      applyStagedUpdate(applied, { confirmations: [], at: T0, by: operatorActor() }),
    ).toThrow(TypeError);
  });

  it('rolls an applied update back with rollback provenance, never touching the releases', () => {
    const applied = applyStagedUpdate(staged(), {
      confirmations: [confirmation({ capability: 'cost.read', scopeKind: 'tenant' })],
      at: T0,
      by: operatorActor(),
    });
    const rolledBack = rollBackAppliedUpdate(applied, { at: T0, by: adminActor() });
    expect(rolledBack.state).toBe('rolled-back');
    expect(rolledBack.rolledBackAt).toBe(T0);
    expect(rolledBack.rolledBackBy).toEqual(adminActor());
    // the from/to pair is preserved — rollback is a record transition, not a rewrite
    expect(rolledBack.fromReleaseId).toBe(releaseV1);
    expect(rolledBack.toReleaseId).toBe(releaseV2);
    // rolling back a non-applied update throws loudly
    expect(() => rollBackAppliedUpdate(staged(), { at: T0, by: adminActor() })).toThrow(TypeError);
    expect(() => rollBackAppliedUpdate(rolledBack, { at: T0, by: adminActor() })).toThrow(TypeError);
  });
});
