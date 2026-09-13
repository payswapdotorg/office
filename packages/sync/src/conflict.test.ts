import { describe, expect, it } from 'vitest';
import {
  detectConflict,
  isConflictRecord,
  parseConflictRecord,
  parseConflictResolution,
  resolveConflict,
} from './conflict';
import type { ConflictRecord, ConflictResolution } from './conflict';
import { clientOperation, operationDigestOf } from './operations';
import type { ClientOperation } from './operations';
import { conflictRecordIdOf, operationIdOf, subscriptionIdOf } from './identity';
import {
  ACTOR_A,
  ACTOR_ADMIN,
  CLIENT_A,
  NOW_1,
  NOW_2,
  NOW_3,
  NOW_4,
  PROJECT_1,
  SCOPE_1,
  SCOPE_2,
  TENANT_A,
  entityIdOf,
  entityKindOf,
  operationKindOf,
  unwrap,
} from './test-support';

// OFF-028 — explicit conflict records: when two clients' concurrent
// operations on the same target produce incompatible states, the conflict
// is recorded EXPLICITLY — both sides, deterministic side ordering (and so a
// deterministic conflict id) — and stays 'detected' until an EXPLICIT
// resolution citing audit ledger events. No destructive automatic
// resolution anywhere; material conflicts surface for explicit resolution.

const PROGRESS = entityKindOf('progress-update');

const operationFor = (
  subscriberOpaque: string,
  payload: Record<string, unknown>,
  parts?: { readonly position?: number; readonly target?: string },
): ClientOperation => {
  const subscriberId = entityIdOf(subscriberOpaque);
  const subscriptionId = subscriptionIdOf({
    tenantId: TENANT_A,
    projectId: PROJECT_1,
    subscriberId,
    ordinal: 1,
  });
  return clientOperation({
    operationId: operationIdOf({
      subscriptionId,
      position: parts?.position ?? 2,
      operationKind: 'record-progress',
    }),
    subscriptionId,
    position: position(parts?.position ?? 2),
    operationKind: operationKindOf('record-progress'),
    actor: { kind: 'user', actorId: subscriberId },
    scope: SCOPE_1,
    target: {
      entityKind: PROGRESS,
      entityId: parts?.target !== undefined ? entityIdOf(parts.target) : CLIENT_A,
    },
    payloadDigest: operationDigestOf(payload),
  });
};

const LEFT = () => operationFor('a1b2c3d4e5f60718293a4b5c6d7e8f9', { percent: 40 });
const RIGHT = () => operationFor('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 60 });

/** Trusted test cast: a fixed slice position (constants are hand-verified). */
const position = (n: number) => n as never;

const resolution = (): ConflictResolution =>
  unwrap(
    parseConflictResolution({
      kind: 'conflict-resolution',
      strategy: 'merge',
      resolvedBy: ACTOR_ADMIN,
      resolvedAt: NOW_4,
      auditEventRefs: ['office-evt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'],
    }),
  );

describe('conflict detection (explicit, deterministic)', () => {
  it('records BOTH sides in deterministic operation-id order', () => {
    const record = unwrap(
      detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }),
    );
    expect(record.state).toBe('detected');
    expect(record.resolution).toBeNull();
    expect(record.tenantId).toBe(TENANT_A);
    expect(record.projectId).toBe(PROJECT_1);
    expect(record.target).toEqual({ entityKind: PROGRESS, entityId: CLIENT_A });
    const [firstId, secondId] = [LEFT().operationId, RIGHT().operationId].sort();
    expect(record.first.operationId).toBe(firstId);
    expect(record.second.operationId).toBe(secondId);
    // The record's sides carry the FULL operations (both clients' proposals).
    expect(new Set([record.first.operationId, record.second.operationId])).toEqual(
      new Set([LEFT().operationId, RIGHT().operationId]),
    );
  });

  it('is deterministic run-twice and input-order independent', () => {
    const one = unwrap(detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }));
    const two = unwrap(detectConflict({ operations: [RIGHT(), LEFT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }));
    const three = unwrap(detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }));
    expect(one).toEqual(two);
    expect(two).toEqual(three);
    expect(one.conflictId).toBe(
      conflictRecordIdOf({
        tenantId: TENANT_A,
        projectId: PROJECT_1,
        targetKind: PROGRESS,
        targetId: CLIENT_A,
        firstOperationId: one.first.operationId,
        secondOperationId: one.second.operationId,
      }),
    );
  });

  it('rejects non-concurrent or non-divergent pairs typed (invariant-violation)', () => {
    const cases: readonly [string, readonly ClientOperation[]][] = [
      ['different targets', [LEFT(), operationFor('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 60 }, { target: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' })]],
      ['different observed positions', [LEFT(), operationFor('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 60 }, { position: 3 })]],
      ['identical payloads (duplicates, not conflicts)', [LEFT(), operationFor('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 40 })]],
      ['wrong arity (one)', [LEFT()]],
      ['wrong arity (three)', [LEFT(), RIGHT(), operationFor('c3d4e5f60718293a4b5c6d7e8f9a1b2', { percent: 80 })]],
    ];
    for (const [label, operations] of cases) {
      const failed = detectConflict({ operations, detectedAt: NOW_3, detectedBy: ACTOR_ADMIN });
      expect(failed.ok, label).toBe(false);
      if (!failed.ok) {
        expect(failed.error.code).toBe('invariant-violation');
      }
    }
    const crossScope = detectConflict({
      operations: [LEFT(), { ...operationFor('b2c3d4e5f60718293a4b5c6d7e8f9a1', { percent: 60 }), scope: SCOPE_2 }],
      detectedAt: NOW_3,
      detectedBy: ACTOR_ADMIN,
    });
    expect(crossScope.ok).toBe(false);
    if (!crossScope.ok) {
      expect(crossScope.error.details[0]?.code).toBe('conflict-scope-mismatch');
    }
  });

  it('parses records fail-closed (strict keys + lifecycle consistency)', () => {
    const record = unwrap(
      detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }),
    );
    expect(unwrap(parseConflictRecord(record))).toEqual(record);
    expect(isConflictRecord(record)).toBe(true);
    const raw = record as unknown as Record<string, unknown>;
    expect(parseConflictRecord({ ...raw, extra: 1 }).ok).toBe(false);
    expect(parseConflictRecord({ ...raw, state: 'resolved', resolution: null }).ok).toBe(false);
    expect(parseConflictRecord({ ...raw, state: 'detected', resolution: resolution() }).ok).toBe(false);
    expect(parseConflictRecord({ ...raw, second: raw['first'] }).ok).toBe(false);
    expect(parseConflictRecord('conflict').ok).toBe(false);
  });
});

describe('conflict resolution (explicit only, audit-trailed, idempotent)', () => {
  const detected = (): ConflictRecord =>
    unwrap(detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_3, detectedBy: ACTOR_ADMIN }));

  it('rejects resolutions without an audit trail fail-closed', () => {
    expect(
      parseConflictResolution({
        kind: 'conflict-resolution',
        strategy: 'merge',
        resolvedBy: ACTOR_ADMIN,
        resolvedAt: NOW_4,
        auditEventRefs: [],
      }).ok,
    ).toBe(false);
    expect(
      parseConflictResolution({
        kind: 'conflict-resolution',
        strategy: 'last-write-wins',
        resolvedBy: ACTOR_ADMIN,
        resolvedAt: NOW_4,
        auditEventRefs: ['office-evt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'],
      }).ok,
    ).toBe(false);
    expect(
      parseConflictResolution({
        kind: 'conflict-resolution',
        strategy: 'merge',
        resolvedBy: ACTOR_ADMIN,
        resolvedAt: 'tomorrow',
        auditEventRefs: ['office-evt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'],
      }).ok,
    ).toBe(false);
  });

  it('resolves explicitly: detected → resolved with the cited audit evidence', () => {
    const resolved = unwrap(resolveConflict(detected(), resolution()));
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution).toEqual(resolution());
    expect(unwrap(parseConflictRecord(resolved))).toEqual(resolved);
  });

  it('re-resolving IDENTICALLY is an idempotent no-op; differently is typed-rejected', () => {
    const resolved = unwrap(resolveConflict(detected(), resolution()));
    expect(unwrap(resolveConflict(resolved, resolution()))).toEqual(resolved);
    const different: ConflictResolution = unwrap(
      parseConflictResolution({
        kind: 'conflict-resolution',
        strategy: 'second-operation-wins',
        resolvedBy: ACTOR_ADMIN,
        resolvedAt: NOW_4,
        auditEventRefs: ['office-evt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'],
      }),
    );
    const failed = resolveConflict(resolved, different);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(failed.error.details[0]?.code).toBe('conflict-already-resolved');
    }
  });

  it('leaves material conflicts surfaced until an explicit resolution (no auto-resolution)', () => {
    const record = detected();
    // Nothing in this package mutates the record: it stays detected.
    expect(record.state).toBe('detected');
    expect(record.resolution).toBeNull();
    expect(record.first.payloadDigest).not.toBe(record.second.payloadDigest);
    // Re-detection of the same pair is the same record (idempotent detection).
    expect(detectConflict({ operations: [RIGHT(), LEFT()], detectedAt: NOW_1, detectedBy: ACTOR_A })).toEqual(
      detectConflict({ operations: [LEFT(), RIGHT()], detectedAt: NOW_1, detectedBy: ACTOR_A }),
    );
    // A different pair is a NEW conflict (new id, new record).
    const otherPair = unwrap(
      detectConflict({
        operations: [LEFT(), operationFor('c3d4e5f60718293a4b5c6d7e8f9a1b2', { percent: 80 })],
        detectedAt: NOW_2,
        detectedBy: ACTOR_ADMIN,
      }),
    );
    expect(otherPair.conflictId).not.toBe(record.conflictId);
  });
});
