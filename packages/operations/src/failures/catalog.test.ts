import { describe, expect, it } from 'vitest';
import {
  FAILURE_MODE_KINDS,
  OFFICE_FAILURE_MODE_CATALOG,
  defineFailureMode,
  isFailureModeId,
  isFailureModeKind,
  isFailureModeRecord,
  parseFailureModeId,
  parseFailureModeKind,
  parseFailureModeRecord,
} from '../index';
import type { FailureModeRecord } from '../index';

// OFF-038 — the failure-mode catalog acceptance: every critical failure mode
// carries BOTH a documented operator action AND a tested detection rule
// (detect.test.ts proves the rule fires on its fixture and stays silent on
// the healthy input), the vocabulary is closed, and untrusted records parse
// fail-closed. Pure data; deterministic by construction.

const CATALOG_RECORD = OFFICE_FAILURE_MODE_CATALOG[0] as FailureModeRecord;

describe('the canonical catalog (OFF-038 acceptance: coverage)', () => {
  it('enumerates exactly the five critical failure modes, one record each', () => {
    expect(OFFICE_FAILURE_MODE_CATALOG.map((record) => record.kind)).toEqual([
      ...FAILURE_MODE_KINDS,
    ]);
    expect(new Set(OFFICE_FAILURE_MODE_CATALOG.map((record) => record.failureModeId)).size).toBe(
      FAILURE_MODE_KINDS.length,
    );
  });

  it('documents an operator action, an escalation policy, and a detection rule per mode', () => {
    for (const record of OFFICE_FAILURE_MODE_CATALOG) {
      expect(record.operatorAction.trim().length, `${record.failureModeId} operatorAction`).toBeGreaterThan(
        40,
      );
      expect(record.escalation.trim().length, `${record.failureModeId} escalation`).toBeGreaterThan(40);
      expect(record.detectionRuleId).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
      expect(record.description.length).toBeGreaterThan(20);
      expect(['warning', 'critical']).toContain(record.severity);
    }
  });

  it('names each record after its failure mode (stable operator vocabulary)', () => {
    for (const record of OFFICE_FAILURE_MODE_CATALOG) {
      expect(record.failureModeId).toBe(record.kind);
    }
  });
});

describe('the failure-mode vocabularies (fail-closed)', () => {
  it('parses every valid kind and rejects unknown kinds', () => {
    for (const kind of FAILURE_MODE_KINDS) {
      expect(parseFailureModeKind(kind)).toEqual({ ok: true, value: kind });
      expect(isFailureModeKind(kind)).toBe(true);
    }
    for (const bad of ['provider-down', 'database', '', null, 1, undefined]) {
      expect(parseFailureModeKind(bad).ok).toBe(false);
      expect(isFailureModeKind(bad)).toBe(false);
    }
  });

  it('parses kebab-case ids and rejects malformed ones', () => {
    expect(parseFailureModeId('database-unavailability')).toEqual({
      ok: true,
      value: 'database-unavailability',
    });
    expect(isFailureModeId('x')).toBe(false);
    for (const bad of ['Database', 'has_underscore', '-leading', 'trailing-', '', null, 3]) {
      expect(parseFailureModeId(bad).ok).toBe(false);
      expect(isFailureModeId(bad)).toBe(false);
    }
  });

  it('parses a well-formed catalog record with strict keys', () => {
    const parsed = parseFailureModeRecord(CATALOG_RECORD);
    if (!parsed.ok) throw new Error(`the canonical record must parse: ${JSON.stringify(parsed)}`);
    expect(parsed.value).toEqual(CATALOG_RECORD);
    expect(isFailureModeRecord(CATALOG_RECORD)).toBe(true);
  });

  it('rejects malformed records fail-closed (type, unknown field, missing field, bad value)', () => {
    expect(parseFailureModeRecord(null).ok).toBe(false);
    expect(parseFailureModeRecord('database-unavailability').ok).toBe(false);
    expect(parseFailureModeRecord([CATALOG_RECORD]).ok).toBe(false);

    const withUnknownField: Record<string, unknown> = { ...CATALOG_RECORD, runbook: 'extra' };
    expect(parseFailureModeRecord(withUnknownField).ok).toBe(false);

    const missingAction = { ...CATALOG_RECORD } as Record<string, unknown>;
    delete missingAction['operatorAction'];
    expect(parseFailureModeRecord(missingAction).ok).toBe(false);

    const badKind: Record<string, unknown> = { ...CATALOG_RECORD, kind: 'provider-down' };
    expect(parseFailureModeRecord(badKind).ok).toBe(false);

    const badSeverity: Record<string, unknown> = { ...CATALOG_RECORD, severity: 'severe' };
    expect(parseFailureModeRecord(badSeverity).ok).toBe(false);

    const emptyAction: Record<string, unknown> = { ...CATALOG_RECORD, operatorAction: '   ' };
    expect(parseFailureModeRecord(emptyAction).ok).toBe(false);

    expect(isFailureModeRecord(withUnknownField)).toBe(false);
  });

  it('builds trusted records and throws loud TypeErrors on invalid parts', () => {
    expect(defineFailureMode(CATALOG_RECORD)).toEqual(CATALOG_RECORD);
    // Double-cast on purpose: simulate malformed RUNTIME data dressed as the
    // trusted type — the builder must still throw, not accept it.
    const badKind = { ...CATALOG_RECORD, kind: 'nope' } as unknown as FailureModeRecord;
    expect(() => defineFailureMode(badKind)).toThrow(TypeError);
    const badSeverity = { ...CATALOG_RECORD, severity: 'urgent' } as unknown as FailureModeRecord;
    expect(() => defineFailureMode(badSeverity)).toThrow(TypeError);
  });
});
