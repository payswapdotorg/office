// Office adapters-sdk — resumable sync cursors (OFF-020).
//
// SyncCursor is the resumable state of one sync stream — the (tenant,
// adapter kind, provider system, object kind) tuple — carrying the provider's
// OPAQUE continuation token plus the checkpoint metadata the SDK records at
// that position (items observed through the position, last provider version
// seen). Replay safety is two-layered, by design:
//
//   1. POSITIONAL — restarting from a cursor hands the provider the token,
//      so the provider resumes AFTER the checkpointed items; nothing already
//      checkpointed is re-delivered.
//   2. IDEMPOTENT — even when items DO come back (at-least-once, provider
//      re-delivery, a re-run from an older cursor), every canonical command
//      derives its idempotency key from SourceRef + provider version
//      (source-ref.ts), so a replayed item is a typed no-op: no duplicate
//      mapping, no duplicate command.
//
// A cursor presented to the WRONG stream is typed-rejected before any sync
// runs: a different tenant is a typed unauthorized rejection (A12), and a
// different adapter/system/object-kind is a typed invariant-violation — a
// cursor never silently resumes a stream it does not belong to.
import {
  parseFail,
  parseOk,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { ParseResult, TenantId, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  checkString,
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import {
  parseAdapterKind,
  parseProviderObjectKind,
  parseProviderSystemId,
  parseProviderVersion,
} from './identity';
import type {
  AdapterKind,
  ProviderObjectKind,
  ProviderSystemId,
  ProviderVersion,
} from './identity';

declare const syncCursorTokenBrand: unique symbol;

/** The provider's opaque continuation token for one sync stream. */
export type SyncCursorToken = string & {
  readonly [syncCursorTokenBrand]: 'SyncCursorToken';
};

/** Grammar description used in parse failures. */
export const SYNC_CURSOR_TOKEN_GRAMMAR =
  'opaque printable-ASCII continuation token of 1..1024 characters (no whitespace)';

const SYNC_CURSOR_TOKEN_RULE: StringRule = {
  min: 1,
  max: 1024,
  pattern: /^[\x21-\x7e]+$/,
  description: SYNC_CURSOR_TOKEN_GRAMMAR,
};

/** One sync stream: a tenant, an adapter kind, a provider system, an object kind. */
export interface SyncStream {
  readonly tenantId: TenantId;
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectKind: ProviderObjectKind;
}

/** Checkpoint metadata recorded at a cursor position. */
export interface SyncCheckpoint {
  /** Provider items observed through this position (monotonic, never regresses). */
  readonly itemsObserved: number;
  /** The last provider version seen through this position (null when none). */
  readonly lastProviderVersion: ProviderVersion | null;
}

/** Resumable state of one sync stream at one position. */
export interface SyncCursor {
  readonly kind: 'sync-cursor';
  /** The stream this cursor belongs to (typed-checked on every resume). */
  readonly stream: SyncStream;
  /** The provider's opaque continuation token at this position. */
  readonly token: SyncCursorToken;
  /** Checkpoint metadata at this position. */
  readonly checkpoint: SyncCheckpoint;
  /** When this cursor was last advanced (injected clock). */
  readonly updatedAt: Timestamp;
}

/** Shape description used in parse failures. */
export const SYNC_STREAM_GRAMMAR =
  'SyncStream: { tenantId, adapterKind, systemId, objectKind }';

/** Shape description used in parse failures. */
export const SYNC_CHECKPOINT_GRAMMAR =
  'SyncCheckpoint: { itemsObserved: integer >= 0, lastProviderVersion: ProviderVersion | null }';

/** Shape description used in parse failures. */
export const SYNC_CURSOR_GRAMMAR =
  'SyncCursor: { kind, stream, token, checkpoint, updatedAt }';

const SYNC_STREAM_KEYS = ['tenantId', 'adapterKind', 'systemId', 'objectKind'] as const;
const SYNC_CHECKPOINT_KEYS = ['itemsObserved', 'lastProviderVersion'] as const;
const SYNC_CURSOR_KEYS = ['kind', 'stream', 'token', 'checkpoint', 'updatedAt'] as const;

/** Parse an untrusted value as a SyncStream (total, fail-closed, strict keys). */
export function parseSyncStream(raw: unknown): ParseResult<SyncStream> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SYNC_STREAM_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SYNC_STREAM_KEYS, '', SYNC_STREAM_GRAMMAR);
  if (unknownKey) return unknownKey;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const adapterKind = requireFieldWith(raw, 'adapterKind', '', parseAdapterKind);
  if (!adapterKind.ok) return adapterKind;
  const systemId = requireFieldWith(raw, 'systemId', '', parseProviderSystemId);
  if (!systemId.ok) return systemId;
  const objectKind = requireFieldWith(raw, 'objectKind', '', parseProviderObjectKind);
  if (!objectKind.ok) return objectKind;
  return parseOk(
    {
      tenantId: tenantId.value,
      adapterKind: adapterKind.value,
      systemId: systemId.value,
      objectKind: objectKind.value,
    } satisfies SyncStream,
  );
}

/** Type guard for structurally valid SyncStream values. */
export function isSyncStream(raw: unknown): raw is SyncStream {
  return parseSyncStream(raw).ok;
}

/** Parse an untrusted value as a SyncCheckpoint (total, fail-closed, strict keys). */
export function parseSyncCheckpoint(raw: unknown): ParseResult<SyncCheckpoint> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SYNC_CHECKPOINT_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SYNC_CHECKPOINT_KEYS, '', SYNC_CHECKPOINT_GRAMMAR);
  if (unknownKey) return unknownKey;
  const itemsObserved = raw['itemsObserved'];
  if (typeof itemsObserved !== 'number' || !Number.isInteger(itemsObserved) || itemsObserved < 0) {
    return parseFail(
      'invalid-value',
      'itemsObserved',
      'an integer >= 0 (monotonic count of provider items observed through this position)',
      describeValue(itemsObserved),
    );
  }
  const lastProviderVersion = requireNullableFieldWith(
    raw,
    'lastProviderVersion',
    '',
    parseProviderVersion,
  );
  if (!lastProviderVersion.ok) return lastProviderVersion;
  return parseOk(
    {
      itemsObserved,
      lastProviderVersion: lastProviderVersion.value,
    } satisfies SyncCheckpoint,
  );
}

/** Type guard for structurally valid SyncCheckpoint values. */
export function isSyncCheckpoint(raw: unknown): raw is SyncCheckpoint {
  return parseSyncCheckpoint(raw).ok;
}

/** Parse an untrusted value as a SyncCursor (total, fail-closed, strict keys). */
export function parseSyncCursor(raw: unknown): ParseResult<SyncCursor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SYNC_CURSOR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SYNC_CURSOR_KEYS, '', SYNC_CURSOR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['sync-cursor']);
  if (!kind.ok) return kind;
  const stream = requireFieldWith(raw, 'stream', '', parseSyncStream);
  if (!stream.ok) return stream;
  const token = requireFieldWith(raw, 'token', '', parseSyncCursorToken);
  if (!token.ok) return token;
  const checkpoint = requireFieldWith(raw, 'checkpoint', '', parseSyncCheckpoint);
  if (!checkpoint.ok) return checkpoint;
  const updatedAt = requireFieldWith(raw, 'updatedAt', '', parseTimestamp);
  if (!updatedAt.ok) return updatedAt;
  return parseOk(
    {
      kind: 'sync-cursor',
      stream: stream.value,
      token: token.value,
      checkpoint: checkpoint.value,
      updatedAt: updatedAt.value,
    } satisfies SyncCursor,
  );
}

/** Type guard for structurally valid SyncCursor values. */
export function isSyncCursor(raw: unknown): raw is SyncCursor {
  return parseSyncCursor(raw).ok;
}

/** Parse an untrusted value as a SyncCursorToken (total, fail-closed). */
export function parseSyncCursorToken(raw: unknown): ParseResult<SyncCursorToken> {
  const result = checkString(raw, SYNC_CURSOR_TOKEN_RULE, '');
  if (!result.ok) return result;
  return parseOk(result.value as SyncCursorToken);
}

/** Type guard for structurally valid SyncCursorToken values. */
export function isSyncCursorToken(raw: unknown): raw is SyncCursorToken {
  return parseSyncCursorToken(raw).ok;
}

/** Compose a SyncStream from validated parts (trusted path; loud TypeError). */
export function syncStream(parts: {
  readonly tenantId: TenantId;
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectKind: ProviderObjectKind;
}): SyncStream {
  const parsed = parseSyncStream(parts);
  if (!parsed.ok) {
    throw new TypeError(`invalid sync stream: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Compose a SyncCursor from validated parts (trusted path; loud TypeError). */
export function syncCursor(parts: {
  readonly stream: SyncStream;
  readonly token: SyncCursorToken;
  readonly checkpoint: SyncCheckpoint;
  readonly updatedAt: Timestamp;
}): SyncCursor {
  const parsed = parseSyncCursor({ ...parts, kind: 'sync-cursor' });
  if (!parsed.ok) {
    throw new TypeError(`invalid sync cursor: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
}

/** Compose a SyncCursorToken from a validated literal (trusted path). */
export function syncCursorToken(raw: string): SyncCursorToken {
  const parsed = parseSyncCursorToken(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid sync cursor token: ${describeValue(raw)}`);
  }
  return parsed.value;
}

/** Canonical, unambiguous serialization of a sync stream (store key). */
export function syncStreamKeyOf(stream: SyncStream): string {
  return JSON.stringify([
    stream.tenantId,
    stream.adapterKind,
    stream.systemId,
    stream.objectKind,
  ]);
}

/**
 * Typed stream-membership check for a cursor presented to a sync: a cursor of
 * a different TENANT is a typed unauthorized rejection (A12); a cursor of a
 * different adapter/system/object-kind (same tenant) is a typed
 * invariant-violation. A cursor never silently resumes a stream it does not
 * belong to.
 */
export function checkCursorStream(
  cursor: SyncCursor,
  stream: SyncStream,
): Result<true, DomainError> {
  if (cursor.stream.tenantId !== stream.tenantId) {
    return fail(
      domainError(
        'unauthorized',
        `sync cursor belongs to tenant ${cursor.stream.tenantId} and cannot resume a stream of tenant ${stream.tenantId}`,
        [
          {
            code: 'tenant-scope-violation',
            message: `${cursor.stream.tenantId} vs ${stream.tenantId}`,
            path: 'stream',
          },
        ],
        { scope: { kind: 'tenant', tenantId: stream.tenantId } },
      ),
    );
  }
  if (
    cursor.stream.adapterKind !== stream.adapterKind ||
    cursor.stream.systemId !== stream.systemId ||
    cursor.stream.objectKind !== stream.objectKind
  ) {
    return fail(
      domainError(
        'invariant-violation',
        `sync cursor of stream ${syncStreamKeyOf(cursor.stream)} cannot resume stream ${syncStreamKeyOf(stream)} — cursors are stream-scoped`,
        [
          {
            code: 'cursor-stream-mismatch',
            message: syncStreamKeyOf(cursor.stream),
            path: 'stream',
          },
        ],
        { scope: { kind: 'tenant', tenantId: stream.tenantId } },
      ),
    );
  }
  return ok(true);
}

/**
 * Derive the next cursor of a stream from a completed page (deterministic):
 * the token and checkpoint come from the adapter's sync result, the timestamp
 * from the injected clock. When a previous cursor is given it must belong to
 * the SAME stream (typed rejection otherwise), and checkpoint regression
 * (itemsObserved going backwards) is a typed invariant-violation — a cursor
 * never rewinds silently.
 */
export function nextCursor(parts: {
  readonly stream: SyncStream;
  readonly previous: SyncCursor | null;
  readonly token: SyncCursorToken;
  readonly checkpoint: SyncCheckpoint;
  readonly now: Timestamp;
}): Result<SyncCursor, DomainError> {
  if (parts.previous !== null) {
    const membership = checkCursorStream(parts.previous, parts.stream);
    if (!membership.ok) return membership;
    if (parts.previous.checkpoint.itemsObserved > parts.checkpoint.itemsObserved) {
      return fail(
        domainError(
          'invariant-violation',
          `sync cursor checkpoint cannot rewind: observed ${parts.previous.checkpoint.itemsObserved} items before, ${parts.checkpoint.itemsObserved} after`,
          [
            {
              code: 'cursor-checkpoint-regression',
              message: `${parts.previous.checkpoint.itemsObserved} → ${parts.checkpoint.itemsObserved}`,
              path: 'checkpoint.itemsObserved',
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.stream.tenantId } },
        ),
      );
    }
  }
  return ok(
    syncCursor({
      stream: parts.stream,
      token: parts.token,
      checkpoint: parts.checkpoint,
      updatedAt: parts.now,
    }),
  );
}

/**
 * Storage port for sync cursors, one row per stream. Implementations MUST key
 * by the full stream (tenant included) so a foreign tenant's cursor is
 * invisible (A12, no existence oracle). The SQL implementation belongs to the
 * runtime, not this SDK.
 */
export interface SyncCursorStore {
  /** The stream's persisted cursor, or null when the stream never synced. */
  load(stream: SyncStream): Promise<SyncCursor | null>;
  /** Persist the stream's cursor (positions only advance — see nextCursor). */
  save(cursor: SyncCursor): Promise<Result<SyncCursor, DomainError>>;
}

/** Deterministic in-memory SyncCursorStore (the SDK's test fixture). */
export function createInMemorySyncCursorStore(): SyncCursorStore {
  const cursors = new Map<string, SyncCursor>();
  return {
    async load(stream) {
      return cursors.get(syncStreamKeyOf(stream)) ?? null;
    },
    async save(cursor) {
      const key = syncStreamKeyOf(cursor.stream);
      const existing = cursors.get(key);
      if (
        existing !== undefined &&
        existing.checkpoint.itemsObserved > cursor.checkpoint.itemsObserved
      ) {
        return fail(
          domainError(
            'invariant-violation',
            `refusing to rewind cursor for stream ${key}: observed ${existing.checkpoint.itemsObserved} items before, ${cursor.checkpoint.itemsObserved} after`,
            [{ code: 'cursor-checkpoint-regression', message: key, path: null }],
            { scope: { kind: 'tenant', tenantId: cursor.stream.tenantId } },
          ),
        );
      }
      cursors.set(key, cursor);
      return ok(cursor);
    },
  };
}
