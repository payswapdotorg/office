// Office events — ledger identity types (OFF-005).
//
// The branded identity vocabulary this package owns on top of the contracts
// kinds: the ledger-assigned event id, the per-aggregate ledger sequence, and
// the consumer name of the idempotent cursor API. All three follow the
// contracts convention: a total fail-closed `parse` for untrusted values, an
// `is` type guard, and a trusted `format`/derivation path that throws loud
// TypeErrors on invalid parts instead of silently coercing.
//
// Deterministic event ids (A9-friendly): ledger ids are DERIVED from the
// ledger key — (tenant, aggregate kind/id, sequence) — via sha256, so the
// same command sequence replayed against a fresh ledger reproduces identical
// ids. The shape `office-evt-v1-<opaque>` deliberately matches the contracts
// id grammar family and is always a valid CausationId, which is what lets a
// downstream event point its causation id at a prior event's ledger id.
import { createHash } from 'node:crypto';
import { parseCausationId, parseFail, parseOk } from '@office/contracts';
import type {
  CausationId,
  EntityRef,
  IdParts,
  ParseResult,
  TenantId,
} from '@office/contracts';

declare const ledgerEventIdBrand: unique symbol;
declare const ledgerSequenceBrand: unique symbol;
declare const consumerNameBrand: unique symbol;

/**
 * Ledger-assigned canonical event id: `office-evt-v1-<opaque>` — derived
 * deterministically from the ledger key (tenant, aggregate, sequence).
 */
export type LedgerEventId = string & {
  readonly [ledgerEventIdBrand]: 'LedgerEventId';
};
/** Dense per-(tenant, aggregate) ledger position of one event; starts at 1. */
export type LedgerSequence = number & {
  readonly [ledgerSequenceBrand]: 'LedgerSequence';
};
/** Consumer identity of an idempotent cursor, e.g. 'projections.projects'. */
export type ConsumerName = string & {
  readonly [consumerNameBrand]: 'ConsumerName';
};

/** Grammar description used in parse failures. */
export const LEDGER_EVENT_ID_GRAMMAR =
  'office-evt-v1-<opaque: 16..64 lowercase alphanumeric> (ledger-assigned, deterministic)';

/** Grammar description used in parse failures. */
export const LEDGER_SEQUENCE_GRAMMAR = `integer sequence in 1..${Number.MAX_SAFE_INTEGER} (dense per tenant+aggregate, starts at 1)`;

/** Grammar description used in parse failures. */
export const CONSUMER_NAME_GRAMMAR =
  "1..6 dot-separated segments, each starting lowercase then alphanumeric, e.g. 'projections.projects'";

const OPAQUE_PATTERN = /^[0-9a-z]{16,64}$/;
const CONSUMER_NAME_PATTERN = /^[a-z][a-zA-Z0-9]{0,31}(\.[a-z][a-zA-Z0-9]{0,31}){0,5}$/;

/** Ledger event ids always carry this prefix + id format version. */
const LEDGER_EVENT_ID_PREFIX = 'office-evt-v1-';

/** Length of the derived opaque part (sha256 hex, truncated). */
const DERIVED_OPAQUE_LENGTH = 32;

const describe = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') {
    const preview = raw.length > 32 ? `${raw.slice(0, 32)}…` : raw;
    return `string ${JSON.stringify(preview)}`;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return `${typeof raw} ${String(raw)}`;
  }
  return typeof raw;
};

/** Parse an untrusted value as a LedgerEventId (total, fail-closed). */
export function parseLedgerEventId(raw: unknown): ParseResult<LedgerEventId> {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith(LEDGER_EVENT_ID_PREFIX) ||
    !OPAQUE_PATTERN.test(raw.slice(LEDGER_EVENT_ID_PREFIX.length))
  ) {
    return parseFail('invalid-value', '', LEDGER_EVENT_ID_GRAMMAR, describe(raw));
  }
  return parseOk(raw as LedgerEventId);
}

/** Type guard for structurally valid LedgerEventId values. */
export function isLedgerEventId(raw: unknown): raw is LedgerEventId {
  return parseLedgerEventId(raw).ok;
}

/** Compose a LedgerEventId from validated parts (trusted path). */
export function formatLedgerEventId(parts: IdParts): LedgerEventId {
  if (parts.version !== 'v1') {
    throw new TypeError(`unknown ledger event id version: ${String(parts.version)}`);
  }
  const candidate = `${LEDGER_EVENT_ID_PREFIX}${parts.opaque}`;
  const parsed = parseLedgerEventId(candidate);
  if (!parsed.ok) {
    throw new TypeError(`invalid ledger event id parts: ${JSON.stringify(parts)}`);
  }
  return parsed.value;
}

/**
 * The ledger key an event id is derived from: the owning tenant, the
 * aggregate the event belongs to, and the assigned sequence.
 */
export interface LedgerKey {
  readonly tenantId: TenantId;
  readonly aggregate: EntityRef;
  readonly sequence: LedgerSequence;
}

/**
 * Derive the ledger event id for a ledger key (deterministic, pure): the
 * first 32 hex characters of sha256 over `tenant|kind|id|sequence`. The same
 * command sequence replayed against a fresh ledger reproduces identical ids;
 * distinct keys practically never collide, and the ledger's unique
 * constraints still guard the table either way.
 */
export function ledgerEventIdOf(key: LedgerKey): LedgerEventId {
  const digest = createHash('sha256')
    .update(
      `${key.tenantId}|${key.aggregate.entityKind}|${key.aggregate.entityId}|${key.sequence}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, DERIVED_OPAQUE_LENGTH);
  return formatLedgerEventId({ version: 'v1', opaque: digest });
}

/**
 * Re-brand an already-validated printable-ASCII token (a ledger event id or
 * a command's idempotency key) as the CausationId of a downstream message
 * (trusted path): both token grammars are exactly the causation id grammar,
 * which is what lets reaction events point at the command/event that caused
 * them. Throws a loud TypeError if handed an invalid token.
 */
export function causationIdOf(token: string): CausationId {
  const parsed = parseCausationId(token);
  if (!parsed.ok) {
    throw new TypeError(`token is not a valid causation id: ${token}`);
  }
  return parsed.value;
}

/** Parse an untrusted value as a LedgerSequence (total, fail-closed). */
export function parseLedgerSequence(raw: unknown): ParseResult<LedgerSequence> {
  if (typeof raw !== 'number') {
    return parseFail('invalid-type', '', LEDGER_SEQUENCE_GRAMMAR, describe(raw));
  }
  if (!Number.isInteger(raw) || raw < 1 || raw > Number.MAX_SAFE_INTEGER) {
    return parseFail('invalid-value', '', LEDGER_SEQUENCE_GRAMMAR, describe(raw));
  }
  return parseOk(raw as LedgerSequence);
}

/** Type guard for structurally valid LedgerSequence values. */
export function isLedgerSequence(raw: unknown): raw is LedgerSequence {
  return parseLedgerSequence(raw).ok;
}

/** Parse an untrusted value as a ConsumerName (total, fail-closed). */
export function parseConsumerName(raw: unknown): ParseResult<ConsumerName> {
  if (typeof raw !== 'string' || !CONSUMER_NAME_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', CONSUMER_NAME_GRAMMAR, describe(raw));
  }
  return parseOk(raw as ConsumerName);
}

/** Type guard for structurally valid ConsumerName values. */
export function isConsumerName(raw: unknown): raw is ConsumerName {
  return parseConsumerName(raw).ok;
}
