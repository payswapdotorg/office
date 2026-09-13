// Office sync — the versioned subscription contract (OFF-028).
//
// A Subscription is the typed, VERSIONED contract a client submits to join
// one project slice's stream (freeze A12: all clients share ONE project
// state — a subscription is a viewing position on that shared state, never
// a private copy of it). Four pinned dimensions, checked fail-closed:
//
// - protocolVersion — the subscription protocol version this subscription
//   speaks (version.ts); unknown versions fail closed, never silently
//   accepted ("no unversioned external synchronization");
// - filter — the typed event filter: the tenant+project scope of the slice,
//   plus OPTIONAL entity-kind and event-name filters (null = all kinds /
//   all names);
// - cursor — the resume position in the slice (null = from the beginning);
// - the A9 backing grant — grantId + the grant lifecycle version the
//   subscription was composed against (a stale pin is typed-rejected at
//   (re)subscribe: the client recomposes against the upgraded grant).
//
// A cursor carried by a subscription MUST belong to that subscription (a
// cursor is subscription-scoped — checked fail-closed here and re-checked
// on every resubscribe).
import {
  parseEntityKind,
  parseEventName,
  parseFail,
  parseOk,
} from '@office/contracts';
import type { EntityKind, EventName, ParseResult, ProjectScope } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import { parseSubscriptionGrantId, parseSubscriptionId } from './identity';
import type { SubscriptionGrantId, SubscriptionId } from './identity';
import { parseGrantVersion } from './grant';
import type { GrantVersion } from './grant';
import { parseProjectScope, parseSliceCursor } from './slice';
import type { SliceCursor, SliceEntry } from './slice';
import { parseProtocolVersion } from './version';
import type { ProtocolVersion } from './version';
import {
  describeValue,
  isPlainObject,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

/** The typed event filter of a subscription. */
export interface SubscriptionFilter {
  /** The tenant+project scope of the slice being subscribed to (freeze A12). */
  readonly scope: ProjectScope;
  /** Optional entity-kind filter on the event's aggregate (null = all kinds). */
  readonly entityKinds: readonly EntityKind[] | null;
  /** Optional event-name filter (null = all event names). */
  readonly eventNames: readonly EventName[] | null;
}

/** The versioned subscription contract (the client synchronization API join). */
export interface Subscription {
  readonly kind: 'subscription';
  /** Deterministic subscription identity (derived from the subscription key). */
  readonly subscriptionId: SubscriptionId;
  /** The subscription protocol version this subscription is pinned to. */
  readonly protocolVersion: ProtocolVersion;
  /** The typed event filter (tenant + project scope + optional kind/name). */
  readonly filter: SubscriptionFilter;
  /** The resume position in the slice (null = subscribe from the beginning). */
  readonly cursor: SliceCursor | null;
  /** The A9 grant backing this subscription. */
  readonly grantId: SubscriptionGrantId;
  /** The grant lifecycle version this subscription was composed against. */
  readonly grantVersion: GrantVersion;
}

/** Shape description used in parse failures. */
export const SUBSCRIPTION_FILTER_GRAMMAR =
  'SubscriptionFilter: { scope: ProjectScope, entityKinds: EntityKind[] | null, eventNames: EventName[] | null }';

/** Shape description used in parse failures. */
export const SUBSCRIPTION_GRAMMAR =
  'Subscription: { kind, subscriptionId, protocolVersion, filter, cursor: SliceCursor | null, grantId, grantVersion }';

const SUBSCRIPTION_FILTER_KEYS = ['scope', 'entityKinds', 'eventNames'] as const;
const SUBSCRIPTION_KEYS = [
  'kind',
  'subscriptionId',
  'protocolVersion',
  'filter',
  'cursor',
  'grantId',
  'grantVersion',
] as const;

/** Parse an untrusted value as a SubscriptionFilter (total, fail-closed, strict keys). */
export function parseSubscriptionFilter(raw: unknown): ParseResult<SubscriptionFilter> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUBSCRIPTION_FILTER_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUBSCRIPTION_FILTER_KEYS, '', SUBSCRIPTION_FILTER_GRAMMAR);
  if (unknownKey) return unknownKey;
  const scope = requireFieldWith(raw, 'scope', '', parseProjectScope);
  if (!scope.ok) return scope;
  const entityKinds = requireNullableFieldWith(raw, 'entityKinds', '', (value) =>
    parseValueArray(value, 'entityKinds', parseEntityKind, 'array of canonical EntityKind values (>= 1, no duplicates)'),
  );
  if (!entityKinds.ok) return entityKinds;
  if (entityKinds.value !== null && entityKinds.value.length < 1) {
    return parseFail(
      'invalid-value',
      'entityKinds',
      'a non-empty array of entity kinds, or null for all kinds',
      'empty array',
    );
  }
  const eventNames = requireNullableFieldWith(raw, 'eventNames', '', (value) =>
    parseValueArray(value, 'eventNames', parseEventName, 'array of canonical EventName values (>= 1, no duplicates)'),
  );
  if (!eventNames.ok) return eventNames;
  if (eventNames.value !== null && eventNames.value.length < 1) {
    return parseFail(
      'invalid-value',
      'eventNames',
      'a non-empty array of event names, or null for all names',
      'empty array',
    );
  }
  return parseOk(
    {
      scope: scope.value,
      entityKinds: entityKinds.value,
      eventNames: eventNames.value,
    } satisfies SubscriptionFilter,
  );
}

/** Type guard for structurally valid SubscriptionFilter values. */
export function isSubscriptionFilter(raw: unknown): raw is SubscriptionFilter {
  return parseSubscriptionFilter(raw).ok;
}

/** Parse an untrusted value as a Subscription (total, fail-closed, strict keys). */
export function parseSubscription(raw: unknown): ParseResult<Subscription> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUBSCRIPTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUBSCRIPTION_KEYS, '', SUBSCRIPTION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['subscription']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const protocolVersion = requireFieldWith(raw, 'protocolVersion', '', parseProtocolVersion);
  if (!protocolVersion.ok) return protocolVersion;
  const filter = requireFieldWith(raw, 'filter', '', parseSubscriptionFilter);
  if (!filter.ok) return filter;
  const cursor = requireNullableFieldWith(raw, 'cursor', '', parseSliceCursor);
  if (!cursor.ok) return cursor;
  if (cursor.value !== null && cursor.value.subscriptionId !== subscriptionId.value) {
    return parseFail(
      'invalid-value',
      'cursor',
      'a cursor belonging to THIS subscription (cursors are subscription-scoped)',
      `cursor of subscription ${cursor.value.subscriptionId}`,
    );
  }
  const grantId = requireFieldWith(raw, 'grantId', '', parseSubscriptionGrantId);
  if (!grantId.ok) return grantId;
  const grantVersion = requireFieldWith(raw, 'grantVersion', '', parseGrantVersion);
  if (!grantVersion.ok) return grantVersion;
  return parseOk(
    {
      kind: 'subscription',
      subscriptionId: subscriptionId.value,
      protocolVersion: protocolVersion.value,
      filter: filter.value,
      cursor: cursor.value,
      grantId: grantId.value,
      grantVersion: grantVersion.value,
    } satisfies Subscription,
  );
}

/** Type guard for structurally valid Subscription values. */
export function isSubscription(raw: unknown): raw is Subscription {
  return parseSubscription(raw).ok;
}

/** Compose a SubscriptionFilter from validated parts (trusted path; loud TypeError). */
export function subscriptionFilter(filter: {
  readonly scope: ProjectScope;
  readonly entityKinds?: readonly EntityKind[] | null;
  readonly eventNames?: readonly EventName[] | null;
}): SubscriptionFilter {
  const parsed = parseSubscriptionFilter({
    scope: filter.scope,
    entityKinds: filter.entityKinds ?? null,
    eventNames: filter.eventNames ?? null,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid subscription filter: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Compose a Subscription from validated parts (trusted path; loud TypeError). */
export function subscription(sub: {
  readonly subscriptionId: SubscriptionId;
  readonly protocolVersion: ProtocolVersion;
  readonly filter: SubscriptionFilter;
  readonly cursor?: SliceCursor | null;
  readonly grantId: SubscriptionGrantId;
  readonly grantVersion: GrantVersion;
}): Subscription {
  const parsed = parseSubscription({
    ...sub,
    kind: 'subscription',
    cursor: sub.cursor ?? null,
  });
  if (!parsed.ok) {
    throw new TypeError(`invalid subscription: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/**
 * Does this ledger event match this subscription filter? (pure, deterministic)
 *
 * The event's scope must EQUAL the filter's tenant+project scope — events of
 * another tenant or another project NEVER match, in either direction (A12:
 * no cross-slice leakage, and no existence oracle: a non-matching event is
 * simply not delivered, never an error). Optional entity-kind and event-name
 * filters apply on top.
 */
export function eventMatchesFilter(
  event: LedgerEvent,
  filter: SubscriptionFilter,
): boolean {
  const scope = event.envelope.scope;
  if (
    scope.kind !== 'project' ||
    scope.tenantId !== filter.scope.tenantId ||
    scope.projectId !== filter.scope.projectId
  ) {
    return false;
  }
  if (
    filter.entityKinds !== null &&
    !filter.entityKinds.includes(event.aggregate.entityKind)
  ) {
    return false;
  }
  if (filter.eventNames !== null && !filter.eventNames.includes(event.envelope.eventName)) {
    return false;
  }
  return true;
}

/**
 * Filter a set of slice entries down to the ones this subscription delivers
 * (pure, deterministic): filter-matching events, in slice order, positions
 * preserved (positions stay intrinsic to the slice — filtered-out events
 * leave position gaps BY DESIGN; the cursor tracks DELIVERED positions, and
 * a resume re-reads and re-filters the in-between window deterministically).
 */
export function filterSliceEntries(
  entries: readonly SliceEntry[],
  filter: SubscriptionFilter,
): readonly SliceEntry[] {
  return entries.filter((entry) => eventMatchesFilter(entry.event, filter));
}
