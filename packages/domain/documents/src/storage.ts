// Office documents domain — the object-storage port (OFF-008).
//
// Freeze A2: object/file storage is SEPARATE from PostgreSQL; freeze A5/A6 +
// the frozen anti-patterns: provider-specific semantics never enter core
// domain entities. This module therefore owns a deliberately MINIMAL,
// provider-neutral port over content-addressed blobs: put/get/check by
// storage key. No cloud provider adapter lives here (external systems are
// adapters owned elsewhere); the in-memory implementation below is a test
// fake, not a production adapter.
//
// Content addressing (the work item's implementation note): a revision's
// content hash is computed from the content bytes by an INJECTED hash
// supplier (deterministic in tests; a real crypto hash in production wiring)
// — never inside this package, so no crypto randomness enters handler logic.
// The storage key is composed deterministically from the owning scope plus
// the hash: same content under the same scope always addresses the same blob,
// so the port may dedupe by key (identical content → one blob). Command
// payloads carry content as canonical base64 (JSON-safe); the pure decoder
// below turns it back into bytes for hashing and storage.
import { parseFail, parseProjectId, parseTenantId } from '@office/contracts';
import type { ParseResult, ProjectId, TenantId } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { describeValue, parseStringLike } from './parse';
import type { StringRule } from './parse';

declare const revisionHashBrand: unique symbol;
declare const storageKeyBrand: unique symbol;

/** Opaque content hash of a revision's bytes (injected supplier, hex). */
export type RevisionHash = string & {
  readonly [revisionHashBrand]: 'RevisionHash';
};

/** Provider-neutral, content-addressed object-storage key. */
export type StorageKey = string & {
  readonly [storageKeyBrand]: 'StorageKey';
};

/** Grammar description used in parse failures. */
export const REVISION_HASH_GRAMMAR =
  'lowercase hexadecimal content hash (16..128 characters), e.g. a sha-256 digest rendered as 64 hex characters';

const REVISION_HASH_RULE: StringRule = {
  min: 16,
  max: 128,
  pattern: /^[0-9a-f]{16,128}$/,
  description: REVISION_HASH_GRAMMAR,
};

/** Grammar description used in parse failures. */
export const STORAGE_KEY_GRAMMAR =
  "'doc/<canonical tenant id>/<canonical project id>/<content hash>' — provider-neutral, content-addressed";

const STORAGE_KEY_PREFIX = 'doc';
const STORAGE_KEY_SEGMENTS = 4;

/** Parse an untrusted value as a RevisionHash (total, fail-closed). */
export function parseRevisionHash(raw: unknown): ParseResult<RevisionHash> {
  const result = parseStringLike(raw, REVISION_HASH_RULE);
  if (!result.ok) return result;
  return result as ParseResult<RevisionHash>;
}

/** Type guard for structurally valid RevisionHash values. */
export function isRevisionHash(raw: unknown): raw is RevisionHash {
  return parseRevisionHash(raw).ok;
}

const storageKeyFailure = (received: string): ParseResult<never> =>
  parseFail('invalid-value', '', STORAGE_KEY_GRAMMAR, describeValue(received));

/**
 * Parse an untrusted value as a StorageKey (total, fail-closed). The key is
 * exactly four slash-separated segments: the literal 'doc', a canonical
 * TenantId, a canonical ProjectId, and a content hash — canonical ids carry
 * dashes but never slashes, so the split is unambiguous.
 */
export function parseStorageKey(raw: unknown): ParseResult<StorageKey> {
  const result = parseStringLike(raw, {
    min: 1,
    max: 512,
    description: STORAGE_KEY_GRAMMAR,
  });
  if (!result.ok) return result;
  const segments = result.value.split('/');
  if (segments.length !== STORAGE_KEY_SEGMENTS) {
    return storageKeyFailure(result.value);
  }
  const [prefix, tenantId, projectId, hash] = segments as [string, string, string, string];
  if (prefix !== STORAGE_KEY_PREFIX) {
    return storageKeyFailure(result.value);
  }
  const tenant = parseTenantId(tenantId);
  if (!tenant.ok) return storageKeyFailure(result.value);
  const project = parseProjectId(projectId);
  if (!project.ok) return storageKeyFailure(result.value);
  const hashResult = parseRevisionHash(hash);
  if (!hashResult.ok) return storageKeyFailure(result.value);
  return ok(result.value as StorageKey);
}

/** Type guard for structurally valid StorageKey values. */
export function isStorageKey(raw: unknown): raw is StorageKey {
  return parseStorageKey(raw).ok;
}

/**
 * Compose a content-addressed StorageKey from validated parts (trusted path).
 * Throws a loud TypeError on invalid parts — a programming error, never a
 * silent fallback (same convention as the contracts format helpers).
 */
export function formatStorageKey(parts: {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly hash: RevisionHash;
}): StorageKey {
  const key = `${STORAGE_KEY_PREFIX}/${parts.tenantId}/${parts.projectId}/${parts.hash}`;
  const parsed = parseStorageKey(key);
  if (!parsed.ok) {
    throw new TypeError(
      `invalid storage key composition: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
}

/** Validated parts of a parsed StorageKey. */
export interface StorageKeyParts {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly hash: RevisionHash;
}

/** Split a validated StorageKey back into its parts. */
export function storageKeyParts(key: StorageKey): StorageKeyParts {
  const [prefix, tenantId, projectId, hash] = key.split('/');
  if (
    prefix === undefined ||
    tenantId === undefined ||
    projectId === undefined ||
    hash === undefined
  ) {
    // Unreachable for branded keys (parseStorageKey is the only issuer);
    // kept loud for defense in depth.
    throw new TypeError(`malformed storage key: ${key}`);
  }
  return {
    tenantId: tenantId as TenantId,
    projectId: projectId as ProjectId,
    hash: hash as RevisionHash,
  };
}

// ----- command-payload content encoding (canonical base64) ----------------------

/** Grammar description used in parse failures. */
export const CONTENT_BASE64_GRAMMAR =
  'canonical base64 (RFC 4648, padded, no whitespace) — 4..133333336 characters (up to ~100 MB of binary content)';

/** The StringRule command payload parsers check `contentBase64` against. */
export const CONTENT_BASE64_RULE: StringRule = {
  min: 4,
  max: 133_333_336,
  pattern: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  description: CONTENT_BASE64_GRAMMAR,
};

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_REVERSE: ReadonlyMap<string, number> = new Map(
  [...BASE64_ALPHABET].map((character, index) => [character, index] as const),
);

/**
 * Decode canonical base64 into bytes (pure, deterministic, no platform APIs).
 * Trusted path: validate with the rule above BEFORE decoding — a malformed
 * input throws a loud TypeError, never a silent wrong byte.
 */
export function decodeBase64(encoded: string): Uint8Array {
  const characters = encoded.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((characters.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let position = 0; position < characters.length; position += 1) {
    const character = characters[position];
    if (character === undefined) {
      throw new TypeError('invalid base64 content: empty character');
    }
    const value = BASE64_REVERSE.get(character);
    if (value === undefined) {
      throw new TypeError(`invalid base64 character: ${character}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

// ----- THE object-storage port ---------------------------------------------------

/**
 * THE object-storage port (minimal, by design, provider-neutral): put/get/
 * check content-addressed blobs by storage key. Content addressing makes the
 * port's contract sharp: a key addresses exactly one byte sequence —
 *
 *  * `put` is idempotent for IDENTICAL content (same key, same bytes → ok;
 *    the blob is stored once — dedupe by key is allowed) and a typed
 *    invariant-violation for DIFFERENT content under the same key (the key
 *    is the content's address; a mismatch is an integrity violation, never
 *    an overwrite);
 *  * `get` returns the stored bytes or a typed not-found failure;
 *  * `check` reports existence without reading the content.
 *
 * Real object-storage adapters (owned by the app/adapter layers, freeze A6)
 * implement this port; the in-memory implementation below exists for
 * deterministic tests.
 */
export interface ObjectStorage {
  /**
   * Store `content` under the content-addressed `key`. Idempotent for
   * identical content; a typed invariant-violation for different content
   * under the same key (never an overwrite — content addressing).
   */
  put(key: StorageKey, content: Uint8Array): Promise<Result<true, DomainError>>;
  /** Read the bytes stored under `key`; typed not-found when absent. */
  get(key: StorageKey): Promise<Result<Uint8Array, DomainError>>;
  /** Does a blob exist under `key`? (No content is read.) */
  check(key: StorageKey): Promise<Result<boolean, DomainError>>;
}

/** Typed failure for a content-address mismatch (never an overwrite). */
export const contentAddressMismatch = (key: StorageKey): DomainError =>
  domainError(
    'invariant-violation',
    `storage key ${key} already addresses different content; content-addressed keys are never overwritten`,
    [
      {
        code: 'content-address-mismatch',
        message: `different content already stored under ${key}`,
        path: null,
      },
    ],
  );

/** Typed not-found for a missing blob. */
export const objectNotFound = (key: StorageKey): DomainError =>
  domainError('not-found', `no object stored under key ${key}`, [
    { code: 'object-not-found', message: key, path: null },
  ]);

/** One stored blob of the in-memory object storage (test introspection). */
export interface InMemoryStoredObject {
  readonly key: StorageKey;
  readonly content: Uint8Array;
}

/** The in-memory ObjectStorage: a deterministic test fake, not an adapter. */
export interface InMemoryObjectStorage extends ObjectStorage {
  /** Every stored blob, in first-put order. */
  readonly objects: readonly InMemoryStoredObject[];
  /** Number of stored blobs (deduped by key). */
  readonly count: number;
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

/** Create an in-memory ObjectStorage for deterministic tests. */
export function createInMemoryObjectStorage(): InMemoryObjectStorage {
  const blobs = new Map<StorageKey, Uint8Array>();
  return {
    get objects(): readonly InMemoryStoredObject[] {
      return [...blobs.entries()].map(([key, content]) => ({ key, content }));
    },
    get count(): number {
      return blobs.size;
    },
    put: async (key, content) => {
      const existing = blobs.get(key);
      if (existing !== undefined) {
        if (bytesEqual(existing, content)) {
          // Content addressing: identical content under the same key is the
          // SAME blob — dedupe, never a second copy.
          return ok(true);
        }
        return fail(contentAddressMismatch(key));
      }
      blobs.set(key, content);
      return ok(true);
    },
    get: async (key) => {
      const content = blobs.get(key);
      if (content === undefined) return fail(objectNotFound(key));
      return ok(content);
    },
    check: async (key) => ok(blobs.has(key)),
  };
}

/** Convenience: an object storage that always fails with a typed error (tests/limits). */
export const failingObjectStorage = (reason: string): ObjectStorage => ({
  put: async () =>
    fail(
      domainError('invariant-violation', `object storage rejected the put: ${reason}`, [
        { code: 'object-storage-rejected', message: reason, path: null },
      ]),
    ),
  get: async () =>
    fail(
      domainError('not-found', `object storage rejected the get: ${reason}`, [
        { code: 'object-storage-rejected', message: reason, path: null },
      ]),
    ),
  check: async () =>
    fail(
      domainError('invariant-violation', `object storage rejected the check: ${reason}`, [
        { code: 'object-storage-rejected', message: reason, path: null },
      ]),
    ),
});
