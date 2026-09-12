// Office events — fail-closed row decoding (OFF-005).
//
// Same discipline as the persistence package's rows.ts: rows come back from
// OUR database, but decoding still fails closed — any column that does not
// match the schema this package owns is a typed PersistenceFailure
// ('row-corruption'), never a silent coercion, never a NaN timestamp.
// Canonical values are re-parsed through the @office/contracts parsers, so a
// forged or truncated id/name can never travel further into the domain; the
// event envelope is decoded WHOLE through parseDomainEventEnvelope, which
// revalidates every envelope field exactly as at the append boundary.
import {
  formatTimestamp,
  parseDomainEventEnvelope,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTenantId,
} from '@office/contracts';
import type {
  DomainEventEnvelope,
  EntityId,
  EntityKind,
  EntityRef,
  ProjectId,
  Scope,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { PersistenceFailure } from '@office/persistence';
import type { SqlValue } from '@office/persistence';
import { parseConsumerName, parseLedgerEventId, parseLedgerSequence } from './identity';
import type { ConsumerName, LedgerEventId, LedgerSequence } from './identity';

type Row = Record<string, unknown>;

/**
 * Inspect a thrown error for a node-postgres error code/constraint pair.
 * Unwraps a PersistenceFailure's `cause` first, so statements can map known
 * constraint violations regardless of which layer wrapped the driver error
 * (same semantics as the persistence package's internal helper).
 */
export const driverErrorInfo = (
  error: unknown,
): { readonly code?: unknown; readonly constraint?: unknown } => {
  const cause = error instanceof PersistenceFailure ? error.cause : error;
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as { code?: unknown; constraint?: unknown };
    return { code: candidate.code, constraint: candidate.constraint };
  }
  return {};
};

/**
 * Widen a validated JSON-object envelope part (actor, entity refs, payload)
 * into a JSONB bind value. The contracts parsers guarantee plain JSON
 * objects; TypeScript's index-signature rule just cannot see that through
 * branded interfaces.
 */
export const asJsonbValue = (value: unknown): SqlValue => value as SqlValue;

/** Fail with a corrupt-row error, including the offending row. */
const rowCorruption = (table: string, field: string, row: Row): PersistenceFailure =>
  new PersistenceFailure(
    'row-corruption',
    `corrupt row in table '${table}': field '${field}' has unexpected value ${safeJson(row[field])}`,
    { cause: row },
  );

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
};

/** Read a non-empty TEXT column. */
export const readText = (row: Row, table: string, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw rowCorruption(table, column, row);
  }
  return value;
};

/** Read a nullable TEXT column (null stays null). */
export const readNullableText = (row: Row, table: string, column: string): string | null => {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw rowCorruption(table, column, row);
  }
  return value;
};

/**
 * Read a BIGINT column holding a bounded non-negative safe integer.
 * node-postgres returns int8 as a string by default; both the string and the
 * (configured) number form are accepted, and anything that is not a safe
 * non-negative integer corrupts the row.
 */
export const readNonNegativeInt = (row: Row, table: string, column: string): number => {
  const raw = row[column];
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > Number.MAX_SAFE_INTEGER) {
    throw rowCorruption(table, column, row);
  }
  return numeric;
};

/** Read a canonical ledger event id column (fail-closed). */
export const readLedgerEventId = (
  row: Row,
  table: string,
  column = 'event_id',
): LedgerEventId => {
  const parsed = parseLedgerEventId(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a ledger `sequence` BIGINT column (fail-closed; >= 1). */
export const readLedgerSequence = (
  row: Row,
  table: string,
  column = 'sequence',
): LedgerSequence => {
  const raw = row[column];
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const parsed = parseLedgerSequence(numeric);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a canonical entity kind column (fail-closed). */
export const readEntityKind = (row: Row, table: string, column: string): EntityKind => {
  const parsed = parseEntityKind(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a canonical entity id column (fail-closed). */
export const readEntityId = (row: Row, table: string, column: string): EntityId => {
  const parsed = parseEntityId(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read an aggregate reference from its kind + id columns (fail-closed). */
export const readEntityRef = (
  row: Row,
  table: string,
  kindColumn: string,
  idColumn: string,
): EntityRef => ({
  entityKind: readEntityKind(row, table, kindColumn),
  entityId: readEntityId(row, table, idColumn),
});

/** Read a canonical project id column, null-aware (fail-closed). */
export const readNullableProjectId = (
  row: Row,
  table: string,
  column = 'project_id',
): ProjectId | null => {
  const value = row[column];
  if (value === null) return null;
  const parsed = parseProjectId(value);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a canonical TenantId column (fail-closed through the contracts parser). */
export const readTenantId = (row: Row, table: string, column = 'tenant_id'): TenantId => {
  const parsed = parseTenantId(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/**
 * Reconstruct the row's Scope from its tenant/project scope columns
 * (fail-closed: tenant and project ids re-parse through the contracts
 * parsers; null project_id selects tenant scope).
 */
export const readScope = (row: Row, table: string): Scope => {
  const tenantId = readTenantId(row, table);
  const projectId = readNullableProjectId(row, table);
  return projectId === null
    ? { kind: 'tenant', tenantId }
    : { kind: 'project', tenantId, projectId };
};

/** Read a canonical consumer name column (fail-closed). */
export const readConsumerName = (
  row: Row,
  table: string,
  column = 'consumer_name',
): ConsumerName => {
  const parsed = parseConsumerName(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a TIMESTAMPTZ column as the canonical UTC Timestamp string. */
export const readTimestamp = (row: Row, table: string, column: string): Timestamp => {
  const value = row[column];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw rowCorruption(table, column, row);
  }
  return formatTimestamp(value);
};

/** Read a nullable TIMESTAMPTZ column (null stays null). */
export const readNullableTimestamp = (
  row: Row,
  table: string,
  column: string,
): Timestamp | null => {
  const value = row[column];
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw rowCorruption(table, column, row);
  }
  return formatTimestamp(value);
};

/** Convert a canonical Timestamp into the Date node-postgres binds for TIMESTAMPTZ. */
export const toDate = (timestamp: Timestamp): Date => new Date(timestamp);

/** Read an outbox state column (fail-closed closed enum). */
export const readOutboxState = (
  row: Row,
  table: string,
  column = 'state',
): 'pending' | 'dispatched' => {
  const value = row[column];
  if (value !== 'pending' && value !== 'dispatched') {
    throw rowCorruption(table, column, row);
  }
  return value;
};

/**
 * Decode a ledger row's envelope WHOLE through the canonical contracts
 * parser: every field (name, scope, actor, source, causality, schema
 * version, occurred-at, entity refs, payload) is revalidated exactly as at
 * the append boundary, so a tampered or drifted row can never re-enter the
 * domain as a "valid" event.
 */
export const readEnvelope = (row: Row, table: string): DomainEventEnvelope => {
  const parsed = parseDomainEventEnvelope({
    kind: 'event',
    eventName: readText(row, table, 'event_name'),
    scope: readScope(row, table),
    actor: row['actor'],
    source: readText(row, table, 'source'),
    causality: {
      correlationId: readText(row, table, 'correlation_id'),
      causationId: readNullableText(row, table, 'causation_id'),
    },
    schemaVersion: readText(row, table, 'schema_version'),
    occurredAt: readTimestamp(row, table, 'occurred_at'),
    entityRefs: row['entity_refs'],
    payload: row['payload'],
  });
  if (!parsed.ok) {
    throw rowCorruption(table, 'envelope', row);
  }
  return parsed.value;
};
