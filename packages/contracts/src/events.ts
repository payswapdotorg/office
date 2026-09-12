// Office canonical contracts — events (OFF-002).
//
// DomainEventEnvelope per freeze A3: every consequential domain mutation
// emits an immutable domain event carrying event name, tenant/project scope,
// actor, source, correlation/causation ids (the Causality value object),
// schema version, occurred-at time, and before/after entity references
// where applicable (null where not). At-least-once delivery is assumed
// downstream; consumer idempotency is enforced by OFF-005, not here.
//
// Causality convention: correlationId ties one causal chain together;
// causationId references the causing message — a command's idempotency key
// or a prior event's ledger id — and is null for chain roots. Precise
// ledger semantics are owned by OFF-005.
import {
  describeValue,
  isPlainObject,
  parseFail,
  parseOk,
  parseStringLike,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import type { ParseResult } from './parse';
import { parseEntityId, parseEntityKind } from './identity';
import type { EntityId, EntityKind } from './identity';
import { parseScope } from './scope';
import type { Scope } from './scope';
import { parseActor } from './actor';
import type { Actor } from './actor';
import { parseTimestamp } from './time';
import type { Timestamp } from './time';
import { parseSchemaVersion } from './version';
import type { SchemaVersion } from './version';

declare const eventNameBrand: unique symbol;
declare const correlationIdBrand: unique symbol;
declare const causationIdBrand: unique symbol;

/** Canonical domain event name, e.g. 'projects.projectCreated'. */
export type EventName = string & { readonly [eventNameBrand]: 'EventName' };
/** Opaque correlation id tying one causal chain together. */
export type CorrelationId = string & { readonly [correlationIdBrand]: 'CorrelationId' };
/** Opaque id of the message that caused this message (null for chain roots). */
export type CausationId = string & { readonly [causationIdBrand]: 'CausationId' };

/** Architectural origin of an event (freeze A3 'source'). */
export type EventSource = 'domain' | 'adapter' | 'system';

/** Grammar description used in parse failures. */
export const EVENT_NAME_GRAMMAR =
  "2..6 dot-separated segments, each starting lowercase then alphanumeric, e.g. 'projects.projectCreated'";

/** Grammar description used in parse failures. */
export const CORRELATION_ID_GRAMMAR =
  'opaque printable-ASCII token of 8..128 characters (no whitespace)';

/** Grammar description used in parse failures. */
export const CAUSATION_ID_GRAMMAR = CORRELATION_ID_GRAMMAR;

const MESSAGE_NAME_RULE: StringRule = {
  min: 3,
  max: 200,
  pattern: /^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){1,5}$/,
  description: EVENT_NAME_GRAMMAR,
};

const CORRELATION_ID_RULE: StringRule = {
  min: 8,
  max: 128,
  pattern: /^[\x21-\x7e]{8,128}$/,
  description: CORRELATION_ID_GRAMMAR,
};

const CAUSATION_ID_RULE: StringRule = {
  min: 8,
  max: 128,
  pattern: /^[\x21-\x7e]{8,128}$/,
  description: CAUSATION_ID_GRAMMAR,
};

const EVENT_SOURCES: readonly EventSource[] = ['domain', 'adapter', 'system'];

/** Parse an untrusted value as an EventName (total, fail-closed). */
export function parseEventName(raw: unknown): ParseResult<EventName> {
  const result = parseStringLike(raw, MESSAGE_NAME_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as EventName);
}

/** Type guard for structurally valid EventName values. */
export function isEventName(raw: unknown): raw is EventName {
  return parseEventName(raw).ok;
}

/** Parse an untrusted value as a CorrelationId (total, fail-closed). */
export function parseCorrelationId(raw: unknown): ParseResult<CorrelationId> {
  const result = parseStringLike(raw, CORRELATION_ID_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as CorrelationId);
}

/** Type guard for structurally valid CorrelationId values. */
export function isCorrelationId(raw: unknown): raw is CorrelationId {
  return parseCorrelationId(raw).ok;
}

/** Parse an untrusted value as a CausationId (total, fail-closed). */
export function parseCausationId(raw: unknown): ParseResult<CausationId> {
  const result = parseStringLike(raw, CAUSATION_ID_RULE);
  if (!result.ok) return result;
  return parseOk(result.value as CausationId);
}

/** Type guard for structurally valid CausationId values. */
export function isCausationId(raw: unknown): raw is CausationId {
  return parseCausationId(raw).ok;
}

/**
 * Causality: the correlation/causation pair every message carries. The
 * correlation id identifies the causal chain; the causation id references
 * the message that caused this one (null for a chain root).
 */
export interface Causality {
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId | null;
}

/** Shape description used in parse failures. */
export const CAUSALITY_GRAMMAR =
  '{ correlationId: CorrelationId, causationId: CausationId | null }';

const CAUSALITY_KEYS = ['correlationId', 'causationId'] as const;

/** Parse an untrusted value as a Causality (total, fail-closed, strict keys). */
export function parseCausality(raw: unknown): ParseResult<Causality> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CAUSALITY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CAUSALITY_KEYS, '', CAUSALITY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const correlationId = requireFieldWith(raw, 'correlationId', '', parseCorrelationId);
  if (!correlationId.ok) return correlationId;
  const causationId = requireNullableFieldWith(raw, 'causationId', '', parseCausationId);
  if (!causationId.ok) return causationId;
  return parseOk(
    { correlationId: correlationId.value, causationId: causationId.value } satisfies Causality,
  );
}

/** Type guard for structurally valid Causality values. */
export function isCausality(raw: unknown): raw is Causality {
  return parseCausality(raw).ok;
}

/** Reference to a canonical entity, by kind and opaque id. */
export interface EntityRef {
  readonly entityKind: EntityKind;
  readonly entityId: EntityId;
}

/** Shape description used in parse failures. */
export const ENTITY_REF_GRAMMAR = '{ entityKind: EntityKind, entityId: EntityId }';

const ENTITY_REF_KEYS = ['entityKind', 'entityId'] as const;

/** Parse an untrusted value as an EntityRef (total, fail-closed, strict keys). */
export function parseEntityRef(raw: unknown): ParseResult<EntityRef> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ENTITY_REF_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ENTITY_REF_KEYS, '', ENTITY_REF_GRAMMAR);
  if (unknownKey) return unknownKey;
  const entityKind = requireFieldWith(raw, 'entityKind', '', parseEntityKind);
  if (!entityKind.ok) return entityKind;
  const entityId = requireFieldWith(raw, 'entityId', '', parseEntityId);
  if (!entityId.ok) return entityId;
  return parseOk({ entityKind: entityKind.value, entityId: entityId.value } satisfies EntityRef);
}

/** Type guard for structurally valid EntityRef values. */
export function isEntityRef(raw: unknown): raw is EntityRef {
  return parseEntityRef(raw).ok;
}

/**
 * Before/after entity references (freeze A3) — null where not applicable:
 * creation events carry before = null, deletion events after = null,
 * update events carry both (identical entity, changed payload), and events
 * not bound to a single entity carry both null.
 */
export interface EntityRefs {
  readonly before: EntityRef | null;
  readonly after: EntityRef | null;
}

/** Shape description used in parse failures. */
export const ENTITY_REFS_GRAMMAR =
  '{ before: EntityRef | null, after: EntityRef | null }';

const ENTITY_REFS_KEYS = ['before', 'after'] as const;

/** Parse an untrusted value as EntityRefs (total, fail-closed, strict keys). */
export function parseEntityRefs(raw: unknown): ParseResult<EntityRefs> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ENTITY_REFS_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ENTITY_REFS_KEYS, '', ENTITY_REFS_GRAMMAR);
  if (unknownKey) return unknownKey;
  const before = requireNullableFieldWith(raw, 'before', '', parseEntityRef);
  if (!before.ok) return before;
  const after = requireNullableFieldWith(raw, 'after', '', parseEntityRef);
  if (!after.ok) return after;
  return parseOk({ before: before.value, after: after.value } satisfies EntityRefs);
}

/** Type guard for structurally valid EntityRefs values. */
export function isEntityRefs(raw: unknown): raw is EntityRefs {
  return parseEntityRefs(raw).ok;
}

/** Shape description used in parse failures. */
export const EVENT_ENVELOPE_GRAMMAR =
  'DomainEventEnvelope (freeze A3): { kind, eventName, scope, actor, source, causality, schemaVersion, occurredAt, entityRefs, payload }';

const EVENT_ENVELOPE_KEYS = [
  'kind',
  'eventName',
  'scope',
  'actor',
  'source',
  'causality',
  'schemaVersion',
  'occurredAt',
  'entityRefs',
  'payload',
] as const;

/**
 * Immutable domain event envelope (freeze A3). The payload is domain-typed
 * data; contracts validate presence and object shape only — payload
 * semantics are validated by the owning domain module (OFF-003+).
 */
export interface DomainEventEnvelope<P = unknown> {
  readonly kind: 'event';
  readonly eventName: EventName;
  readonly scope: Scope;
  readonly actor: Actor;
  readonly source: EventSource;
  readonly causality: Causality;
  readonly schemaVersion: SchemaVersion;
  readonly occurredAt: Timestamp;
  readonly entityRefs: EntityRefs;
  readonly payload: P;
}

/**
 * Parse an untrusted value as a DomainEventEnvelope (total, fail-closed,
 * strict keys). Unknown schema versions fail closed with code
 * 'unknown-schema-version'.
 */
export function parseDomainEventEnvelope(
  raw: unknown,
): ParseResult<DomainEventEnvelope> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVENT_ENVELOPE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVENT_ENVELOPE_KEYS, '', EVENT_ENVELOPE_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['event']);
  if (!kind.ok) return kind;
  const eventName = requireFieldWith(raw, 'eventName', '', parseEventName);
  if (!eventName.ok) return eventName;
  const scope = requireFieldWith(raw, 'scope', '', parseScope);
  if (!scope.ok) return scope;
  const actor = requireFieldWith(raw, 'actor', '', parseActor);
  if (!actor.ok) return actor;
  const source = requireLiteral(raw, 'source', '', EVENT_SOURCES);
  if (!source.ok) return source;
  const causality = requireFieldWith(raw, 'causality', '', parseCausality);
  if (!causality.ok) return causality;
  const schemaVersion = requireFieldWith(raw, 'schemaVersion', '', parseSchemaVersion);
  if (!schemaVersion.ok) return schemaVersion;
  const occurredAt = requireFieldWith(raw, 'occurredAt', '', parseTimestamp);
  if (!occurredAt.ok) return occurredAt;
  const entityRefs = requireFieldWith(raw, 'entityRefs', '', parseEntityRefs);
  if (!entityRefs.ok) return entityRefs;
  const payload = raw['payload'];
  if (payload === undefined) {
    return parseFail('missing-field', 'payload', 'a JSON object (domain-validated downstream)', 'undefined');
  }
  if (!isPlainObject(payload)) {
    return parseFail('invalid-type', 'payload', 'a JSON object (domain-validated downstream)', describeValue(payload));
  }
  return parseOk(
    {
      kind: 'event',
      eventName: eventName.value,
      scope: scope.value,
      actor: actor.value,
      source: source.value as EventSource,
      causality: causality.value,
      schemaVersion: schemaVersion.value,
      occurredAt: occurredAt.value,
      entityRefs: entityRefs.value,
      payload,
    } satisfies DomainEventEnvelope,
  );
}

/** Type guard for structurally valid DomainEventEnvelope values. */
export function isDomainEventEnvelope(raw: unknown): raw is DomainEventEnvelope {
  return parseDomainEventEnvelope(raw).ok;
}
