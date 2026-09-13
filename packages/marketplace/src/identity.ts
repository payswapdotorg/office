// Office marketplace — identity vocabulary (OFF-027).
//
// The branded identity vocabulary of the marketplace's OWN records
// (publisher / release / entitlement / installation-link / update / audit
// record), mirroring the app-sdk's permission-id convention: every id is
// DERIVED from its logical key via sha256, so the same logical operation
// always reproduces the same identity — re-registering the same publisher
// key, re-granting the same entitlement range, or re-running the same
// lifecycle scenario in a second engine resolves to byte-identical ids
// (the run-twice audit-ledger determinism the acceptance demands). No
// clock, no randomness, no I/O in this module.
//
// These are marketplace-METADATA identities, deliberately distinct from the
// canonical contracts EntityId: the marketplace owns catalog/lifecycle
// bookkeeping (freeze A11 — marketplace metadata is never canonical project
// state), so its ids live in their own grammar namespace
// (office-pub/rel/etl/lnk/upd/mka-v1-…), never in office-ent-v1-….
import { createHash } from 'node:crypto';
import { parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { checkString, describeValue, parseStringLike } from './parse';
import type { StringRule } from './parse';

declare const publisherIdBrand: unique symbol;
declare const releaseIdBrand: unique symbol;
declare const entitlementIdBrand: unique symbol;
declare const installationLinkIdBrand: unique symbol;
declare const updateIdBrand: unique symbol;
declare const auditRecordIdBrand: unique symbol;

/** Marketplace publisher identity: office-pub-v1-<opaque> (derived). */
export type PublisherId = string & { readonly [publisherIdBrand]: 'PublisherId' };
/** Published app release identity: office-rel-v1-<opaque> (derived). */
export type ReleaseId = string & { readonly [releaseIdBrand]: 'ReleaseId' };
/** Tenant entitlement identity: office-etl-v1-<opaque> (derived, ordinal-qualified). */
export type EntitlementId = string & { readonly [entitlementIdBrand]: 'EntitlementId' };
/** Installation-link identity: office-lnk-v1-<opaque> (derived). */
export type InstallationLinkId = string & {
  readonly [installationLinkIdBrand]: 'InstallationLinkId';
};
/** Staged installation update identity: office-upd-v1-<opaque> (derived). */
export type UpdateId = string & { readonly [updateIdBrand]: 'UpdateId' };
/** Audit-ledger record identity: office-mka-v1-<opaque> (derived). */
export type AuditRecordId = string & { readonly [auditRecordIdBrand]: 'AuditRecordId' };

/** Grammar description used in parse failures. */
export const PUBLISHER_ID_GRAMMAR =
  'office-pub-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the publisher key)';
/** Grammar description used in parse failures. */
export const RELEASE_ID_GRAMMAR =
  'office-rel-v1-<opaque: 16..64 lowercase alphanumeric> (derived from app id + manifest version)';
/** Grammar description used in parse failures. */
export const ENTITLEMENT_ID_GRAMMAR =
  'office-etl-v1-<opaque: 16..64 lowercase alphanumeric> (derived from tenant + app + range + grant ordinal)';
/** Grammar description used in parse failures. */
export const INSTALLATION_LINK_ID_GRAMMAR =
  'office-lnk-v1-<opaque: 16..64 lowercase alphanumeric> (derived from tenant + installation id)';
/** Grammar description used in parse failures. */
export const UPDATE_ID_GRAMMAR =
  'office-upd-v1-<opaque: 16..64 lowercase alphanumeric> (derived from link + from/to release ids)';
/** Grammar description used in parse failures. */
export const AUDIT_RECORD_ID_GRAMMAR =
  'office-mka-v1-<opaque: 16..64 lowercase alphanumeric> (derived from transition + subject + instant)';

const DERIVED_OPAQUE_LENGTH = 32;

/** The shared id shape rule (prefix + lowercase alphanumeric opaque). */
const idRule = (prefix: string, grammar: string): StringRule => ({
  min: prefix.length + 16,
  max: prefix.length + 64,
  pattern: new RegExp(`^${prefix}[0-9a-z]{16,64}$`),
  description: grammar,
});

const PREFIXES = {
  publisher: 'office-pub-v1-',
  release: 'office-rel-v1-',
  entitlement: 'office-etl-v1-',
  link: 'office-lnk-v1-',
  update: 'office-upd-v1-',
  audit: 'office-mka-v1-',
} as const;

/** Parse any prefixed derived id (total, fail-closed against its grammar). */
const parseDerivedId = (
  raw: unknown,
  prefix: string,
  grammar: string,
): ParseResult<string> => {
  const result = parseStringLike(raw, idRule(prefix, grammar));
  return result;
};

/** The sha256-derived opaque part of a marketplace id. */
const derivedOpaque = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(
    0,
    DERIVED_OPAQUE_LENGTH,
  );

// ----- publisher --------------------------------------------------------------------------

/** Parse an untrusted value as a PublisherId (total, fail-closed). */
export function parsePublisherId(raw: unknown): ParseResult<PublisherId> {
  const result = parseDerivedId(raw, PREFIXES.publisher, PUBLISHER_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as PublisherId);
}

/** Type guard for structurally valid PublisherId values. */
export function isPublisherId(raw: unknown): raw is PublisherId {
  return parsePublisherId(raw).ok;
}

/** Compose a PublisherId (trusted path; loud TypeError). */
export function formatPublisherId(raw: string): PublisherId {
  const parsed = parsePublisherId(raw);
  if (!parsed.ok) throw new TypeError(`invalid publisher id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key a publisher id is derived from: the tenant-scoped
 * publisher identity (tenant + display name) and the closed set of apps the
 * publisher may publish. One publisher per logical key.
 */
export interface PublisherKey {
  readonly tenantId: string;
  readonly displayName: string;
  readonly apps: readonly string[];
}

/** Derive the deterministic publisher id from its logical key (pure). */
export function publisherIdOf(key: PublisherKey): PublisherId {
  return formatPublisherId(
    `${PREFIXES.publisher}${derivedOpaque(
      'publisher',
      key.tenantId,
      key.displayName,
      [...key.apps].sort().join(','),
    )}`,
  );
}

// ----- release -----------------------------------------------------------------------------

/** Parse an untrusted value as a ReleaseId (total, fail-closed). */
export function parseReleaseId(raw: unknown): ParseResult<ReleaseId> {
  const result = parseDerivedId(raw, PREFIXES.release, RELEASE_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as ReleaseId);
}

/** Type guard for structurally valid ReleaseId values. */
export function isReleaseId(raw: unknown): raw is ReleaseId {
  return parseReleaseId(raw).ok;
}

/** Compose a ReleaseId (trusted path; loud TypeError). */
export function formatReleaseId(raw: string): ReleaseId {
  const parsed = parseReleaseId(raw);
  if (!parsed.ok) throw new TypeError(`invalid release id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key a release id is derived from: the published app and its
 * pinned manifest version. One release per (app, version) — releases are
 * immutable once published, so the key never resolves to a second record.
 */
export interface ReleaseKey {
  readonly appId: string;
  readonly manifestVersion: string;
}

/** Derive the deterministic release id from its logical key (pure). */
export function releaseIdOf(key: ReleaseKey): ReleaseId {
  return formatReleaseId(
    `${PREFIXES.release}${derivedOpaque('release', key.appId, key.manifestVersion)}`,
  );
}

// ----- entitlement -------------------------------------------------------------------------

/** Parse an untrusted value as an EntitlementId (total, fail-closed). */
export function parseEntitlementId(raw: unknown): ParseResult<EntitlementId> {
  const result = parseDerivedId(raw, PREFIXES.entitlement, ENTITLEMENT_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as EntitlementId);
}

/** Type guard for structurally valid EntitlementId values. */
export function isEntitlementId(raw: unknown): raw is EntitlementId {
  return parseEntitlementId(raw).ok;
}

/** Compose an EntitlementId (trusted path; loud TypeError). */
export function formatEntitlementId(raw: string): EntitlementId {
  const parsed = parseEntitlementId(raw);
  if (!parsed.ok) throw new TypeError(`invalid entitlement id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key an entitlement id is derived from: the tenant, the app,
 * the granted version range, and the GRANT ORDINAL — the number of prior
 * entitlement records (active or revoked) over the same base key. Revocation
 * is terminal, so a re-grant after revocation mints a NEW, deterministic
 * identity (ordinal + 1) instead of resurrecting or overwriting the revoked
 * record — never last-write-wins.
 */
export interface EntitlementKey {
  readonly tenantId: string;
  readonly appId: string;
  readonly versionRange: string;
  readonly ordinal: number;
}

/** Derive the deterministic entitlement id from its logical key (pure). */
export function entitlementIdOf(key: EntitlementKey): EntitlementId {
  if (!Number.isInteger(key.ordinal) || key.ordinal < 0) {
    throw new TypeError(`invalid entitlement grant ordinal: ${String(key.ordinal)}`);
  }
  return formatEntitlementId(
    `${PREFIXES.entitlement}${derivedOpaque(
      'entitlement',
      key.tenantId,
      key.appId,
      key.versionRange,
      String(key.ordinal),
    )}`,
  );
}

// ----- installation link -------------------------------------------------------------------

/** Parse an untrusted value as an InstallationLinkId (total, fail-closed). */
export function parseInstallationLinkId(raw: unknown): ParseResult<InstallationLinkId> {
  const result = parseDerivedId(raw, PREFIXES.link, INSTALLATION_LINK_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as InstallationLinkId);
}

/** Type guard for structurally valid InstallationLinkId values. */
export function isInstallationLinkId(raw: unknown): raw is InstallationLinkId {
  return parseInstallationLinkId(raw).ok;
}

/** Compose an InstallationLinkId (trusted path; loud TypeError). */
export function formatInstallationLinkId(raw: string): InstallationLinkId {
  const parsed = parseInstallationLinkId(raw);
  if (!parsed.ok) throw new TypeError(`invalid installation-link id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key an installation-link id is derived from: the tenant and
 * the canonical app-runtime installation identity (an office EntityId). One
 * link per (tenant, installation) — an installation's marketplace metadata
 * linkage is unique and re-linking a severed installation is a typed error,
 * never a silent rebind.
 */
export interface InstallationLinkKey {
  readonly tenantId: string;
  readonly installationId: string;
}

/** Derive the deterministic installation-link id from its logical key (pure). */
export function installationLinkIdOf(key: InstallationLinkKey): InstallationLinkId {
  return formatInstallationLinkId(
    `${PREFIXES.link}${derivedOpaque('installation-link', key.tenantId, key.installationId)}`,
  );
}

// ----- update ------------------------------------------------------------------------------

/** Parse an untrusted value as an UpdateId (total, fail-closed). */
export function parseUpdateId(raw: unknown): ParseResult<UpdateId> {
  const result = parseDerivedId(raw, PREFIXES.update, UPDATE_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as UpdateId);
}

/** Type guard for structurally valid UpdateId values. */
export function isUpdateId(raw: unknown): raw is UpdateId {
  return parseUpdateId(raw).ok;
}

/** Compose an UpdateId (trusted path; loud TypeError). */
export function formatUpdateId(raw: string): UpdateId {
  const parsed = parseUpdateId(raw);
  if (!parsed.ok) throw new TypeError(`invalid update id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key an update id is derived from: the installation link and
 * the from/to release pair. One staged update per (link, from, to) —
 * staging the same move twice is a typed duplicate, never a silent
 * re-stamp.
 */
export interface UpdateKey {
  readonly linkId: string;
  readonly fromReleaseId: string;
  readonly toReleaseId: string;
}

/** Derive the deterministic update id from its logical key (pure). */
export function updateIdOf(key: UpdateKey): UpdateId {
  return formatUpdateId(
    `${PREFIXES.update}${derivedOpaque('update', key.linkId, key.fromReleaseId, key.toReleaseId)}`,
  );
}

// ----- audit ledger ------------------------------------------------------------------------

/** Parse an untrusted value as an AuditRecordId (total, fail-closed). */
export function parseAuditRecordId(raw: unknown): ParseResult<AuditRecordId> {
  const result = parseDerivedId(raw, PREFIXES.audit, AUDIT_RECORD_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as AuditRecordId);
}

/** Type guard for structurally valid AuditRecordId values. */
export function isAuditRecordId(raw: unknown): raw is AuditRecordId {
  return parseAuditRecordId(raw).ok;
}

/** Compose an AuditRecordId (trusted path; loud TypeError). */
export function formatAuditRecordId(raw: string): AuditRecordId {
  const parsed = parseAuditRecordId(raw);
  if (!parsed.ok) throw new TypeError(`invalid audit record id: ${describeValue(raw)}`);
  return parsed.value;
}

/**
 * The logical key an audit record id is derived from: the lifecycle
 * transition, its primary subject id, and the audited instant. Two full
 * runs of the same lifecycle scenario over the same injected clock derive
 * byte-identical audit ledgers — record ids included.
 */
export interface AuditRecordKey {
  readonly transition: string;
  readonly subject: string;
  readonly at: string;
}

/** Derive the deterministic audit record id from its logical key (pure). */
export function auditRecordIdOf(key: AuditRecordKey): AuditRecordId {
  return formatAuditRecordId(
    `${PREFIXES.audit}${derivedOpaque('audit', key.transition, key.subject, key.at)}`,
  );
}

// ----- shared sanity (exercised by the identity suite) ------------------------------------

/** Check a raw string against the shared opaque grammar (internal). */
export const checkOpaque = (value: string, prefix: string): ParseResult<string> =>
  checkString(value, idRule(prefix, `${prefix}<opaque>`), '');
