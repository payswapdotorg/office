// Office sync — protocol identity types (OFF-028).
//
// The branded identity vocabulary this package owns on top of the contracts
// and events kinds: the subscription id, the A9 subscription-grant id, the
// deterministic client operation id, and the sync conflict-record id. All
// four follow the workspace convention: a total fail-closed `parse` for
// untrusted values, an `is` type guard, and a trusted `format` path that
// throws loud TypeErrors on invalid parts instead of silently coercing.
//
// Determinism (A9-friendly, mirroring the events ledger and the adapters-sdk
// conflict ids): every id is DERIVED from its logical key via sha256, so the
// same protocol inputs always reproduce identical ids — a replayed append
// sequence, a recomposed subscription, a re-detected conflict, or a client
// retrying the same logical operation never mints a second identity.
import { createHash } from 'node:crypto';
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { describeValue } from './parse';

declare const subscriptionIdBrand: unique symbol;
declare const subscriptionGrantIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;
declare const conflictRecordIdBrand: unique symbol;

/** Subscription identity: office-sub-v1-<opaque> (derived, deterministic). */
export type SubscriptionId = string & {
  readonly [subscriptionIdBrand]: 'SubscriptionId';
};
/** A9 subscription-grant identity: office-grt-v1-<opaque> (derived). */
export type SubscriptionGrantId = string & {
  readonly [subscriptionGrantIdBrand]: 'SubscriptionGrantId';
};
/** Deterministic client operation identity: office-op-v1-<opaque>. */
export type OperationId = string & {
  readonly [operationIdBrand]: 'OperationId';
};
/** Sync conflict-record identity: office-scf-v1-<opaque> (derived). */
export type ConflictRecordId = string & {
  readonly [conflictRecordIdBrand]: 'ConflictRecordId';
};

/** Grammar description used in parse failures. */
export const SUBSCRIPTION_ID_GRAMMAR =
  'office-sub-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the subscription key)';
/** Grammar description used in parse failures. */
export const SUBSCRIPTION_GRANT_ID_GRAMMAR =
  'office-grt-v1-<opaque: 16..64 lowercase alphanumeric> (derived from the grant key)';
/** Grammar description used in parse failures. */
export const OPERATION_ID_GRAMMAR =
  'office-op-v1-<opaque: 16..64 lowercase alphanumeric> (derived from subscription + cursor + operation kind)';
/** Grammar description used in parse failures. */
export const CONFLICT_RECORD_ID_GRAMMAR =
  'office-scf-v1-<opaque: 16..64 lowercase alphanumeric> (derived from both sides)';

const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;
const DERIVED_OPAQUE_LENGTH = 32;

const SUBSCRIPTION_ID_PREFIX = 'office-sub-v1-';
const GRANT_ID_PREFIX = 'office-grt-v1-';
const OPERATION_ID_PREFIX = 'office-op-v1-';
const CONFLICT_RECORD_ID_PREFIX = 'office-scf-v1-';

const parseDerivedId = (
  raw: unknown,
  prefix: string,
  grammar: string,
): ParseResult<string> => {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(prefix) ||
    !OPAQUE_PATTERN.test(raw.slice(prefix.length))
  ) {
    return parseFail('invalid-value', '', grammar, describeValue(raw));
  }
  return parseOk(raw);
};

/** Parse an untrusted value as a SubscriptionId (total, fail-closed). */
export function parseSubscriptionId(raw: unknown): ParseResult<SubscriptionId> {
  const result = parseDerivedId(raw, SUBSCRIPTION_ID_PREFIX, SUBSCRIPTION_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as SubscriptionId);
}

/** Type guard for structurally valid SubscriptionId values. */
export function isSubscriptionId(raw: unknown): raw is SubscriptionId {
  return parseSubscriptionId(raw).ok;
}

/** Parse an untrusted value as a SubscriptionGrantId (total, fail-closed). */
export function parseSubscriptionGrantId(
  raw: unknown,
): ParseResult<SubscriptionGrantId> {
  const result = parseDerivedId(raw, GRANT_ID_PREFIX, SUBSCRIPTION_GRANT_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as SubscriptionGrantId);
}

/** Type guard for structurally valid SubscriptionGrantId values. */
export function isSubscriptionGrantId(raw: unknown): raw is SubscriptionGrantId {
  return parseSubscriptionGrantId(raw).ok;
}

/** Parse an untrusted value as an OperationId (total, fail-closed). */
export function parseOperationId(raw: unknown): ParseResult<OperationId> {
  const result = parseDerivedId(raw, OPERATION_ID_PREFIX, OPERATION_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as OperationId);
}

/** Type guard for structurally valid OperationId values. */
export function isOperationId(raw: unknown): raw is OperationId {
  return parseOperationId(raw).ok;
}

/** Parse an untrusted value as a ConflictRecordId (total, fail-closed). */
export function parseConflictRecordId(raw: unknown): ParseResult<ConflictRecordId> {
  const result = parseDerivedId(raw, CONFLICT_RECORD_ID_PREFIX, CONFLICT_RECORD_ID_GRAMMAR);
  if (!result.ok) return result;
  return parseOk(result.value as ConflictRecordId);
}

/** Type guard for structurally valid ConflictRecordId values. */
export function isConflictRecordId(raw: unknown): raw is ConflictRecordId {
  return parseConflictRecordId(raw).ok;
}

/** Compose a SubscriptionId from validated parts (trusted path). */
export function formatSubscriptionId(raw: string): SubscriptionId {
  const parsed = parseSubscriptionId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid subscription id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Compose a SubscriptionGrantId from validated parts (trusted path). */
export function formatSubscriptionGrantId(raw: string): SubscriptionGrantId {
  const parsed = parseSubscriptionGrantId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid subscription grant id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Compose an OperationId from validated parts (trusted path). */
export function formatOperationId(raw: string): OperationId {
  const parsed = parseOperationId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid operation id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Compose a ConflictRecordId from validated parts (trusted path). */
export function formatConflictRecordId(raw: string): ConflictRecordId {
  const parsed = parseConflictRecordId(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid conflict record id: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** The sha256-derived opaque part shared by every derivation below. */
const derivedOpaque = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(
    0,
    DERIVED_OPAQUE_LENGTH,
  );

/**
 * The logical key a subscription id is derived from: the tenant and project
 * of the slice being subscribed to, the subscribing client's canonical
 * identity, and the client's subscription ordinal (a client may hold more
 * than one subscription on the same slice; the ordinal keeps them distinct).
 */
export interface SubscriptionKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly subscriberId: string;
  readonly ordinal: number;
}

/**
 * Derive the subscription id of a subscription key (deterministic, pure):
 * sha256 over `tenant|project|subscriber|ordinal`. Two clients subscribing
 * to the same slice derive different ids (different subscriber identity);
 * the same client re-subscribing with the same ordinal derives the SAME id —
 * a resumed subscription, never a second stream identity.
 */
export function subscriptionIdOf(key: SubscriptionKey): SubscriptionId {
  if (!Number.isInteger(key.ordinal) || key.ordinal < 1) {
    throw new TypeError(`subscription ordinal must be a positive integer: ${String(key.ordinal)}`);
  }
  return formatSubscriptionId(
    `${SUBSCRIPTION_ID_PREFIX}${derivedOpaque(key.tenantId, key.projectId, key.subscriberId, String(key.ordinal))}`,
  );
}

/**
 * The logical key a subscription-grant id is derived from: the tenant, the
 * subscriber the grant backs, and the issuing serial (one tenant may issue
 * several grant generations to the same subscriber over time).
 */
export interface SubscriptionGrantKey {
  readonly tenantId: string;
  readonly subscriberId: string;
  readonly serial: number;
}

/**
 * Derive the subscription-grant id of a grant key (deterministic, pure):
 * sha256 over `tenant|subscriber|serial`. Re-issuing the same grant
 * generation derives the same id (idempotent issue); a new serial is a NEW
 * grant generation with a new id.
 */
export function subscriptionGrantIdOf(key: SubscriptionGrantKey): SubscriptionGrantId {
  if (!Number.isInteger(key.serial) || key.serial < 1) {
    throw new TypeError(`grant serial must be a positive integer: ${String(key.serial)}`);
  }
  return formatSubscriptionGrantId(
    `${GRANT_ID_PREFIX}${derivedOpaque(key.tenantId, key.subscriberId, String(key.serial))}`,
  );
}

/**
 * The logical key an operation id is derived from: the subscription the
 * operation was composed under, the slice position the client had observed
 * when it composed it (its cursor basis), and the operation kind.
 */
export interface OperationKey {
  readonly subscriptionId: SubscriptionId;
  readonly position: number;
  readonly operationKind: string;
}

/**
 * Derive the operation id of an operation key (deterministic, pure):
 * sha256 over `subscription|position|operationKind`. This is the A9
 * deterministic-operation-id rule: the same client, at the same observed
 * cursor, composing the same kind of operation, always derives the SAME id
 * — so a retry after a reconnect is a typed duplicate, never a second
 * effect. A different cursor basis or kind derives a different id.
 */
export function operationIdOf(key: OperationKey): OperationId {
  if (!Number.isInteger(key.position) || key.position < 0) {
    throw new TypeError(`operation cursor position must be an integer >= 0: ${String(key.position)}`);
  }
  if (typeof key.operationKind !== 'string' || key.operationKind.length === 0) {
    throw new TypeError('operation kind must be a non-empty string');
  }
  return formatOperationId(
    `${OPERATION_ID_PREFIX}${derivedOpaque(key.subscriptionId, String(key.position), key.operationKind)}`,
  );
}

/**
 * The logical key a conflict-record id is derived from: the tenant, the
 * project, the contested target entity, and BOTH operations' ids — in the
 * record's canonical side order.
 */
export interface ConflictRecordKey {
  readonly tenantId: string;
  readonly projectId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly firstOperationId: OperationId;
  readonly secondOperationId: OperationId;
}

/**
 * Derive the conflict-record id of a divergence pair (deterministic, pure):
 * sha256 over `tenant|project|targetKind|targetId|firstOp|secondOp`.
 * Re-detecting the same pair of concurrent operations yields the same id
 * (idempotent detection, no duplicate records); any different pair is a new
 * conflict with a new id.
 */
export function conflictRecordIdOf(key: ConflictRecordKey): ConflictRecordId {
  return formatConflictRecordId(
    `${CONFLICT_RECORD_ID_PREFIX}${derivedOpaque(
      key.tenantId,
      key.projectId,
      key.targetKind,
      key.targetId,
      key.firstOperationId,
      key.secondOperationId,
    )}`,
  );
}
