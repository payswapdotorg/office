// Office client-sync — the LocalQueue model (OFF-029, freeze A9).
//
// THE disconnected mutation queue: the client-side store of mutations
// composed while disconnected. Every capture is a domain COMMAND captured
// with:
//
// - a CLIENT-GENERATED deterministic operation id — sha256 over
//   client id + local sequence + command fingerprint (identity.ts) — which
//   is ALSO the command envelope's idempotency key, so the replay through
//   the typed command path is idempotent BY OPERATION ID (freeze A8);
// - a client-observed timestamp — the envelope's issuedAt (payload data,
//   never ordering authority, exactly like the landed field domain's
//   offline capture);
// - a CAUSAL/VERSION TOKEN — the slice position the client had last seen
//   when it composed the mutation (its base for the server-side divergence
//   check, tokens.ts);
// - a local causal chain — each capture's causation id is the previous
//   entry's operation id (null for the first), so the client's own offline
//   sequence is causally ordered per freeze A3.
//
// The queue is BOUNDED (freeze A9: "field clients keep a bounded local
// event queue"): capturing beyond the capacity is a typed rejection — the
// client must synchronize before capturing more.
//
// Entry lifecycle (terminal states only, typed transitions):
//
//   pending ──▶ applied      (replayed clean through the command path)
//        ──▶ conflicted    (protected divergence — parked for EXPLICIT
//                            resolution; the replay engine can never apply
//                            it: conflict.ts)
//        ──▶ superseded    (open-state divergence — deterministically
//                            superseded by the committed server side, with
//                            the explicit auto-resolved conflict record as
//                            the audit trail)
//
// Determinism: no clock, no randomness — every field is either derived
// deterministically or supplied explicitly by the caller.
import {
  CURRENT_SCHEMA_VERSION,
  parseActor,
  parseCommandEnvelope,
  parseCommandName,
  parseCorrelationId,
  parseEntityId,
  parseEntityRef,
  parseFail,
  parseOk,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  CommandEnvelope,
  CommandName,
  CorrelationId,
  EntityId,
  EntityRef,
  ParseResult,
  ProjectScope,
  Timestamp,
} from '@office/contracts';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import {
  clientOperation,
  operationDigestOf,
  parseOperationDigest,
  parseOperationId,
  parseOperationKind,
  parseProjectScope,
  parseSlicePosition,
  parseSubscriptionId,
} from '@office/sync';
import type {
  ClientOperation,
  ConflictRecordId,
  OperationDigest,
  OperationId,
  OperationKind,
  SlicePosition,
  SubscriptionId,
} from '@office/sync';
import { parseConflictRecordId } from '@office/sync';
import {
  offlineCommandFingerprint,
  offlineOperationIdOf,
  parseLocalSequence,
} from './identity';
import type { LocalSequence } from './identity';
import {
  describeValue,
  isPlainObject,
  requireFieldWith,
  requireLiteral,
  unknownKeyFailure,
} from './parse';

/**
 * The protection class of a captured mutation (freeze A9: conflict
 * resolution is DOMAIN-SPECIFIC and can never silently last-write-wins
 * material commercial state). 'protected' mutations — financial,
 * contractual, or schedule-critical state — REQUIRE explicit resolution on
 * divergence; 'open' mutations may be superseded deterministically by the
 * committed server side, with the explicit conflict record as the trail.
 */
export type ProtectionClass = 'protected' | 'open';

/** Grammar description used in parse failures. */
export const PROTECTION_CLASS_GRAMMAR = "'protected' | 'open' (domain-declared, freeze A9)";

/** Parse an untrusted value as a ProtectionClass (total, fail-closed). */
export function parseProtectionClass(raw: unknown): ParseResult<ProtectionClass> {
  if (raw !== 'protected' && raw !== 'open') {
    return parseFail('invalid-value', '', PROTECTION_CLASS_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw);
}

/** Type guard for structurally valid ProtectionClass values. */
export function isProtectionClass(raw: unknown): raw is ProtectionClass {
  return parseProtectionClass(raw).ok;
}

/** The terminal 'applied' state: the applied effect's ledger event id. */
export interface AppliedEntryState {
  readonly status: 'applied';
  /** The ledger event the replayed command appended (its ledger identity). */
  readonly eventId: LedgerEventId;
  /** True when the command path replayed a recorded outcome (idempotent). */
  readonly replayed: boolean;
}

/** The parked 'conflicted' state (protected divergence — explicit resolution required). */
export interface ConflictedEntryState {
  readonly status: 'conflicted';
  /** The surfaced conflict record awaiting EXPLICIT resolution. */
  readonly conflictId: ConflictRecordId;
}

/** The terminal 'superseded' state (open divergence — committed server side stands). */
export interface SupersededEntryState {
  readonly status: 'superseded';
  /** The auto-resolved conflict record proving the supersession. */
  readonly conflictId: ConflictRecordId;
}

/** One queue entry's lifecycle state (pending or terminal). */
export type QueueEntryState =
  | { readonly status: 'pending' }
  | AppliedEntryState
  | ConflictedEntryState
  | SupersededEntryState;

/** Shape description used in parse failures. */
export const QUEUE_ENTRY_STATE_GRAMMAR =
  "QueueEntryState: { status: 'pending' } | { status: 'applied', eventId, replayed } | { status: 'conflicted', conflictId } | { status: 'superseded', conflictId }";

const APPLIED_KEYS = ['status', 'eventId', 'replayed'] as const;
const CONFLICTED_KEYS = ['status', 'conflictId'] as const;
// 'conflicted' and 'superseded' share the same strict key shape (status +
// conflictId), so one key list serves both branches.

/** Parse an untrusted value as a QueueEntryState (total, fail-closed, strict keys). */
export function parseQueueEntryState(raw: unknown): ParseResult<QueueEntryState> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', QUEUE_ENTRY_STATE_GRAMMAR, describeValue(raw));
  }
  const status = raw['status'];
  if (status === 'pending') {
    const unknownKey = unknownKeyFailure(raw, ['status'], '', QUEUE_ENTRY_STATE_GRAMMAR);
    if (unknownKey) return unknownKey;
    return parseOk({ status: 'pending' } satisfies QueueEntryState);
  }
  if (status === 'applied') {
    const unknownKey = unknownKeyFailure(raw, APPLIED_KEYS, '', QUEUE_ENTRY_STATE_GRAMMAR);
    if (unknownKey) return unknownKey;
    const eventId = requireFieldWith(raw, 'eventId', '', parseLedgerEventId);
    if (!eventId.ok) return eventId;
    if (typeof raw['replayed'] !== 'boolean') {
      return parseFail(
        'invalid-value',
        'replayed',
        'a boolean (true when the command path replayed the recorded outcome)',
        describeValue(raw['replayed']),
      );
    }
    return parseOk(
      {
        status: 'applied',
        eventId: eventId.value,
        replayed: raw['replayed'],
      } satisfies QueueEntryState,
    );
  }
  if (status === 'conflicted' || status === 'superseded') {
    const unknownKey = unknownKeyFailure(raw, CONFLICTED_KEYS, '', QUEUE_ENTRY_STATE_GRAMMAR);
    if (unknownKey) return unknownKey;
    const conflictId = requireFieldWith(raw, 'conflictId', '', parseConflictRecordId);
    if (!conflictId.ok) return conflictId;
    return parseOk(
      status === 'conflicted'
        ? { status: 'conflicted', conflictId: conflictId.value }
        : { status: 'superseded', conflictId: conflictId.value },
    );
  }
  return parseFail(
    'invalid-value',
    'status',
    QUEUE_ENTRY_STATE_GRAMMAR,
    describeValue(status),
  );
}

/** Type guard for structurally valid QueueEntryState values. */
export function isQueueEntryState(raw: unknown): raw is QueueEntryState {
  return parseQueueEntryState(raw).ok;
}

/** One captured offline mutation: the durable queue entry. */
export interface QueueEntry {
  readonly kind: 'queue-entry';
  /** The capturing client's canonical identity. */
  readonly clientId: EntityId;
  /** The capture's dense 1-based local sequence (the drain order). */
  readonly localSequence: LocalSequence;
  /** The deterministic offline operation id (also the command's idempotency key). */
  readonly operationId: OperationId;
  /** The subscription the client was syncing under when it captured. */
  readonly subscriptionId: SubscriptionId;
  /** The CAUSAL/VERSION TOKEN: the slice position the client had last seen. */
  readonly basePosition: SlicePosition;
  /** The captured command (idempotencyKey = operationId; issuedAt = client-observed). */
  readonly command: CommandEnvelope<unknown>;
  /** The canonical entity the mutation addresses. */
  readonly target: EntityRef;
  /** The operation kind (domain-owned vocabulary, mirrored from @office/sync). */
  readonly operationKind: OperationKind;
  /** The canonical digest of the command payload. */
  readonly payloadDigest: OperationDigest;
  /** The domain-declared protection class (freeze A9). */
  readonly protection: ProtectionClass;
  /** The write capability the replay must be granted (A9/A12 on replay). */
  readonly requiredCapability: Capability;
  /** The lifecycle state (pending until the drain resolves it terminally). */
  readonly state: QueueEntryState;
}

/** Shape description used in parse failures. */
export const QUEUE_ENTRY_GRAMMAR =
  'QueueEntry: { kind, clientId, localSequence, operationId, subscriptionId, basePosition, command, target, operationKind, payloadDigest, protection, requiredCapability, state }';

const QUEUE_ENTRY_KEYS = [
  'kind',
  'clientId',
  'localSequence',
  'operationId',
  'subscriptionId',
  'basePosition',
  'command',
  'target',
  'operationKind',
  'payloadDigest',
  'protection',
  'requiredCapability',
  'state',
] as const;

/**
 * Parse an untrusted value as a QueueEntry (total, fail-closed, strict
 * keys). The command's scope must be a PROJECT scope (the slice protocol is
 * project-scoped — freeze A12), and the envelope's idempotency key must
 * equal the entry's deterministic operation id (the A8 offline rule: the
 * replay is idempotent by operation id).
 */
export function parseQueueEntry(raw: unknown): ParseResult<QueueEntry> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', QUEUE_ENTRY_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, QUEUE_ENTRY_KEYS, '', QUEUE_ENTRY_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['queue-entry']);
  if (!kind.ok) return kind;
  const clientId = requireFieldWith(raw, 'clientId', '', parseEntityId);
  if (!clientId.ok) return clientId;
  const localSequence = requireFieldWith(raw, 'localSequence', '', parseLocalSequence);
  if (!localSequence.ok) return localSequence;
  const operationId = requireFieldWith(raw, 'operationId', '', parseOperationId);
  if (!operationId.ok) return operationId;
  const subscriptionId = requireFieldWith(raw, 'subscriptionId', '', parseSubscriptionId);
  if (!subscriptionId.ok) return subscriptionId;
  const basePosition = requireFieldWith(raw, 'basePosition', '', parseSlicePosition);
  if (!basePosition.ok) return basePosition;
  const command = requireFieldWith(raw, 'command', '', parseCommandEnvelope);
  if (!command.ok) return command;
  if (command.value.scope.kind !== 'project') {
    return parseFail(
      'invalid-value',
      'command.scope',
      "a PROJECT scope (the slice protocol is project-scoped, freeze A12)",
      describeValue(command.value.scope),
    );
  }
  // The A8 offline idempotency rule: the envelope's idempotency key IS the
  // entry's deterministic operation id (two branded string types over one
  // runtime value — compared as the underlying strings).
  if (command.value.idempotencyKey !== (operationId.value as unknown as CommandEnvelope['idempotencyKey'])) {
    return parseFail(
      'invalid-value',
      'command.idempotencyKey',
      'the entry operation id (the offline idempotency rule: replays are idempotent by operation id, freeze A8)',
      describeValue(command.value.idempotencyKey),
    );
  }
  const target = requireFieldWith(raw, 'target', '', parseEntityRef);
  if (!target.ok) return target;
  const operationKind = requireFieldWith(raw, 'operationKind', '', parseOperationKind);
  if (!operationKind.ok) return operationKind;
  const payloadDigest = requireFieldWith(raw, 'payloadDigest', '', parseOperationDigest);
  if (!payloadDigest.ok) return payloadDigest;
  const protection = requireFieldWith(raw, 'protection', '', parseProtectionClass);
  if (!protection.ok) return protection;
  const requiredCapability = requireFieldWith(raw, 'requiredCapability', '', parseCapability);
  if (!requiredCapability.ok) return requiredCapability;
  const state = requireFieldWith(raw, 'state', '', parseQueueEntryState);
  if (!state.ok) return state;
  return parseOk(
    {
      kind: 'queue-entry',
      clientId: clientId.value,
      localSequence: localSequence.value,
      operationId: operationId.value,
      subscriptionId: subscriptionId.value,
      basePosition: basePosition.value,
      command: command.value,
      target: target.value,
      operationKind: operationKind.value,
      payloadDigest: payloadDigest.value,
      protection: protection.value,
      requiredCapability: requiredCapability.value,
      state: state.value,
    } satisfies QueueEntry,
  );
}

/** Type guard for structurally valid QueueEntry values. */
export function isQueueEntry(raw: unknown): raw is QueueEntry {
  return parseQueueEntry(raw).ok;
}

/**
 * Project the @office/sync ClientOperation of a queue entry — the entry's
 * protocol-facing view (deterministic operation id, subscription basis,
 * CAUSAL TOKEN as the observed position, payload digest). This projection
 * is what the operation registry deduplicates and what conflict detection
 * composes both sides from.
 */
export function clientOperationOf(entry: QueueEntry): ClientOperation {
  return clientOperation({
    operationId: entry.operationId,
    subscriptionId: entry.subscriptionId,
    position: entry.basePosition,
    operationKind: entry.operationKind,
    actor: entry.command.actor,
    scope: entry.command.scope as ProjectScope,
    target: entry.target,
    payloadDigest: entry.payloadDigest,
  });
}

/** One offline mutation capture (the caller-supplied parts). */
export interface OfflineMutation {
  /** The domain command name, e.g. 'work.recordProgress'. */
  readonly commandName: CommandName;
  /** The mutation's project scope (must match the syncing session's scope). */
  readonly scope: ProjectScope;
  /** The mutating actor (whose mutation this is). */
  readonly actor: Actor;
  /** The client's causal-chain correlation id (carried onto every effect). */
  readonly correlationId: CorrelationId;
  /** The CLIENT-OBSERVED capture instant (payload data, never ordering authority). */
  readonly issuedAt: Timestamp;
  /** The domain command payload (a plain JSON object). */
  readonly payload: Record<string, unknown>;
  /** The canonical entity the mutation addresses. */
  readonly target: EntityRef;
  /** The operation kind (domain-owned vocabulary). */
  readonly operationKind: OperationKind;
  /** The domain-declared protection class (freeze A9). */
  readonly protection: ProtectionClass;
  /** The write capability the replay must be granted. */
  readonly requiredCapability: Capability;
  /** The subscription the client is syncing under (the queue records it). */
  readonly subscriptionId: SubscriptionId;
  /** The CAUSAL/VERSION TOKEN: the client's last-seen slice position. */
  readonly basePosition: SlicePosition;
}

/**
 * THE disconnected mutation queue (freeze A9: bounded, deterministic
 * ordering, terminal lifecycle). In-memory implementation; the durable
 * client store implements the same interface (the protocol is the
 * discipline, not the storage).
 */
export interface LocalQueue {
  /** The owning client's canonical identity. */
  readonly clientId: EntityId;
  /** The queue capacity (freeze A9 bounded queue). */
  readonly capacity: number;
  /** Every entry in deterministic local-sequence order. */
  readonly entries: readonly QueueEntry[];
  /** The entries still pending replay, in local-sequence order. */
  readonly pending: readonly QueueEntry[];
  /** The number of captured entries (all states). */
  readonly size: number;
  /**
   * Capture one offline mutation: assigns the next local sequence, derives
   * the deterministic operation id, composes the command envelope
   * (idempotency key = operation id; causation id = the previous entry's
   * operation id), and stores the pending entry.
   */
  capture(mutation: OfflineMutation): Result<QueueEntry, DomainError>;
  /** The entry of an operation id, or null (lookup). */
  entryOf(operationId: OperationId): QueueEntry | null;
  /** Terminal transition: pending → applied (the replayed effect's event id). */
  markApplied(
    operationId: OperationId,
    outcome: { readonly eventId: LedgerEventId; readonly replayed: boolean },
  ): Result<QueueEntry, DomainError>;
  /** Terminal transition: pending → conflicted (parked for explicit resolution). */
  markConflicted(
    operationId: OperationId,
    conflictId: ConflictRecordId,
  ): Result<QueueEntry, DomainError>;
  /** Terminal transition: pending → superseded (open-state committed side stands). */
  markSuperseded(
    operationId: OperationId,
    conflictId: ConflictRecordId,
  ): Result<QueueEntry, DomainError>;
}

/** Default queue capacity (freeze A9 bounded queue). */
export const DEFAULT_QUEUE_CAPACITY = 1024;

const queueFullFailure = (queue: {
  readonly clientId: EntityId;
  readonly capacity: number;
  readonly size: number;
}): DomainError =>
  domainError(
    'invariant-violation',
    `the offline queue of client ${queue.clientId} is full (${queue.size}/${queue.capacity}) — synchronize before capturing more (freeze A9: the local queue is bounded)`,
    [
      {
        code: 'queue-full',
        message: `${queue.size} of ${queue.capacity}`,
        path: 'capacity',
      },
    ],
  );

const invalidCaptureFailure = (statement: string): DomainError =>
  domainError(
    'invariant-violation',
    `the offline capture is not structurally valid: ${statement}`,
    [{ code: 'capture-invalid', message: statement, path: null }],
  );

const transitionFailure = (
  operationId: OperationId,
  from: QueueEntryState['status'],
): DomainError =>
  domainError(
    'invariant-violation',
    `queue entry ${operationId} is already '${from}' — queue entry states are terminal`,
    [{ code: 'queue-entry-terminal', message: from, path: 'state' }],
  );

const entryNotFoundFailure = (operationId: OperationId): DomainError =>
  domainError(
    'not-found',
    `queue entry ${operationId} not found`,
    [{ code: 'queue-entry-not-found', message: operationId, path: 'operationId' }],
  );

/**
 * Create an empty bounded in-memory LocalQueue (deterministic, pure memory —
 * no clock, no randomness).
 */
export function createLocalQueue(parts: {
  readonly clientId: EntityId;
  readonly capacity?: number;
}): LocalQueue {
  const capacity = parts.capacity ?? DEFAULT_QUEUE_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`queue capacity must be a positive integer: ${String(capacity)}`);
  }
  const entries = new Map<string, QueueEntry>();

  const store = (entry: QueueEntry): void => {
    entries.set(entry.operationId, entry);
  };

  const transition = (
    operationId: OperationId,
    to: QueueEntryState,
  ): Result<QueueEntry, DomainError> => {
    const entry = entries.get(operationId);
    if (entry === undefined) {
      return fail(entryNotFoundFailure(operationId));
    }
    if (entry.state.status !== 'pending') {
      return fail(transitionFailure(operationId, entry.state.status));
    }
    const next: QueueEntry = { ...entry, state: to };
    const parsed = parseQueueEntry(next);
    if (!parsed.ok) {
      return fail(invalidCaptureFailure(`transitioned entry does not parse: ${parsed.error.code}`));
    }
    store(parsed.value);
    return ok(parsed.value);
  };

  return {
    clientId: parts.clientId,
    capacity,
    get entries(): readonly QueueEntry[] {
      return [...entries.values()].sort((left, right) => left.localSequence - right.localSequence);
    },
    get pending(): readonly QueueEntry[] {
      return this.entries.filter((entry) => entry.state.status === 'pending');
    },
    get size(): number {
      return entries.size;
    },
    capture: (mutation) => {
      const scope = parseProjectScope(mutation.scope);
      if (!scope.ok) {
        return fail(
          invalidCaptureFailure(`the mutation scope must be a project scope (freeze A12)`),
        );
      }
      const commandName = parseCommandName(mutation.commandName);
      if (!commandName.ok) {
        return fail(invalidCaptureFailure(`invalid command name: ${commandName.error.received}`));
      }
      const actor = parseActor(mutation.actor);
      if (!actor.ok) {
        return fail(invalidCaptureFailure('invalid actor'));
      }
      const correlationId = parseCorrelationId(mutation.correlationId);
      if (!correlationId.ok) {
        return fail(
          invalidCaptureFailure(
            `invalid correlation id: ${correlationId.error.received}`,
          ),
        );
      }
      const issuedAt = parseTimestamp(mutation.issuedAt);
      if (!issuedAt.ok) {
        return fail(invalidCaptureFailure('invalid client-observed timestamp'));
      }
      if (entries.size >= capacity) {
        return fail(queueFullFailure({ clientId: parts.clientId, capacity, size: entries.size }));
      }
      const localSequence = (entries.size + 1) as LocalSequence;
      const fingerprint = offlineCommandFingerprint({
        commandName: commandName.value,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        scope: scope.value,
        actor: actor.value,
        payload: mutation.payload,
      });
      const operationId = offlineOperationIdOf({
        clientId: parts.clientId,
        localSequence,
        fingerprint,
      });
      // The local causal chain: each capture is caused by the previous one.
      const previous = [...entries.values()].sort(
        (left, right) => left.localSequence - right.localSequence,
      )[entries.size - 1];
      const causationId = previous === undefined ? null : previous.operationId;
      const envelope = parseCommandEnvelope({
        kind: 'command',
        commandName: commandName.value,
        scope: scope.value,
        actor: actor.value,
        idempotencyKey: operationId,
        causality: { correlationId: correlationId.value, causationId },
        issuedAt: issuedAt.value,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        payload: mutation.payload,
      });
      if (!envelope.ok) {
        return fail(
          invalidCaptureFailure(`composed command envelope does not parse: ${envelope.error.code}`),
        );
      }
      const candidate: QueueEntry = {
        kind: 'queue-entry',
        clientId: parts.clientId,
        localSequence,
        operationId,
        subscriptionId: mutation.subscriptionId,
        basePosition: mutation.basePosition,
        command: envelope.value,
        target: mutation.target,
        operationKind: mutation.operationKind,
        payloadDigest: operationDigestOf(mutation.payload),
        protection: mutation.protection,
        requiredCapability: mutation.requiredCapability,
        state: { status: 'pending' },
      };
      const parsed = parseQueueEntry(candidate);
      if (!parsed.ok) {
        return fail(
          invalidCaptureFailure(`captured entry does not parse: ${parsed.error.code}`),
        );
      }
      store(parsed.value);
      return ok(parsed.value);
    },
    entryOf: (operationId) => entries.get(operationId) ?? null,
    markApplied: (operationId, outcome) =>
      transition(operationId, {
        status: 'applied',
        eventId: outcome.eventId,
        replayed: outcome.replayed,
      }),
    markConflicted: (operationId, conflictId) =>
      transition(operationId, { status: 'conflicted', conflictId }),
    markSuperseded: (operationId, conflictId) =>
      transition(operationId, { status: 'superseded', conflictId }),
  };
}
