// Office app-sdk — deterministic test support (OFF-025).
//
// The shared fixtures of this package's acceptance suites, mirroring the
// landed packages' test idioms (actions/sync/authz): fixed tenants/
// installations/actors, injected timestamps (no wall clock, no randomness),
// the canonical sample manifest the suites mutate into malformed variants,
// fake action/app-catalog sources for the pure validation suites, and typed
// Result/ParseResult assertion helpers.
//
// Package-internal (NOT re-exported from index.ts): test files import it
// through the relative path only.
import { parseActor, parseCommandName, parseEntityId, parseTenantId, parseTimestamp } from '@office/contracts';
import type {
  Actor,
  CommandName,
  ContractParseError,
  EntityId,
  ParseResult,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { capability } from '@office/authz';
import type { DomainError } from '@office/domain-kernel';
import type { ActionDescriptorSource, AppCatalogSource, KnownAction, ManifestReview } from './validation';
import { parseAppManifest } from './manifest';
import type { AppManifest } from './manifest';
import type { AppVersion } from './identity';
import { appVersion } from './identity';

/** Unwrap a successful ParseResult (fails loud in tests). */
export const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

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

/** Narrow a manifest review failure to the cross-reference DomainError channel. */
export const expectValidationFail = (review: ManifestReview): DomainError => {
  if (review.ok) {
    throw new Error(`expected a typed failure, got: ${JSON.stringify(review.value)}`);
  }
  if (!('details' in review.error)) {
    throw new Error(`expected a validation failure, got a parse failure: ${JSON.stringify(review.error)}`);
  }
  return review.error;
};

/** Narrow a manifest review failure to the structural parse channel. */
export const expectParseFail = (review: ManifestReview): ContractParseError => {
  if (review.ok) {
    throw new Error(`expected a typed failure, got: ${JSON.stringify(review.value)}`);
  }
  if ('details' in review.error) {
    throw new Error(`expected a parse failure, got a validation failure: ${JSON.stringify(review.error)}`);
  }
  return review.error;
};

// ----- fixed identities --------------------------------------------------------------------

export const TENANT_A: TenantId = unwrap(
  parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'),
);
export const TENANT_B: TenantId = unwrap(
  parseTenantId('office-tnt-v1-b1b2c3d4e5f60718293a4b5c6d7e8f9a'),
);
export const INSTALLATION: EntityId = unwrap(
  parseEntityId('office-ent-v1-c3d4e5f60718293a4b5c6d7e8f9a1b2'),
);
export const INSTALLATION_B: EntityId = unwrap(
  parseEntityId('office-ent-v1-9d8c7b6a5f4e3d2c1b0a9988776655443322'),
);
export const ADMIN: EntityId = unwrap(
  parseEntityId('office-ent-v1-e5f60718293a4b5c6d7e8f9a1b2c3d4'),
);
export const OPERATOR: EntityId = unwrap(
  parseEntityId('office-ent-v1-f60718293a4b5c6d7e8f9a1b2c3d4e5'),
);

/** The fixed admin actor that grants/revokes permissions in the suites. */
export const adminActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: ADMIN }));
/** The fixed operator actor (a second revoker/grantor for identity proofs). */
export const operatorActor = (): Actor => unwrap(parseActor({ kind: 'user', actorId: OPERATOR }));

/** The injected clock: fixed instants, never wall time. */
export const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T10:15:30.000Z'));
export const T1: Timestamp = unwrap(parseTimestamp('2026-09-13T08:00:00.000Z'));
export const T2: Timestamp = unwrap(parseTimestamp('2026-09-14T09:30:00.000Z'));

// ----- the canonical sample manifest --------------------------------------------------------

/** The sample app's own id/version (typed builders, used across suites). */
export const SAMPLE_APP_ID = 'field-progress-tracker';
export const SAMPLE_APP_VERSION = '1.4.0';

/** The canonical sample command the sample app binds (reversible class). */
export const SAMPLE_COMMAND: CommandName = unwrap(parseCommandName('field.recordProgress'));
/** A read-class command used by the class-mismatch fixtures. */
export const READ_COMMAND: CommandName = unwrap(parseCommandName('cost.listCostItems'));

/**
 * The canonical VALID manifest raw the suites parse, validate, and mutate
 * into malformed variants. Deterministic data only — no clock, no ids.
 */
export const SAMPLE_MANIFEST_RAW = {
  kind: 'app-manifest',
  schemaVersion: '1.0.0',
  appId: SAMPLE_APP_ID,
  manifestVersion: SAMPLE_APP_VERSION,
  title: 'Field Progress Tracker',
  description: 'Tracks daily field progress against the plan.',
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
        description: 'Records one field progress observation.',
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
  uiExtensions: [
    {
      kind: 'ui-extension',
      extensionPoint: 'project.overview.panel',
      view: {
        kind: 'view',
        viewId: 'progress-summary',
        title: 'Progress',
        elements: [
          { kind: 'heading', text: 'Field progress' },
          { kind: 'metric', label: 'Completion', value: '82', unit: '%' },
          { kind: 'action', label: 'Record progress', commandName: 'field.recordProgress' },
        ],
      },
    },
  ],
  dependencies: [
    { kind: 'app-dependency', appId: 'cost-insights', versionRange: '^2.1.0' },
  ],
} as const;

/**
 * The canonical sample manifest in PARSED (typed) form — the round-trip
 * oracle the suites compare parse/builder output against. Identical to
 * SAMPLE_MANIFEST_RAW except the dependency version range, which normalizes
 * from its string form ('^2.1.0') to the typed
 * { kind: 'caret', version: '2.1.0' }.
 */
export const SAMPLE_MANIFEST: AppManifest = unwrap(parseAppManifest(SAMPLE_MANIFEST_RAW));

// ----- fake validation sources (pure; the REAL registry is exercised in validation.test.ts) --

/** The known action behind the sample command (reversible, work.write). */
export const SAMPLE_ACTION: KnownAction = {
  commandName: SAMPLE_COMMAND,
  actionClass: 'reversible',
  requiredCapabilities: [capability('work.write')],
};

/** A read-class known action (cost.listCostItems, cost.read). */
export const READ_ACTION: KnownAction = {
  commandName: READ_COMMAND,
  actionClass: 'read',
  requiredCapabilities: [capability('cost.read')],
};

/** Build a fake action-descriptor source from a list of known actions. */
export const fakeActionSource = (actions: readonly KnownAction[]): ActionDescriptorSource => ({
  find: (commandName) => actions.find((action) => action.commandName === commandName) ?? null,
});

/** Build a fake app catalog: app id → published versions (absent id → unknown). */
export const fakeCatalog = (
  entries: Record<string, readonly string[]>,
): AppCatalogSource => ({
  versions: (appId) => {
    const published = entries[appId as string];
    return published === undefined ? null : (published.map(appVersion) as AppVersion[]);
  },
});

/** The canonical validation deps the happy-path suites use. */
export const sampleDeps = (): { readonly actions: ActionDescriptorSource; readonly apps: AppCatalogSource } => ({
  actions: fakeActionSource([SAMPLE_ACTION, READ_ACTION]),
  apps: fakeCatalog({ 'cost-insights': ['2.1.0', '2.3.1', '3.0.0'] }),
});
