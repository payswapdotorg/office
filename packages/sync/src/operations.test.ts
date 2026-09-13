import { describe, expect, it } from 'vitest';
import {
  clientOperation,
  createInMemoryOperationRegistry,
  isClientOperation,
  isOperationDigest,
  isOperationKind,
  operationDigestOf,
  parseClientOperation,
  parseOperationDigest,
  parseOperationKind,
} from './operations';
import type { ClientOperation } from './operations';
import type { SlicePosition } from './slice';
import { operationIdOf, subscriptionIdOf } from './identity';
import {
  ACTOR_A,
  CLIENT_A,
  SCOPE_1,
  TENANT_A,
  entityKindOf,
  operationKindOf,
  unwrap,
} from './test-support';

// OFF-028 — deterministic client operations: the idempotency key of a
// client operation is composed from (subscription, cursor position,
// operation kind) via sha256, the payload is carried as its canonical
// digest, and duplicates are deduplicated TYPED-CLEANLY (same id + same
// digest = no-op; same id + different digest = idempotency-conflict).

const PROGRESS = entityKindOf('progress-update');

const subscriptionId = () =>
  subscriptionIdOf({ tenantId: TENANT_A, projectId: SCOPE_1.projectId, subscriberId: CLIENT_A, ordinal: 1 });

/** Trusted test cast: a fixed slice position (constants are hand-verified). */
const position = (n: number): SlicePosition => n as SlicePosition;

const makeOperation = (parts?: {
  readonly position?: number;
  readonly kind?: 'record-progress' | 'resolve-conflict';
  readonly payload?: Record<string, unknown>;
}): ClientOperation =>
  clientOperation({
    operationId: operationIdOf({
      subscriptionId: subscriptionId(),
      position: parts?.position ?? 2,
      operationKind: parts?.kind ?? 'record-progress',
    }),
    subscriptionId: subscriptionId(),
    position: position(parts?.position ?? 2),
    operationKind: operationKindOf(parts?.kind ?? 'record-progress'),
    actor: ACTOR_A,
    scope: SCOPE_1,
    target: { entityKind: PROGRESS, entityId: CLIENT_A },
    payloadDigest: operationDigestOf(parts?.payload ?? { percent: 40 }),
  });

describe('operation kinds & digests (fail-closed, deterministic)', () => {
  it('parses kebab-case operation kinds and rejects malformed ones', () => {
    expect(unwrap(parseOperationKind('record-progress'))).toBe('record-progress');
    expect(unwrap(parseOperationKind('a'))).toBe('a');
    expect(isOperationKind('resolve-conflict')).toBe(true);
    for (const bad of ['Record-Progress', 'record progress', '-record', 'record-', 'a'.repeat(65), 7, null]) {
      expect(parseOperationKind(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('digests payloads canonically: key order does not matter, content does', () => {
    expect(operationDigestOf({ percent: 40, note: 'a' })).toBe(operationDigestOf({ note: 'a', percent: 40 }));
    expect(operationDigestOf({ percent: 40 })).not.toBe(operationDigestOf({ percent: 60 }));
    expect(operationDigestOf({ nested: { b: 1, a: 2 } })).toBe(operationDigestOf({ nested: { a: 2, b: 1 } }));
    expect(operationDigestOf([1, 2, 3])).not.toBe(operationDigestOf([3, 2, 1]));
    expect(operationDigestOf(null)).toBe(operationDigestOf(null));
    expect(() => operationDigestOf({ bad: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('parses digests fail-closed (64 lowercase hex)', () => {
    const digest = operationDigestOf({ percent: 40 });
    expect(unwrap(parseOperationDigest(digest))).toBe(digest);
    expect(isOperationDigest(digest)).toBe(true);
    expect(parseOperationDigest(digest.slice(0, 63)).ok).toBe(false);
    expect(parseOperationDigest(digest.toUpperCase()).ok).toBe(false);
    expect(parseOperationDigest(42).ok).toBe(false);
  });
});

describe('the client operation contract (fail-closed)', () => {
  it('composes and round-trips an operation', () => {
    const operation = makeOperation();
    expect(unwrap(parseClientOperation(operation))).toEqual(operation);
    expect(isClientOperation(operation)).toBe(true);
  });

  it('derives the operation id from subscription + cursor + kind (deterministic)', () => {
    const base = makeOperation();
    expect(base.operationId).toBe(
      operationIdOf({ subscriptionId: subscriptionId(), position: 2, operationKind: 'record-progress' }),
    );
    const differentPosition = makeOperation({ position: 3 });
    expect(differentPosition.operationId).not.toBe(base.operationId);
    const differentKind = makeOperation({ kind: 'resolve-conflict' });
    expect(differentKind.operationId).not.toBe(base.operationId);
  });

  it('rejects malformed operations fail-closed', () => {
    const raw = makeOperation() as unknown as Record<string, unknown>;
    expect(parseClientOperation({ ...raw, operationKind: 'NotKebab' }).ok).toBe(false);
    expect(parseClientOperation({ ...raw, payloadDigest: 'deadbeef' }).ok).toBe(false);
    expect(parseClientOperation({ ...raw, position: -1 }).ok).toBe(false);
    expect(parseClientOperation({ ...raw, target: { entityKind: 'progress-update' } }).ok).toBe(false);
    expect(parseClientOperation({ ...raw, scope: { kind: 'tenant', tenantId: TENANT_A } }).ok).toBe(false);
    expect(parseClientOperation({ ...raw, extra: true }).ok).toBe(false);
    expect(parseClientOperation('operation').ok).toBe(false);
  });
});

describe('the operation registry (typed deduplication)', () => {
  it('records the first sighting and deduplicates identical retries typed-cleanly', async () => {
    const registry = createInMemoryOperationRegistry();
    const operation = makeOperation();
    expect(unwrap(await registry.register(operation))).toEqual({ status: 'recorded' });
    // An honest retry (same id, same payload digest) is a typed no-op.
    expect(unwrap(await registry.register(operation))).toEqual({ status: 'duplicate' });
    expect(unwrap(await registry.register({ ...operation, actor: ACTOR_A }))).toEqual({ status: 'duplicate' });
  });

  it('raises a typed idempotency-conflict when an id switches payloads', async () => {
    const registry = createInMemoryOperationRegistry();
    const operation = makeOperation();
    expect(unwrap(await registry.register(operation))).toEqual({ status: 'recorded' });
    const switched = makeOperation({ payload: { percent: 90 } });
    expect(switched.operationId).toBe(operation.operationId); // same id basis…
    expect(switched.payloadDigest).not.toBe(operation.payloadDigest); // …different payload
    const failed = await registry.register(switched);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('idempotency-conflict');
      expect(failed.error.details[0]?.code).toBe('operation-id-reuse');
      expect(failed.error.scope).toEqual({ kind: 'project', tenantId: TENANT_A, projectId: SCOPE_1.projectId });
    }
  });

  it('keys per operation id: different ids never collide', async () => {
    const registry = createInMemoryOperationRegistry();
    const first = makeOperation({ position: 2, payload: { percent: 40 } });
    const second = makeOperation({ position: 3, payload: { percent: 40 } });
    expect(first.operationId).not.toBe(second.operationId);
    expect(unwrap(await registry.register(first))).toEqual({ status: 'recorded' });
    expect(unwrap(await registry.register(second))).toEqual({ status: 'recorded' });
    // Re-registering the first after the second is still its own duplicate.
    expect(unwrap(await registry.register(first))).toEqual({ status: 'duplicate' });
  });
});
