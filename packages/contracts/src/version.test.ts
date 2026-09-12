import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  isKnownSchemaVersion,
  KNOWN_SCHEMA_VERSIONS,
  parseSchemaVersion,
} from './index';
import type { ParseResult } from './index';

// OFF-002 contracts — versioning tests. Deterministic.

const unwrap = <T>(result: ParseResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected parse failure: ${JSON.stringify(result.error)}`);
};

describe('schema versioning (fail closed)', () => {
  it('knows exactly the 1.0.0 family for this release', () => {
    expect(KNOWN_SCHEMA_VERSIONS).toStrictEqual(['1.0.0']);
    expect(CURRENT_SCHEMA_VERSION).toBe('1.0.0');
    expect(KNOWN_SCHEMA_VERSIONS).toContain(CURRENT_SCHEMA_VERSION);
  });

  it('parses known versions', () => {
    expect(unwrap(parseSchemaVersion('1.0.0'))).toBe('1.0.0');
    expect(isKnownSchemaVersion('1.0.0')).toBe(true);
  });

  it('fails closed on well-formed unknown versions with typed errors', () => {
    for (const candidate of ['2.0.0', '1.0.1', '1.1.0', '0.9.0']) {
      const result = parseSchemaVersion(candidate);
      expect(result.ok, `candidate: ${candidate}`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown-schema-version');
        expect(result.error.path).toBe('');
      }
    }
    expect(isKnownSchemaVersion('9.9.9')).toBe(false);
  });

  it('rejects malformed version strings', () => {
    const malformed = ['1.0', '1', 'v1', '1.0.0.0', '01.0.0', '1.0.0-beta', '', 1, null, ['1.0.0']];
    for (const candidate of malformed) {
      expect(parseSchemaVersion(candidate).ok, `candidate: ${String(candidate)}`).toBe(false);
    }
  });
});
