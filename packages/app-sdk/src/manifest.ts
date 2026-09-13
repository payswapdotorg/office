// Office app-sdk — the AppManifest model (OFF-025).
//
// THE marketplace app declaration (freeze A7: apps declare capabilities,
// permissions, events, commands, UI surfaces, data dependencies,
// compatibility, versions): a versioned, tenant-independent TEMPLATE an app
// publisher ships and the marketplace (OFF-027) catalogs. The manifest is
// versioned TWICE — the envelope schema version (@office/contracts,
// fail-closed against KNOWN_SCHEMA_VERSIONS) and the app's own semantic
// version — and is validated in two total, fail-closed steps:
//
// 1. `parseAppManifest` (this module) — the STRUCTURAL parse: strict keys,
//    typed fields, closed vocabularies (capabilities via @office/authz,
//    extension points, scope kinds), and manifest-level uniqueness rules.
// 2. `validateAppManifest` (validation.ts) — the CROSS-REFERENCE validation
//    against the real OFF-017 action descriptors and the app catalog.
//
// A manifest NEVER carries executable code, credentials, provider
// vocabulary, or wildcard permissions; every declaration is explicit.
import {
  CURRENT_SCHEMA_VERSION,
  parseFail,
  parseOk,
  parseSchemaVersion,
} from '@office/contracts';
import type { ParseResult, SchemaVersion } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  parseArrayWith,
  requireFieldWith,
  requireLiteral,
  requireString,
  unknownKeyFailure,
} from './parse';
import { parseAppId, parseAppVersion, parseVersionRange } from './identity';
import type { AppId, AppVersion, VersionRange } from './identity';
import { parsePermissionSpec } from './permissions';
import type { PermissionSpec } from './permissions';
import { parseCommandBinding } from './bindings';
import type { CommandBinding } from './bindings';
import { parseEventSubscription } from './subscriptions';
import type { EventSubscription } from './subscriptions';
import { parseUiExtension } from './ui-extensions';
import type { UiExtension } from './ui-extensions';

/** Grammar description used in parse failures. */
export const APP_MANIFEST_GRAMMAR =
  "AppManifest: { kind: 'app-manifest', schemaVersion, appId, manifestVersion, title, description?, permissions, bindings, subscriptions, uiExtensions, dependencies }";

const APP_MANIFEST_KEYS = [
  'kind',
  'schemaVersion',
  'appId',
  'manifestVersion',
  'title',
  'description',
  'permissions',
  'bindings',
  'subscriptions',
  'uiExtensions',
  'dependencies',
] as const;

const APP_TITLE_RULE = { min: 1, max: 200, description: 'app title' } as const;
const APP_DESCRIPTION_RULE = { min: 1, max: 2000, description: 'app description' } as const;

/**
 * One app dependency: a dependency on ANOTHER app's published CONTRACT
 * versions (its manifest surface — commands, events, permissions it
 * exposes), never on its implementation. The version range is exact or
 * caret; validation.ts checks it against the app catalog and typed-rejects
 * unknown apps and unsatisfiable ranges.
 */
export interface AppDependency {
  readonly kind: 'app-dependency';
  /** The app the dependency is on (never the manifest's own app). */
  readonly appId: AppId;
  /** The contract version range required from that app. */
  readonly versionRange: VersionRange;
}

/** Grammar description used in parse failures. */
export const APP_DEPENDENCY_GRAMMAR =
  "AppDependency: { kind: 'app-dependency', appId, versionRange: 'MAJOR.MINOR.PATCH' | '^MAJOR.MINOR.PATCH' }";

const APP_DEPENDENCY_KEYS = ['kind', 'appId', 'versionRange'] as const;

/** Parse an untrusted value as an AppDependency (total, fail-closed, strict keys). */
export function parseAppDependency(raw: unknown): ParseResult<AppDependency> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_DEPENDENCY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_DEPENDENCY_KEYS, '', APP_DEPENDENCY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-dependency']);
  if (!kind.ok) return kind;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const versionRange = requireFieldWith(raw, 'versionRange', '', parseVersionRange);
  if (!versionRange.ok) return versionRange;
  return parseOk(
    {
      kind: 'app-dependency',
      appId: appId.value,
      versionRange: versionRange.value,
    } satisfies AppDependency,
  );
}

/** Type guard for structurally valid AppDependency values. */
export function isAppDependency(raw: unknown): raw is AppDependency {
  return parseAppDependency(raw).ok;
}

/**
 * THE marketplace app manifest: the versioned, explicit declaration of an
 * app's entire surface — identity, permissions, command bindings, event
 * subscriptions, UI extensions, and contract dependencies. Installation
 * (OFF-026/OFF-027) instantiates it tenant-scoped; the manifest itself
 * carries no tenant, no code, and no secrets.
 */
export interface AppManifest {
  readonly kind: 'app-manifest';
  /** The envelope schema version (fail-closed against KNOWN_SCHEMA_VERSIONS). */
  readonly schemaVersion: SchemaVersion;
  /** The app's own semantic version this manifest describes. */
  readonly manifestVersion: AppVersion;
  /** The marketplace app identity. */
  readonly appId: AppId;
  /** Human-readable app title (1..200 characters). */
  readonly title: string;
  /** Human-readable app description, or null. */
  readonly description: string | null;
  /** The A9 permission declarations (explicit, versioned; no wildcards). */
  readonly permissions: readonly PermissionSpec[];
  /** The command bindings (validated against the action vocabulary). */
  readonly bindings: readonly CommandBinding[];
  /** The event subscriptions (canonical event names + typed filters). */
  readonly subscriptions: readonly EventSubscription[];
  /** The UI extensions (typed extension points + view descriptors). */
  readonly uiExtensions: readonly UiExtension[];
  /** The contract dependencies on other apps (validated against the catalog). */
  readonly dependencies: readonly AppDependency[];
}

/**
 * Parse an untrusted value as an AppManifest (total, fail-closed, strict
 * keys) — the STRUCTURAL step. Manifest-level uniqueness rules are enforced
 * here: one permission per (capability, scope kind), one binding per
 * command name, one subscription per event name, one view per view id, one
 * dependency per app id — duplicates are typed-rejected, never silently
 * merged. A dependency on the manifest's OWN app id is rejected here too.
 */
export function parseAppManifest(raw: unknown): ParseResult<AppManifest> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APP_MANIFEST_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APP_MANIFEST_KEYS, '', APP_MANIFEST_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['app-manifest']);
  if (!kind.ok) return kind;
  const schemaVersion = requireFieldWith(raw, 'schemaVersion', '', parseSchemaVersion);
  if (!schemaVersion.ok) return schemaVersion;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const manifestVersion = requireFieldWith(raw, 'manifestVersion', '', parseAppVersion);
  if (!manifestVersion.ok) return manifestVersion;
  const title = requireString(raw, 'title', '', APP_TITLE_RULE);
  if (!title.ok) return title;
  const description = raw['description'];
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      return parseFail('invalid-type', 'description', APP_DESCRIPTION_RULE.description, describeValue(description));
    }
    if (description.length < APP_DESCRIPTION_RULE.min || description.length > APP_DESCRIPTION_RULE.max) {
      return parseFail('invalid-value', 'description', APP_DESCRIPTION_RULE.description, `string of length ${description.length}`);
    }
  }
  const permissions = requireFieldWith(raw, 'permissions', '', (value) =>
    parseArrayWith(value, '', parsePermissionSpec, APP_MANIFEST_GRAMMAR),
  );
  if (!permissions.ok) return permissions;
  const bindings = requireFieldWith(raw, 'bindings', '', (value) =>
    parseArrayWith(value, '', parseCommandBinding, APP_MANIFEST_GRAMMAR),
  );
  if (!bindings.ok) return bindings;
  const subscriptions = requireFieldWith(raw, 'subscriptions', '', (value) =>
    parseArrayWith(value, '', parseEventSubscription, APP_MANIFEST_GRAMMAR),
  );
  if (!subscriptions.ok) return subscriptions;
  const uiExtensions = requireFieldWith(raw, 'uiExtensions', '', (value) =>
    parseArrayWith(value, '', parseUiExtension, APP_MANIFEST_GRAMMAR),
  );
  if (!uiExtensions.ok) return uiExtensions;
  const dependencies = requireFieldWith(raw, 'dependencies', '', (value) =>
    parseArrayWith(value, '', parseAppDependency, APP_MANIFEST_GRAMMAR),
  );
  if (!dependencies.ok) return dependencies;

  // --- manifest-level uniqueness rules (fail-closed) ---
  const seenPermissions = new Set<string>();
  for (const [index, permission] of permissions.value.entries()) {
    const key = `${permission.capability}|${permission.scopeKind}`;
    if (seenPermissions.has(key)) {
      return parseFail(
        'invalid-value',
        `permissions[${index}]`,
        'one permission declaration per (capability, scope kind)',
        `duplicate permission '${permission.capability}' at scope kind '${permission.scopeKind}'`,
      );
    }
    seenPermissions.add(key);
  }
  const seenCommands = new Set<string>();
  for (const [index, binding] of bindings.value.entries()) {
    if (seenCommands.has(binding.commandName)) {
      return parseFail(
        'invalid-value',
        `bindings[${index}]`,
        'one binding per command name',
        `duplicate binding '${binding.commandName}'`,
      );
    }
    seenCommands.add(binding.commandName);
  }
  const seenEvents = new Set<string>();
  for (const [index, subscription] of subscriptions.value.entries()) {
    if (seenEvents.has(subscription.eventName)) {
      return parseFail(
        'invalid-value',
        `subscriptions[${index}]`,
        'one subscription per event name',
        `duplicate subscription '${subscription.eventName}'`,
      );
    }
    seenEvents.add(subscription.eventName);
  }
  const seenViews = new Set<string>();
  for (const [index, extension] of uiExtensions.value.entries()) {
    if (seenViews.has(extension.view.viewId)) {
      return parseFail(
        'invalid-value',
        `uiExtensions[${index}]`,
        'one view per view id',
        `duplicate view id '${extension.view.viewId}'`,
      );
    }
    seenViews.add(extension.view.viewId);
  }
  const seenDependencyApps = new Set<string>();
  for (const [index, dependency] of dependencies.value.entries()) {
    if (dependency.appId === appId.value) {
      return parseFail(
        'invalid-value',
        `dependencies[${index}]`,
        'a dependency on another app (never the manifest itself)',
        `self-dependency '${dependency.appId}'`,
      );
    }
    if (seenDependencyApps.has(dependency.appId)) {
      return parseFail(
        'invalid-value',
        `dependencies[${index}]`,
        'one dependency per app id',
        `duplicate dependency '${dependency.appId}'`,
      );
    }
    seenDependencyApps.add(dependency.appId);
  }

  return parseOk(
    {
      kind: 'app-manifest',
      schemaVersion: schemaVersion.value,
      appId: appId.value,
      manifestVersion: manifestVersion.value,
      title: title.value,
      description: description ?? null,
      permissions: permissions.value,
      bindings: bindings.value,
      subscriptions: subscriptions.value,
      uiExtensions: uiExtensions.value,
      dependencies: dependencies.value,
    } satisfies AppManifest,
  );
}

/** Type guard for structurally valid AppManifest values. */
export function isAppManifest(raw: unknown): raw is AppManifest {
  return parseAppManifest(raw).ok;
}

/**
 * Compose a validated AppManifest from a trusted object literal (trusted
 * path; loud TypeError): the same fail-closed parse runs, injecting the
 * manifest kind, defaulting the schema version to CURRENT_SCHEMA_VERSION
 * and the description to null when omitted. Publishers write manifests as
 * plain data and compose them through this builder.
 */
export function appManifest(
  parts: Omit<AppManifest, 'kind' | 'schemaVersion' | 'description'> & {
    readonly schemaVersion?: SchemaVersion;
    readonly description?: string | null;
  },
): AppManifest {
  const parsed = parseAppManifest({
    ...parts,
    kind: 'app-manifest',
    schemaVersion: parts.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    description: parts.description ?? null,
  });
  if (!parsed.ok) {
    throw new TypeError(
      `invalid app manifest: ${parsed.error.code} at '${
        parsed.error.path === '' ? '<root>' : parsed.error.path
      }' — expected ${parsed.error.expected}, received ${parsed.error.received}`,
    );
  }
  return parsed.value;
}
