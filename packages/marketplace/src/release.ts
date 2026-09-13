// Office marketplace — app releases (OFF-027).
//
// A release pins ONE validated AppManifest: the raw submission travels
// through the SDK's `reviewAppManifest` (structural parse + cross-reference
// validation against the injected action registry and the marketplace's own
// catalog source) BEFORE a release record exists. Releases are IMMUTABLE
// once published: the record carries the validated manifest verbatim and no
// marketplace operation ever rewrites, re-publishes, or removes a stored
// release — rollback moves installation LINKS back to a prior release, it
// never touches the release itself. The derived release id keys on
// (app id, manifest version), so one (app, version) resolves to at most one
// release forever.
import { parseActor, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId, parseAppManifest, parseAppVersion } from '@office/app-sdk';
import type { AppId, AppManifest, AppVersion } from '@office/app-sdk';
import { parseReleaseId, releaseIdOf, parsePublisherId } from './identity';
import type { PublisherId, ReleaseId } from './identity';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

/** Grammar description used in parse failures. */
export const APP_RELEASE_GRAMMAR =
  "AppRelease: { kind: 'app-release', releaseId, appId, manifestVersion, manifest, publisherId, tenantId, publishedAt, publishedBy }";

const APP_RELEASE_KEYS = [
  'kind',
  'releaseId',
  'appId',
  'manifestVersion',
  'manifest',
  'publisherId',
  'tenantId',
  'publishedAt',
  'publishedBy',
] as const;

/**
 * One published, immutable app release: the validated manifest pinned
 * verbatim (validation never repairs — `reviewAppManifest` returns the
 * manifest unchanged), the derived release identity, and the publishing
 * provenance (publisher + the publisher's tenant + injected-clock instant +
 * acting actor).
 */
export interface AppRelease {
  readonly kind: 'app-release';
  /** The derived, deterministic release identity (app + manifest version). */
  readonly releaseId: ReleaseId;
  /** The released app. */
  readonly appId: AppId;
  /** The pinned manifest version of this release. */
  readonly manifestVersion: AppVersion;
  /** The validated manifest, verbatim (immutable once published). */
  readonly manifest: AppManifest;
  /** The publisher that published the release. */
  readonly publisherId: PublisherId;
  /** The publisher's tenant (A12 scopes publisher operations, not the catalog). */
  readonly tenantId: TenantId;
  /** When the release was published (injected clock). */
  readonly publishedAt: Timestamp;
  /** The actor that published the release. */
  readonly publishedBy: Actor;
}

/** Parse an untrusted value as an AppRelease (total, fail-closed, strict keys). */
export function parseAppRelease(raw: unknown): ParseResult<AppRelease> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_RELEASE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_RELEASE_KEYS, '', APP_RELEASE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-release']);
  if (!kind.ok) return kind;
  const releaseId = requireFieldWith(raw, 'releaseId', '', parseReleaseId);
  if (!releaseId.ok) return releaseId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const manifestVersion = requireFieldWith(raw, 'manifestVersion', '', parseAppVersion);
  if (!manifestVersion.ok) return manifestVersion;
  const manifest = requireFieldWith(raw, 'manifest', '', parseAppManifest);
  if (!manifest.ok) return manifest;
  const publisherId = requireFieldWith(raw, 'publisherId', '', parsePublisherId);
  if (!publisherId.ok) return publisherId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const publishedAt = requireFieldWith(raw, 'publishedAt', '', parseTimestamp);
  if (!publishedAt.ok) return publishedAt;
  const publishedBy = requireFieldWith(raw, 'publishedBy', '', parseActor);
  if (!publishedBy.ok) return publishedBy;
  // The pinned manifest must BE the release: same app, same version.
  if (manifest.value.appId !== appId.value) {
    return parseFail(
      'invalid-value',
      'manifest.appId',
      'the pinned manifest describes the released app',
      `manifest app '${manifest.value.appId}' vs release app '${appId.value}'`,
    );
  }
  if (manifest.value.manifestVersion !== manifestVersion.value) {
    return parseFail(
      'invalid-value',
      'manifest.manifestVersion',
      'the pinned manifest carries the released version',
      `manifest version '${manifest.value.manifestVersion}' vs release version '${manifestVersion.value}'`,
    );
  }
  return parseOk({
    kind: 'app-release',
    releaseId: releaseId.value,
    appId: appId.value,
    manifestVersion: manifestVersion.value,
    manifest: manifest.value,
    publisherId: publisherId.value,
    tenantId: tenantId.value,
    publishedAt: publishedAt.value,
    publishedBy: publishedBy.value,
  } satisfies AppRelease);
}

/** Type guard for structurally valid AppRelease values. */
export function isAppRelease(raw: unknown): raw is AppRelease {
  return parseAppRelease(raw).ok;
}

/**
 * Compose a release record from an ALREADY-VALIDATED manifest (trusted
 * path; loud TypeError): the release id is DERIVED from (app, manifest
 * version) — deterministic identity, never caller-minted. The engine runs
 * `reviewAppManifest` first; this builder never validates the manifest
 * against the action/app vocabularies (that is the intake's job).
 */
export function publishReleaseRecord(parts: {
  readonly manifest: AppManifest;
  readonly publisherId: PublisherId;
  readonly tenantId: TenantId;
  readonly publishedAt: Timestamp;
  readonly publishedBy: Actor;
}): AppRelease {
  const release: AppRelease = {
    kind: 'app-release',
    releaseId: releaseIdOf({
      appId: parts.manifest.appId,
      manifestVersion: parts.manifest.manifestVersion,
    }),
    appId: parts.manifest.appId,
    manifestVersion: parts.manifest.manifestVersion,
    manifest: parts.manifest,
    publisherId: parts.publisherId,
    tenantId: parts.tenantId,
    publishedAt: parts.publishedAt,
    publishedBy: parts.publishedBy,
  };
  const parsed = parseAppRelease(release);
  if (!parsed.ok) {
    throw new TypeError(`invalid app release: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}
