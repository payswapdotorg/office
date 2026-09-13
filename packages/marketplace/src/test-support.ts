// Office marketplace — deterministic test support (OFF-027).
//
// The shared fixtures of the package's acceptance suites, mirroring the
// landed packages' test idioms (app-sdk/app-runtime): fixed tenants/actors/
// installations, an injected auto-ticking clock (no wall clock in logic —
// the fixture epoch is fixed), the fixture action descriptors (the
// structural ActionDescriptorSource the SDK's validation port accepts), the
// generic fixture app manifests (raw untrusted JSON — the publisher's
// submission form) with a permission DELTA between versions, canonical
// app-runtime installation records built through the runtime's own trusted
// builder (the host side of the linkage — the marketplace's LOGIC only ever
// sees the typed records), the canonical-world fixture + counting port for
// the A11 boundary proof, and typed Result assertion helpers.
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import { createHash } from 'node:crypto';
import { parseActor, parseCommandName, parseEntityId, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, EntityId, TenantId, Timestamp } from '@office/contracts';
import { actionDescriptorSource, parseAppId, parseAppVersion } from '@office/app-sdk';
import type { ActionClass, KnownAction } from '@office/app-sdk';
import { capability } from '@office/authz';
import { installInstallation } from '@office/app-runtime';
import type { AppInstallation } from '@office/app-runtime';
import type { CanonicalStatePort, CanonicalStateSnapshot } from './canonical-state';

// ----- typed Result assertion helpers -------------------------------------------------------

/** Any typed result shape (contracts ParseResult or kernel Result alike). */
export type AnyResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Unwrap a successful typed result of any shape (fails loud in tests). */
export const expectOk = <T>(result: AnyResult<T, unknown>): T => {
  if (result.ok) return result.value;
  throw new Error(`expected a typed success, got: ${JSON.stringify(result)}`);
};

/** Unwrap a failed typed result of any shape (fails loud in tests). */
export const expectFail = <T, E>(result: AnyResult<T, E>): E => {
  if (!result.ok) return result.error;
  throw new Error(`expected a typed failure, got: ${JSON.stringify(result.value)}`);
};

/** Unwrap a successful contracts ParseResult (fails loud in tests). */
export const unwrap = <T>(result: AnyResult<T, unknown>): T => expectOk(result);

// ----- fixed identities --------------------------------------------------------------------

export const TENANT_A: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);
export const TENANT_B: TenantId = unwrap(
  parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'),
);
export const ADMIN: EntityId = unwrap(
  parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'),
);
export const OPERATOR: EntityId = unwrap(
  parseEntityId('office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5'),
);
export const INSTALLATION_A: EntityId = unwrap(
  parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'),
);
export const INSTALLATION_B: EntityId = unwrap(
  parseEntityId('office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322'),
);
export const INSTALLATION_C: EntityId = unwrap(
  parseEntityId('office-ent-v1-5e4d3c2b1a0987654321fedcba9876543210'),
);

/** The fixed admin actor that registers publishers / grants entitlements. */
export const adminActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: ADMIN }));
/** The fixed operator actor that revokes / uninstalls. */
export const operatorActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: OPERATOR }));

// ----- the injected auto-ticking clock ------------------------------------------------------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 12, 10, 15, 31);

/** The fixture epoch (T0). */
export const T0: Timestamp = unwrap(parseTimestamp(new Date(BASE_EPOCH_MS).toISOString()));

/**
 * The deterministic injected clock: every call advances exactly one second
 * from the fixed fixture epoch. Two clocks created here and driven through
 * the same operation sequence tick identically (run-twice determinism).
 */
export const makeClock = (): { readonly now: () => Timestamp } => {
  let ticks = 0;
  return {
    now: (): Timestamp =>
      unwrap(parseTimestamp(new Date(BASE_EPOCH_MS + ticks++ * 1000).toISOString())),
  };
};

// ----- the canonical-world fixture (the A11 boundary proof) ---------------------------------

/**
 * A simulated canonical project state the acceptance harness owns: a
 * deterministic record set + a mutation log. The fingerprint is a sha256
 * digest over the whole world, so ANY canonical mutation changes it — which
 * is what makes "identical fingerprints before/after every marketplace
 * operation" a meaningful zero-mutation proof (the control test mutates the
 * world directly and watches the fingerprint move).
 */
export interface CanonicalWorld {
  /** Observe the canonical state (pure read; deterministic). */
  snapshot(): CanonicalStateSnapshot;
  /** Apply one canonical mutation (the CONTROL path — never the marketplace). */
  mutate(label: string): void;
  /** The canonical-state port view of this world (safe to hand the engine). */
  port(): CanonicalStatePort;
}

/** Create the deterministic canonical world fixture (seeded, empty log). */
export const createCanonicalWorld = (): CanonicalWorld => {
  const records: Record<string, { readonly title: string; readonly progress: number }> = {
    'project-alpha': { title: 'Project Alpha', progress: 0 },
  };
  const log: string[] = [];
  const snapshot = (): CanonicalStateSnapshot => ({
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ records, log }), 'utf8')
      .digest('hex'),
    mutationCount: log.length,
  });
  return {
    snapshot,
    mutate: (label) => {
      const record = records['project-alpha'];
      records['project-alpha'] = {
        title: record?.title ?? 'Project Alpha',
        progress: (record?.progress ?? 0) + 1,
      };
      log.push(label);
    },
    port: () => ({ snapshot }),
  };
};

/**
 * Wrap a canonical-state port in a COUNTING proxy: `calls` counts every
 * invocation that flowed through the port the ENGINE holds — the harness
 * reads the world directly through its own reference, so a non-zero count
 * can only be a marketplace invocation (the A11 behavioral proof).
 */
export const countingCanonicalStatePort = (
  port: CanonicalStatePort,
): { readonly port: CanonicalStatePort; readonly calls: () => number } => {
  let calls = 0;
  return {
    port: {
      snapshot: () => {
        calls += 1;
        return port.snapshot();
      },
    },
    calls: () => calls,
  };
};

// ----- the fixture action vocabulary --------------------------------------------------------

const RECORD_PROGRESS_COMMAND = unwrap(parseCommandName('field.recordProgress'));
const LIST_COST_ITEMS_COMMAND = unwrap(parseCommandName('cost.listCostItems'));

/** Reversible-class fixture: the sample command (work.write). */
export const RECORD_PROGRESS: KnownAction = {
  commandName: RECORD_PROGRESS_COMMAND,
  actionClass: 'reversible' as ActionClass,
  requiredCapabilities: [capability('work.write')],
};

/** Read-class fixture: the cost query the v2 release adds (cost.read). */
export const LIST_COST_ITEMS: KnownAction = {
  commandName: LIST_COST_ITEMS_COMMAND,
  actionClass: 'read' as ActionClass,
  requiredCapabilities: [capability('cost.read')],
};

/** The structural action-descriptor source over the fixture descriptors. */
export const fixtureActions = () => actionDescriptorSource({ find: () => null });

/** The fixture action source that KNOWS the two fixture commands. */
export const knownFixtureActions = () =>
  actionDescriptorSource({
    find: (commandName) => {
      if (commandName === RECORD_PROGRESS_COMMAND) return RECORD_PROGRESS;
      if (commandName === LIST_COST_ITEMS_COMMAND) return LIST_COST_ITEMS;
      return null;
    },
  });

// ----- the generic fixture app (publisher-01 style vocabulary) ------------------------------

export const PROGRESS_APP_ID = unwrap(parseAppId('progress-recorder'));
export const V1 = unwrap(parseAppVersion('1.4.0'));
export const V2 = unwrap(parseAppVersion('1.5.0'));
export const PATCH = unwrap(parseAppVersion('1.4.1'));

/** The publisher display fixture (generic vocabulary). */
export const PUBLISHER_NAME = 'publisher-01';

/**
 * The fixture app's RAW v1.4.0 manifest (the untrusted publisher
 * submission): two explicit project-scoped permission specs (work.read /
 * work.write) and ONE reversible command binding.
 */
export const rawManifestV1 = {
  kind: 'app-manifest',
  schemaVersion: '1.0.0',
  appId: 'progress-recorder',
  manifestVersion: '1.4.0',
  title: 'Progress Recorder',
  description: 'Records daily field progress against the plan.',
  permissions: [
    { kind: 'app-permission', capability: 'work.read', scopeKind: 'project', version: 1 },
    { kind: 'app-permission', capability: 'work.write', scopeKind: 'project', version: 1 },
  ],
  bindings: [
    {
      kind: 'command-binding',
      commandName: 'field.recordProgress',
      handler: {
        kind: 'app-handler',
        handlerId: 'record-progress-handler',
        title: 'Record progress',
        description: 'Records one progress observation.',
      },
      actionClass: 'reversible',
    },
  ],
  subscriptions: [
    {
      kind: 'event-subscription',
      eventName: 'work.progressRecorded',
      filter: { kind: 'entity-kind', entityKind: 'field-report' },
    },
  ],
  uiExtensions: [],
  dependencies: [],
} as const;

/**
 * The fixture app's RAW v1.5.0 manifest: ADDS the tenant-scoped cost.read
 * permission spec and the cost.listCostItems read binding — the
 * permission-delta update (added capability requires fresh confirmation).
 */
export const rawManifestV2 = {
  ...rawManifestV1,
  manifestVersion: '1.5.0',
  description: 'Records daily field progress and reads cost context.',
  permissions: [
    ...rawManifestV1.permissions,
    { kind: 'app-permission', capability: 'cost.read', scopeKind: 'tenant', version: 1 },
  ],
  bindings: [
    ...rawManifestV1.bindings,
    {
      kind: 'command-binding',
      commandName: 'cost.listCostItems',
      handler: {
        kind: 'app-handler',
        handlerId: 'list-cost-items-handler',
        title: 'List cost items',
        description: 'Lists the cost items of the project.',
      },
      actionClass: 'read',
    },
  ],
} as const;

/**
 * The fixture app's RAW v1.4.1 manifest: a patch release with an UNCHANGED
 * capability footprint (same permissions as v1.4.0) — the
 * unchanged-capability update that applies WITHOUT confirmation.
 */
export const rawManifestPatch = {
  ...rawManifestV1,
  manifestVersion: '1.4.1',
  description: 'Records daily field progress (patch).',
} as const;

// ----- canonical app-runtime installation fixtures (the host side) ---------------------------

/** Build a canonical app-runtime installation record for the fixture app. */
export const fixtureInstallation = (
  installationId: EntityId,
  tenantId: TenantId,
  manifestVersion: string,
  installedAt: Timestamp,
): AppInstallation =>
  installInstallation({
    installationId,
    tenantId,
    appId: PROGRESS_APP_ID,
    manifestVersion: unwrap(parseAppVersion(manifestVersion)),
    installedAt,
    installedBy: adminActor(),
  });
