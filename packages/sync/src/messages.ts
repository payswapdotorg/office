// Office sync — typed stream protocol messages (OFF-028).
//
// The five typed messages of the subscription stream protocol. This module
// defines the PROTOCOL ONLY — typed messages + stream semantics; the
// transport (websocket or otherwise) is wired by the app layer later. Every
// message is a plain JSON value with a strict fail-closed parse (unknown
// fields, unknown kinds, and unknown protocol versions are typed errors,
// never silently accepted), so a client can validate what crosses its
// boundary exactly like every other Office contract.
//
//   event-delivered   one event, live: the envelope + ledger sequence + the
//                     event's intrinsic slice position + the advanced cursor
//   slice-catchup     the bulk resumption window from a cursor: the entries
//                     the subscription delivers, in slice order, plus the
//                     cursor after the last of them
//   grant-revoked     the CLEAN stop: the A9 grant backing the stream was
//                     revoked; the stream ends here, whole messages only —
//                     never a partial or corrupt event mid-delivery
//   conflict-notified a material conflict surfaced: the explicit
//                     ConflictRecord (both sides) for explicit resolution
//   protocol-error    a typed, fail-closed protocol violation (closed code
//                     vocabulary) — e.g. a discontinuous slice read
import { parseFail, parseOk, parseTimestamp } from '@office/contracts';
import type { ParseResult, Timestamp } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import { parseSubscriptionGrantId, parseSubscriptionId } from './identity';
import type { SubscriptionGrantId, SubscriptionId } from './identity';
import { parseConflictRecord } from './conflict';
import type { ConflictRecord } from './conflict';
import { parseLedgerEvent, parseSliceCursor, parseSlicePosition } from './slice';
import type { SliceCursor, SliceEntry, SlicePosition } from './slice';
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

/** One live event delivered on a subscription stream. */
export interface EventDeliveredMessage {
  readonly kind: 'event-delivered';
  /** The stream this message was delivered on. */
  readonly subscriptionId: SubscriptionId;
  /** The protocol version the stream speaks (pinned per subscription). */
  readonly protocolVersion: ProtocolVersion;
  /** The event itself: the envelope + the ledger-assigned identity/sequence. */
  readonly event: LedgerEvent;
  /** The event's intrinsic position in the project slice. */
  readonly position: SlicePosition;
  /** The subscription's cursor AFTER this event (resume basis). */
  readonly cursor: SliceCursor;
}

/** The bulk resumption window delivered from a cursor. */
export interface SliceCatchupMessage {
  readonly kind: 'slice-catchup';
  /** The stream this message was delivered on. */
  readonly subscriptionId: SubscriptionId;
  /** The protocol version the stream speaks (pinned per subscription). */
  readonly protocolVersion: ProtocolVersion;
  /** The entries the subscription delivers, in slice order (deterministic). */
  readonly entries: readonly SliceEntry[];
  /** The subscription's cursor AFTER the last delivered entry. */
  readonly cursor: SliceCursor;
}

/** The clean stop: the A9 grant backing the stream was revoked. */
export interface GrantRevokedMessage {
  readonly kind: 'grant-revoked';
  /** The stream that stopped. */
  readonly subscriptionId: SubscriptionId;
  /** The revoked grant. */
  readonly grantId: SubscriptionGrantId;
  /** When the grant was revoked (injected clock). */
  readonly revokedAt: Timestamp;
}

/** A material conflict surfaced for explicit resolution. */
export interface ConflictNotifiedMessage {
  readonly kind: 'conflict-notified';
  /** The stream the conflict was surfaced on. */
  readonly subscriptionId: SubscriptionId;
  /** The explicit conflict record: both sides, resolution state. */
  readonly conflict: ConflictRecord;
}

/** The closed protocol-error code vocabulary (typed, fail-closed). */
export type ProtocolErrorCode =
  /** The stream spoke a protocol version this endpoint does not understand. */
  | 'unknown-protocol-version'
  /** A cursor was presented against a subscription it does not belong to. */
  | 'cursor-subscription-mismatch'
  /** A slice read was discontinuous (positions skipped — a delivery-layer fault). */
  | 'slice-discontinuity';

/** A typed, fail-closed protocol violation. */
export interface ProtocolErrorMessage {
  readonly kind: 'protocol-error';
  /** The stream the violation concerns, or null when streamless. */
  readonly subscriptionId: SubscriptionId | null;
  /** The closed error code vocabulary. */
  readonly code: ProtocolErrorCode;
  /** Human-readable explanation safe to display. */
  readonly message: string;
}

/** One typed message of the subscription stream protocol. */
export type StreamMessage =
  | EventDeliveredMessage
  | SliceCatchupMessage
  | GrantRevokedMessage
  | ConflictNotifiedMessage
  | ProtocolErrorMessage;

/** Shape description used in parse failures. */
export const EVENT_DELIVERED_GRAMMAR =
  "EventDeliveredMessage: { kind: 'event-delivered', subscriptionId, protocolVersion, event, position, cursor }";

/** Shape description used in parse failures. */
export const SLICE_CATCHUP_GRAMMAR =
  "SliceCatchupMessage: { kind: 'slice-catchup', subscriptionId, protocolVersion, entries: SliceEntry[], cursor }";

/** Shape description used in parse failures. */
export const GRANT_REVOKED_GRAMMAR =
  "GrantRevokedMessage: { kind: 'grant-revoked', subscriptionId, grantId, revokedAt }";

/** Shape description used in parse failures. */
export const CONFLICT_NOTIFIED_GRAMMAR =
  "ConflictNotifiedMessage: { kind: 'conflict-notified', subscriptionId, conflict }";

/** Shape description used in parse failures. */
export const PROTOCOL_ERROR_GRAMMAR =
  "ProtocolErrorMessage: { kind: 'protocol-error', subscriptionId: SubscriptionId | null, code, message }";

const EVENT_DELIVERED_KEYS = [
  'kind',
  'subscriptionId',
  'protocolVersion',
  'event',
  'position',
  'cursor',
] as const;
const SLICE_CATCHUP_KEYS = [
  'kind',
  'subscriptionId',
  'protocolVersion',
  'entries',
  'cursor',
] as const;
const GRANT_REVOKED_KEYS = ['kind', 'subscriptionId', 'grantId', 'revokedAt'] as const;
const CONFLICT_NOTIFIED_KEYS = ['kind', 'subscriptionId', 'conflict'] as const;
const PROTOCOL_ERROR_KEYS = ['kind', 'subscriptionId', 'code', 'message'] as const;

const PROTOCOL_ERROR_CODES: readonly ProtocolErrorCode[] = [
  'unknown-protocol-version',
  'cursor-subscription-mismatch',
  'slice-discontinuity',
];

const MESSAGE_KINDS = [
  'event-delivered',
  'slice-catchup',
  'grant-revoked',
  'conflict-notified',
  'protocol-error',
] as const;

/** Parse one untrusted slice entry (fail-closed, strict keys). */
export function parseSliceEntry(raw: unknown): ParseResult<SliceEntry> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'SliceEntry: { event, position }', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ['event', 'position'], '', 'SliceEntry');
  if (unknownKey) return unknownKey;
  const event = requireFieldWith(raw, 'event', '', parseLedgerEvent);
  if (!event.ok) return event;
  const position = requireFieldWith(raw, 'position', '', parseSlicePosition);
  if (!position.ok) return position;
  if (position.value < 1) {
    return parseFail(
      'invalid-value',
      'position',
      'a slice entry position is 1-based (dense within the slice)',
      describeValue(position.value),
    );
  }
  return parseOk({ event: event.value, position: position.value } satisfies SliceEntry);
}

/** Parse an untrusted value as an EventDeliveredMessage (fail-closed, strict keys). */
export function parseEventDeliveredMessage(
  raw: unknown,
): ParseResult<EventDeliveredMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EVENT_DELIVERED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EVENT_DELIVERED_KEYS, '', EVENT_DELIVERED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['event-delivered']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const protocolVersion = requireFieldWith(raw, 'protocolVersion', '', parseProtocolVersion);
  if (!protocolVersion.ok) return protocolVersion;
  const event = requireFieldWith(raw, 'event', '', parseLedgerEvent);
  if (!event.ok) return event;
  const position = requireFieldWith(raw, 'position', '', parseSlicePosition);
  if (!position.ok) return position;
  if (position.value < 1) {
    return parseFail(
      'invalid-value',
      'position',
      'a delivered event position is 1-based',
      describeValue(position.value),
    );
  }
  const cursor = requireFieldWith(raw, 'cursor', '', parseSliceCursor);
  if (!cursor.ok) return cursor;
  if (cursor.value.subscriptionId !== subscriptionId.value || cursor.value.position !== position.value) {
    return parseFail(
      'invalid-value',
      'cursor',
      'the cursor after a delivered event names THIS subscription at THIS position',
      `subscription ${cursor.value.subscriptionId} at ${cursor.value.position}`,
    );
  }
  return parseOk(
    {
      kind: 'event-delivered',
      subscriptionId: subscriptionId.value,
      protocolVersion: protocolVersion.value,
      event: event.value,
      position: position.value,
      cursor: cursor.value,
    } satisfies EventDeliveredMessage,
  );
}

/** Parse an untrusted value as a SliceCatchupMessage (fail-closed, strict keys). */
export function parseSliceCatchupMessage(raw: unknown): ParseResult<SliceCatchupMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SLICE_CATCHUP_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SLICE_CATCHUP_KEYS, '', SLICE_CATCHUP_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['slice-catchup']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const protocolVersion = requireFieldWith(raw, 'protocolVersion', '', parseProtocolVersion);
  if (!protocolVersion.ok) return protocolVersion;
  const entries = parseValueArray(raw['entries'], 'entries', parseSliceEntry, 'array of slice entries in slice order');
  if (!entries.ok) return entries;
  for (const [index, entry] of entries.value.entries()) {
    if (index > 0 && entry.position <= entries.value[index - 1]!.position) {
      return parseFail(
        'invalid-value',
        `entries[${index}].position`,
        'strictly increasing slice positions (slice order)',
        describeValue(entry.position),
      );
    }
  }
  const cursor = requireFieldWith(raw, 'cursor', '', parseSliceCursor);
  if (!cursor.ok) return cursor;
  if (cursor.value.subscriptionId !== subscriptionId.value) {
    return parseFail(
      'invalid-value',
      'cursor',
      'the catchup cursor names THIS subscription',
      `subscription ${cursor.value.subscriptionId}`,
    );
  }
  const last = entries.value[entries.value.length - 1];
  if (last !== undefined && cursor.value.position !== last.position) {
    return parseFail(
      'invalid-value',
      'cursor',
      'the catchup cursor sits at the last delivered entry position',
      `cursor at ${cursor.value.position}, last entry at ${last.position}`,
    );
  }
  return parseOk(
    {
      kind: 'slice-catchup',
      subscriptionId: subscriptionId.value,
      protocolVersion: protocolVersion.value,
      entries: entries.value,
      cursor: cursor.value,
    } satisfies SliceCatchupMessage,
  );
}

/** Parse an untrusted value as a GrantRevokedMessage (fail-closed, strict keys). */
export function parseGrantRevokedMessage(raw: unknown): ParseResult<GrantRevokedMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', GRANT_REVOKED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, GRANT_REVOKED_KEYS, '', GRANT_REVOKED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['grant-revoked']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const grantId = requireFieldWith(raw, 'grantId', '', parseSubscriptionGrantId);
  if (!grantId.ok) return grantId;
  const revokedAt = requireFieldWith(raw, 'revokedAt', '', parseTimestamp);
  if (!revokedAt.ok) return revokedAt;
  return parseOk(
    {
      kind: 'grant-revoked',
      subscriptionId: subscriptionId.value,
      grantId: grantId.value,
      revokedAt: revokedAt.value,
    } satisfies GrantRevokedMessage,
  );
}

/** Parse an untrusted value as a ConflictNotifiedMessage (fail-closed, strict keys). */
export function parseConflictNotifiedMessage(
  raw: unknown,
): ParseResult<ConflictNotifiedMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONFLICT_NOTIFIED_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CONFLICT_NOTIFIED_KEYS, '', CONFLICT_NOTIFIED_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['conflict-notified']);
  if (!kind.ok) return kind;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const conflict = requireFieldWith(raw, 'conflict', '', parseConflictRecord);
  if (!conflict.ok) return conflict;
  return parseOk(
    {
      kind: 'conflict-notified',
      subscriptionId: subscriptionId.value,
      conflict: conflict.value,
    } satisfies ConflictNotifiedMessage,
  );
}

/** Parse an untrusted value as a ProtocolErrorMessage (fail-closed, strict keys). */
export function parseProtocolErrorMessage(raw: unknown): ParseResult<ProtocolErrorMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PROTOCOL_ERROR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PROTOCOL_ERROR_KEYS, '', PROTOCOL_ERROR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['protocol-error']);
  if (!kind.ok) return kind;
  const subscriptionId = requireNullableFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const code = requireLiteral(raw, 'code', '', PROTOCOL_ERROR_CODES);
  if (!code.ok) return code;
  const message = raw['message'];
  if (typeof message !== 'string' || message.length === 0 || message.length > 512) {
    return parseFail(
      'invalid-value',
      'message',
      'a non-empty explanation of at most 512 characters',
      describeValue(message),
    );
  }
  return parseOk(
    {
      kind: 'protocol-error',
      subscriptionId: subscriptionId.value,
      code: code.value as ProtocolErrorCode,
      message,
    } satisfies ProtocolErrorMessage,
  );
}

/**
 * Parse an untrusted value as ANY stream message (total, fail-closed,
 * strict keys): dispatches on the `kind` discriminator; unknown kinds fail
 * closed with 'invalid-value'.
 */
export function parseStreamMessage(raw: unknown): ParseResult<StreamMessage> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'one of the five stream message kinds', describeValue(raw));
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    return parseFail('invalid-type', 'kind', 'one of the five stream message kinds', describeValue(kind));
  }
  switch (kind) {
    case 'event-delivered':
      return parseEventDeliveredMessage(raw);
    case 'slice-catchup':
      return parseSliceCatchupMessage(raw);
    case 'grant-revoked':
      return parseGrantRevokedMessage(raw);
    case 'conflict-notified':
      return parseConflictNotifiedMessage(raw);
    case 'protocol-error':
      return parseProtocolErrorMessage(raw);
    default:
      return parseFail(
        'invalid-value',
        'kind',
        `one of: ${MESSAGE_KINDS.join(', ')}`,
        describeValue(kind),
      );
  }
}

/** Type guard for structurally valid StreamMessage values. */
export function isStreamMessage(raw: unknown): raw is StreamMessage {
  return parseStreamMessage(raw).ok;
}
