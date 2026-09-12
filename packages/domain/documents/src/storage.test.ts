import { describe, expect, it } from 'vitest';
import { parseProjectId, parseTenantId } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import {
  CONTENT_BASE64_RULE,
  createInMemoryObjectStorage,
  decodeBase64,
  failingObjectStorage,
  formatStorageKey,
  isRevisionHash,
  isStorageKey,
  parseRevisionHash,
  parseStorageKey,
  storageKeyParts,
} from './storage';
import type { StorageKey } from './storage';

// OFF-008 documents domain — the object-storage port, storage keys, content
// hashes, and base64 content decoding. Pure unit tests: fixed everything.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const PROJECT_P1 = unwrap(
  parseProjectId('office-prj-v1-1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f'),
);

const hashOf = (character: string): string => character.repeat(64);

describe('revision hash parsing (fail-closed)', () => {
  it('accepts a lowercase hex hash of 16..128 characters', () => {
    expect(unwrap(parseRevisionHash(hashOf('a')))).toBe(hashOf('a'));
    expect(parseRevisionHash('0123456789abcdef').ok).toBe(true);
  });

  it('rejects uppercase, non-hex, too-short, and non-string values', () => {
    expect(parseRevisionHash(hashOf('A')).ok).toBe(false);
    expect(parseRevisionHash('zzzz').ok).toBe(false);
    expect(parseRevisionHash('abc').ok).toBe(false);
    expect(parseRevisionHash(1234).ok).toBe(false);
    expect(isRevisionHash(null)).toBe(false);
  });
});

describe('storage key parsing and composition (provider-neutral)', () => {
  it('composes a content-addressed key from scope + hash and round-trips it', () => {
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('a'))),
    });
    expect(key).toBe(`doc/${TENANT_A}/${PROJECT_P1}/${hashOf('a')}`);
    expect(isStorageKey(key)).toBe(true);
    const parts = storageKeyParts(key);
    expect(parts.tenantId).toBe(TENANT_A);
    expect(parts.projectId).toBe(PROJECT_P1);
    expect(parts.hash).toBe(hashOf('a'));
  });

  it('round-trips through the parser exactly', () => {
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('b'))),
    });
    const parsed = parseStorageKey(key);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(key);
  });

  it('rejects malformed keys fail-closed', () => {
    expect(parseStorageKey('not-a-key').ok).toBe(false);
    expect(parseStorageKey(`doc/${TENANT_A}/${PROJECT_P1}`).ok).toBe(false);
    expect(parseStorageKey(`blob/${TENANT_A}/${PROJECT_P1}/${hashOf('a')}`).ok).toBe(false);
    expect(parseStorageKey(`doc/not-a-tenant/${PROJECT_P1}/${hashOf('a')}`).ok).toBe(false);
    expect(parseStorageKey(`doc/${TENANT_A}/not-a-project/${hashOf('a')}`).ok).toBe(false);
    expect(parseStorageKey(`doc/${TENANT_A}/${PROJECT_P1}/NOTHEX`).ok).toBe(false);
    expect(parseStorageKey(42).ok).toBe(false);
    expect(isStorageKey('doc/x/y/z')).toBe(false);
  });
});

describe('base64 content decoding (pure, deterministic)', () => {
  it('decodes canonical base64 to the exact bytes', () => {
    expect(decodeBase64('QUJD')).toStrictEqual(new Uint8Array([65, 66, 67]));
    expect(decodeBase64('QUJDRA==')).toStrictEqual(new Uint8Array([65, 66, 67, 68]));
    expect(decodeBase64('QUJDRGU=')).toStrictEqual(new Uint8Array([65, 66, 67, 68, 101]));
    expect(decodeBase64('')).toStrictEqual(new Uint8Array([]));
  });

  it('the payload rule accepts canonical base64 and rejects the rest', () => {
    expect(CONTENT_BASE64_RULE.pattern?.test('QUJDRA==')).toBe(true);
    expect(CONTENT_BASE64_RULE.pattern?.test('QUJD')).toBe(true);
    expect(CONTENT_BASE64_RULE.pattern?.test('A')).toBe(false);
    expect(CONTENT_BASE64_RULE.pattern?.test('QUJD RA==')).toBe(false);
    expect(CONTENT_BASE64_RULE.pattern?.test('QUJDR=')).toBe(false);
    expect(CONTENT_BASE64_RULE.pattern?.test('-___')).toBe(false);
  });

  it('throws a loud TypeError for a malformed decode input (trusted path)', () => {
    expect(() => decodeBase64('!!!!')).toThrow(TypeError);
  });
});

describe('the in-memory object storage (test fake)', () => {
  it('puts, checks, and gets a blob by content-addressed key', async () => {
    const storage = createInMemoryObjectStorage();
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('a'))),
    });
    const content = new Uint8Array([1, 2, 3]);
    const put = await storage.put(key, content);
    expect(put.ok).toBe(true);
    const check = await storage.check(key);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.value).toBe(true);
    const got = await storage.get(key);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toStrictEqual(content);
    expect(storage.count).toBe(1);
    expect(storage.objects[0]?.key).toBe(key);
  });

  it('get and check report absence with typed results', async () => {
    const storage = createInMemoryObjectStorage();
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('c'))),
    }) as StorageKey;
    const got = await storage.get(key);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error.code).toBe('not-found');
      expect(got.error.details[0]?.code).toBe('object-not-found');
    }
    const check = await storage.check(key);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.value).toBe(false);
  });

  it('dedupes identical content under the same key (one blob)', async () => {
    const storage = createInMemoryObjectStorage();
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('a'))),
    });
    const first = await storage.put(key, new Uint8Array([9, 9]));
    const second = await storage.put(key, new Uint8Array([9, 9]));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(storage.count).toBe(1);
  });

  it('rejects different content under the same key — never an overwrite (typed failure)', async () => {
    const storage = createInMemoryObjectStorage();
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('a'))),
    });
    await storage.put(key, new Uint8Array([1]));
    const result = await storage.put(key, new Uint8Array([2]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('content-address-mismatch');
    }
    // The original content is untouched.
    const got = await storage.get(key);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toStrictEqual(new Uint8Array([1]));
  });

  it('the failing object storage returns typed failures', async () => {
    const storage = failingObjectStorage('backend unreachable');
    const key = formatStorageKey({
      tenantId: TENANT_A,
      projectId: PROJECT_P1,
      hash: unwrap(parseRevisionHash(hashOf('a'))),
    });
    const put = await storage.put(key, new Uint8Array([1]));
    expect(put.ok).toBe(false);
    if (!put.ok) {
      expect(put.error.details[0]?.code).toBe('object-storage-rejected');
    }
  });
});
