// Office app-sdk — identity & versioning vocabulary (OFF-025).
//
// The branded identity vocabulary this package owns on top of the contracts
// kinds: the marketplace app id, the app version (semantic version — the
// manifest is versioned twice: the envelope schema version from
// @office/contracts AND this app version), the extension view id, the app
// handler id (a stable SYMBOLIC name the app runtime resolves to installed
// handler code — a manifest never carries code, freeze A8), the A9
// permission id (deterministically derived, mirroring the events ledger /
// adapters-sdk / sync derivations), and the app dependency version range
// (exact or caret, on the OTHER app's contract versions).
//
// Every type follows the workspace convention: a total fail-closed `parse`
// for untrusted values, an `is` type guard, and a trusted builder/format
// path that throws loud TypeErrors instead of silently coercing.
//
// Determinism: ids are DERIVED from their logical key via sha256, so the
// same permission inputs always reproduce the same identity — re-granting a
// revoked permission for the same installation never mints a second id. No
// clock, no randomness, no I/O in this module.
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import {
  checkString,
  describeValue,
  isPlainObject,
  parseStringLike,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
  type StringRule,
} from './parse';

declare const appIdBrand: unique symbol;
declare const appVersionBrand: unique symbol;
declare const viewIdBrand: unique symbol;
declare const handlerIdBrand: unique symbol;
declare const permissionIdBrand: unique symbol;
declare const permissionVersionBrand: unique symbol;

/** Marketplace app identity: a lowercase slug, e.g. 'field-progress-tracker'. */
export type AppId = string & { readonly [appIdBrand]: 'AppId' };
/** App semantic version, e.g. '1.4.0' (the manifest's own version). */
export type AppVersion = string & { readonly [appVersionBrand]: 'AppVersion' };
/** Extension view identity: a lowercase slug unique within one app manifest. */
export type ViewId = string & { readonly [viewIdBrand]: 'ViewId' };
/** App handler identity: a lowercase slug the app runtime resolves to code. */
export type AppHandlerId = string & { readonly [handlerIdBrand]: 'AppHandlerId' };
/** A9 permission identity: office-prm-v1-<opaque> (derived, deterministic). */
export type PermissionId = string & { readonly [permissionIdBrand]: 'PermissionId' };
/**
 * Lifecycle version of a permission: 1 when issued, bumped by each explicit
 * spec upgrade. Holders pinned to the previous lifecycle version are stale
 * until the marketplace re-grants against the upgraded spec.
 */
export type PermissionVersion = number & {
  readonly [permissionVersionBrand]: 'PermissionVersion';
};

/** Grammar description used in parse failures. */
export const APP_ID_GRAMMAR =
  'marketplace app id: lowercase slug of 3..63 characters (letters, digits, hyphens; starts with a letter, ends alphanumeric, no double hyphens), e.g. field-progress-tracker';
/** Grammar description used in parse failures. */
export const APP_VERSION_GRAMMAR =
  'semantic version MAJOR.MINOR.PATCH with no leading zeros, e.g. 1.4.0';
/** Grammar description used in parse failures. */
export const VIEW_ID_GRAMMAR =
  'extension view id: lowercase slug of 3..63 characters (letters, digits, hyphens; starts with a letter, ends alphanumeric, no double hyphens)';
/** Grammar description used in parse failures. */
export const APP_HANDLER_ID_GRAMMAR =
  'app handler id: lowercase slug of 3..63 characters (letters, digits, hyphens; starts with a letter, ends alphanumeric, no double hyphens)';
/** Grammar description used in parse failures. */
export const PERMISSION_ID_GRAMMAR =
  'office-prm-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the permission key)';
/** Grammar description used in parse failures. */
export const PERMISSION_VERSION_GRAMMAR = `integer version in 1..${Number.MAX_SAFE_INTEGER} (1 when issued, bumped per explicit upgrade)`;
/** Grammar description used in parse failures. */
export const VERSION_RANGE_GRAMMAR =
  "exact semantic version 'MAJOR.MINOR.PATCH' or caret range '^MAJOR.MINOR.PATCH' (string form), or the equivalent typed { kind: 'exact' | 'caret', version }";

const SLUG_RULE: StringRule = {
  min: 3,
  max: 63,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/,
  description: 'lowercase slug (letters, digits, hyphens; starts with a letter, ends alphanumeric, no double hyphens)',
};

const APP_VERSION_RULE: StringRule = {
  min: 5,
  max: 32,
  pattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  description: APP_VERSION_GRAMMAR,
};

const VERSION_RANGE_RULE: StringRule = {
  min: 5,
  max: 33,
  pattern: /^\^?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  description: VERSION_RANGE_GRAMMAR,
};

/** The typed object form's keys (strict: 'kind' + 'version' only). */
const VERSION_RANGE_KEYS = ['kind', 'version'] as const;
/** The typed object form's kind literals. */
const VERSION_RANGE_KINDS = ['exact', 'caret'] as const;

const PERMISSION_ID_PREFIX = 'office-prm-v1-';
const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;

/** Parse an untrusted value as an AppId (total, fail-closed). */
export function parseAppId(raw: unknown): ParseResult<AppId> {
  const result = parseStringLike(raw, { ...SLUG_RULE, description: APP_ID_GRAMMAR });
  if (!result.ok) return result;
  return parseOk(result.value as AppId);
}

/** Type guard for structurally valid AppId values. */
export function isAppId(raw: unknown): raw is AppId {
  return parseAppId(raw).ok;
}

/** Compose an AppId (trusted path; loud TypeError). */
export function appId(raw: string): AppId {
  const parsed = parseAppId(raw);
  if (!parsed.ok) throw new TypeError(`invalid app id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Parse an untrusted value as an AppVersion (total, fail-closed). */
export function parseAppVersion(raw: unknown): ParseResult<AppVersion> {
  const result = parseStringLike(raw, APP_VERSION_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as AppVersion);
}

/** Type guard for structurally valid AppVersion values. */
export function isAppVersion(raw: unknown): raw is AppVersion {
  return parseAppVersion(raw).ok;
}

/** Compose an AppVersion (trusted path; loud TypeError). */
export function appVersion(raw: string): AppVersion {
  const parsed = parseAppVersion(raw);
  if (!parsed.ok) throw new TypeError(`invalid app version: ${describeValue(raw)}`);
  return parsed.value;
}

/** Parse an untrusted value as a ViewId (total, fail-closed). */
export function parseViewId(raw: unknown): ParseResult<ViewId> {
  const result = parseStringLike(raw, { ...SLUG_RULE, description: VIEW_ID_GRAMMAR });
  if (!result.ok) return result;
  return parseOk(result.value as ViewId);
}

/** Type guard for structurally valid ViewId values. */
export function isViewId(raw: unknown): raw is ViewId {
  return parseViewId(raw).ok;
}

/** Compose a ViewId (trusted path; loud TypeError). */
export function viewId(raw: string): ViewId {
  const parsed = parseViewId(raw);
  if (!parsed.ok) throw new TypeError(`invalid view id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Parse an untrusted value as an AppHandlerId (total, fail-closed). */
export function parseAppHandlerId(raw: unknown): ParseResult<AppHandlerId> {
  const result = parseStringLike(raw, {
    ...SLUG_RULE,
    description: APP_HANDLER_ID_GRAMMAR,
  });
  if (!result.ok) return result;
  return parseOk(result.value as AppHandlerId);
}

/** Type guard for structurally valid AppHandlerId values. */
export function isAppHandlerId(raw: unknown): raw is AppHandlerId {
  return parseAppHandlerId(raw).ok;
}

/** Compose an AppHandlerId (trusted path; loud TypeError). */
export function appHandlerId(raw: string): AppHandlerId {
  const parsed = parseAppHandlerId(raw);
  if (!parsed.ok) throw new TypeError(`invalid app handler id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Parse an untrusted value as a PermissionId (total, fail-closed). */
export function parsePermissionId(raw: unknown): ParseResult<PermissionId> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(PERMISSION_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(PERMISSION_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', PERMISSION_ID_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as PermissionId);
}

/** Type guard for structurally valid PermissionId values. */
export function isPermissionId(raw: unknown): raw is PermissionId {
  return parsePermissionId(raw).ok;
}

/** Compose a PermissionId (trusted path; loud TypeError). */
export function formatPermissionId(raw: string): PermissionId {
  const parsed = parsePermissionId(raw);
  if (!parsed.ok) throw new TypeError(`invalid permission id: ${describeValue(raw)}`);
  return parsed.value;
}

/** Parse an untrusted value as a PermissionVersion (total, fail-closed). */
export function parsePermissionVersion(raw: unknown): ParseResult<PermissionVersion> {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    return parseFail('invalid-value', '', PERMISSION_VERSION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as PermissionVersion);
}

/** Type guard for structurally valid PermissionVersion values. */
export function isPermissionVersion(raw: unknown): raw is PermissionVersion {
  return parsePermissionVersion(raw).ok;
}

/** The sha256-derived opaque part of a permission id. */
const derivedOpaque = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(
    0,
    DERIVED_OPAQUE_LENGTH,
  );

/**
 * The logical key a permission id is derived from: the tenant, the
 * tenant-scoped app installation (freeze A7 — installation creates the
 * tenant-scoped installation), the granted capability, and the scope kind.
 * One permission record per logical key: granting the same capability at the
 * same scope kind to the same installation again resolves to the SAME id —
 * the marketplace reviews a permission delta, never a silent duplicate.
 */
export interface PermissionKey {
  readonly tenantId: string;
  readonly installationId: string;
  readonly capability: string;
  readonly scopeKind: 'tenant' | 'project';
}

/** Derive the deterministic permission id from its logical key (pure). */
export function permissionIdOf(key: PermissionKey): PermissionId {
  return formatPermissionId(
    `${PERMISSION_ID_PREFIX}${derivedOpaque(
      'permission',
      key.tenantId,
      key.installationId,
      key.capability,
      key.scopeKind,
    )}`,
  );
}

// ----- app dependency version ranges ------------------------------------------------------

/**
 * The version range a dependency declares over ANOTHER app's published
 * contract versions: an exact pin, or a caret range (compatible upgrades
 * within the pinned major — or minor, below 1.0.0). A dependency is on the
 * other app's CONTRACT (its manifest surface), never its implementation.
 */
export type VersionRange =
  | { readonly kind: 'exact'; readonly version: AppVersion }
  | { readonly kind: 'caret'; readonly version: AppVersion };

/**
 * Parse an untrusted value as a VersionRange (total, fail-closed). Two
 * STRICTLY equivalent input forms are accepted, both normalizing to the
 * same typed value: the string form a manifest ships as JSON
 * ('2.1.0' / '^2.1.0'), and the typed object form a composed manifest
 * carries ({ kind: 'exact' | 'caret', version }) — so a parsed manifest
 * round-trips through the parse unchanged and the trusted `appManifest`
 * builder can re-validate its own typed parts. Anything else — '~' ranges,
 * wildcards, malformed versions, unknown keys — fails closed.
 */
export function parseVersionRange(raw: unknown): ParseResult<VersionRange> {
  if (isPlainObject(raw)) {
    const unknownKey = unknownKeyFailure(raw, VERSION_RANGE_KEYS, '', VERSION_RANGE_GRAMMAR);
    if (unknownKey) return unknownKey;
    const kind = requireLiteral(raw, 'kind', '', VERSION_RANGE_KINDS);
    if (!kind.ok) return kind;
    const version = requireFieldWith(raw, 'version', '', parseAppVersion);
    if (!version.ok) return version;
    return parseOk(
      (kind.value === 'caret'
        ? { kind: 'caret', version: version.value }
        : { kind: 'exact', version: version.value }) satisfies VersionRange,
    );
  }
  const result = checkString(raw, VERSION_RANGE_RULE, '');
  if (!result.ok) return result;
  const text = result.value;
  const caret = text.startsWith('^');
  const version = caret ? text.slice(1) : text;
  return parseOk(
    (caret
      ? { kind: 'caret', version: version as AppVersion }
      : { kind: 'exact', version: version as AppVersion }) satisfies VersionRange,
  );
}

/** Type guard for structurally valid VersionRange values. */
export function isVersionRange(raw: unknown): raw is VersionRange {
  return parseVersionRange(raw).ok;
}

/** Compose a VersionRange from its string form (trusted path; loud TypeError). */
export function versionRange(raw: string): VersionRange {
  const parsed = parseVersionRange(raw);
  if (!parsed.ok) throw new TypeError(`invalid version range: ${describeValue(raw)}`);
  return parsed.value;
}

/** The [major, minor, patch] triple of an app version. */
const versionParts = (value: AppVersion): readonly [number, number, number] => {
  const [major = '', minor = '', patch = ''] = value.split('.');
  return [Number(major), Number(minor), Number(patch)];
};

/**
 * Compare two app versions lexicographically over their triples: -1 when
 * `a` sorts before `b`, 0 when equal, 1 when after (pure, total).
 */
export function compareAppVersions(a: AppVersion, b: AppVersion): -1 | 0 | 1 {
  const left = versionParts(a);
  const right = versionParts(b);
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? 0;
    if (part < other) return -1;
    if (part > other) return 1;
  }
  return 0;
}

/**
 * Does `candidate` satisfy the version range? Exact: equality. Caret: the
 * semver caret semantics — within the pinned major for >=1.0.0, within the
 * pinned minor for 0.x.y (x > 0), and patch-compatible only for 0.0.z.
 */
export function satisfiesVersion(range: VersionRange, candidate: AppVersion): boolean {
  if (range.kind === 'exact') {
    return compareAppVersions(range.version, candidate) === 0;
  }
  const base = versionParts(range.version);
  const [baseMajor = 0, baseMinor = 0] = base;
  const other = versionParts(candidate);
  const [major = 0, minor = 0] = other;
  if (compareAppVersions(range.version, candidate) > 0) return false;
  if (baseMajor > 0) return major === baseMajor;
  if (baseMinor > 0) return major === 0 && minor === baseMinor;
  return major === 0 && minor === 0;
}
