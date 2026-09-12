import { describe, expect, it } from 'vitest';
import {
  adapterKind,
  isAdapterKind,
  isProviderObjectId,
  isProviderObjectKind,
  isProviderSystemId,
  isProviderVersion,
  parseAdapterKind,
  parseProviderObjectId,
  parseProviderObjectKind,
  parseProviderSystemId,
  parseProviderVersion,
  providerObjectKind,
  providerObjectId,
  providerSystemId,
  providerVersion,
} from './identity';

// OFF-020 adapters-sdk — the provider-side identity vocabulary. Every type
// follows the contracts convention: a total fail-closed `parse` for untrusted
// values, an `is` type guard, and a trusted builder that throws a loud
// TypeError instead of coercing. ProviderVersion is required and never null
// (no unversioned sync — a frozen anti-pattern). Deterministic: pure
// functions over literals; the vocabulary is deliberately generic here
// ('fake-crm' style) — the OFF-021+ adapter packages own the real names.

describe('adapter kind (the adapter family vocabulary)', () => {
  it('accepts lowercase kebab-case kinds of 2..64 characters', () => {
    for (const raw of ['ab', 'fake-crm', 'fake-pm', 'a'.repeat(64)]) {
      const parsed = parseAdapterKind(raw);
      expect(parsed.ok, raw).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(raw);
      expect(isAdapterKind(raw)).toBe(true);
    }
  });

  it('rejects malformed kinds fail-closed', () => {
    for (const raw of [
      'a', // below the 2-character minimum
      'Fake-CRM', // uppercase
      'fake_crm', // underscore is not kebab
      'fake-crm-', // trailing dash
      '-fake-crm', // leading dash
      'fake--crm', // double dash
      'a'.repeat(65), // above the 64-character maximum
      '',
      42,
      null,
      undefined,
    ]) {
      const parsed = parseAdapterKind(raw);
      expect(parsed.ok, `raw: ${String(raw)}`).toBe(false);
      if (!parsed.ok) {
        expect(['invalid-type', 'invalid-value']).toContain(parsed.error.code);
      }
      expect(isAdapterKind(raw)).toBe(false);
    }
  });

  it('composes on the trusted path and throws loudly on bad input', () => {
    expect(adapterKind('fake-crm')).toBe('fake-crm');
    expect(() => adapterKind('Fake-CRM')).toThrow(TypeError);
    expect(() => adapterKind('a')).toThrow(TypeError);
  });
});

describe('provider object kind (the provider object type name)', () => {
  it('accepts lowercase kebab-case kinds of 1..64 characters', () => {
    for (const raw of ['a', 'contact', 'purchase-order-line', 'z'.repeat(64)]) {
      expect(parseProviderObjectKind(raw).ok, raw).toBe(true);
      expect(isProviderObjectKind(raw)).toBe(true);
    }
  });

  it('rejects malformed object kinds fail-closed', () => {
    for (const raw of ['Contact', 'contact-', '-contact', 'contact--x', 'c'.repeat(65), '', null]) {
      const parsed = parseProviderObjectKind(raw);
      expect(parsed.ok, `raw: ${String(raw)}`).toBe(false);
      expect(isProviderObjectKind(raw)).toBe(false);
    }
  });

  it('composes on the trusted path and throws loudly on bad input', () => {
    expect(providerObjectKind('contact')).toBe('contact');
    expect(() => providerObjectKind('Contact')).toThrow(TypeError);
  });
});

describe('opaque provider tokens (system id, object id, version)', () => {
  it('accepts printable-ASCII tokens of 1..128 characters (no whitespace)', () => {
    for (const raw of ['x', 'fake-instance-01', 'c-1', 'v1', 'etag:9f8e7d6c', 'Z9/a+b==']) {
      expect(parseProviderSystemId(raw).ok, raw).toBe(true);
      expect(parseProviderObjectId(raw).ok, raw).toBe(true);
      expect(parseProviderVersion(raw).ok, raw).toBe(true);
      expect(isProviderSystemId(raw)).toBe(true);
      expect(isProviderObjectId(raw)).toBe(true);
      expect(isProviderVersion(raw)).toBe(true);
    }
  });

  it('rejects whitespace, empty, oversized, and non-string tokens fail-closed', () => {
    for (const raw of [
      'has space',
      'tab\tseparated',
      'line\nbreak',
      '',
      'x'.repeat(129),
      7,
      null,
      undefined,
    ]) {
      expect(parseProviderSystemId(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(parseProviderObjectId(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(parseProviderVersion(raw).ok, `raw: ${String(raw)}`).toBe(false);
      expect(isProviderSystemId(raw)).toBe(false);
      expect(isProviderObjectId(raw)).toBe(false);
      expect(isProviderVersion(raw)).toBe(false);
    }
  });

  it('composes on the trusted path and throws loudly on bad input', () => {
    expect(providerSystemId('fake-instance-01')).toBe('fake-instance-01');
    expect(providerObjectId('c-1')).toBe('c-1');
    expect(providerVersion('v1')).toBe('v1');
    expect(() => providerSystemId('')).toThrow(TypeError);
    expect(() => providerObjectId('no spaces')).toThrow(TypeError);
    expect(() => providerVersion(null as unknown as string)).toThrow(TypeError);
  });
});
