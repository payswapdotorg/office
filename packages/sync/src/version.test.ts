import { describe, expect, it } from 'vitest';
import {
  CURRENT_PROTOCOL_VERSION,
  KNOWN_PROTOCOL_VERSIONS,
  isProtocolVersion,
  parseProtocolVersion,
} from './version';
import { unwrap } from './test-support';

// OFF-028 — fail-closed subscription protocol versioning ("no unversioned
// external synchronization"): a subscription pins ONE protocol version,
// every stream message carries it, and an unknown version is a typed parse
// error — never silent acceptance.

describe('subscription protocol versioning (OFF-028)', () => {
  it('parses the current protocol version', () => {
    expect(unwrap(parseProtocolVersion(CURRENT_PROTOCOL_VERSION))).toBe('1.0.0');
    expect(isProtocolVersion('1.0.0')).toBe(true);
  });

  it('keeps the current version inside the closed known list', () => {
    expect(KNOWN_PROTOCOL_VERSIONS).toContain(CURRENT_PROTOCOL_VERSION);
    expect(KNOWN_PROTOCOL_VERSIONS.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed versions fail-closed', () => {
    for (const bad of ['1.0', 'v1.0.0', '1.0.0.0', '01.0.0', '1.0.00', '', 'semver', 1, null, undefined]) {
      expect(parseProtocolVersion(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(isProtocolVersion(bad)).toBe(false);
    }
  });

  it('parses every known protocol version and rejects well-formed UNKNOWN ones fail-closed', () => {
    for (const known of KNOWN_PROTOCOL_VERSIONS) {
      expect(unwrap(parseProtocolVersion(known))).toBe(known);
      expect(isProtocolVersion(known)).toBe(true);
    }
    for (const unknown of ['0.9.0', '1.0.1', '1.2.0', '2.0.0', '10.20.30']) {
      const parsed = parseProtocolVersion(unknown);
      expect(parsed.ok, unknown).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe('invalid-value');
        expect(parsed.error.expected).toContain(CURRENT_PROTOCOL_VERSION);
      }
    }
  });

  it('reports the closed grammar in failures', () => {
    const parsed = parseProtocolVersion('2.0.0');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.path).toBe('');
      expect(parsed.error.received).toContain('2.0.0');
    }
  });
});
