// Office intelligence — the stack analysis engine's coverage measurement
// (OFF-035): the typed scan-input model + THE deterministic workflow
// coverage measurement.
//
// THE discipline: coverage is MEASURED, never declared. An external
// system's observed workflow/capability surface is exactly the capability
// set its adapter's declared object-kind surfaces span (the adapters-sdk's
// provider-neutral vocabulary — one capability per provider object kind,
// each evidenced by the object kinds declaring it); an installed app's
// declared capability surface is exactly the capability set its pinned
// marketplace release's manifest permissions declare (the app-sdk's A9
// explicit declarations, each evidenced by the permission specs declaring
// it — the landed manifest validation guarantees every capability a bound
// command REQUIRES is declared, so the permission set is the complete
// surface). The app's observed command/event surfaces (the manifest's
// command bindings and event subscriptions) are carried as workflow
// EVIDENCE alongside the capability set.
//
// The measured-portfolio rule (documented, deterministic, tallied — never
// silent): the installed app portfolio is the installation links in state
// 'linked' whose referenced entitlements are ACTIVE; severed links and
// revoked-entitlement links are skipped and counted in the scan's consumed
// provenance. Releases are CATALOG records (publisher-tenant-scoped by
// design) resolved THROUGH the tenant's own links — the A12 gate applies to
// the tenant-owned link, not the catalog record it pins.
//
// Everything here is pure typed computation over validated records: no
// clock, no randomness, no I/O; every list is canonically ordered, so the
// input arrays' order never matters.
import { isEntityId, isScope, isTenantId } from '@office/contracts';
import type {
  CommandName,
  EntityId,
  EventName,
  TenantId,
} from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { Capability } from '@office/authz';
import {
  isAdapterKind,
  isProviderSystemId,
  parseAdapterCapabilities,
} from '@office/adapters-sdk';
import type {
  AdapterCapabilities,
  AdapterKind,
  ProviderObjectKind,
  ProviderSystemId,
} from '@office/adapters-sdk';
import type { AppId, AppManifest, AppVersion, PermissionSpec } from '@office/app-sdk';
import { parseAppRelease, parseEntitlement, parseInstallationLink } from '@office/marketplace';
import type {
  AppRelease,
  Entitlement,
  EntitlementId,
  InstallationLink,
  InstallationLinkId,
  ReleaseId,
} from '@office/marketplace';
import { isBenchmarkId, isOutcomeId } from '@office/intelligence-memory';
import type { Benchmark, OutcomeRecord } from '@office/intelligence-memory';
import {
  compareAppInstallationRefs,
  compareCapabilities,
  compareExternalSystemRefs,
} from './model';
import type { AppInstallationRef, ExternalSystemRef } from './model';

// ---------------------------------------------------------------------------
// The scan-input model (typed read surfaces of the landed packages).
// ---------------------------------------------------------------------------

/**
 * One observed external system of the scanned tenant: the adapters-sdk's
 * provider-neutral observed-system vocabulary — which adapter family
 * observes it, which provider system it is, and the declared object-kind
 * surfaces it syncs (the typed capability surface the coverage measurement
 * derives from). This is the SDK's READ surface only: the engine never
 * constructs, connects, or executes an adapter.
 */
export interface ObservedExternalSystem {
  readonly kind: 'observed-external-system';
  /** The tenant whose portfolio the system was observed in (A12). */
  readonly tenantId: TenantId;
  /** The adapter family kind observing the system (generic vocabulary). */
  readonly adapterKind: AdapterKind;
  /** The provider system id (the observed external system's identity). */
  readonly systemId: ProviderSystemId;
  /** The declared object-kind sync surfaces (the adapters-sdk vocabulary). */
  readonly capabilities: AdapterCapabilities;
}

/**
 * THE scan inputs: the tenant's observed external systems, the marketplace
 * records resolving its installed apps (installation links + the releases
 * and entitlements they reference), and the memory engine's observed facts
 * (the observed-performance basis). Records only — there is NO score,
 * weight, threshold, or manual input of any kind anywhere in this shape
 * (the strict fail-closed validation rejects any unknown field, so a
 * manual score fed here is a typed rejection).
 */
export interface StackScanInputs {
  /** The observed external systems (the adapters-sdk vocabulary). */
  readonly systems: readonly ObservedExternalSystem[];
  /** The marketplace releases referenced by the tenant's installation links. */
  readonly releases: readonly AppRelease[];
  /** The marketplace entitlements referenced by the tenant's installation links. */
  readonly entitlements: readonly Entitlement[];
  /** The tenant's marketplace installation links (what is installed). */
  readonly links: readonly InstallationLink[];
  /** The tenant's memory outcome records (the observed-performance basis; may be empty). */
  readonly outcomes: readonly OutcomeRecord[];
  /** The tenant's memory benchmark facts (the observed-performance basis; may be empty). */
  readonly benchmarks: readonly Benchmark[];
}

/** One measured installed app: the link + its resolved release/entitlement + the pinned manifest. */
export interface MeasuredInstallation {
  readonly link: InstallationLink;
  readonly release: AppRelease;
  readonly entitlement: Entitlement;
  readonly manifest: AppManifest;
}

/** The validated scan inputs, every list in its canonical order. */
export interface ValidatedStackInputs {
  readonly systems: readonly ObservedExternalSystem[];
  readonly releases: readonly AppRelease[];
  readonly entitlements: readonly Entitlement[];
  readonly links: readonly InstallationLink[];
  readonly outcomes: readonly OutcomeRecord[];
  readonly benchmarks: readonly Benchmark[];
}

// ---------------------------------------------------------------------------
// Fail-closed input validation (strict keys + re-parse + duplicates +
// cross-reference resolution). Every record is re-validated through its
// OWNING package's parser wherever one exists (the adapters-sdk's
// capabilities parser, the marketplace's release/entitlement/link parsers)
// — the engines-treat-output-as-untrusted discipline — and strict keys are
// enforced everywhere, so an unknown field (a manual score, for instance)
// is a typed rejection, never a silently ignored one.
// ---------------------------------------------------------------------------

const STACK_INPUT_KEYS = [
  'systems',
  'releases',
  'entitlements',
  'links',
  'outcomes',
  'benchmarks',
] as const;

const OBSERVED_SYSTEM_KEYS = [
  'kind',
  'tenantId',
  'adapterKind',
  'systemId',
  'capabilities',
] as const;

const OUTCOME_RECORD_KEYS = [
  'outcomeId',
  'outcomeVersion',
  'engine',
  'recordedAt',
  'actor',
  'scope',
  'projectId',
  'schedule',
  'margin',
  'entitlement',
  'changePressure',
  'consumed',
  'evidence',
] as const;

const BENCHMARK_KEYS = [
  'benchmarkId',
  'benchmarkVersion',
  'engine',
  'computedAt',
  'actor',
  'scope',
  'outcomeCount',
  'metrics',
  'positions',
] as const;

const stackInputFailure = (reason: string, path: string): DomainError =>
  domainError(
    'invariant-violation',
    `the stack analysis scan inputs are invalid: ${reason}`,
    [{ code: 'stack-input-invalid', message: reason, path }],
  );

const isPlainRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** Strict-keys check: an unknown field is a typed rejection (never ignored). */
const requireStrictKeys = (
  raw: unknown,
  keys: readonly string[],
  path: string,
): Result<Record<string, unknown>, DomainError> => {
  if (!isPlainRecord(raw)) {
    return fail(stackInputFailure(`expected a record at '${path}'`, path));
  }
  const present = Object.keys(raw);
  const unknown = present.filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    return fail(
      stackInputFailure(
        `unknown field(s) ${unknown
          .map((key) => `'${key}'`)
          .join(', ')} at '${path}' — the scan accepts records only (no score, weight, or manual input of any kind)`,
        path,
      ),
    );
  }
  return ok(raw);
};

const validateObservedSystem = (
  raw: unknown,
  index: number,
): Result<ObservedExternalSystem, DomainError> => {
  const path = `systems[${index}]`;
  const record = requireStrictKeys(raw, OBSERVED_SYSTEM_KEYS, path);
  if (!record.ok) return record;
  if (record.value['kind'] !== 'observed-external-system') {
    return fail(
      stackInputFailure(`expected kind 'observed-external-system' at '${path}'`, `${path}.kind`),
    );
  }
  const tenantId = record.value['tenantId'];
  if (!isTenantId(tenantId)) {
    return fail(stackInputFailure(`expected a tenant id at '${path}'`, `${path}.tenantId`));
  }
  const adapterKind = record.value['adapterKind'];
  if (!isAdapterKind(adapterKind)) {
    return fail(stackInputFailure(`expected an adapter kind at '${path}'`, `${path}.adapterKind`));
  }
  const systemId = record.value['systemId'];
  if (!isProviderSystemId(systemId)) {
    return fail(stackInputFailure(`expected a provider system id at '${path}'`, `${path}.systemId`));
  }
  const capabilities = record.value['capabilities'];
  if (!isPlainRecord(capabilities)) {
    return fail(
      stackInputFailure(`expected adapter capabilities at '${path}'`, `${path}.capabilities`),
    );
  }
  // Re-parse through the adapters-sdk's own strict parser (untrusted-input
  // discipline: unique object kinds, >= 1, declared capabilities only).
  const parsed = parseAdapterCapabilities(capabilities);
  if (!parsed.ok) {
    return fail(
      stackInputFailure(
        `the observed system's declared capabilities failed the adapters-sdk grammar: ${parsed.error.code} at '${parsed.error.path === '' ? '<root>' : parsed.error.path}'`,
        `${path}.capabilities`,
      ),
    );
  }
  return ok({
    kind: 'observed-external-system',
    tenantId,
    adapterKind,
    systemId,
    capabilities: parsed.value,
  } satisfies ObservedExternalSystem);
};

const validateOutcomeRecord = (
  raw: unknown,
  index: number,
): Result<OutcomeRecord, DomainError> => {
  const path = `outcomes[${index}]`;
  const record = requireStrictKeys(raw, OUTCOME_RECORD_KEYS, path);
  if (!record.ok) return record;
  if (!isOutcomeId(record.value['outcomeId'])) {
    return fail(stackInputFailure(`expected an outcome id at '${path}'`, `${path}.outcomeId`));
  }
  if (!isScope(record.value['scope'])) {
    return fail(stackInputFailure(`expected a scope at '${path}'`, `${path}.scope`));
  }
  if (!isEntityId(record.value['projectId'])) {
    return fail(stackInputFailure(`expected a project id at '${path}'`, `${path}.projectId`));
  }
  // The memory engine's own boundary validates the full record shape; the
  // scan enforces the identity/scope/strict-keys surface it consumes.
  return ok(raw as OutcomeRecord);
};

const validateBenchmark = (raw: unknown, index: number): Result<Benchmark, DomainError> => {
  const path = `benchmarks[${index}]`;
  const record = requireStrictKeys(raw, BENCHMARK_KEYS, path);
  if (!record.ok) return record;
  if (!isBenchmarkId(record.value['benchmarkId'])) {
    return fail(stackInputFailure(`expected a benchmark id at '${path}'`, `${path}.benchmarkId`));
  }
  if (!isScope(record.value['scope'])) {
    return fail(stackInputFailure(`expected a scope at '${path}'`, `${path}.scope`));
  }
  return ok(raw as Benchmark);
};

const duplicateFailure = (what: string, key: string): DomainError =>
  domainError(
    'invariant-violation',
    `the stack analysis scan inputs contain a duplicate ${what}: '${key}' (an input set is a set)`,
    [{ code: 'stack-input-duplicate', message: `${what} '${key}'`, path: null }],
  );

const checkDuplicates = <T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  what: string,
): Result<true, DomainError> => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      return fail(duplicateFailure(what, key));
    }
    seen.add(key);
  }
  return ok(true);
};

/**
 * Validate the scan inputs fail-closed: strict keys everywhere (an unknown
 * field — a manual score, for instance — is a typed rejection), every
 * observed system's declared capabilities re-parsed through the
 * adapters-sdk's own grammar, every marketplace record re-parsed through
 * the marketplace's own parsers, the memory records' identity/scope surface
 * checked, duplicate identities typed-rejected, and every installation
 * link's release/entitlement references RESOLVED (a link whose release or
 * entitlement is not supplied, or whose pinned release does not match its
 * app/version, is a typed rejection — never a silent skip). Every list is
 * returned in its canonical order.
 */
export function validateStackScanInputs(
  inputs: StackScanInputs,
): Result<ValidatedStackInputs, DomainError> {
  const wrapper = requireStrictKeys(inputs, STACK_INPUT_KEYS, '');
  if (!wrapper.ok) return wrapper;

  if (!Array.isArray(wrapper.value['systems'])) {
    return fail(stackInputFailure("expected 'systems' to be an array", 'systems'));
  }
  if (!Array.isArray(wrapper.value['releases'])) {
    return fail(stackInputFailure("expected 'releases' to be an array", 'releases'));
  }
  if (!Array.isArray(wrapper.value['entitlements'])) {
    return fail(stackInputFailure("expected 'entitlements' to be an array", 'entitlements'));
  }
  if (!Array.isArray(wrapper.value['links'])) {
    return fail(stackInputFailure("expected 'links' to be an array", 'links'));
  }
  if (!Array.isArray(wrapper.value['outcomes'])) {
    return fail(stackInputFailure("expected 'outcomes' to be an array", 'outcomes'));
  }
  if (!Array.isArray(wrapper.value['benchmarks'])) {
    return fail(stackInputFailure("expected 'benchmarks' to be an array", 'benchmarks'));
  }

  const systems: ObservedExternalSystem[] = [];
  const systemList = wrapper.value['systems'] as readonly unknown[];
  for (const [index, raw] of systemList.entries()) {
    const system = validateObservedSystem(raw, index);
    if (!system.ok) return system;
    systems.push(system.value);
  }

  const releases: AppRelease[] = [];
  const releaseList = wrapper.value['releases'] as readonly unknown[];
  for (const [index, raw] of releaseList.entries()) {
    const parsed = parseAppRelease(raw);
    if (!parsed.ok) {
      return fail(
        stackInputFailure(
          `releases[${index}] failed the marketplace release grammar: ${parsed.error.code} at '${parsed.error.path === '' ? '<root>' : parsed.error.path}'`,
          `releases[${index}]`,
        ),
      );
    }
    releases.push(parsed.value);
  }

  const entitlements: Entitlement[] = [];
  const entitlementList = wrapper.value['entitlements'] as readonly unknown[];
  for (const [index, raw] of entitlementList.entries()) {
    const parsed = parseEntitlement(raw);
    if (!parsed.ok) {
      return fail(
        stackInputFailure(
          `entitlements[${index}] failed the marketplace entitlement grammar: ${parsed.error.code} at '${parsed.error.path === '' ? '<root>' : parsed.error.path}'`,
          `entitlements[${index}]`,
        ),
      );
    }
    entitlements.push(parsed.value);
  }

  const links: InstallationLink[] = [];
  const linkList = wrapper.value['links'] as readonly unknown[];
  for (const [index, raw] of linkList.entries()) {
    const parsed = parseInstallationLink(raw);
    if (!parsed.ok) {
      return fail(
        stackInputFailure(
          `links[${index}] failed the marketplace installation-link grammar: ${parsed.error.code} at '${parsed.error.path === '' ? '<root>' : parsed.error.path}'`,
          `links[${index}]`,
        ),
      );
    }
    links.push(parsed.value);
  }

  const outcomes: OutcomeRecord[] = [];
  const outcomeList = wrapper.value['outcomes'] as readonly unknown[];
  for (const [index, raw] of outcomeList.entries()) {
    const outcome = validateOutcomeRecord(raw, index);
    if (!outcome.ok) return outcome;
    outcomes.push(outcome.value);
  }

  const benchmarks: Benchmark[] = [];
  const benchmarkList = wrapper.value['benchmarks'] as readonly unknown[];
  for (const [index, raw] of benchmarkList.entries()) {
    const benchmark = validateBenchmark(raw, index);
    if (!benchmark.ok) return benchmark;
    benchmarks.push(benchmark.value);
  }

  // Duplicate identities are typed invariant violations (input sets are sets).
  const systemDuplicates = checkDuplicates(
    systems,
    (system) => `${system.adapterKind}|${system.systemId}`,
    'observed external system (adapter kind, system id)',
  );
  if (!systemDuplicates.ok) return systemDuplicates;
  const releaseDuplicates = checkDuplicates(
    releases,
    (release) => release.releaseId,
    'app release',
  );
  if (!releaseDuplicates.ok) return releaseDuplicates;
  const entitlementDuplicates = checkDuplicates(
    entitlements,
    (entitlement) => entitlement.entitlementId,
    'app entitlement',
  );
  if (!entitlementDuplicates.ok) return entitlementDuplicates;
  const linkDuplicates = checkDuplicates(links, (link) => link.linkId, 'installation link');
  if (!linkDuplicates.ok) return linkDuplicates;
  const outcomeDuplicates = checkDuplicates(
    outcomes,
    (outcome) => outcome.outcomeId,
    'outcome record',
  );
  if (!outcomeDuplicates.ok) return outcomeDuplicates;
  const benchmarkDuplicates = checkDuplicates(
    benchmarks,
    (benchmark) => benchmark.benchmarkId,
    'benchmark',
  );
  if (!benchmarkDuplicates.ok) return benchmarkDuplicates;

  // Cross-reference resolution: every link's release and entitlement must be
  // supplied and consistent with the link (fail-closed, never a silent skip).
  const releasesById = new Map<string, AppRelease>(
    releases.map((release) => [release.releaseId, release]),
  );
  const entitlementsById = new Map<string, Entitlement>(
    entitlements.map((entitlement) => [entitlement.entitlementId, entitlement]),
  );
  for (const [index, link] of links.entries()) {
    const release = releasesById.get(link.releaseId);
    if (release === undefined) {
      return fail(
        stackInputFailure(
          `links[${index}] references release '${link.releaseId}' which is not supplied (supply every referenced release)`,
          `links[${index}].releaseId`,
        ),
      );
    }
    if (release.appId !== link.appId || release.manifestVersion !== link.currentVersion) {
      return fail(
        stackInputFailure(
          `links[${index}] pins release '${link.releaseId}' but the supplied release describes app '${release.appId}' version '${release.manifestVersion}' while the link pins app '${link.appId}' version '${link.currentVersion}'`,
          `links[${index}].releaseId`,
        ),
      );
    }
    const entitlement = entitlementsById.get(link.entitlementId);
    if (entitlement === undefined) {
      return fail(
        stackInputFailure(
          `links[${index}] references entitlement '${link.entitlementId}' which is not supplied (supply every referenced entitlement)`,
          `links[${index}].entitlementId`,
        ),
      );
    }
    if (entitlement.tenantId !== link.tenantId || entitlement.appId !== link.appId) {
      return fail(
        stackInputFailure(
          `links[${index}] references entitlement '${link.entitlementId}' of a different tenant/app than the link's own`,
          `links[${index}].entitlementId`,
        ),
      );
    }
  }

  return ok({
    systems: [...systems].sort(compareObservedSystems),
    releases: [...releases].sort((left, right) =>
      left.releaseId < right.releaseId ? -1 : left.releaseId > right.releaseId ? 1 : 0,
    ),
    entitlements: [...entitlements].sort((left, right) =>
      left.entitlementId < right.entitlementId
        ? -1
        : left.entitlementId > right.entitlementId
          ? 1
          : 0,
    ),
    links: [...links].sort((left, right) =>
      left.linkId < right.linkId ? -1 : left.linkId > right.linkId ? 1 : 0,
    ),
    outcomes: [...outcomes].sort((left, right) =>
      left.outcomeId < right.outcomeId ? -1 : left.outcomeId > right.outcomeId ? 1 : 0,
    ),
    benchmarks: [...benchmarks].sort((left, right) =>
      left.benchmarkId < right.benchmarkId ? -1 : left.benchmarkId > right.benchmarkId ? 1 : 0,
    ),
  } satisfies ValidatedStackInputs);
}

/** The canonical order of observed systems (adapter kind, then system id). */
export const compareObservedSystems = (
  left: ObservedExternalSystem,
  right: ObservedExternalSystem,
): number => {
  if (left.adapterKind !== right.adapterKind) {
    return left.adapterKind < right.adapterKind ? -1 : 1;
  }
  if (left.systemId !== right.systemId) {
    return left.systemId < right.systemId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// THE coverage records (typed + evidenced).
// ---------------------------------------------------------------------------

/**
 * One capability of an external system's OBSERVED surface, with the object
 * kinds whose declared sync surfaces evidence it (canonical object-kind order).
 */
export interface SystemCapabilitySurface {
  readonly capability: Capability;
  readonly objectKinds: readonly ProviderObjectKind[];
}

/**
 * One capability of an external system's surface that the tenant's
 * installed apps already cover, with EVERY app installation whose manifest
 * declares it (canonical app order).
 */
export interface CoveredSystemCapability {
  readonly capability: Capability;
  readonly providedBy: readonly AppInstallationRef[];
}

/**
 * One TYPED coverage gap: a capability of the external system's observed
 * surface that NO installed app declares, with the object kinds that need
 * it (the evidence of the gap).
 */
export interface SystemCapabilityGap {
  readonly capability: Capability;
  readonly neededBy: readonly ProviderObjectKind[];
}

/**
 * THE coverage record of one observed external system: the observed
 * workflow surface (the declared object-kind translations) and the derived
 * capability surface with covered/gap split — every capability evidenced by
 * the object kinds that declared it and (when covered) the app installations
 * that provide it.
 */
export interface ExternalSystemCoverage {
  readonly kind: 'external-system-coverage';
  readonly tenantId: TenantId;
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  /** The observed object-kind sync surface (canonical object-kind order). */
  readonly objectKinds: readonly AdapterCapabilities['objectKinds'][number][];
  /** The derived capability surface (canonical capability order), evidenced. */
  readonly surface: readonly SystemCapabilitySurface[];
  /** The covered subset (canonical capability order), evidenced per installation. */
  readonly covered: readonly CoveredSystemCapability[];
  /** The typed gaps (canonical capability order), evidenced by object kinds. */
  readonly gaps: readonly SystemCapabilityGap[];
  readonly surfaceCount: number;
  readonly coveredCount: number;
  readonly gapCount: number;
}

/** One capability of an installed app's DECLARED surface, with its evidencing permission specs. */
export interface AppCapabilitySurface {
  readonly capability: Capability;
  readonly specs: readonly PermissionSpec[];
}

/**
 * One capability of an installed app's declared surface that the external
 * systems also provide, with every providing system (canonical order).
 */
export interface OverlappedAppCapability {
  readonly capability: Capability;
  readonly providedBy: readonly ExternalSystemRef[];
}

/**
 * THE coverage record of one installed app: the declared capability surface
 * (the pinned manifest's permission declarations, each evidenced by its
 * specs), the observed command/event workflow surfaces (the manifest's
 * bindings and subscriptions), and the overlap/unique split against the
 * external-system portfolio.
 */
export interface InstalledAppCoverage {
  readonly kind: 'installed-app-coverage';
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly installationId: EntityId;
  readonly linkId: InstallationLinkId;
  readonly releaseId: ReleaseId;
  readonly entitlementId: EntitlementId;
  readonly currentVersion: AppVersion;
  /** The declared capability surface (canonical capability order), evidenced. */
  readonly surface: readonly AppCapabilitySurface[];
  /** The observed command surface (bound command names, canonical order). */
  readonly commandSurface: readonly CommandName[];
  /** The observed event-reactive surface (subscribed event names, canonical order). */
  readonly subscriptionSurface: readonly EventName[];
  /** The overlapping subset (canonical capability order), evidenced per system. */
  readonly overlapping: readonly OverlappedAppCapability[];
  /** The unique declared capabilities no external system provides. */
  readonly unique: readonly AppCapabilitySurface[];
  readonly surfaceCount: number;
  readonly overlappingCount: number;
  readonly uniqueCount: number;
}

/** The measured portfolio the coverage measurement runs over. */
export interface MeasuredPortfolio {
  readonly systems: readonly ObservedExternalSystem[];
  readonly apps: readonly MeasuredInstallation[];
}

/** The measured coverage: one record per external system and per installed app. */
export interface MeasuredStackCoverage {
  readonly systems: readonly ExternalSystemCoverage[];
  readonly apps: readonly InstalledAppCoverage[];
}

const appInstallationRefOf = (app: MeasuredInstallation): AppInstallationRef => ({
  kind: 'app-installation-ref',
  appId: app.link.appId,
  installationId: app.link.installationId,
  linkId: app.link.linkId,
  releaseId: app.link.releaseId,
  entitlementId: app.link.entitlementId,
});

const externalSystemRefOf = (system: ObservedExternalSystem): ExternalSystemRef => ({
  kind: 'external-system-ref',
  adapterKind: system.adapterKind,
  systemId: system.systemId,
});

const compareSpecs = (left: PermissionSpec, right: PermissionSpec): number => {
  if (left.scopeKind !== right.scopeKind) {
    return left.scopeKind < right.scopeKind ? -1 : 1;
  }
  return left.version - right.version;
};

const compareObjectKinds = (
  left: ProviderObjectKind,
  right: ProviderObjectKind,
): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * THE deterministic workflow coverage measurement: pure typed computation
 * over the measured portfolio. For every external system, the capability
 * surface is DERIVED from its adapter's declared object-kind surfaces (each
 * capability evidenced by its declaring object kinds) and split into
 * covered (evidenced by the app installations whose manifests declare the
 * capability) and typed gaps; for every installed app, the declared
 * capability surface is DERIVED from its pinned manifest's permission
 * declarations (each evidenced by its specs) and split into overlapping
 * (evidenced by the providing systems) and unique. Every list is in
 * canonical order, so the measured portfolio's array orders never matter.
 */
export function measureStackCoverage(portfolio: MeasuredPortfolio): MeasuredStackCoverage {
  // The app-side capability index: capability -> the installations declaring
  // it. One reference per (installation, capability): a manifest may declare
  // the same capability at several scope kinds — the installation still
  // PROVIDES it exactly once (the provider lists are sets).
  const appsByCapability = new Map<Capability, AppInstallationRef[]>();
  for (const app of portfolio.apps) {
    const declared = new Set<string>();
    for (const spec of app.manifest.permissions) {
      if (declared.has(spec.capability)) continue;
      declared.add(spec.capability);
      const providers = appsByCapability.get(spec.capability) ?? [];
      providers.push(appInstallationRefOf(app));
      appsByCapability.set(spec.capability, providers);
    }
  }

  // The system-side capability index: capability -> the systems providing
  // it. One reference per (system, capability): several object kinds may
  // translate to the same capability — the system still PROVIDES it exactly
  // once (the provider lists are sets).
  const systemsByCapability = new Map<Capability, ExternalSystemRef[]>();
  for (const system of portfolio.systems) {
    const provided = new Set<string>();
    for (const objectCapability of system.capabilities.objectKinds) {
      if (provided.has(objectCapability.capability)) continue;
      provided.add(objectCapability.capability);
      const providers = systemsByCapability.get(objectCapability.capability) ?? [];
      providers.push(externalSystemRefOf(system));
      systemsByCapability.set(objectCapability.capability, providers);
    }
  }

  const systemCoverages: ExternalSystemCoverage[] = [];
  for (const system of [...portfolio.systems].sort(compareObservedSystems)) {
    // The observed surface: capability -> evidencing object kinds.
    const surfaceByCapability = new Map<Capability, ProviderObjectKind[]>();
    for (const objectCapability of system.capabilities.objectKinds) {
      const objectKinds = surfaceByCapability.get(objectCapability.capability) ?? [];
      objectKinds.push(objectCapability.objectKind);
      surfaceByCapability.set(objectCapability.capability, objectKinds);
    }
    const surface: SystemCapabilitySurface[] = [...surfaceByCapability.entries()]
      .map(([capability, objectKinds]) => ({
        capability,
        objectKinds: [...objectKinds].sort(compareObjectKinds),
      }))
      .sort((left, right) => compareCapabilities(left.capability, right.capability));

    const covered: CoveredSystemCapability[] = [];
    const gaps: SystemCapabilityGap[] = [];
    for (const entry of surface) {
      const providers = appsByCapability.get(entry.capability);
      if (providers === undefined || providers.length === 0) {
        gaps.push({
          capability: entry.capability,
          neededBy: entry.objectKinds,
        });
      } else {
        covered.push({
          capability: entry.capability,
          providedBy: [...providers].sort(compareAppInstallationRefs),
        });
      }
    }

    systemCoverages.push({
      kind: 'external-system-coverage',
      tenantId: system.tenantId,
      adapterKind: system.adapterKind,
      systemId: system.systemId,
      objectKinds: [...system.capabilities.objectKinds].sort((left, right) =>
        compareObjectKinds(left.objectKind, right.objectKind),
      ),
      surface,
      covered,
      gaps,
      surfaceCount: surface.length,
      coveredCount: covered.length,
      gapCount: gaps.length,
    });
  }

  const appCoverages: InstalledAppCoverage[] = [];
  for (const app of [...portfolio.apps].sort((left, right) =>
    compareAppInstallationRefs(appInstallationRefOf(left), appInstallationRefOf(right)),
  )) {
    // The declared surface: capability -> evidencing specs (this app only).
    const surfaceByCapability = new Map<Capability, PermissionSpec[]>();
    for (const spec of app.manifest.permissions) {
      const specs = surfaceByCapability.get(spec.capability) ?? [];
      specs.push(spec);
      surfaceByCapability.set(spec.capability, specs);
    }
    const surface: AppCapabilitySurface[] = [...surfaceByCapability.entries()]
      .map(([capability, specs]) => ({ capability, specs: [...specs].sort(compareSpecs) }))
      .sort((left, right) => compareCapabilities(left.capability, right.capability));

    const overlapping: OverlappedAppCapability[] = [];
    const unique: AppCapabilitySurface[] = [];
    for (const entry of surface) {
      const providers = systemsByCapability.get(entry.capability);
      if (providers === undefined || providers.length === 0) {
        unique.push(entry);
      } else {
        overlapping.push({
          capability: entry.capability,
          providedBy: [...providers].sort(compareExternalSystemRefs),
        });
      }
    }

    const commandSurface = [
      ...new Set(app.manifest.bindings.map((binding) => binding.commandName)),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const subscriptionSurface = [
      ...new Set(app.manifest.subscriptions.map((subscription) => subscription.eventName)),
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    appCoverages.push({
      kind: 'installed-app-coverage',
      tenantId: app.link.tenantId,
      appId: app.link.appId,
      installationId: app.link.installationId,
      linkId: app.link.linkId,
      releaseId: app.link.releaseId,
      entitlementId: app.link.entitlementId,
      currentVersion: app.link.currentVersion,
      surface,
      commandSurface,
      subscriptionSurface,
      overlapping,
      unique,
      surfaceCount: surface.length,
      overlappingCount: overlapping.length,
      uniqueCount: unique.length,
    });
  }

  return { systems: systemCoverages, apps: appCoverages };
}
