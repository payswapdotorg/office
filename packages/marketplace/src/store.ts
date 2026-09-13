// Office marketplace — the in-memory record store (OFF-027).
//
// The deterministic in-memory reference of the marketplace's records:
// publishers, immutable releases, entitlements (with the deterministic
// grant-ordinal counter), installation links, and staged updates. The
// engine (engine.ts) is the only writer; every put is preceded by the
// engine's typed gates and an audit append, so the store only ever holds
// committed, audited records. Persistence-backed stores satisfy the same
// ports later; everything here is plain in-memory bookkeeping over
// ALREADY-VALIDATED typed records (parse before storing): no canonical
// entities are stored (A11), no SQL, no I/O. Deterministic: insertion
// order preserved, ids derived, no clock, no randomness.
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { AppId, AppVersion } from '@office/app-sdk';
import type { Publisher } from './publisher';
import type { PublisherId } from './identity';
import type { AppRelease } from './release';
import type { ReleaseId } from './identity';
import type { Entitlement } from './entitlement';
import type { EntitlementId } from './identity';
import type { InstallationLink } from './installation-link';
import type { InstallationLinkId } from './identity';
import type { InstallationUpdate } from './update';
import type { UpdateId } from './identity';
import type { TenantId } from '@office/contracts';

// ----- publishers --------------------------------------------------------------------------

/** The store of publisher records. */
export interface PublisherStore {
  /** Store one publisher record (replaces the same publisher id). */
  put(publisher: Publisher): void;
  /** The publisher record of an id, or null. */
  find(publisherId: PublisherId): Publisher | null;
  /** The publishers of one tenant, in registration order. */
  ofTenant(tenantId: TenantId): readonly Publisher[];
  /** Every publisher, in registration order. */
  publishers(): readonly Publisher[];
}

// ----- releases ----------------------------------------------------------------------------

/** The store of published (immutable) app releases. */
export interface ReleaseStore {
  /**
   * Store one release record. A duplicate (app, manifest version) is a
   * TYPED-REJECTED invariant violation — releases are immutable once
   * published; one (app, version) resolves to at most one release forever.
   */
  register(release: AppRelease): Result<true, DomainError>;
  /** The release record of an id, or null. */
  find(releaseId: ReleaseId): AppRelease | null;
  /** The release record of an exact (app, manifest version), or null. */
  findByVersion(appId: AppId, manifestVersion: AppVersion): AppRelease | null;
  /** Every release of one app, in publication order. */
  ofApp(appId: AppId): readonly AppRelease[];
  /** Every release, in publication order. */
  releases(): readonly AppRelease[];
}

// ----- entitlements ------------------------------------------------------------------------

/** The store of tenant entitlement records. */
export interface EntitlementStore {
  /** Store one entitlement record (replaces the same entitlement id). */
  put(entitlement: Entitlement): void;
  /** The entitlement record of an id, or null. */
  find(entitlementId: EntitlementId): Entitlement | null;
  /** The entitlements of one (tenant, app), in grant order. */
  ofTenantApp(tenantId: TenantId, appId: AppId): readonly Entitlement[];
  /** Every entitlement, in grant order. */
  entitlements(): readonly Entitlement[];
  /**
   * The next deterministic grant ordinal for a (tenant, app, range) base
   * key: the number of entitlement records ever granted over that key
   * (active or revoked). A re-grant after revocation mints a NEW
   * deterministic identity (ordinal + 1) — never a resurrection.
   */
  nextGrantOrdinal(tenantId: TenantId, appId: AppId, versionRange: string): number;
}

// ----- installation links ------------------------------------------------------------------

/** The store of installation metadata links. */
export interface InstallationLinkStore {
  /** Store one link record (replaces the same link id). */
  put(link: InstallationLink): void;
  /** The link record of an id, or null. */
  find(linkId: InstallationLinkId): InstallationLink | null;
  /** The link of a canonical installation id, or null (one link per installation). */
  findByInstallation(installationId: string): InstallationLink | null;
  /** The links of one tenant, in link order. */
  ofTenant(tenantId: TenantId): readonly InstallationLink[];
  /** Every link, in link order. */
  links(): readonly InstallationLink[];
}

// ----- updates -----------------------------------------------------------------------------

/** The store of staged installation updates. */
export interface UpdateStore {
  /** Store one update record (replaces the same update id). */
  put(update: InstallationUpdate): void;
  /** The update record of an id, or null. */
  find(updateId: UpdateId): InstallationUpdate | null;
  /** The updates of one installation link, in staging order. */
  ofLink(linkId: InstallationLinkId): readonly InstallationUpdate[];
  /** The updates of one tenant, in staging order. */
  ofTenant(tenantId: TenantId): readonly InstallationUpdate[];
  /** Every update, in staging order. */
  updates(): readonly InstallationUpdate[];
}

/** The combined in-memory marketplace store. */
export interface InMemoryMarketplaceStore {
  readonly publishers: PublisherStore;
  readonly releases: ReleaseStore;
  readonly entitlements: EntitlementStore;
  readonly links: InstallationLinkStore;
  readonly updates: UpdateStore;
}

/**
 * Create the deterministic in-memory marketplace store (publishers +
 * releases + entitlements + links + updates). Pure bookkeeping: typed
 * records in, typed records out, insertion order preserved.
 */
export function createInMemoryMarketplaceStore(): InMemoryMarketplaceStore {
  // --- publishers ---
  const publishersById = new Map<string, Publisher>();
  const publishersOrdered: Publisher[] = [];
  const publisherStore: PublisherStore = {
    put: (publisher) => {
      const key = publisher.publisherId;
      if (!publishersById.has(key)) publishersOrdered.push(publisher);
      else {
        const index = publishersOrdered.findIndex(
          (candidate) => candidate.publisherId === key,
        );
        if (index >= 0) publishersOrdered[index] = publisher;
      }
      publishersById.set(key, publisher);
    },
    find: (publisherId) => publishersById.get(publisherId) ?? null,
    ofTenant: (tenantId) =>
      publishersOrdered.filter((publisher) => publisher.tenantId === tenantId),
    publishers: () => [...publishersOrdered],
  };

  // --- releases ---
  const releasesById = new Map<string, AppRelease>();
  const releasesByKey = new Map<string, AppRelease>();
  const releasesOrdered: AppRelease[] = [];
  const releaseStore: ReleaseStore = {
    register: (release) => {
      const key = `${release.appId}@${release.manifestVersion}`;
      if (releasesByKey.has(key) || releasesById.has(release.releaseId)) {
        return fail(
          domainError(
            'invariant-violation',
            `release '${key}' is already published — releases are immutable once published`,
            [{ code: 'release-already-published', message: key, path: 'manifestVersion' }],
          ),
        );
      }
      releasesById.set(release.releaseId, release);
      releasesByKey.set(key, release);
      releasesOrdered.push(release);
      return ok(true);
    },
    find: (releaseId) => releasesById.get(releaseId) ?? null,
    findByVersion: (appId, manifestVersion) =>
      releasesByKey.get(`${appId}@${manifestVersion}`) ?? null,
    ofApp: (appId) => releasesOrdered.filter((release) => release.appId === appId),
    releases: () => [...releasesOrdered],
  };

  // --- entitlements ---
  const entitlementsById = new Map<string, Entitlement>();
  const entitlementsOrdered: Entitlement[] = [];
  const grantOrdinals = new Map<string, number>();
  const entitlementStore: EntitlementStore = {
    put: (entitlement) => {
      const key = entitlement.entitlementId;
      if (!entitlementsById.has(key)) entitlementsOrdered.push(entitlement);
      else {
        const index = entitlementsOrdered.findIndex(
          (candidate) => candidate.entitlementId === key,
        );
        if (index >= 0) entitlementsOrdered[index] = entitlement;
      }
      entitlementsById.set(key, entitlement);
    },
    find: (entitlementId) => entitlementsById.get(entitlementId) ?? null,
    ofTenantApp: (tenantId, appId) =>
      entitlementsOrdered.filter(
        (entitlement) => entitlement.tenantId === tenantId && entitlement.appId === appId,
      ),
    entitlements: () => [...entitlementsOrdered],
    nextGrantOrdinal: (tenantId, appId, versionRange) => {
      const baseKey = `${tenantId}|${appId}|${versionRange}`;
      const next = (grantOrdinals.get(baseKey) ?? 0) + 1;
      grantOrdinals.set(baseKey, next);
      return next;
    },
  };

  // --- installation links ---
  const linksById = new Map<string, InstallationLink>();
  const linksByInstallation = new Map<string, InstallationLink>();
  const linksOrdered: InstallationLink[] = [];
  const linkStore: InstallationLinkStore = {
    put: (link) => {
      const key = link.linkId;
      if (!linksById.has(key)) linksOrdered.push(link);
      else {
        const index = linksOrdered.findIndex((candidate) => candidate.linkId === key);
        if (index >= 0) linksOrdered[index] = link;
      }
      linksById.set(key, link);
      linksByInstallation.set(link.installationId, link);
    },
    find: (linkId) => linksById.get(linkId) ?? null,
    findByInstallation: (installationId) => linksByInstallation.get(installationId) ?? null,
    ofTenant: (tenantId) => linksOrdered.filter((link) => link.tenantId === tenantId),
    links: () => [...linksOrdered],
  };

  // --- updates ---
  const updatesById = new Map<string, InstallationUpdate>();
  const updatesOrdered: InstallationUpdate[] = [];
  const updateStore: UpdateStore = {
    put: (update) => {
      const key = update.updateId;
      if (!updatesById.has(key)) updatesOrdered.push(update);
      else {
        const index = updatesOrdered.findIndex((candidate) => candidate.updateId === key);
        if (index >= 0) updatesOrdered[index] = update;
      }
      updatesById.set(key, update);
    },
    find: (updateId) => updatesById.get(updateId) ?? null,
    ofLink: (linkId) => updatesOrdered.filter((update) => update.linkId === linkId),
    ofTenant: (tenantId) => updatesOrdered.filter((update) => update.tenantId === tenantId),
    updates: () => [...updatesOrdered],
  };

  return {
    publishers: publisherStore,
    releases: releaseStore,
    entitlements: entitlementStore,
    links: linkStore,
    updates: updateStore,
  };
}
