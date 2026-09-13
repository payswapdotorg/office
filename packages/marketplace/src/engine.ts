// Office marketplace — THE composed engine (OFF-027).
//
// `createMarketplace` wires the record modules over an injected store, an
// injected action-descriptor source (the SDK's validation port), an
// injected audit sink (every lifecycle transition lands there BEFORE any
// state commits — a failing append aborts the operation with no committed
// effect), an injected clock (all instants), and the canonical-state
// observation port (freeze A11: constructed with it, provably never
// touches it — no marketplace operation reads or writes canonical project
// state, and none ever could: the port is read-only and the engine holds
// no mutation surface of any kind).
//
// The engine NEVER constructs or invokes the action gateway or the app
// runtime (A7/A8): app manifests are DATA, and the marketplace's only
// contact with the action vocabulary is the SDK's `reviewAppManifest` over
// an injected descriptor source. The engine NEVER issues canonical events:
// its audit ledger is its own typed record set.
//
// A12 discipline: every tenant-scoped operation and query carries the
// ACTING tenant; a record owned by another tenant is typed-rejected
// ('unauthorized' / 'cross-tenant-scope') in BOTH directions — and the
// catalog's global listing/detail projections (pure metadata over
// published releases) carry no tenant data at all.
import type { DomainError, Result } from '@office/domain-kernel';
import { ok } from '@office/domain-kernel';
import type { Actor, TenantId, Timestamp } from '@office/contracts';
import { reviewAppManifest, satisfiesVersion, compareAppVersions } from '@office/app-sdk';
import type { ActionDescriptorSource, AppCatalogSource, AppId, VersionRange } from '@office/app-sdk';
import type { AppInstallation } from '@office/app-runtime';
import type { MarketplaceAuditRecord, MarketplaceAuditSink } from './audit';
import { EMPTY_AUDIT_DETAIL, marketplaceAuditRecord } from './audit';
import type { MarketplaceAuditDetail } from './audit';
import type { CanonicalStatePort } from './canonical-state';
import { createInMemoryMarketplaceStore } from './store';
import type { InMemoryMarketplaceStore } from './store';
import { registerPublisher, revokePublisher as revokePublisherRecord } from './publisher';
import type { Publisher } from './publisher';
import type { PublisherId } from './identity';
import { publishReleaseRecord } from './release';
import type { AppRelease } from './release';
import type { ReleaseId } from './identity';
import { catalogEntryOf, catalogSnapshotOf, catalogSourceOf, entitledCatalogOf } from './catalog';
import type { CatalogEntry, EntitledCatalogEntry } from './catalog';
import { grantEntitlement, revokeEntitlement as revokeEntitlementRecord, versionRangeKey } from './entitlement';
import type { Entitlement } from './entitlement';
import type { EntitlementId } from './identity';
import {
  linkInstallation,
  moveInstallationLink,
  unlinkInstallation,
  UNLINKABLE_RUNTIME_STATES,
} from './installation-link';
import type { InstallationLink } from './installation-link';
import type { InstallationLinkId } from './identity';
import {
  applyStagedUpdate,
  confirmationsCover,
  permissionDeltaOf,
  permissionSummary,
  confirmationSummary,
  rollBackAppliedUpdate,
  stageInstallationUpdate,
} from './update';
import type { InstallationUpdate, PermissionConfirmation } from './update';
import type { UpdateId } from './identity';
import { crossTenantFailure, forbiddenFailure, invariantFailure, manifestReviewToResult, notFoundFailure } from './failure';

/** The injected dependencies of the marketplace engine. */
export interface MarketplaceDeps {
  /** The known actions (release manifests validate their bindings against this). */
  readonly actions: ActionDescriptorSource;
  /** THE audit sink every lifecycle transition lands in (append-then-commit). */
  readonly audit: MarketplaceAuditSink;
  /**
   * THE canonical-state observation port (freeze A11). Read-only by
   * construction; the engine is CONSTRUCTED with it and NEVER invokes it —
   * the acceptance harness wraps it in a counting proxy and proves zero
   * invocations plus byte-identical fingerprints across every operation.
   */
  readonly canonicalState: CanonicalStatePort;
  /** Injected clock: the canonical 'now' of every audited transition. */
  readonly now: () => Timestamp;
}

/** The result of an applied update: the update record + the moved link. */
export interface AppliedUpdate {
  readonly update: InstallationUpdate;
  readonly link: InstallationLink;
}

/**
 * THE marketplace engine: the audited catalog/lifecycle surface. One
 * instance owns one record store; every mutating operation runs its typed
 * gates, appends the audit record, and only then commits the state change.
 */
export interface Marketplace {
  // --- lifecycle operations (every transition audited) ---
  /** Register a tenant-scoped publisher (audited: publisher-registered). */
  registerPublisher(input: {
    readonly tenantId: TenantId;
    readonly displayName: string;
    readonly apps: readonly AppId[];
    readonly by: Actor;
  }): Result<Publisher, DomainError>;
  /** Revoke a publisher — terminal, idempotent (audited: publisher-revoked). */
  revokePublisher(input: {
    readonly tenant: TenantId;
    readonly publisherId: PublisherId;
    readonly by: Actor;
  }): Result<Publisher, DomainError>;
  /**
   * Publish one app release: the RAW manifest travels through the SDK's
   * `reviewAppManifest` against the injected action source and the
   * marketplace's own catalog; releases are immutable once published
   * (audited: release-published).
   */
  publishRelease(input: {
    readonly tenant: TenantId;
    readonly publisherId: PublisherId;
    readonly rawManifest: unknown;
    readonly by: Actor;
  }): Result<AppRelease, DomainError>;
  /** Grant a tenant entitlement over an app release range (audited: entitlement-granted). */
  grantEntitlement(input: {
    readonly tenant: TenantId;
    readonly appId: AppId;
    readonly versionRange: VersionRange;
    readonly by: Actor;
  }): Result<Entitlement, DomainError>;
  /** Revoke an entitlement — terminal, idempotent (audited: entitlement-revoked). */
  revokeEntitlement(input: {
    readonly tenant: TenantId;
    readonly entitlementId: EntitlementId;
    readonly by: Actor;
  }): Result<Entitlement, DomainError>;
  /**
   * Record the installation metadata linkage: which canonical app-runtime
   * installation resulted from which release under which entitlement
   * (metadata only — the engine never constructs or executes the runtime).
   * Audited: installation-linked.
   */
  linkInstallation(input: {
    readonly tenant: TenantId;
    readonly installation: AppInstallation;
    readonly releaseId: ReleaseId;
    readonly entitlementId: EntitlementId;
    readonly by: Actor;
  }): Result<InstallationLink, DomainError>;
  /**
   * Stage an update to a strictly newer release: computes the permission
   * delta for review (audited: update-staged). Updates are staged records,
   * never silent swaps.
   */
  stageUpdate(input: {
    readonly tenant: TenantId;
    readonly linkId: InstallationLinkId;
    readonly toReleaseId: ReleaseId;
    readonly by: Actor;
  }): Result<InstallationUpdate, DomainError>;
  /**
   * Apply a staged update: added-capability updates require a fresh grant
   * confirmation for EVERY added permission spec (typed-rejected otherwise);
   * unchanged-capability updates proceed. Moves the link's pin
   * (audited: update-applied).
   */
  applyUpdate(input: {
    readonly tenant: TenantId;
    readonly updateId: UpdateId;
    readonly confirmations?: readonly PermissionConfirmation[];
    readonly by: Actor;
  }): Result<AppliedUpdate, DomainError>;
  /**
   * Roll an applied update back to its from-release: an explicit typed
   * command moving the link's pin back — the release records themselves are
   * never mutated (audited: update-rolled-back).
   */
  rollbackUpdate(input: {
    readonly tenant: TenantId;
    readonly updateId: UpdateId;
    readonly by: Actor;
  }): Result<AppliedUpdate, DomainError>;
  /**
   * Record an uninstall: severs the entitlement→installation linkage —
   * terminal, idempotent (audited: installation-unlinked).
   */
  recordUninstall(input: {
    readonly tenant: TenantId;
    readonly linkId: InstallationLinkId;
    readonly by: Actor;
  }): Result<InstallationLink, DomainError>;

  // --- queries (deterministic projections; A12-gated where tenant-scoped) ---
  /** The global catalog snapshot (pure projection over published releases). */
  catalog(): readonly CatalogEntry[];
  /** The global catalog detail of one app (typed not-found when unknown). */
  catalogEntry(appId: AppId): Result<CatalogEntry, DomainError>;
  /** The AppCatalogSource view (plugs into reviewAppManifest's dependency validation). */
  catalogSource(): AppCatalogSource;
  /**
   * The ENTITLED catalog: the catalog as `tenant` may install it. The
   * acting tenant must equal the queried tenant (A12, typed-rejected both
   * directions).
   */
  entitledCatalog(
    acting: TenantId,
    tenant: TenantId,
  ): Result<readonly EntitledCatalogEntry[], DomainError>;
  /** The acting tenant's publishers (A12). */
  publishersOf(acting: TenantId, tenant: TenantId): Result<readonly Publisher[], DomainError>;
  /** One publisher by id (A12: cross-tenant typed-rejected both directions). */
  publisher(acting: TenantId, publisherId: PublisherId): Result<Publisher, DomainError>;
  /** The acting tenant's entitlements (A12). */
  entitlementsOf(acting: TenantId, tenant: TenantId): Result<readonly Entitlement[], DomainError>;
  /** One entitlement by id (A12: cross-tenant typed-rejected both directions). */
  entitlement(acting: TenantId, entitlementId: EntitlementId): Result<Entitlement, DomainError>;
  /** The acting tenant's installation links (A12). */
  installationLinksOf(
    acting: TenantId,
    tenant: TenantId,
  ): Result<readonly InstallationLink[], DomainError>;
  /** One installation link by id (A12: cross-tenant typed-rejected both directions). */
  installationLink(
    acting: TenantId,
    linkId: InstallationLinkId,
  ): Result<InstallationLink, DomainError>;
  /** The acting tenant's staged updates (A12). */
  updatesOf(acting: TenantId, tenant: TenantId): Result<readonly InstallationUpdate[], DomainError>;
  /** One update by id (A12: cross-tenant typed-rejected both directions). */
  update(acting: TenantId, updateId: UpdateId): Result<InstallationUpdate, DomainError>;
}

/**
 * Create the marketplace engine over an injected store (defaults to the
 * deterministic in-memory reference) and the injected deps. Every mutating
 * operation: gates → audit append (a failure aborts with NO state change)
 * → commit.
 */
export function createMarketplace(
  deps: MarketplaceDeps,
  store: InMemoryMarketplaceStore = createInMemoryMarketplaceStore(),
): Marketplace {
  // The canonical-state port is held by `deps` for the A11 boundary proof
  // and deliberately NEVER dereferenced below: no marketplace operation
  // reads or writes canonical project state (the acceptance harness wraps
  // the port in a counting proxy and counts ZERO engine invocations).

  /** Append one audit record; a failure aborts the surrounding operation. */
  const audit = (
    transition: Parameters<typeof marketplaceAuditRecord>[0]['transition'],
    tenantId: TenantId,
    by: Actor,
    subject: string,
    detail: MarketplaceAuditDetail,
  ): Result<true, DomainError> => {
    const record: MarketplaceAuditRecord = marketplaceAuditRecord({
      transition,
      tenantId,
      at: deps.now(),
      by,
      subject,
      detail,
    });
    return deps.audit.append(record);
  };

  const requireSameTenant = (
    acting: TenantId,
    recordTenant: TenantId,
  ): Result<true, DomainError> =>
    acting === recordTenant
      ? ok(true)
      : crossTenantFailure(acting, recordTenant);

  return {
    registerPublisher: (input) => {
      const publisher = registerPublisher({
        tenantId: input.tenantId,
        displayName: input.displayName,
        apps: input.apps,
        registeredAt: deps.now(),
        registeredBy: input.by,
      });
      if (store.publishers.find(publisher.publisherId) !== null) {
        return invariantFailure(
          'publisher-already-registered',
          `publisher '${publisher.publisherId}' is already registered — one publisher per (tenant, display name, app set)`,
        );
      }
      const appended = audit('publisher-registered', publisher.tenantId, input.by, publisher.publisherId, {
        ...EMPTY_AUDIT_DETAIL,
        publisherId: publisher.publisherId,
      });
      if (!appended.ok) return appended;
      store.publishers.put(publisher);
      return ok(publisher);
    },

    revokePublisher: (input) => {
      const publisher = store.publishers.find(input.publisherId);
      if (publisher === null) {
        return notFoundFailure('publisher', input.publisherId);
      }
      const scoped = requireSameTenant(input.tenant, publisher.tenantId);
      if (!scoped.ok) return scoped;
      const revoked = revokePublisherRecord(publisher, { at: deps.now(), by: input.by });
      if (revoked !== publisher) {
        const appended = audit('publisher-revoked', publisher.tenantId, input.by, publisher.publisherId, {
          ...EMPTY_AUDIT_DETAIL,
          publisherId: publisher.publisherId,
        });
        if (!appended.ok) return appended;
        store.publishers.put(revoked);
      }
      return ok(revoked);
    },

    publishRelease: (input) => {
      const publisher = store.publishers.find(input.publisherId);
      if (publisher === null) {
        return notFoundFailure('publisher', input.publisherId);
      }
      const scoped = requireSameTenant(input.tenant, publisher.tenantId);
      if (!scoped.ok) return scoped;
      if (publisher.state !== 'active') {
        return forbiddenFailure(
          'publisher-revoked',
          `publisher '${publisher.publisherId}' is revoked — a revoked publisher cannot publish`,
        );
      }
      const review = reviewAppManifest(input.rawManifest, {
        actions: deps.actions,
        apps: catalogSourceOf(store.releases.releases()),
      });
      const manifest = manifestReviewToResult(review);
      if (!manifest.ok) return manifest;
      if (!publisher.apps.includes(manifest.value.appId)) {
        return forbiddenFailure(
          'publisher-app-not-declared',
          `publisher '${publisher.publisherId}' may publish [${publisher.apps.join(', ')}] — not '${manifest.value.appId}'`,
        );
      }
      const release = publishReleaseRecord({
        manifest: manifest.value,
        publisherId: publisher.publisherId,
        tenantId: publisher.tenantId,
        publishedAt: deps.now(),
        publishedBy: input.by,
      });
      const duplicate = store.releases.findByVersion(release.appId, release.manifestVersion);
      if (duplicate !== null) {
        return invariantFailure(
          'release-already-published',
          `release '${release.appId}@${release.manifestVersion}' is already published — releases are immutable once published`,
        );
      }
      const appended = audit('release-published', publisher.tenantId, input.by, release.releaseId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: release.appId,
        manifestVersion: release.manifestVersion,
        releaseId: release.releaseId,
        publisherId: publisher.publisherId,
      });
      if (!appended.ok) return appended;
      const registered = store.releases.register(release);
      if (!registered.ok) return registered;
      return ok(release);
    },

    grantEntitlement: (input) => {
      const rangeKey = versionRangeKey(input.versionRange);
      const activeDuplicate = store.entitlements
        .ofTenantApp(input.tenant, input.appId)
        .find(
          (entitlement) =>
            entitlement.state === 'active' &&
            versionRangeKey(entitlement.versionRange) === rangeKey,
        );
      if (activeDuplicate !== undefined) {
        return invariantFailure(
          'entitlement-already-granted',
          `tenant '${input.tenant}' already holds an active entitlement over '${input.appId}' ${rangeKey} — revoke it before re-granting`,
        );
      }
      const ordinal = store.entitlements.nextGrantOrdinal(input.tenant, input.appId, rangeKey);
      const entitlement = grantEntitlement({
        tenantId: input.tenant,
        appId: input.appId,
        versionRange: input.versionRange,
        grantOrdinal: ordinal,
        grantedAt: deps.now(),
        grantedBy: input.by,
      });
      const appended = audit('entitlement-granted', entitlement.tenantId, input.by, entitlement.entitlementId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: entitlement.appId,
        entitlementId: entitlement.entitlementId,
      });
      if (!appended.ok) return appended;
      store.entitlements.put(entitlement);
      return ok(entitlement);
    },

    revokeEntitlement: (input) => {
      const entitlement = store.entitlements.find(input.entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', input.entitlementId);
      }
      const scoped = requireSameTenant(input.tenant, entitlement.tenantId);
      if (!scoped.ok) return scoped;
      const revoked = revokeEntitlementRecord(entitlement, { at: deps.now(), by: input.by });
      if (revoked !== entitlement) {
        const appended = audit('entitlement-revoked', entitlement.tenantId, input.by, entitlement.entitlementId, {
          ...EMPTY_AUDIT_DETAIL,
          appId: entitlement.appId,
          entitlementId: entitlement.entitlementId,
        });
        if (!appended.ok) return appended;
        store.entitlements.put(revoked);
      }
      return ok(revoked);
    },

    linkInstallation: (input) => {
      const release = store.releases.find(input.releaseId);
      if (release === null) {
        return notFoundFailure('release', input.releaseId);
      }
      const entitlement = store.entitlements.find(input.entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', input.entitlementId);
      }
      const scoped = requireSameTenant(input.tenant, entitlement.tenantId);
      if (!scoped.ok) return scoped;
      const scopedInstallation = requireSameTenant(input.tenant, input.installation.tenantId);
      if (!scopedInstallation.ok) return scopedInstallation;
      if (entitlement.state !== 'active') {
        return forbiddenFailure(
          'entitlement-revoked',
          `entitlement '${entitlement.entitlementId}' is revoked — a revoked entitlement cannot install`,
        );
      }
      if (entitlement.appId !== release.appId) {
        return invariantFailure(
          'entitlement-app-mismatch',
          `entitlement '${entitlement.entitlementId}' covers app '${entitlement.appId}' — not '${release.appId}'`,
        );
      }
      if (input.installation.manifestVersion !== release.manifestVersion) {
        return invariantFailure(
          'installation-version-mismatch',
          `installation '${input.installation.installationId}' pins manifest version '${input.installation.manifestVersion}' — release '${release.releaseId}' is '${release.manifestVersion}'`,
        );
      }
      if (input.installation.appId !== release.appId) {
        return invariantFailure(
          'installation-app-mismatch',
          `installation '${input.installation.installationId}' is app '${input.installation.appId}' — release '${release.releaseId}' is '${release.appId}'`,
        );
      }
      if (UNLINKABLE_RUNTIME_STATES.includes(input.installation.state)) {
        return invariantFailure(
          'installation-terminal',
          `installation '${input.installation.installationId}' is in the terminal runtime state '${input.installation.state}' and cannot be linked`,
        );
      }
      if (!satisfiesVersion(entitlement.versionRange, release.manifestVersion)) {
        return forbiddenFailure(
          'entitlement-range-unsatisfied',
          `entitlement '${entitlement.entitlementId}' covers ${versionRangeKey(entitlement.versionRange)} — not release version '${release.manifestVersion}'`,
        );
      }
      const existing = store.links.findByInstallation(input.installation.installationId);
      if (existing !== null) {
        return invariantFailure(
          'installation-already-linked',
          `installation '${input.installation.installationId}' already carries a marketplace link ('${existing.linkId}')`,
        );
      }
      const link = linkInstallation({
        installation: input.installation,
        releaseId: release.releaseId,
        releaseVersion: release.manifestVersion,
        entitlementId: entitlement.entitlementId,
        linkedAt: deps.now(),
        linkedBy: input.by,
      });
      const appended = audit('installation-linked', link.tenantId, input.by, link.linkId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: release.appId,
        manifestVersion: release.manifestVersion,
        releaseId: release.releaseId,
        entitlementId: entitlement.entitlementId,
        installationId: link.installationId,
        linkId: link.linkId,
      });
      if (!appended.ok) return appended;
      store.links.put(link);
      return ok(link);
    },

    stageUpdate: (input) => {
      const link = store.links.find(input.linkId);
      if (link === null) {
        return notFoundFailure('installation-link', input.linkId);
      }
      const scoped = requireSameTenant(input.tenant, link.tenantId);
      if (!scoped.ok) return scoped;
      if (link.state !== 'linked') {
        return invariantFailure(
          'installation-link-severed',
          `installation link '${link.linkId}' is severed — a severed link cannot update`,
        );
      }
      const toRelease = store.releases.find(input.toReleaseId);
      if (toRelease === null) {
        return notFoundFailure('release', input.toReleaseId);
      }
      if (toRelease.appId !== link.appId) {
        return invariantFailure(
          'update-app-mismatch',
          `release '${toRelease.releaseId}' is app '${toRelease.appId}' — the link is app '${link.appId}'`,
        );
      }
      if (compareAppVersions(toRelease.manifestVersion, link.currentVersion) <= 0) {
        return invariantFailure(
          'update-target-not-newer',
          `release '${toRelease.releaseId}' (${toRelease.manifestVersion}) is not newer than the link's pin (${link.currentVersion})`,
        );
      }
      const entitlement = store.entitlements.find(link.entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', link.entitlementId);
      }
      if (entitlement.state !== 'active') {
        return forbiddenFailure(
          'entitlement-revoked',
          `entitlement '${entitlement.entitlementId}' is revoked — a revoked entitlement cannot update`,
        );
      }
      if (!satisfiesVersion(entitlement.versionRange, toRelease.manifestVersion)) {
        return forbiddenFailure(
          'entitlement-range-unsatisfied',
          `entitlement '${entitlement.entitlementId}' (${entitlement.state}) covers ${versionRangeKey(entitlement.versionRange)} — not release version '${toRelease.manifestVersion}'`,
        );
      }
      const fromRelease = store.releases.find(link.releaseId);
      if (fromRelease === null) {
        return notFoundFailure('release', link.releaseId);
      }
      const delta = permissionDeltaOf(fromRelease.manifest, toRelease.manifest);
      const update = stageInstallationUpdate({
        linkId: link.linkId,
        tenantId: link.tenantId,
        appId: link.appId,
        fromReleaseId: fromRelease.releaseId,
        fromVersion: fromRelease.manifestVersion,
        toReleaseId: toRelease.releaseId,
        toVersion: toRelease.manifestVersion,
        permissionDelta: delta,
        stagedAt: deps.now(),
        stagedBy: input.by,
      });
      const existing = store.updates.find(update.updateId);
      if (existing !== null) {
        return invariantFailure(
          'update-already-staged',
          `update '${update.updateId}' is already staged (${existing.state}) — one staged move per (link, from, to)`,
        );
      }
      const appended = audit('update-staged', link.tenantId, input.by, update.updateId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: update.appId,
        linkId: update.linkId,
        updateId: update.updateId,
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
        addedCapabilities: delta.added.map(permissionSummary),
        removedCapabilities: delta.removed.map(permissionSummary),
      });
      if (!appended.ok) return appended;
      store.updates.put(update);
      return ok(update);
    },

    applyUpdate: (input) => {
      const update = store.updates.find(input.updateId);
      if (update === null) {
        return notFoundFailure('update', input.updateId);
      }
      const scoped = requireSameTenant(input.tenant, update.tenantId);
      if (!scoped.ok) return scoped;
      if (update.state !== 'staged') {
        return invariantFailure(
          'update-not-staged',
          `update '${update.updateId}' is in state '${update.state}' — only a staged update can apply`,
        );
      }
      const confirmations = input.confirmations ?? [];
      const covered = confirmationsCover(update.permissionDelta, confirmations);
      if (!covered.ok) {
        return forbiddenFailure(
          covered.error.details[0]?.code ?? 'confirmation-required',
          covered.error.message,
        );
      }
      const link = store.links.find(update.linkId);
      if (link === null) {
        return notFoundFailure('installation-link', update.linkId);
      }
      if (link.state !== 'linked') {
        return invariantFailure(
          'installation-link-severed',
          `installation link '${link.linkId}' is severed — a severed link cannot update`,
        );
      }
      const entitlement = store.entitlements.find(link.entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', link.entitlementId);
      }
      if (entitlement.state !== 'active') {
        return forbiddenFailure(
          'entitlement-revoked',
          `entitlement '${entitlement.entitlementId}' is revoked — a revoked entitlement cannot update`,
        );
      }
      if (!satisfiesVersion(entitlement.versionRange, update.toVersion)) {
        return forbiddenFailure(
          'entitlement-range-unsatisfied',
          `entitlement '${entitlement.entitlementId}' (${entitlement.state}) covers ${versionRangeKey(entitlement.versionRange)} — not release version '${update.toVersion}'`,
        );
      }
      const appliedAt = deps.now();
      const applied = applyStagedUpdate(update, {
        confirmations,
        at: appliedAt,
        by: input.by,
      });
      const moved = moveInstallationLink(link, {
        toReleaseId: update.toReleaseId,
        toVersion: update.toVersion,
        at: appliedAt,
        by: input.by,
      });
      const appended = audit('update-applied', update.tenantId, input.by, update.updateId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: update.appId,
        linkId: update.linkId,
        updateId: update.updateId,
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
        addedCapabilities: update.permissionDelta.added.map(permissionSummary),
        removedCapabilities: update.permissionDelta.removed.map(permissionSummary),
        confirmations: confirmations.map(confirmationSummary),
      });
      if (!appended.ok) return appended;
      store.updates.put(applied);
      store.links.put(moved);
      return ok({ update: applied, link: moved });
    },

    rollbackUpdate: (input) => {
      const update = store.updates.find(input.updateId);
      if (update === null) {
        return notFoundFailure('update', input.updateId);
      }
      const scoped = requireSameTenant(input.tenant, update.tenantId);
      if (!scoped.ok) return scoped;
      if (update.state !== 'applied') {
        return invariantFailure(
          'update-not-applied',
          `update '${update.updateId}' is in state '${update.state}' — only an applied update can roll back`,
        );
      }
      const link = store.links.find(update.linkId);
      if (link === null) {
        return notFoundFailure('installation-link', update.linkId);
      }
      if (link.state !== 'linked') {
        return invariantFailure(
          'installation-link-severed',
          `installation link '${link.linkId}' is severed — a severed link cannot roll back`,
        );
      }
      const entitlement = store.entitlements.find(link.entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', link.entitlementId);
      }
      if (entitlement.state !== 'active') {
        return forbiddenFailure(
          'entitlement-revoked',
          `entitlement '${entitlement.entitlementId}' is revoked — a revoked entitlement cannot roll back`,
        );
      }
      if (!satisfiesVersion(entitlement.versionRange, update.fromVersion)) {
        return forbiddenFailure(
          'entitlement-range-unsatisfied',
          `entitlement '${entitlement.entitlementId}' (${entitlement.state}) covers ${versionRangeKey(entitlement.versionRange)} — not the rollback target version '${update.fromVersion}'`,
        );
      }
      const rolledBackAt = deps.now();
      const rolledBack = rollBackAppliedUpdate(update, { at: rolledBackAt, by: input.by });
      const restored = moveInstallationLink(link, {
        toReleaseId: update.fromReleaseId,
        toVersion: update.fromVersion,
        at: rolledBackAt,
        by: input.by,
      });
      const appended = audit('update-rolled-back', update.tenantId, input.by, update.updateId, {
        ...EMPTY_AUDIT_DETAIL,
        appId: update.appId,
        linkId: update.linkId,
        updateId: update.updateId,
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
        addedCapabilities: update.permissionDelta.added.map(permissionSummary),
        removedCapabilities: update.permissionDelta.removed.map(permissionSummary),
      });
      if (!appended.ok) return appended;
      store.updates.put(rolledBack);
      store.links.put(restored);
      return ok({ update: rolledBack, link: restored });
    },

    recordUninstall: (input) => {
      const link = store.links.find(input.linkId);
      if (link === null) {
        return notFoundFailure('installation-link', input.linkId);
      }
      const scoped = requireSameTenant(input.tenant, link.tenantId);
      if (!scoped.ok) return scoped;
      const severed = unlinkInstallation(link, { at: deps.now(), by: input.by });
      if (severed !== link) {
        const appended = audit('installation-unlinked', link.tenantId, input.by, link.linkId, {
          ...EMPTY_AUDIT_DETAIL,
          appId: link.appId,
          manifestVersion: link.currentVersion,
          releaseId: link.releaseId,
          entitlementId: link.entitlementId,
          installationId: link.installationId,
          linkId: link.linkId,
        });
        if (!appended.ok) return appended;
        store.links.put(severed);
      }
      return ok(severed);
    },

    catalog: () => catalogSnapshotOf(store.releases.releases()),

    catalogEntry: (appId) => {
      const entry = catalogEntryOf(store.releases.releases(), appId);
      if (entry === null) {
        return notFoundFailure('catalog-entry', appId);
      }
      return ok(entry);
    },

    catalogSource: () => catalogSourceOf(store.releases.releases()),

    entitledCatalog: (acting, tenant) => {
      const scoped = requireSameTenant(acting, tenant);
      if (!scoped.ok) return scoped;
      return ok(
        entitledCatalogOf(store.releases.releases(), store.entitlements.entitlements(), tenant),
      );
    },

    publishersOf: (acting, tenant) => {
      const scoped = requireSameTenant(acting, tenant);
      if (!scoped.ok) return scoped;
      return ok(store.publishers.ofTenant(tenant));
    },

    publisher: (acting, publisherId) => {
      const publisher = store.publishers.find(publisherId);
      if (publisher === null) {
        return notFoundFailure('publisher', publisherId);
      }
      const scoped = requireSameTenant(acting, publisher.tenantId);
      if (!scoped.ok) return scoped;
      return ok(publisher);
    },

    entitlementsOf: (acting, tenant) => {
      const scoped = requireSameTenant(acting, tenant);
      if (!scoped.ok) return scoped;
      return ok(
        store.entitlements.entitlements().filter((entitlement) => entitlement.tenantId === tenant),
      );
    },

    entitlement: (acting, entitlementId) => {
      const entitlement = store.entitlements.find(entitlementId);
      if (entitlement === null) {
        return notFoundFailure('entitlement', entitlementId);
      }
      const scoped = requireSameTenant(acting, entitlement.tenantId);
      if (!scoped.ok) return scoped;
      return ok(entitlement);
    },

    installationLinksOf: (acting, tenant) => {
      const scoped = requireSameTenant(acting, tenant);
      if (!scoped.ok) return scoped;
      return ok(store.links.ofTenant(tenant));
    },

    installationLink: (acting, linkId) => {
      const link = store.links.find(linkId);
      if (link === null) {
        return notFoundFailure('installation-link', linkId);
      }
      const scoped = requireSameTenant(acting, link.tenantId);
      if (!scoped.ok) return scoped;
      return ok(link);
    },

    updatesOf: (acting, tenant) => {
      const scoped = requireSameTenant(acting, tenant);
      if (!scoped.ok) return scoped;
      return ok(store.updates.ofTenant(tenant));
    },

    update: (acting, updateId) => {
      const updateRecord = store.updates.find(updateId);
      if (updateRecord === null) {
        return notFoundFailure('update', updateId);
      }
      const scoped = requireSameTenant(acting, updateRecord.tenantId);
      if (!scoped.ok) return scoped;
      return ok(updateRecord);
    },
  };
}
