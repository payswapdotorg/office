// Office marketplace — publisher registration & revocation (OFF-027).
//
// The tenant-scoped publisher record (ADR-003 "marketplace trust": publisher
// identity): WHO may publish WHICH apps. A publisher belongs to exactly one
// tenant (A12 — registration, revocation, and every query are tenant-scoped)
// and carries the CLOSED set of app ids it may publish; publishing any other
// app through it is a typed rejection. Revocation is TERMINAL and
// IDEMPOTENT (the A9 permission/revocation convention): a revoked publisher
// can never publish again — re-registration is a NEW publisher key — and
// re-revoking returns the record unchanged with the original revocation
// instant and actor preserved.
import { parseActor, parseFail, parseOk, parseTenantId, parseTimestamp } from '@office/contracts';
import type { Actor, ParseResult, TenantId, Timestamp } from '@office/contracts';
import { parseAppId } from '@office/app-sdk';
import type { AppId } from '@office/app-sdk';
import { publisherIdOf, parsePublisherId } from './identity';
import type { PublisherId } from './identity';
import {
  describeValue,
  isPlainObject,
  parseArrayWith,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';

/** Lifecycle state of a marketplace publisher (revocation is terminal). */
export type PublisherState = 'active' | 'revoked';

/** Both publisher states, in vocabulary order. */
export const PUBLISHER_STATES: readonly PublisherState[] = ['active', 'revoked'] as const;

/** Grammar description used in parse failures. */
export const PUBLISHER_STATE_GRAMMAR = "'active' | 'revoked' (revoked is terminal)";

/** Grammar description used in parse failures. */
export const PUBLISHER_GRAMMAR =
  "Publisher: { kind: 'marketplace-publisher', publisherId, tenantId, displayName, apps, state, registeredAt, registeredBy, revokedAt, revokedBy }";

const PUBLISHER_KEYS = [
  'kind',
  'publisherId',
  'tenantId',
  'displayName',
  'apps',
  'state',
  'registeredAt',
  'registeredBy',
  'revokedAt',
  'revokedBy',
] as const;

const DISPLAY_NAME_RULE = {
  min: 1,
  max: 120,
  description: 'publisher display name',
} as const;

/** Parse an untrusted value as a PublisherState (total, fail-closed). */
export function parsePublisherState(raw: unknown): ParseResult<PublisherState> {
  if (typeof raw !== 'string' || !(PUBLISHER_STATES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', PUBLISHER_STATE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as PublisherState);
}

/** Type guard for structurally valid PublisherState values. */
export function isPublisherState(raw: unknown): raw is PublisherState {
  return parsePublisherState(raw).ok;
}

/**
 * The tenant-scoped marketplace publisher: the identity that may publish
 * releases of its declared apps. The derived publisher id keys on
 * (tenant, display name, sorted app set) — one publisher per logical key.
 */
export interface Publisher {
  readonly kind: 'marketplace-publisher';
  /** The derived, deterministic publisher identity. */
  readonly publisherId: PublisherId;
  /** The tenant the publisher belongs to (A12). */
  readonly tenantId: TenantId;
  /** Human-readable publisher name (1..120 characters). */
  readonly displayName: string;
  /** The closed set of apps this publisher may publish. */
  readonly apps: readonly AppId[];
  /** The lifecycle position (revocation is terminal). */
  readonly state: PublisherState;
  /** When the publisher was registered (injected clock). */
  readonly registeredAt: Timestamp;
  /** The actor that registered the publisher. */
  readonly registeredBy: Actor;
  /** When the publisher was revoked; non-null exactly when revoked. */
  readonly revokedAt: Timestamp | null;
  /** The actor that revoked the publisher; non-null exactly when revoked. */
  readonly revokedBy: Actor | null;
}

/** Parse an untrusted value as a Publisher (total, fail-closed, strict keys). */
export function parsePublisher(raw: unknown): ParseResult<Publisher> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PUBLISHER_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PUBLISHER_KEYS, '', PUBLISHER_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['marketplace-publisher']);
  if (!kind.ok) return kind;
  const publisherId = requireFieldWith(raw, 'publisherId', '', parsePublisherId);
  if (!publisherId.ok) return publisherId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const displayName = requireString(raw, 'displayName', '', DISPLAY_NAME_RULE);
  if (!displayName.ok) return displayName;
  const apps = requireFieldWith(raw, 'apps', '', (value) =>
    parseArrayWith(value, 'apps', (item) => parseAppId(item), PUBLISHER_GRAMMAR),
  );
  if (!apps.ok) return apps;
  const state = requireFieldWith(raw, 'state', '', parsePublisherState);
  if (!state.ok) return state;
  const registeredAt = requireFieldWith(raw, 'registeredAt', '', parseTimestamp);
  if (!registeredAt.ok) return registeredAt;
  const registeredBy = requireFieldWith(raw, 'registeredBy', '', parseActor);
  if (!registeredBy.ok) return registeredBy;
  const revokedAt = requireNullableFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  const revokedBy = requireNullableFieldWith(raw, 'revokedBy', '', parseActor);
  if (!revokedBy.ok) return revokedBy;
  if (apps.value.length === 0) {
    return parseFail('invalid-value', 'apps', 'at least one publishable app id', 'empty array');
  }
  if (apps.value.length !== new Set(apps.value.map((app) => app as string)).size) {
    return parseFail('invalid-value', 'apps', 'no duplicate app ids', 'duplicate app id');
  }
  if (state.value === 'revoked' && (revokedAt.value === null || revokedBy.value === null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      'revocation instant and actor non-null exactly when state is revoked',
      'revoked publisher without revocation provenance',
    );
  }
  if (state.value === 'active' && (revokedAt.value !== null || revokedBy.value !== null)) {
    return parseFail(
      'invalid-value',
      'revokedAt',
      'revocation instant and actor null exactly when state is active',
      'active publisher carrying revocation provenance',
    );
  }
  return parseOk({
    kind: 'marketplace-publisher',
    publisherId: publisherId.value,
    tenantId: tenantId.value,
    displayName: displayName.value,
    apps: apps.value,
    state: state.value,
    registeredAt: registeredAt.value,
    registeredBy: registeredBy.value,
    revokedAt: revokedAt.value,
    revokedBy: revokedBy.value,
  } satisfies Publisher);
}

/** Type guard for structurally valid Publisher values. */
export function isPublisher(raw: unknown): raw is Publisher {
  return parsePublisher(raw).ok;
}

/**
 * Compose a fresh publisher record (trusted path; loud TypeError): state
 * 'active', no revocation fields. The publisher id is DERIVED from the
 * (tenant, display name, sorted apps) logical key — deterministic identity,
 * never caller-minted.
 */
export function registerPublisher(parts: {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly apps: readonly AppId[];
  readonly registeredAt: Timestamp;
  readonly registeredBy: Actor;
}): Publisher {
  const publisher: Publisher = {
    kind: 'marketplace-publisher',
    publisherId: publisherIdOf({
      tenantId: parts.tenantId,
      displayName: parts.displayName,
      apps: parts.apps.map((app) => app as string),
    }),
    tenantId: parts.tenantId,
    displayName: parts.displayName,
    apps: [...parts.apps],
    state: 'active',
    registeredAt: parts.registeredAt,
    registeredBy: parts.registeredBy,
    revokedAt: null,
    revokedBy: null,
  };
  const parsed = parsePublisher(publisher);
  if (!parsed.ok) {
    throw new TypeError(`invalid marketplace publisher: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Revoke the publisher (TERMINAL and IDEMPOTENT — the A9 revocation
 * convention): the record stops conferring the right to publish; revoking
 * an already-revoked publisher returns it unchanged with the ORIGINAL
 * revocation instant and actor preserved. The audit trail (engine level)
 * records only the actual transition.
 */
export function revokePublisher(
  publisher: Publisher,
  parts: { readonly at: Timestamp; readonly by: Actor },
): Publisher {
  if (publisher.state === 'revoked') return publisher;
  const revoked: Publisher = {
    ...publisher,
    state: 'revoked',
    revokedAt: parts.at,
    revokedBy: parts.by,
  };
  const parsed = parsePublisher(revoked);
  if (!parsed.ok) {
    throw new TypeError(`invalid revoked publisher: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Is the publisher currently entitled to publish (state 'active')? */
export function isPublisherActive(publisher: Publisher): boolean {
  return publisher.state === 'active';
}

/** May the publisher publish releases of `appId` (active + declared app)? */
export function mayPublishApp(publisher: Publisher, appId: AppId): boolean {
  return isPublisherActive(publisher) && publisher.apps.includes(appId);
}
