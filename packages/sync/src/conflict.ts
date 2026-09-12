// Office sync — explicit conflict records (OFF-028, freeze A9).
//
// A ConflictRecord is the explicit, auditable record created when two
// clients' CONCURRENT operations on the same target produce incompatible
// states — both composed against the SAME observed slice position (the
// concurrency basis) yet carrying different payloads. It carries BOTH sides
// (both ClientOperations, complete with their deterministic operation ids),
// in a DETERMINISTIC canonical side order (operation id ascending), so the
// same divergence always presents the same way and re-detection derives the
// same conflict id (sha256 over tenant|project|target|firstOp|secondOp).
//
// NO destructive automatic resolution (frozen anti-pattern: material
// commercial state is never silently last-write-wins'd): the record lands
// in the 'detected' state and STAYS there. Resolution is an explicit
// command — resolveConflict() — that must cite the ledger events proving
// the reconciliation (audit event refs, at least one). The three strategies
// are the closed vocabulary: merge, first-operation-wins,
// second-operation-wins — 'first'/'second' refer to the record's canonical
// side ORDER (deterministic), never to wall-clock arrival order. Resolving
// an already-resolved conflict identically is an idempotent no-op;
// resolving it differently is a typed invariant-violation.
import {
  parseActor,
  parseEntityRef,
  parseFail,
  parseOk,
  parseProjectId,
  parseTenantId,
  parseTimestamp,
} from '@office/contracts';
import type { Actor, EntityRef, ParseResult, ProjectId, TenantId, Timestamp } from '@office/contracts';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { conflictRecordIdOf, parseConflictRecordId } from './identity';
import type { ConflictRecordId } from './identity';
import { parseClientOperation } from './operations';
import type { ClientOperation } from './operations';
import {
  describeValue,
  isPlainObject,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  unknownKeyFailure,
} from './parse';

/** The closed resolution-strategy vocabulary (sides in canonical order). */
export type ConflictResolutionStrategy = 'merge' | 'first-operation-wins' | 'second-operation-wins';

/** Lifecycle state of a conflict record. */
export type ConflictRecordState = 'detected' | 'resolved';

/** The explicit resolution of a conflict: strategy, actor, time, and audit evidence. */
export interface ConflictResolution {
  readonly kind: 'conflict-resolution';
  /** How the divergence was reconciled (closed vocabulary). */
  readonly strategy: ConflictResolutionStrategy;
  /** The actor that explicitly resolved the conflict. */
  readonly resolvedBy: Actor;
  /** When the resolution was recorded (injected clock). */
  readonly resolvedAt: Timestamp;
  /**
   * Ledger events proving the reconciliation — at least one, no duplicates.
   * A resolution without an audit trail is typed-rejected, never accepted.
   */
  readonly auditEventRefs: readonly LedgerEventId[];
}

/** The explicit divergence record: both sides + resolution state. */
export interface ConflictRecord {
  readonly kind: 'sync-conflict';
  /** Deterministic identity (derived from both sides — see conflictRecordIdOf). */
  readonly conflictId: ConflictRecordId;
  /** Owning tenant (freeze A12). */
  readonly tenantId: TenantId;
  /** The project whose slice the conflicting operations were composed against. */
  readonly projectId: ProjectId;
  /** The contested canonical entity. */
  readonly target: EntityRef;
  /** The deterministically-FIRST side (operation id ascending). */
  readonly first: ClientOperation;
  /** The deterministically-SECOND side (operation id ascending). */
  readonly second: ClientOperation;
  /** When the divergence was detected (injected clock). */
  readonly detectedAt: Timestamp;
  /** The actor whose synchronization detected the divergence. */
  readonly detectedBy: Actor;
  /** Lifecycle state: conflicts land 'detected' and are resolved only explicitly. */
  readonly state: ConflictRecordState;
  /** The resolution, exactly when state === 'resolved' (else null). */
  readonly resolution: ConflictResolution | null;
}

/** Shape description used in parse failures. */
export const CONFLICT_RESOLUTION_GRAMMAR =
  "ConflictResolution: { kind: 'conflict-resolution', strategy: 'merge' | 'first-operation-wins' | 'second-operation-wins', resolvedBy, resolvedAt, auditEventRefs: LedgerEventId[] (>= 1, no duplicates) }";

/** Shape description used in parse failures. */
export const CONFLICT_RECORD_GRAMMAR =
  'ConflictRecord: { kind, conflictId, tenantId, projectId, target, first, second, detectedAt, detectedBy, state, resolution }';

const CONFLICT_RESOLUTION_KEYS = [
  'kind',
  'strategy',
  'resolvedBy',
  'resolvedAt',
  'auditEventRefs',
] as const;
const CONFLICT_RECORD_KEYS = [
  'kind',
  'conflictId',
  'tenantId',
  'projectId',
  'target',
  'first',
  'second',
  'detectedAt',
  'detectedBy',
  'state',
  'resolution',
] as const;

const conflictContext = (conflict: {
  readonly tenantId: TenantId;
}): DomainErrorContext => ({
  scope: { kind: 'tenant', tenantId: conflict.tenantId },
});

/** Parse an untrusted value as a ConflictResolution (total, fail-closed, strict keys). */
export function parseConflictResolution(raw: unknown): ParseResult<ConflictResolution> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONFLICT_RESOLUTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    CONFLICT_RESOLUTION_KEYS,
    '',
    CONFLICT_RESOLUTION_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['conflict-resolution']);
  if (!kind.ok) return kind;
  const strategy = requireLiteral(raw, 'strategy', '', [
    'merge',
    'first-operation-wins',
    'second-operation-wins',
  ]);
  if (!strategy.ok) return strategy;
  const resolvedBy = requireFieldWith(raw, 'resolvedBy', '', parseActor);
  if (!resolvedBy.ok) return resolvedBy;
  const resolvedAt = requireFieldWith(raw, 'resolvedAt', '', parseTimestamp);
  if (!resolvedAt.ok) return resolvedAt;
  const auditEventRefs = parseValueArray(
    raw['auditEventRefs'],
    'auditEventRefs',
    parseLedgerEventId,
    'array of ledger event ids proving the reconciliation (>= 1, no duplicates)',
  );
  if (!auditEventRefs.ok) return auditEventRefs;
  if (auditEventRefs.value.length < 1) {
    return parseFail(
      'invalid-value',
      'auditEventRefs',
      'at least one ledger event id (a resolution without an audit trail is rejected)',
      'empty array',
    );
  }
  return parseOk(
    {
      kind: 'conflict-resolution',
      strategy: strategy.value as ConflictResolutionStrategy,
      resolvedBy: resolvedBy.value,
      resolvedAt: resolvedAt.value,
      auditEventRefs: auditEventRefs.value,
    } satisfies ConflictResolution,
  );
}

/** Type guard for structurally valid ConflictResolution values. */
export function isConflictResolution(raw: unknown): raw is ConflictResolution {
  return parseConflictResolution(raw).ok;
}

/** Parse an untrusted value as a ConflictRecord (total, fail-closed, strict keys). */
export function parseConflictRecord(raw: unknown): ParseResult<ConflictRecord> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CONFLICT_RECORD_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CONFLICT_RECORD_KEYS, '', CONFLICT_RECORD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['sync-conflict']);
  if (!kind.ok) return kind;
  const conflictId = requireFieldWith(raw, 'conflictId', '', parseConflictRecordId);
  if (!conflictId.ok) return conflictId;
  const tenantId = requireFieldWith(raw, 'tenantId', '', parseTenantId);
  if (!tenantId.ok) return tenantId;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const target = requireFieldWith(raw, 'target', '', parseEntityRef);
  if (!target.ok) return target;
  const first = requireFieldWith(raw, 'first', '', parseClientOperation);
  if (!first.ok) return first;
  const second = requireFieldWith(raw, 'second', '', parseClientOperation);
  if (!second.ok) return second;
  const detectedAt = requireFieldWith(raw, 'detectedAt', '', parseTimestamp);
  if (!detectedAt.ok) return detectedAt;
  const detectedBy = requireFieldWith(raw, 'detectedBy', '', parseActor);
  if (!detectedBy.ok) return detectedBy;
  const state = requireLiteral(raw, 'state', '', ['detected', 'resolved']);
  if (!state.ok) return state;
  const resolution = requireNullableFieldWith(raw, 'resolution', '', parseConflictResolution);
  if (!resolution.ok) return resolution;
  const recordState = state.value as ConflictRecordState;
  if (recordState === 'resolved') {
    if (resolution.value === null) {
      return parseFail(
        'invalid-value',
        'resolution',
        'a resolved conflict carries its resolution',
        'null',
      );
    }
  } else if (resolution.value !== null) {
    return parseFail('invalid-value', 'resolution', "null unless state === 'resolved'", describeValue(resolution.value));
  }
  if (first.value.operationId === second.value.operationId) {
    return parseFail(
      'invalid-value',
      'second',
      'the two sides of a conflict are distinct operations',
      `both sides are operation ${first.value.operationId}`,
    );
  }
  return parseOk(
    {
      kind: 'sync-conflict',
      conflictId: conflictId.value,
      tenantId: tenantId.value,
      projectId: projectId.value,
      target: target.value,
      first: first.value,
      second: second.value,
      detectedAt: detectedAt.value,
      detectedBy: detectedBy.value,
      state: recordState,
      resolution: resolution.value,
    } satisfies ConflictRecord,
  );
}

/** Type guard for structurally valid ConflictRecord values. */
export function isConflictRecord(raw: unknown): raw is ConflictRecord {
  return parseConflictRecord(raw).ok;
}

/**
 * Detect the conflict record of two clients' concurrent operations.
 *
 * Concurrency basis (typed invariant-violation when violated): both
 * operations address the SAME target entity, in the SAME project scope, and
 * were composed against the SAME observed slice position — yet carry
 * different operation ids and different payload digests (incompatible
 * divergent state). Identical operations are duplicates (the operation
 * registry deduplicates those, operations.ts), not conflicts; different
 * positions are sequential causation, not concurrency.
 *
 * The record's sides are ordered DETERMINISTICALLY (operation id ascending)
 * — the deterministic presentation order the freeze's ordering rule
 * requires — and the conflict id is derived from both sides in that order,
 * so re-detecting the same pair yields the identical record.
 */
export function detectConflict(input: {
  readonly operations: readonly [ClientOperation, ClientOperation] | readonly ClientOperation[];
  readonly detectedAt: Timestamp;
  readonly detectedBy: Actor;
}): Result<ConflictRecord, DomainError> {
  if (input.operations.length !== 2) {
    return fail(
      domainError(
        'invariant-violation',
        'conflict detection requires exactly two operations',
        [{ code: 'conflict-two-operations', message: String(input.operations.length), path: 'operations' }],
      ),
    );
  }
  const [left, right] = input.operations;
  if (left === undefined || right === undefined) {
    return fail(
      domainError(
        'invariant-violation',
        'conflict detection requires exactly two operations',
        [{ code: 'conflict-two-operations', message: String(input.operations.length), path: 'operations' }],
      ),
    );
  }
  if (left.scope.tenantId !== right.scope.tenantId || left.scope.projectId !== right.scope.projectId) {
    return fail(
      domainError(
        'invariant-violation',
        'conflicting operations must share one project scope (freeze A12)',
        [
          {
            code: 'conflict-scope-mismatch',
            message: `${left.scope.tenantId}/${left.scope.projectId} vs ${right.scope.tenantId}/${right.scope.projectId}`,
            path: 'operations',
          },
        ],
      ),
    );
  }
  if (left.target.entityKind !== right.target.entityKind || left.target.entityId !== right.target.entityId) {
    return fail(
      domainError(
        'invariant-violation',
        'conflicting operations must address the same target entity',
        [
          {
            code: 'conflict-target-mismatch',
            message: `${left.target.entityKind} ${left.target.entityId} vs ${right.target.entityKind} ${right.target.entityId}`,
            path: 'operations',
          },
        ],
      ),
    );
  }
  if (left.position !== right.position) {
    return fail(
      domainError(
        'invariant-violation',
        `conflicting operations must share one observed slice position (concurrency basis): ${left.position} vs ${right.position}`,
        [{ code: 'conflict-position-mismatch', message: `${left.position} vs ${right.position}`, path: 'operations' }],
      ),
    );
  }
  if (left.operationId === right.operationId || left.payloadDigest === right.payloadDigest) {
    return fail(
      domainError(
        'invariant-violation',
        'conflict detection requires two DISTINCT, INCOMPATIBLE operations (identical operations are duplicates, not conflicts)',
        [{ code: 'conflict-operations-not-divergent', message: `${left.operationId} vs ${right.operationId}`, path: 'operations' }],
      ),
    );
  }
  // Deterministic canonical side order: operation id ascending.
  const first = left.operationId < right.operationId ? left : right;
  const second = left.operationId < right.operationId ? right : left;
  const record: ConflictRecord = {
    kind: 'sync-conflict',
    conflictId: conflictRecordIdOf({
      tenantId: first.scope.tenantId,
      projectId: first.scope.projectId,
      targetKind: first.target.entityKind,
      targetId: first.target.entityId,
      firstOperationId: first.operationId,
      secondOperationId: second.operationId,
    }),
    tenantId: first.scope.tenantId,
    projectId: first.scope.projectId,
    target: first.target,
    first,
    second,
    detectedAt: input.detectedAt,
    detectedBy: input.detectedBy,
    state: 'detected',
    resolution: null,
  };
  const parsed = parseConflictRecord(record);
  if (!parsed.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `detected conflict record is not structurally valid: ${parsed.error.code}`,
        [{ code: 'conflict-record-invalid', message: parsed.error.received, path: parsed.error.path }],
      ),
    );
  }
  return ok(parsed.value);
}

/** Structural equality of two actors (kind + id; parsed actors are fresh objects). */
const sameActor = (left: Actor, right: Actor): boolean => {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'system' || right.kind === 'system') {
    // Kinds are equal, so both are the system actor.
    return left.kind === 'system';
  }
  return left.actorId === right.actorId;
};

/** Structural equality of two resolutions (the idempotency basis). */
const sameResolution = (left: ConflictResolution, right: ConflictResolution): boolean =>
  left.strategy === right.strategy &&
  sameActor(left.resolvedBy, right.resolvedBy) &&
  left.resolvedAt === right.resolvedAt &&
  left.auditEventRefs.length === right.auditEventRefs.length &&
  left.auditEventRefs.every((ref, index) => ref === right.auditEventRefs[index]);

const alreadyResolved = (conflict: ConflictRecord): DomainError =>
  domainError(
    'invariant-violation',
    `conflict ${conflict.conflictId} is already resolved and cannot be re-resolved differently`,
    [{ code: 'conflict-already-resolved', message: conflict.conflictId, path: 'state' }],
    conflictContext(conflict),
  );

/**
 * Resolve a conflict EXPLICITLY (no destructive automatic resolution
 * anywhere in this package). The resolution must cite at least one ledger
 * event proving the reconciliation (typed rejection otherwise); resolving an
 * already-resolved conflict IDENTICALLY is an idempotent no-op, while a
 * different resolution is a typed invariant-violation.
 */
export function resolveConflict(
  conflict: ConflictRecord,
  resolution: ConflictResolution,
): Result<ConflictRecord, DomainError> {
  if (conflict.state === 'resolved') {
    const existing = conflict.resolution;
    if (existing !== null && sameResolution(existing, resolution)) {
      return ok(conflict); // idempotent replay of the identical resolution
    }
    return fail(alreadyResolved(conflict));
  }
  const resolved: ConflictRecord = { ...conflict, state: 'resolved', resolution };
  const parsed = parseConflictRecord(resolved);
  if (!parsed.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `resolved conflict record is not structurally valid: ${parsed.error.code}`,
        [{ code: 'conflict-resolution-invalid', message: parsed.error.received, path: parsed.error.path }],
        conflictContext(conflict),
      ),
    );
  }
  return ok(parsed.value);
}
