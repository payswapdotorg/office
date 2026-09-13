// Office marketplace — updates with permission-delta review (OFF-027).
//
// THE update flow (ADR-003 lifecycle: "update → rollback"): an update to a
// newer release is a STAGED RECORD, never a silent swap. Staging computes
// the permission delta between the currently-pinned release's manifest and
// the target release's manifest (keyed on (capability, scope kind) — the A9
// declaration footprint; a declaration-version bump within the same key is
// a reviewed change, but it does not ADD capability). Applying requires the
// SDK's `reviewAppManifest` to have validated the target release's manifest
// (the release intake already did — the pinned manifests are validated),
// and ADDED capabilities require FRESH grant confirmations: an
// added-capability update applied without a confirmation for EVERY added
// permission spec is typed-rejected ('forbidden' / 'confirmation-required');
// an unchanged-capability update proceeds without confirmation.
//
// Rollback of an applied update moves the installation link's pin back to
// the update's from-release — an explicit typed command producing an
// auditable transition; the release records themselves are immutable.
import { parseActor, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId, parseAppVersion, parsePermissionSpec } from '@office/app-sdk';
import type { AppId, AppManifest, AppVersion, PermissionSpec } from '@office/app-sdk';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
import { parseInstallationLinkId, parseReleaseId, parseUpdateId, updateIdOf } from './identity';
import type { InstallationLinkId, ReleaseId, UpdateId } from './identity';
import {
  describeValue,
  isPlainObject,
  parseArrayWith,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';
import { invariantFailure } from './failure';
import type { Result } from '@office/domain-kernel';
import type { DomainError } from '@office/domain-kernel';

// ----- the permission delta ----------------------------------------------------------------

/**
 * The reviewed permission delta between two manifests' A9 declarations:
 * specs keyed on (capability, scope kind) — ADDED keys (the target asks for
 * capability the current release never had), REMOVED keys, and UNCHANGED
 * keys (present in both; the spec version may differ — a version bump is
 * carried in the target's spec, but it does not add capability footprint).
 * Lists are canonically ordered (capability ascending, then scope kind).
 */
export interface PermissionDelta {
  /** Specs the target release ADDS (fresh confirmation required to apply). */
  readonly added: readonly PermissionSpec[];
  /** Specs the target release drops. */
  readonly removed: readonly PermissionSpec[];
  /** Specs present in both (the target's spec — version bumps visible). */
  readonly unchanged: readonly PermissionSpec[];
}

/** Grammar description used in parse failures. */
export const PERMISSION_DELTA_GRAMMAR =
  'PermissionDelta: { added, removed, unchanged } — canonically ordered PermissionSpec lists keyed on (capability, scopeKind)';

const PERMISSION_DELTA_KEYS = ['added', 'removed', 'unchanged'] as const;

/** The logical key of a permission spec (the A9 footprint identity). */
const permissionKey = (spec: PermissionSpec): string =>
  `${spec.capability}@${spec.scopeKind}`;

/** Canonical (capability, scopeKind) comparator. */
const byPermissionKey = (a: PermissionSpec, b: PermissionSpec): number => {
  const ka = permissionKey(a);
  const kb = permissionKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * Compute the permission delta between the CURRENT release's manifest and
 * the TARGET release's manifest (pure, deterministic): the A9 review the
 * marketplace runs before an update may apply. Version-range: same
 * (capability, scopeKind) in both manifests is UNCHANGED (the target's spec
 * is carried — its declaration version may have bumped); keys only in the
 * target are ADDED; keys only in the current release are REMOVED.
 */
export function permissionDeltaOf(
  current: AppManifest,
  target: AppManifest,
): PermissionDelta {
  const currentKeys = new Map<string, PermissionSpec>();
  for (const spec of current.permissions) currentKeys.set(permissionKey(spec), spec);
  const targetKeys = new Map<string, PermissionSpec>();
  for (const spec of target.permissions) targetKeys.set(permissionKey(spec), spec);
  const added: PermissionSpec[] = [];
  const removed: PermissionSpec[] = [];
  const unchanged: PermissionSpec[] = [];
  for (const [key, spec] of targetKeys) {
    if (currentKeys.has(key)) unchanged.push(spec);
    else added.push(spec);
  }
  for (const [key, spec] of currentKeys) {
    if (!targetKeys.has(key)) removed.push(spec);
  }
  return {
    added: added.sort(byPermissionKey),
    removed: removed.sort(byPermissionKey),
    unchanged: unchanged.sort(byPermissionKey),
  };
}

/** Parse an untrusted value as a PermissionDelta (total, fail-closed). */
export function parsePermissionDelta(raw: unknown): ParseResult<PermissionDelta> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PERMISSION_DELTA_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PERMISSION_DELTA_KEYS, '', PERMISSION_DELTA_GRAMMAR);
  if (unknownKey) return unknownKey;
  const lists: Record<string, readonly PermissionSpec[]> = {};
  for (const field of PERMISSION_DELTA_KEYS) {
    const parsed = requireFieldWith(raw, field, '', (value) =>
      parseArrayWith(value, field, (item) => parsePermissionSpec(item), PERMISSION_DELTA_GRAMMAR),
    );
    if (!parsed.ok) return parsed;
    lists[field] = parsed.value;
  }
  return parseOk({
    added: lists['added'] ?? [],
    removed: lists['removed'] ?? [],
    unchanged: lists['unchanged'] ?? [],
  } satisfies PermissionDelta);
}

/** Type guard for structurally valid PermissionDelta values. */
export function isPermissionDelta(raw: unknown): raw is PermissionDelta {
  return parsePermissionDelta(raw).ok;
}

/** Does the delta add capability footprint (fresh confirmation required)? */
export function addsCapability(delta: PermissionDelta): boolean {
  return delta.added.length > 0;
}

/** The '<capability>@<scope-kind>' summary of a spec (audit rendering). */
export const permissionSummary = (spec: PermissionSpec): string =>
  `${spec.capability}@${spec.scopeKind}`;

// ----- the fresh grant confirmation --------------------------------------------------------

/** Grammar description used in parse failures. */
export const PERMISSION_CONFIRMATION_GRAMMAR =
  "PermissionConfirmation: { kind: 'update-confirmation', capability, scopeKind: 'tenant' | 'project' } — one fresh grant confirmation per ADDED permission spec";

const PERMISSION_CONFIRMATION_KEYS = ['kind', 'capability', 'scopeKind'] as const;

const SCOPE_KINDS = ['tenant', 'project'] as const;

/**
 * One fresh grant confirmation: the explicit confirmation that the added
 * permission spec (capability + scope kind) was re-granted/reviewed for the
 * update. The capability is validated against the CLOSED authz vocabulary.
 */
export interface PermissionConfirmation {
  readonly kind: 'update-confirmation';
  /** The confirmed capability (closed authz vocabulary). */
  readonly capability: Capability;
  /** The confirmed scope kind. */
  readonly scopeKind: 'tenant' | 'project';
}

/** Parse an untrusted value as a PermissionConfirmation (total, fail-closed). */
export function parsePermissionConfirmation(raw: unknown): ParseResult<PermissionConfirmation> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PERMISSION_CONFIRMATION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    PERMISSION_CONFIRMATION_KEYS,
    '',
    PERMISSION_CONFIRMATION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['update-confirmation']);
  if (!kind.ok) return kind;
  const capability = requireFieldWith(raw, 'capability', '', parseCapability);
  if (!capability.ok) return capability;
  const scopeKind = requireLiteral(raw, 'scopeKind', '', [...SCOPE_KINDS]);
  if (!scopeKind.ok) return scopeKind;
  return parseOk({
    kind: 'update-confirmation',
    capability: capability.value,
    scopeKind: scopeKind.value as PermissionConfirmation['scopeKind'],
  } satisfies PermissionConfirmation);
}

/** Type guard for structurally valid PermissionConfirmation values. */
export function isPermissionConfirmation(raw: unknown): raw is PermissionConfirmation {
  return parsePermissionConfirmation(raw).ok;
}

/** The confirmation summary (audit rendering). */
export const confirmationSummary = (confirmation: PermissionConfirmation): string =>
  `${confirmation.capability}@${confirmation.scopeKind}`;

/**
 * Do the confirmations cover the delta EXACTLY (fail-closed)? Every ADDED
 * spec must have exactly one matching confirmation; a confirmation for a
 * capability/scope-kind NOT being added, or a duplicate confirmation, is a
 * typed rejection — an added-capability update without complete fresh
 * confirmation never applies.
 */
export function confirmationsCover(
  delta: PermissionDelta,
  confirmations: readonly PermissionConfirmation[],
): Result<true, DomainError> {
  if (!addsCapability(delta) && confirmations.length === 0) {
    return { ok: true as const, value: true };
  }
  const required = new Set(delta.added.map((spec) => permissionKey(spec)));
  const seen = new Set<string>();
  for (const confirmation of confirmations) {
    const key = `${confirmation.capability}@${confirmation.scopeKind}`;
    if (seen.has(key)) {
      return invariantFailure(
        'duplicate-confirmation',
        `duplicate fresh-grant confirmation for '${key}'`,
      );
    }
    seen.add(key);
    if (!required.has(key)) {
      return invariantFailure(
        'unexpected-confirmation',
        `fresh-grant confirmation for '${key}' does not match any added permission spec`,
      );
    }
  }
  for (const key of required) {
    if (!seen.has(key)) {
      return invariantFailure(
        'confirmation-required',
        `added permission spec '${key}' requires a fresh grant confirmation to apply the update`,
      );
    }
  }
  return { ok: true as const, value: true };
}

// ----- the installation update record ------------------------------------------------------

/**
 * The lifecycle states of a staged update: 'staged' until applied; 'applied'
 * is the committed move (rollback returns it to 'rolled-back'); a staged
 * update that is never applied simply stays staged (a later staging of the
 * same move is a typed duplicate).
 */
export type UpdateState = 'staged' | 'applied' | 'rolled-back';

/** Every update state, in vocabulary order. */
export const UPDATE_STATES: readonly UpdateState[] = [
  'staged',
  'applied',
  'rolled-back',
] as const;

/** Grammar description used in parse failures. */
export const UPDATE_STATE_GRAMMAR =
  "'staged' | 'applied' | 'rolled-back' (applied moves the pin; rolled-back restored it)";

/** Grammar description used in parse failures. */
export const INSTALLATION_UPDATE_GRAMMAR =
  "InstallationUpdate: { kind: 'installation-update', updateId, linkId, tenantId, appId, fromReleaseId, fromVersion, toReleaseId, toVersion, permissionDelta, state, stagedAt, stagedBy, confirmations, appliedAt, appliedBy, rolledBackAt, rolledBackBy }";

const INSTALLATION_UPDATE_KEYS = [
  'kind',
  'updateId',
  'linkId',
  'tenantId',
  'appId',
  'fromReleaseId',
  'fromVersion',
  'toReleaseId',
  'toVersion',
  'permissionDelta',
  'state',
  'stagedAt',
  'stagedBy',
  'confirmations',
  'appliedAt',
  'appliedBy',
  'rolledBackAt',
  'rolledBackBy',
] as const;

/**
 * One staged installation update: the auditable record of moving an
 * installation link from one release to a NEWER one — the from/to pair, the
 * reviewed permission delta, the fresh grant confirmations accepted at
 * apply time, and the staged/applied/rolled-back position. The update id is
 * derived from (link, from release, to release): one staged move per pair.
 */
export interface InstallationUpdate {
  readonly kind: 'installation-update';
  /** The derived, deterministic update identity. */
  readonly updateId: UpdateId;
  /** The installation link being moved. */
  readonly linkId: InstallationLinkId;
  /** The tenant of the link (A12). */
  readonly tenantId: TenantId;
  /** The app being updated. */
  readonly appId: AppId;
  /** The release the link is moving FROM. */
  readonly fromReleaseId: ReleaseId;
  /** The version the link is moving FROM. */
  readonly fromVersion: AppVersion;
  /** The release the link is moving TO (strictly newer). */
  readonly toReleaseId: ReleaseId;
  /** The version the link is moving TO (strictly newer). */
  readonly toVersion: AppVersion;
  /** The reviewed permission delta of the move. */
  readonly permissionDelta: PermissionDelta;
  /** The update lifecycle position. */
  readonly state: UpdateState;
  /** When the update was staged (injected clock). */
  readonly stagedAt: Timestamp;
  /** The actor that staged the update. */
  readonly stagedBy: Actor;
  /** The fresh grant confirmations accepted at apply time (empty until applied). */
  readonly confirmations: readonly PermissionConfirmation[];
  /** When the update was applied; non-null exactly when applied/rolled-back. */
  readonly appliedAt: Timestamp | null;
  /** The actor that applied the update; non-null exactly when applied/rolled-back. */
  readonly appliedBy: Actor | null;
  /** When the applied update was rolled back; non-null exactly when rolled-back. */
  readonly rolledBackAt: Timestamp | null;
  /** The actor that rolled the update back; non-null exactly when rolled-back. */
  readonly rolledBackBy: Actor | null;
}

/** Parse an untrusted value as an InstallationUpdate (total, fail-closed, strict keys). */
export function parseInstallationUpdate(raw: unknown): ParseResult<InstallationUpdate> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', INSTALLATION_UPDATE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    INSTALLATION_UPDATE_KEYS,
    '',
    INSTALLATION_UPDATE_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['installation-update']);
  if (!kind.ok) return kind;
  const updateId = requireFieldWith(raw, 'updateId', '', parseUpdateId);
  if (!updateId.ok) return updateId;
  const linkId = requireFieldWith(raw, 'linkId', '', parseInstallationLinkId);
  if (!linkId.ok) return linkId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const appId = requireFieldWith(raw, 'appId', '', parseAppId);
  if (!appId.ok) return appId;
  const fromReleaseId = requireFieldWith(raw, 'fromReleaseId', '', parseReleaseId);
  if (!fromReleaseId.ok) return fromReleaseId;
  const fromVersion = requireFieldWith(raw, 'fromVersion', '', parseAppVersion);
  if (!fromVersion.ok) return fromVersion;
  const toReleaseId = requireFieldWith(raw, 'toReleaseId', '', parseReleaseId);
  if (!toReleaseId.ok) return toReleaseId;
  const toVersion = requireFieldWith(raw, 'toVersion', '', parseAppVersion);
  if (!toVersion.ok) return toVersion;
  const permissionDelta = requireFieldWith(raw, 'permissionDelta', '', parsePermissionDelta);
  if (!permissionDelta.ok) return permissionDelta;
  const state = requireFieldWith(raw, 'state', '', (value) => {
    if (typeof value !== 'string' || !(UPDATE_STATES as readonly string[]).includes(value)) {
      return parseFail('invalid-value', 'state', UPDATE_STATE_GRAMMAR, describeValue(value));
    }
    return parseOk(value);
  });
  if (!state.ok) return state;
  const stateValue = state.value as UpdateState;
  const stagedAt = requireFieldWith(raw, 'stagedAt', '', parseTimestamp);
  if (!stagedAt.ok) return stagedAt;
  const stagedBy = requireFieldWith(raw, 'stagedBy', '', parseActor);
  if (!stagedBy.ok) return stagedBy;
  const confirmations = requireFieldWith(raw, 'confirmations', '', (value) =>
    parseArrayWith(value, 'confirmations', (item) => parsePermissionConfirmation(item), INSTALLATION_UPDATE_GRAMMAR),
  );
  if (!confirmations.ok) return confirmations;
  const appliedAt = requireNullableFieldWith(raw, 'appliedAt', '', parseTimestamp);
  if (!appliedAt.ok) return appliedAt;
  const appliedBy = requireNullableFieldWith(raw, 'appliedBy', '', parseActor);
  if (!appliedBy.ok) return appliedBy;
  const rolledBackAt = requireNullableFieldWith(raw, 'rolledBackAt', '', parseTimestamp);
  if (!rolledBackAt.ok) return rolledBackAt;
  const rolledBackBy = requireNullableFieldWith(raw, 'rolledBackBy', '', parseActor);
  if (!rolledBackBy.ok) return rolledBackBy;
  if (
    (stateValue === 'applied' || stateValue === 'rolled-back') &&
    (appliedAt.value === null || appliedBy.value === null)
  ) {
    return parseFail(
      'invalid-value',
      'appliedAt',
      "applied instant and actor non-null exactly when state is 'applied' or 'rolled-back'",
      'applied update without apply provenance',
    );
  }
  if (stateValue === 'staged' && (appliedAt.value !== null || appliedBy.value !== null)) {
    return parseFail(
      'invalid-value',
      'appliedAt',
      "applied instant and actor null exactly when state is 'staged'",
      'staged update carrying apply provenance',
    );
  }
  if (
    stateValue === 'rolled-back' &&
    (rolledBackAt.value === null || rolledBackBy.value === null)
  ) {
    return parseFail(
      'invalid-value',
      'rolledBackAt',
      "rollback instant and actor non-null exactly when state is 'rolled-back'",
      'rolled-back update without rollback provenance',
    );
  }
  if (
    stateValue !== 'rolled-back' &&
    (rolledBackAt.value !== null || rolledBackBy.value !== null)
  ) {
    return parseFail(
      'invalid-value',
      'rolledBackAt',
      "rollback instant and actor null exactly when state is not 'rolled-back'",
      'non-rolled-back update carrying rollback provenance',
    );
  }
  return parseOk({
    kind: 'installation-update',
    updateId: updateId.value,
    linkId: linkId.value,
    tenantId: tenantId.value,
    appId: appId.value,
    fromReleaseId: fromReleaseId.value,
    fromVersion: fromVersion.value,
    toReleaseId: toReleaseId.value,
    toVersion: toVersion.value,
    permissionDelta: permissionDelta.value,
    state: stateValue,
    stagedAt: stagedAt.value,
    stagedBy: stagedBy.value,
    confirmations: confirmations.value,
    appliedAt: appliedAt.value,
    appliedBy: appliedBy.value,
    rolledBackAt: rolledBackAt.value,
    rolledBackBy: rolledBackBy.value,
  } satisfies InstallationUpdate);
}

/** Type guard for structurally valid InstallationUpdate values. */
export function isInstallationUpdate(raw: unknown): raw is InstallationUpdate {
  return parseInstallationUpdate(raw).ok;
}

/**
 * Compose a staged update record (trusted path; loud TypeError): state
 * 'staged', no apply/rollback provenance, no confirmations yet. The update
 * id is DERIVED from (link, from release, to release) — deterministic
 * identity; staging the same move twice collides typed.
 */
export function stageInstallationUpdate(parts: {
  readonly linkId: InstallationLinkId;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly fromReleaseId: ReleaseId;
  readonly fromVersion: AppVersion;
  readonly toReleaseId: ReleaseId;
  readonly toVersion: AppVersion;
  readonly permissionDelta: PermissionDelta;
  readonly stagedAt: Timestamp;
  readonly stagedBy: Actor;
}): InstallationUpdate {
  const update: InstallationUpdate = {
    kind: 'installation-update',
    updateId: updateIdOf({
      linkId: parts.linkId,
      fromReleaseId: parts.fromReleaseId,
      toReleaseId: parts.toReleaseId,
    }),
    linkId: parts.linkId,
    tenantId: parts.tenantId,
    appId: parts.appId,
    fromReleaseId: parts.fromReleaseId,
    fromVersion: parts.fromVersion,
    toReleaseId: parts.toReleaseId,
    toVersion: parts.toVersion,
    permissionDelta: parts.permissionDelta,
    state: 'staged',
    stagedAt: parts.stagedAt,
    stagedBy: parts.stagedBy,
    confirmations: [],
    appliedAt: null,
    appliedBy: null,
    rolledBackAt: null,
    rolledBackBy: null,
  };
  const parsed = parseInstallationUpdate(update);
  if (!parsed.ok) {
    throw new TypeError(`invalid installation update: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Apply a staged update (pure record transition; the engine gates it on the
 * confirmation review and moves the link's pin): the accepted fresh grant
 * confirmations are recorded on the update, and the state becomes 'applied'.
 */
export function applyStagedUpdate(
  update: InstallationUpdate,
  parts: {
    readonly confirmations: readonly PermissionConfirmation[];
    readonly at: Timestamp;
    readonly by: Actor;
  },
): InstallationUpdate {
  if (update.state !== 'staged') {
    throw new TypeError(`cannot apply an update in state '${update.state}'`);
  }
  const applied: InstallationUpdate = {
    ...update,
    state: 'applied',
    confirmations: [...parts.confirmations],
    appliedAt: parts.at,
    appliedBy: parts.by,
  };
  const parsed = parseInstallationUpdate(applied);
  if (!parsed.ok) {
    throw new TypeError(`invalid applied update: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Roll an APPLIED update back (pure record transition; the engine moves the
 * link's pin back to the from-release): the state becomes 'rolled-back'
 * with rollback provenance. The release records never change — only the
 * link's pin returns to the prior release.
 */
export function rollBackAppliedUpdate(
  update: InstallationUpdate,
  parts: { readonly at: Timestamp; readonly by: Actor },
): InstallationUpdate {
  if (update.state !== 'applied') {
    throw new TypeError(`cannot roll back an update in state '${update.state}'`);
  }
  const rolledBack: InstallationUpdate = {
    ...update,
    state: 'rolled-back',
    rolledBackAt: parts.at,
    rolledBackBy: parts.by,
  };
  const parsed = parseInstallationUpdate(rolledBack);
  if (!parsed.ok) {
    throw new TypeError(`invalid rolled-back update: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}
