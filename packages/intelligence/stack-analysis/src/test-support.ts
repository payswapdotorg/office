// Office intelligence — package-internal test support (OFF-035).
//
// NOT part of the public surface: deterministic factories for the typed
// values the golden stack analysis scenarios need — the observed external
// systems (built through the adapters-sdk's own capabilities grammar),
// the marketplace app fixtures (manifests parsed through the app-sdk's own
// fail-closed parser; releases/entitlements/links built through the
// marketplace's own trusted builders and parsers), the memory outcome/
// benchmark fixtures (structurally complete typed literals — the single
// documented branded cast is the currency code the memory model brands
// through the margin package this package may not import), and the stack
// authorizations. Fixed clock, fixed ids, fixed correlation/causation
// tokens: no Date.now, no Math.random, no environment.
import {
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandName,
  parseEventName,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  CommandName,
  EntityId,
  EventName,
  Scope,
  Timestamp,
} from '@office/contracts';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { appId, appVersion, parseAppManifest, versionRange } from '@office/app-sdk';
import type { AppManifest } from '@office/app-sdk';
import {
  grantEntitlement,
  installationLinkIdOf,
  parseInstallationLink,
  publishReleaseRecord,
  publisherIdOf,
  releaseIdOf,
} from '@office/marketplace';
import type {
  AppRelease,
  Entitlement,
  InstallationLink,
  PublisherId,
} from '@office/marketplace';
import { rationalOf, parseBenchmarkId, parseOutcomeId } from '@office/intelligence-memory';
import type {
  Benchmark,
  BenchmarkId,
  OutcomeId,
  OutcomeRecord,
  Rational,
} from '@office/intelligence-memory';
import { adapterKind, parseAdapterCapabilities, providerSystemId } from '@office/adapters-sdk';
import { parseStackScanId } from './vocabulary';
import type { StackScanId } from './vocabulary';
import type { ObservedExternalSystem } from './coverage';
import type { StackAuthorization } from './authorization';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

/** The fixed test clock (deterministic — replayed scenarios replay exactly). */
export const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T08:00:00.000Z'));
export const T1: Timestamp = unwrap(parseTimestamp('2026-09-13T09:30:00.000Z'));
export const T2: Timestamp = unwrap(parseTimestamp('2026-09-14T11:45:00.000Z'));
export const T3: Timestamp = unwrap(parseTimestamp('2026-09-15T14:15:00.000Z'));
export const T4: Timestamp = unwrap(parseTimestamp('2026-09-16T16:45:00.000Z'));
export const T5: Timestamp = unwrap(parseTimestamp('2026-09-17T10:00:00.000Z'));

/** The fixed marketplace lifecycle clock (publish → grant → link). */
export const PUBLISHED_AT: Timestamp = unwrap(parseTimestamp('2026-09-18T09:00:00.000Z'));
export const GRANTED_AT: Timestamp = unwrap(parseTimestamp('2026-09-19T09:00:00.000Z'));
export const LINKED_AT: Timestamp = unwrap(parseTimestamp('2026-09-20T09:00:00.000Z'));

/** The fixed scan clock (the injected `assessedAt` of every golden scan). */
export const ASSESSED_AT: Timestamp = unwrap(parseTimestamp('2026-09-21T09:00:00.000Z'));

/** The fixed record/compute clocks of the memory fixtures (injected). */
export const RECORDED_AT: Timestamp = unwrap(parseTimestamp('2026-09-22T09:00:00.000Z'));
export const COMPUTED_AT: Timestamp = unwrap(parseTimestamp('2026-09-23T09:00:00.000Z'));

/** Two tenants (A12 isolation tests run in BOTH directions). */
export const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const TENANT_B = formatTenantId({
  version: 'v1',
  opaque: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
});

/** Two projects of tenant A (the completed history the outcomes record). */
export const PROJECT_1 = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
export const PROJECT_2 = formatProjectId({
  version: 'v1',
  opaque: 'a9f8e7d6c5b4a39281706f5e4d3c2b10',
});

/** The fixed acting user (a canonical actor, not a provider identity). */
export const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
export const USER_ACTOR: Actor = { kind: 'user', actorId: ACTOR_ID };

export const projectOneScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_1,
});

export const projectTwoScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_2,
});

export const tenantAScope = (): Scope => ({
  kind: 'tenant',
  tenantId: TENANT_A,
});

export const tenantBScope = (): Scope => ({
  kind: 'tenant',
  tenantId: TENANT_B,
});

/** Deterministic entity ids: <prefix><n> padded to the 16-char opaque minimum. */
export const testId = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

/** Deterministic correlation/causation tokens (one per causal chain). */
export const testCorrelationId = (n: number): string => `corr-${String(n).padStart(8, '0')}`;

/** Deterministic scan identities (the injected tokens of the golden scans). */
export const testScanId = (n: number): StackScanId =>
  unwrap(parseStackScanId(`scan-${String(n).padStart(4, '0')}`));

/** Deterministic outcome identities (the history fixture tokens). */
export const testOutcomeId = (n: number): OutcomeId =>
  unwrap(parseOutcomeId(`outcome-${String(n).padStart(4, '0')}`));

/** Deterministic benchmark identities (the history fixture tokens). */
export const testBenchmarkId = (n: number): BenchmarkId =>
  unwrap(parseBenchmarkId(`benchmark-${String(n).padStart(4, '0')}`));

// ---------------------------------------------------------------------------
// Policies + authorizations.
// ---------------------------------------------------------------------------

/** The allow-all-reads policy: every read within the caller's covered scope. */
export const ALLOW_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'allow', actions: ['read'] },
]);

/** The explicit-deny-every-read policy (explicit deny wins over any allow). */
export const DENY_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'deny', actions: ['read'] },
]);

/** A policy denying reads of one resource kind (exclusion probes). */
export const denyKindPolicy = (resourceKind: string): Policy =>
  definePolicy([{ effect: 'deny', resourceKinds: [resourceKind] }]);

/** The default stack scan/read authorization (all four required capabilities). */
export const stackAuthorizationOf = (
  scope: Scope,
  policy: Policy = ALLOW_ALL_READS_POLICY,
  capabilities: readonly string[] = [
    'apps.read',
    'contracts.read',
    'cost.read',
    'schedule.read',
  ],
): StackAuthorization => ({
  policy,
  context: authorizationContext({
    actor: USER_ACTOR,
    scope,
    capabilities,
  }),
});

// ---------------------------------------------------------------------------
// Observed external systems (the adapters-sdk vocabulary).
// ---------------------------------------------------------------------------

/** One declared object-kind surface of an observed system fixture. */
export interface SystemObjectFixture {
  readonly objectKind: string;
  readonly canonicalKind: string;
  readonly capability: string;
}

/** Build one observed external system through the adapters-sdk's own grammar. */
export const fixtureSystem = (parts: {
  readonly tenantId: ReturnType<typeof formatTenantId>;
  readonly adapterKind: string;
  readonly systemId: string;
  readonly objectKinds: readonly SystemObjectFixture[];
}): ObservedExternalSystem => {
  const capabilities = unwrap(
    parseAdapterCapabilities({
      objectKinds: parts.objectKinds.map((entry) => ({
        objectKind: entry.objectKind,
        canonicalKind: entry.canonicalKind,
        capability: entry.capability,
      })),
    }),
  );
  return {
    kind: 'observed-external-system',
    tenantId: parts.tenantId,
    adapterKind: adapterKind(parts.adapterKind),
    systemId: providerSystemId(parts.systemId),
    capabilities,
  };
};

// ---------------------------------------------------------------------------
// Marketplace app fixtures (manifest → release → entitlement → link).
// ---------------------------------------------------------------------------

/** One declared permission of an app manifest fixture. */
export interface AppPermissionFixture {
  readonly capability: string;
  readonly scopeKind: 'tenant' | 'project';
}

/** Build one app manifest through the app-sdk's own fail-closed parser. */
export const fixtureManifest = (parts: {
  readonly appId: string;
  readonly manifestVersion: string;
  readonly title: string;
  readonly permissions: readonly AppPermissionFixture[];
  readonly commands: readonly string[];
  readonly events: readonly string[];
}): AppManifest =>
  unwrap(
    parseAppManifest({
      kind: 'app-manifest',
      schemaVersion: '1.0.0',
      appId: parts.appId,
      manifestVersion: parts.manifestVersion,
      title: parts.title,
      description: `${parts.title} fixture.`,
      permissions: parts.permissions.map((permission) => ({
        kind: 'app-permission',
        capability: permission.capability,
        scopeKind: permission.scopeKind,
        version: 1,
      })),
      bindings: parts.commands.map((command) => ({
        kind: 'command-binding',
        commandName: command,
        handler: {
          kind: 'app-handler',
          handlerId: command.replace(/\./g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
          title: command,
          description: null,
        },
        actionClass: 'read',
      })),
      subscriptions: parts.events.map((event) => ({
        kind: 'event-subscription',
        eventName: event,
        filter: { kind: 'all' },
      })),
      uiExtensions: [],
      dependencies: [],
    }),
  );

/** The tenant-B fixture publisher (catalog records are publisher-tenant-scoped). */
export const FIXTURE_PUBLISHER: PublisherId = publisherIdOf({
  tenantId: TENANT_B,
  displayName: 'publisher-one',
  apps: [],
});

/** The derived release id of one fixture release (app id + manifest version). */
export const releaseFixtureId = (appIdValue: string, manifestVersion: string): string =>
  releaseIdOf({
    appId: appId(appIdValue),
    manifestVersion: appVersion(manifestVersion),
  });

/** Build one published release through the marketplace's trusted builder. */
export const fixtureRelease = (manifest: AppManifest): AppRelease =>
  publishReleaseRecord({
    manifest,
    publisherId: FIXTURE_PUBLISHER,
    tenantId: TENANT_B,
    publishedAt: PUBLISHED_AT,
    publishedBy: USER_ACTOR,
  });

/** Build one active tenant entitlement through the marketplace's trusted builder. */
export const fixtureEntitlement = (parts: {
  readonly tenantId: ReturnType<typeof formatTenantId>;
  readonly appId: string;
  readonly range: string;
  readonly ordinal: number;
}): Entitlement =>
  grantEntitlement({
    tenantId: parts.tenantId,
    appId: appId(parts.appId),
    versionRange: versionRange(parts.range),
    grantOrdinal: parts.ordinal,
    grantedAt: GRANTED_AT,
    grantedBy: USER_ACTOR,
  });

/** Build one linked installation link (typed literal + the marketplace parser). */
export const fixtureLink = (parts: {
  readonly tenantId: ReturnType<typeof formatTenantId>;
  readonly installationId: EntityId;
  readonly appId: string;
  readonly releaseId: string;
  readonly currentVersion: string;
  readonly entitlementId: string;
}): InstallationLink =>
  unwrap(
    parseInstallationLink({
      kind: 'installation-link',
      linkId: installationLinkIdOf({
        tenantId: parts.tenantId,
        installationId: parts.installationId,
      }),
      installationId: parts.installationId,
      tenantId: parts.tenantId,
      appId: parts.appId,
      releaseId: parts.releaseId,
      currentVersion: parts.currentVersion,
      entitlementId: parts.entitlementId,
      runtimeLifecycle: 'active',
      state: 'linked',
      linkedAt: LINKED_AT,
      linkedBy: USER_ACTOR,
      updatedAt: null,
      updatedBy: null,
      unlinkedAt: null,
      unlinkedBy: null,
    }),
  );

// ---------------------------------------------------------------------------
// Memory fixtures (the observed-performance basis).
// ---------------------------------------------------------------------------

const half: Rational = unwrap(rationalOf(1, 2));
const zero: Rational = unwrap(rationalOf(0, 1));
const one: Rational = unwrap(rationalOf(1, 1));

/**
 * Build one structurally complete OutcomeRecord fixture (the memory
 * engine's typed record shape — built as a typed literal with one
 * documented branded cast: the currency code, branded through the margin
 * package this package may not import).
 */
export const fixtureOutcomeRecord = (parts: {
  readonly outcomeId: OutcomeId;
  readonly projectId: ReturnType<typeof formatProjectId>;
  readonly varianceDays: number;
  readonly changeEventCount: number;
}): OutcomeRecord =>
  ({
    outcomeId: parts.outcomeId,
    outcomeVersion: 1,
    engine: 'intelligence-memory',
    recordedAt: RECORDED_AT,
    actor: USER_ACTOR,
    scope: {
      kind: 'project',
      tenantId: TENANT_A,
      projectId: parts.projectId,
    },
    projectId: parts.projectId,
    schedule: {
      baselineDurationDays: 40,
      finalDurationDays: 40 + parts.varianceDays,
      varianceDays: parts.varianceDays,
      sources: [],
    },
    margin: {
      currency: 'EUR',
      originalContractedValueMinor: 10_000_000,
      contractedValueMinor: 10_500_000,
      committedCostMinor: 8_000_000,
      projectedCostMinor: 8_400_000,
      marginMinor: 2_100_000,
      marginRatio: half,
      perContract: [],
      sources: [],
      eventSources: [],
    },
    entitlement: {
      approvedCount: 4,
      executedCount: 2,
      rejectedCount: 1,
      pendingCount: 1,
      approvedValueMinor: 400_000,
      rejectedValueMinor: 100_000,
      pendingValueMinor: 50_000,
      approvalRate: unwrap(rationalOf(6, 8)),
      orders: [],
      eventSources: [],
    },
    changePressure: {
      changeEventCount: parts.changeEventCount,
      changeOrderCount: 8,
      contractCount: 3,
      eventSources: [],
    },
    consumed: { projectedEventCount: 24, assessmentCount: 12 },
    evidence: [],
  }) as unknown as OutcomeRecord;

/** Build one structurally complete Benchmark fixture (typed literal). */
export const fixtureBenchmark = (parts: {
  readonly benchmarkId: BenchmarkId;
  readonly outcomeIds: readonly OutcomeId[];
}): Benchmark =>
  ({
    benchmarkId: parts.benchmarkId,
    benchmarkVersion: 1,
    engine: 'intelligence-memory',
    computedAt: COMPUTED_AT,
    actor: USER_ACTOR,
    scope: { kind: 'tenant', tenantId: TENANT_A },
    outcomeCount: parts.outcomeIds.length,
    metrics: [
      {
        kind: 'schedule-variance-days',
        outcomeIds: [...parts.outcomeIds],
        min: zero,
        max: unwrap(rationalOf(6, 1)),
        mean: unwrap(rationalOf(3, 1)),
        median: unwrap(rationalOf(3, 1)),
        percentile90: unwrap(rationalOf(6, 1)),
      },
      {
        kind: 'margin-ratio',
        outcomeIds: [...parts.outcomeIds],
        min: half,
        max: half,
        mean: half,
        median: half,
        percentile90: half,
      },
      {
        kind: 'entitlement-approval-rate',
        outcomeIds: [...parts.outcomeIds],
        min: unwrap(rationalOf(3, 4)),
        max: one,
        mean: unwrap(rationalOf(7, 8)),
        median: unwrap(rationalOf(7, 8)),
        percentile90: one,
      },
      {
        kind: 'change-event-count',
        outcomeIds: [...parts.outcomeIds],
        min: unwrap(rationalOf(7, 1)),
        max: unwrap(rationalOf(9, 1)),
        mean: unwrap(rationalOf(8, 1)),
        median: unwrap(rationalOf(8, 1)),
        percentile90: unwrap(rationalOf(9, 1)),
      },
    ],
    positions: [],
  }) as Benchmark;

/** Deterministic command/event name fixtures (grammar-validated). */
export const fixtureCommandName = (name: string): CommandName =>
  unwrap(parseCommandName(name));
export const fixtureEventName = (name: string): EventName => unwrap(parseEventName(name));
