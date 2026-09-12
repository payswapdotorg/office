import { describe, expect, it } from 'vitest';
import type { ParseResult } from '@office/contracts';
import {
  CAPABILITIES,
  capability,
  capabilityAction,
  isCapability,
  parseCapability,
} from './index';

// OFF-006 authz — capability vocabulary tests. Deterministic: fixed values.

const CAPABILITY_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,31}\.(read|write)$/;

/** Unwrap a parse failure (tests assert failures explicitly). */
const failure = <T>(result: ParseResult<T>) => {
  if (result.ok) throw new Error('expected a parse failure');
  return result.error;
};

describe('capability vocabulary (OFF-006)', () => {
  it('declares a non-empty, duplicate-free vocabulary', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it('every declared capability matches the <area>.<read|write> grammar', () => {
    for (const name of CAPABILITIES) {
      expect(CAPABILITY_PATTERN.test(name), name).toBe(true);
    }
  });

  it('declares both a read and a write capability for every area', () => {
    const names = new Set<string>(CAPABILITIES);
    const areas = new Set(CAPABILITIES.map((name) => name.slice(0, name.indexOf('.'))));
    expect(areas.size).toBeGreaterThan(0);
    for (const area of areas) {
      expect(names.has(`${area}.read`), `${area}.read`).toBe(true);
      expect(names.has(`${area}.write`), `${area}.write`).toBe(true);
    }
  });

  it('keeps read and write capabilities distinct (a read never grants a write)', () => {
    const reads = CAPABILITIES.filter((value) => capabilityAction(value) === 'read');
    const writes = CAPABILITIES.filter((value) => capabilityAction(value) === 'write');
    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(reads.some((value) => writes.includes(value))).toBe(false);
  });

  it('parses every declared capability', () => {
    for (const name of CAPABILITIES) {
      const result = parseCapability(name);
      expect(result.ok, name).toBe(true);
      if (result.ok) expect(result.value).toBe(name);
    }
  });

  it('rejects undeclared capability strings (fail-closed vocabulary)', () => {
    for (const undeclared of ['projects.admin', 'nonexistent.read', 'organization.delete']) {
      const error = failure(parseCapability(undeclared));
      expect(error.code, undeclared).toBe('invalid-value');
      expect(error.received).toContain(undeclared);
      expect(error.path).toBe('');
    }
  });

  it('rejects malformed capability values', () => {
    for (const malformed of [
      'Projects.Read',
      'projects',
      'projects.read.extra',
      '',
      'projects..read',
      'projects.read.',
      42,
      null,
      undefined,
      {},
      ['projects.read'],
    ]) {
      expect(parseCapability(malformed).ok, JSON.stringify(malformed)).toBe(false);
    }
  });

  it('types failures as invalid-type / invalid-value at the root path', () => {
    const nonString = failure(parseCapability(42));
    expect(nonString.code).toBe('invalid-type');
    expect(nonString.path).toBe('');
    const malformed = failure(parseCapability('projects'));
    expect(malformed.code).toBe('invalid-value');
    expect(malformed.path).toBe('');
  });

  it('isCapability guards only declared capabilities', () => {
    expect(isCapability('projects.read')).toBe(true);
    expect(isCapability('projects.admin')).toBe(false);
    expect(isCapability(42)).toBe(false);
    expect(isCapability(null)).toBe(false);
  });

  it('capability() composes trusted values and throws loudly on unknown names', () => {
    expect(capability('projects.read')).toBe('projects.read');
    expect(capability('documents.write')).toBe('documents.write');
    expect(() => capability('projects.admin')).toThrow(TypeError);
    expect(() => capability('')).toThrow(TypeError);
    expect(() => capability(42 as unknown as string)).toThrow(TypeError);
  });

  it('capabilityAction maps the structural read/write suffix', () => {
    expect(capabilityAction(capability('projects.read'))).toBe('read');
    expect(capabilityAction(capability('projects.write'))).toBe('write');
  });
});
