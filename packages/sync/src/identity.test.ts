import { describe, expect, it } from 'vitest';
import {
  conflictRecordIdOf,
  isConflictRecordId,
  isOperationId,
  isSubscriptionGrantId,
  isSubscriptionId,
  operationIdOf,
  parseConflictRecordId,
  parseOperationId,
  parseSubscriptionGrantId,
  parseSubscriptionId,
  subscriptionGrantIdOf,
  subscriptionIdOf,
} from './identity';
import {
  CLIENT_A,
  CLIENT_B,
  PROJECT_1,
  TENANT_A,
  TENANT_B,
  entityKindOf,
  unwrap,
} from './test-support';

// OFF-028 — protocol identity vocabulary. Determinism is the point: every
// id is DERIVED from its logical key via sha256, so the same protocol inputs
// always reproduce the identical id — the replayability basis of the whole
// subscription protocol (same as the events ledger and the adapters-sdk
// conflict ids). Fixed tenants/projects/subscribers; no clock, no randomness.

const KEY = { tenantId: TENANT_A, projectId: PROJECT_1, subscriberId: CLIENT_A, ordinal: 1 };

describe('protocol identity grammars (OFF-028)', () => {
  it('parses a derived subscription id and rejects malformed values fail-closed', () => {
    const id = subscriptionIdOf(KEY);
    expect(id.startsWith('office-sub-v1-')).toBe(true);
    expect(unwrap(parseSubscriptionId(id))).toBe(id);
    expect(isSubscriptionId(id)).toBe(true);
    for (const bad of [
      'office-sub-v2-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'office-sub-v1-SHORT',
      'office-op-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      'office-sub-v1-UPPERCASE0a1b2c3d4e5f60718293a4b5',
      '',
      42,
      null,
    ]) {
      expect(parseSubscriptionId(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(isSubscriptionId(bad)).toBe(false);
    }
  });

  it('parses a derived grant id and rejects malformed values fail-closed', () => {
    const id = subscriptionGrantIdOf({ tenantId: TENANT_A, subscriberId: CLIENT_A, serial: 1 });
    expect(id.startsWith('office-grt-v1-')).toBe(true);
    expect(unwrap(parseSubscriptionGrantId(id))).toBe(id);
    expect(isSubscriptionGrantId(id)).toBe(true);
    expect(parseSubscriptionGrantId('office-grt-v1-short').ok).toBe(false);
    expect(parseSubscriptionGrantId(7).ok).toBe(false);
  });

  it('parses a derived operation id and rejects malformed values fail-closed', () => {
    const id = operationIdOf({
      subscriptionId: subscriptionIdOf(KEY),
      position: 3,
      operationKind: 'record-progress',
    });
    expect(id.startsWith('office-op-v1-')).toBe(true);
    expect(unwrap(parseOperationId(id))).toBe(id);
    expect(isOperationId(id)).toBe(true);
    expect(parseOperationId('office-op-v1-##').ok).toBe(false);
    expect(parseOperationId(undefined).ok).toBe(false);
  });

  it('parses a derived conflict-record id and rejects malformed values fail-closed', () => {
    const first = operationIdOf({ subscriptionId: subscriptionIdOf(KEY), position: 2, operationKind: 'record-progress' });
    const second = operationIdOf({
      subscriptionId: subscriptionIdOf({ ...KEY, subscriberId: CLIENT_B }),
      position: 2,
      operationKind: 'record-progress',
    });
    const id = conflictRecordIdOf({
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      targetKind: entityKindOf('progress-update'),
      targetId: CLIENT_A,
      firstOperationId: first,
      secondOperationId: second,
    });
    expect(id.startsWith('office-scf-v1-')).toBe(true);
    expect(unwrap(parseConflictRecordId(id))).toBe(id);
    expect(isConflictRecordId(id)).toBe(true);
    expect(parseConflictRecordId('office-scf-v1-!!!').ok).toBe(false);
    expect(parseConflictRecordId({}).ok).toBe(false);
  });
});

describe('deterministic id derivations (OFF-028)', () => {
  it('derives the same subscription id for the same key, different ids for different keys', () => {
    expect(subscriptionIdOf(KEY)).toBe(subscriptionIdOf(KEY));
    expect(subscriptionIdOf({ ...KEY, subscriberId: CLIENT_B })).not.toBe(subscriptionIdOf(KEY));
    expect(subscriptionIdOf({ ...KEY, ordinal: 2 })).not.toBe(subscriptionIdOf(KEY));
    expect(subscriptionIdOf({ ...KEY, tenantId: TENANT_B })).not.toBe(subscriptionIdOf(KEY));
    expect(subscriptionIdOf({ ...KEY, projectId: PROJECT_1 })).toBe(subscriptionIdOf(KEY));
  });

  it('rejects invalid subscription ordinals loudly (trusted path throws)', () => {
    expect(() => subscriptionIdOf({ ...KEY, ordinal: 0 })).toThrow(TypeError);
    expect(() => subscriptionIdOf({ ...KEY, ordinal: 1.5 })).toThrow(TypeError);
  });

  it('derives the same grant id for the same key and new ids per serial', () => {
    const key = { tenantId: TENANT_A, subscriberId: CLIENT_A, serial: 1 };
    expect(subscriptionGrantIdOf(key)).toBe(subscriptionGrantIdOf(key));
    expect(subscriptionGrantIdOf({ ...key, serial: 2 })).not.toBe(subscriptionGrantIdOf(key));
    expect(() => subscriptionGrantIdOf({ ...key, serial: 0 })).toThrow(TypeError);
  });

  it('derives operation ids from subscription + cursor + kind, deterministically', () => {
    const subscriptionId = subscriptionIdOf(KEY);
    const base = { subscriptionId, position: 4, operationKind: 'record-progress' };
    expect(operationIdOf(base)).toBe(operationIdOf(base));
    expect(operationIdOf({ ...base, position: 5 })).not.toBe(operationIdOf(base));
    expect(operationIdOf({ ...base, operationKind: 'resolve-conflict' })).not.toBe(operationIdOf(base));
    expect(operationIdOf({ ...base, subscriptionId: subscriptionIdOf({ ...KEY, ordinal: 2 }) })).not.toBe(
      operationIdOf(base),
    );
    expect(() => operationIdOf({ ...base, position: -1 })).toThrow(TypeError);
    expect(() => operationIdOf({ ...base, operationKind: '' })).toThrow(TypeError);
  });

  it('derives conflict ids from both sides, deterministically', () => {
    const first = operationIdOf({ subscriptionId: subscriptionIdOf(KEY), position: 2, operationKind: 'record-progress' });
    const second = operationIdOf({
      subscriptionId: subscriptionIdOf({ ...KEY, subscriberId: CLIENT_B }),
      position: 2,
      operationKind: 'record-progress',
    });
    const sides = {
      tenantId: TENANT_A,
      projectId: PROJECT_1,
      targetKind: entityKindOf('progress-update'),
      targetId: CLIENT_A,
      firstOperationId: first,
      secondOperationId: second,
    };
    expect(conflictRecordIdOf(sides)).toBe(conflictRecordIdOf(sides));
    expect(conflictRecordIdOf({ ...sides, secondOperationId: first })).not.toBe(conflictRecordIdOf(sides));
  });
});
