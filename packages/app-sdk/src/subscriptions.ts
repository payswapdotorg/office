// Office app-sdk — event subscriptions (OFF-025).
//
// A marketplace app subscribes to canonical domain events (freeze A3/A6:
// apps are extensions over the same project graph — they REACT to events,
// they never write state directly). A subscription is the event name
// (validated against the canonical event-name grammar from
// @office/contracts — '2..6 dot-separated segments') plus a TYPED filter:
// either every occurrence of that event name, or the occurrences whose
// entity reference is of one declared entity kind. Delivery scope is the
// installation's scope (A12) — the app runtime (OFF-026) enforces it; the
// manifest only declares the subscription surface.
import { parseEntityKind, parseEventName, parseFail, parseOk } from '@office/contracts';
import type { EntityKind, EventName, ParseResult } from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

/** Grammar description used in parse failures. */
export const EVENT_SUBSCRIPTION_GRAMMAR =
  "EventSubscription: { kind: 'event-subscription', eventName, filter: { kind: 'all' } | { kind: 'entity-kind', entityKind } }";

/** Grammar description used in parse failures. */
export const EVENT_SUBSCRIPTION_FILTER_GRAMMAR =
  "{ kind: 'all' } | { kind: 'entity-kind', entityKind } — a typed filter, never a wildcard predicate";

const EVENT_SUBSCRIPTION_KEYS = ['kind', 'eventName', 'filter'] as const;
const FILTER_KINDS = ['all', 'entity-kind'] as const;

/**
 * The typed subscription filter: every occurrence of the subscribed event
 * name, or the occurrences whose entity reference carries one declared
 * entity kind. Filters are typed values — no arbitrary predicates, no
 * wildcard expressions.
 */
export type EventSubscriptionFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'entity-kind'; readonly entityKind: EntityKind };

/** Parse an untrusted value as an EventSubscriptionFilter (total, fail-closed). */
export function parseEventSubscriptionFilter(
  raw: unknown,
): ParseResult<EventSubscriptionFilter> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVENT_SUBSCRIPTION_FILTER_GRAMMAR, describeValue(raw));
  }
  const filterKind = requireLiteral(raw, 'kind', '', FILTER_KINDS);
  if (!filterKind.ok) return filterKind;
  if (filterKind.value === 'all') {
    const unknownKey = unknownKeyFailure(raw, ['kind'], '', EVENT_SUBSCRIPTION_FILTER_GRAMMAR);
    if (unknownKey) return unknownKey;
    return parseOk({ kind: 'all' } satisfies EventSubscriptionFilter);
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ['kind', 'entityKind'],
    '',
    EVENT_SUBSCRIPTION_FILTER_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const entityKind = requireFieldWith(raw, 'entityKind', '', parseEntityKind);
  if (!entityKind.ok) return entityKind;
  return parseOk(
    { kind: 'entity-kind', entityKind: entityKind.value } satisfies EventSubscriptionFilter,
  );
}

/** Type guard for structurally valid EventSubscriptionFilter values. */
export function isEventSubscriptionFilter(raw: unknown): raw is EventSubscriptionFilter {
  return parseEventSubscriptionFilter(raw).ok;
}

/**
 * One event subscription of an app manifest: the canonical event name plus
 * the typed filter. The event name must satisfy the canonical grammar;
 * delivery is installation-scoped and idempotent (consumers must be
 * idempotent — freeze A3 at-least-once assumption).
 */
export interface EventSubscription {
  readonly kind: 'event-subscription';
  /** The canonical domain event name subscribed to (grammar-validated). */
  readonly eventName: EventName;
  /** The typed filter narrowing which occurrences are delivered. */
  readonly filter: EventSubscriptionFilter;
}

/**
 * Parse an untrusted value as an EventSubscription (total, fail-closed,
 * strict keys). The filter is REQUIRED — a subscription without an explicit
 * filter fails closed; 'all occurrences' is declared as `{ kind: 'all' }`,
 * never silently defaulted.
 */
export function parseEventSubscription(raw: unknown): ParseResult<EventSubscription> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVENT_SUBSCRIPTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EVENT_SUBSCRIPTION_KEYS,
    '',
    EVENT_SUBSCRIPTION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['event-subscription']);
  if (!kind.ok) return kind;
  const eventName = requireFieldWith(raw, 'eventName', '', parseEventName);
  if (!eventName.ok) return eventName;
  const filter = requireFieldWith(raw, 'filter', '', parseEventSubscriptionFilter);
  if (!filter.ok) return filter;
  return parseOk(
    {
      kind: 'event-subscription',
      eventName: eventName.value,
      filter: filter.value,
    } satisfies EventSubscription,
  );
}

/** Type guard for structurally valid EventSubscription values. */
export function isEventSubscription(raw: unknown): raw is EventSubscription {
  return parseEventSubscription(raw).ok;
}
