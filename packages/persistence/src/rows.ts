// Office persistence — fail-closed row decoding (OFF-004).
//
// Rows come back from OUR database, but decoding is still fail-closed: any
// column that does not match the schema this package owns is a typed
// PersistenceFailure('row-corruption') — never a silent coercion, never a
// NaN timestamp. Canonical ids are re-parsed through @office/contracts, so a
// forged or truncated id cannot travel further into the domain.
import { formatTimestamp, parseEntityKind, parseProjectId, parseTenantId } from '@office/contracts';
import type { EntityKind, ProjectId, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import { rowCorruption } from './failure';

type Row = Record<string, unknown>;

/** Read a non-empty TEXT column. */
export const readText = (row: Row, table: string, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw rowCorruption(table, column, row);
  }
  return value;
};

/** Read a canonical TenantId column (fail-closed through the contracts parser). */
export const readTenantId = (row: Row, table: string, column = 'tenant_id'): TenantId => {
  const parsed = parseTenantId(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/** Read a canonical ProjectId column (fail-closed through the contracts parser). */
export const readProjectId = (row: Row, table: string, column = 'project_id'): ProjectId => {
  const parsed = parseProjectId(row[column]);
  if (!parsed.ok) {
    throw rowCorruption(table, column, row);
  }
  return parsed.value;
};

/**
 * Read an aggregate `version` BIGINT column. node-postgres returns int8 as a
 * string by default; both the string and the (configured) number form are
 * accepted, and anything that is not a safe positive integer corrupts the row.
 */
export const readAggregateVersion = (
  row: Row,
  table: string,
  column = 'version',
): AggregateVersion => {
  const raw = row[column];
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const parsed = parseAggregateVersion(numeric);
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

/** Read a JSONB column that must hold a JSON object (extension metadata, A2). */
export const readJsonObject = (
  row: Row,
  table: string,
  column: string,
): Readonly<Record<string, unknown>> => {
  const value = row[column];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw rowCorruption(table, column, row);
  }
  return value as Record<string, unknown>;
};

/** Convert a canonical Timestamp into the Date node-postgres binds for TIMESTAMPTZ. */
export const toDate = (timestamp: Timestamp): Date => new Date(timestamp);

/** Resolve a trusted entity-kind literal (loud TypeError on invalid input). */
export const entityKindOf = (kind: string): EntityKind => {
  const parsed = parseEntityKind(kind);
  if (!parsed.ok) {
    throw new TypeError(`invalid entity kind: ${kind}`);
  }
  return parsed.value;
};
