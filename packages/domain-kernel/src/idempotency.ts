// Office domain kernel — idempotency primitives (OFF-003).
//
// Key-registry semantics for command deduplication (freeze A8 / ADR-005:
// every command carries an idempotency key; replays must not duplicate
// effects):
//
// - dedupe key is the pair (scope, idempotency key);
// - same key + same command fingerprint → the recorded outcome is replayed
//   (harmless: no second execution, no duplicated effects);
// - same key + different command fingerprint → typed idempotency-conflict;
//   a key never silently switches commands.
//
// The command fingerprint is the canonical identity of the command:
// commandName, schemaVersion, scope, actor, and payload, serialized as
// canonical JSON (object keys sorted recursively, arrays in order). Retry
// metadata — issuedAt, causality, and the idempotency key itself — is
// deliberately excluded, so an honest client retry (fresh timestamp, same
// logical command) fingerprints identically.
//
// This module ships an in-memory registry suitable for unit tests and the
// deterministic kernel acceptance suite. Persistence-backed dedupe (same
// semantics, transactional with the mutation) belongs to OFF-004/OFF-005;
// the IdempotencyRegistry interface is the contract they implement.
//
// Execution policy of withIdempotency: only successful outcomes are
// recorded. A failed execution is not recorded, so the same key can retry —
// transient failures (e.g. concurrency-conflict after a version refresh)
// remain retryable, and permanent failures deterministically fail again.
import type { CommandEnvelope, IdempotencyKey, Scope } from '@office/contracts';
import { fail, ok } from './result';
import type { Result } from './result';
import { idempotencyConflict } from './errors';
import type { DomainError, DomainErrorContext } from './errors';

declare const commandFingerprintBrand: unique symbol;

/** Deterministic canonical identity of a command (branded canonical JSON). */
export type CommandFingerprint = string & {
  readonly [commandFingerprintBrand]: 'CommandFingerprint';
};

/**
 * Canonical JSON: object keys sorted recursively, arrays in order, JSON
 * scalars verbatim. Matches JSON.stringify semantics for `undefined`
 * (omitted in objects, null inside arrays) and throws TypeError for values
 * JSON cannot represent — a loud programming error, never a silent
 * fingerprint collision.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot serialize non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? 'null' : canonicalJson(item)))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot serialize ${typeof value}`);
};

/**
 * Fingerprint an already-validated command envelope: its logical identity
 * (commandName, schemaVersion, scope, actor, payload) as canonical JSON.
 * Deterministic: structurally equal commands fingerprint identically
 * regardless of key order; issuedAt, causality, and the idempotency key are
 * excluded (retry metadata, not command identity).
 */
export function commandFingerprint(command: CommandEnvelope<unknown>): CommandFingerprint {
  return canonicalJson({
    commandName: command.commandName,
    schemaVersion: command.schemaVersion,
    scope: command.scope,
    actor: command.actor,
    payload: command.payload,
  }) as CommandFingerprint;
}

/** Result of a registry lookup: first execution, or a recorded replay. */
export type IdempotencyLookup =
  | { readonly status: 'unregistered' }
  | { readonly status: 'replay'; readonly outcome: unknown };

/**
 * Key-registry contract for idempotent command deduplication, keyed by
 * (scope, idempotency key). The in-memory implementation below satisfies
 * it; OFF-004/OFF-005 implement it transactionally against persistence.
 */
export interface IdempotencyRegistry {
  /**
   * Look up a (scope, key) registration. Unregistered → execute and record.
   * Registered with the same fingerprint → replay the recorded outcome.
   * Registered with a different fingerprint → typed idempotency-conflict.
   */
  lookup(
    scope: Scope,
    idempotencyKey: IdempotencyKey,
    fingerprint: CommandFingerprint,
    context?: DomainErrorContext,
  ): Result<IdempotencyLookup, DomainError>;

  /**
   * Record the outcome of an execution under (scope, key). Recording over
   * an entry with the SAME fingerprint replaces the outcome (idempotent);
   * recording over a DIFFERENT fingerprint is a typed idempotency-conflict —
   * a key never silently switches commands.
   */
  record(
    scope: Scope,
    idempotencyKey: IdempotencyKey,
    fingerprint: CommandFingerprint,
    outcome: unknown,
    context?: DomainErrorContext,
  ): Result<true, DomainError>;
}

/** Create an in-memory IdempotencyRegistry (unit tests, deterministic suites). */
export function createInMemoryIdempotencyRegistry(): IdempotencyRegistry {
  const entries = new Map<string, { fingerprint: CommandFingerprint; outcome: unknown }>();
  const compositeKey = (scope: Scope, idempotencyKey: IdempotencyKey): string =>
    `${canonicalJson(scope)}\u0000${idempotencyKey}`;
  return {
    lookup(scope, idempotencyKey, fingerprint, context) {
      const existing = entries.get(compositeKey(scope, idempotencyKey));
      if (existing === undefined) {
        return ok({ status: 'unregistered' } satisfies IdempotencyLookup);
      }
      if (existing.fingerprint !== fingerprint) {
        return fail(
          idempotencyConflict(
            { idempotencyKey },
            context ?? { scope },
          ),
        );
      }
      return ok({ status: 'replay', outcome: existing.outcome } satisfies IdempotencyLookup);
    },
    record(scope, idempotencyKey, fingerprint, outcome, context) {
      const key = compositeKey(scope, idempotencyKey);
      const existing = entries.get(key);
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return fail(
          idempotencyConflict(
            { idempotencyKey },
            context ?? { scope },
          ),
        );
      }
      entries.set(key, { fingerprint, outcome });
      return ok(true);
    },
  };
}

/** Outcome of an idempotently executed command. */
export interface IdempotentExecution<T> {
  /** True when the recorded outcome of a prior execution was replayed. */
  readonly replayed: boolean;
  readonly value: T;
}

/**
 * Execute a command idempotently against a registry: look up
 * (scope, idempotency key) before executing; replay the recorded outcome on
 * a same-fingerprint hit; record only successful executions. Fingerprint
 * mismatches surface as typed idempotency-conflict DomainErrors.
 *
 * The executor receives no arguments — it closes over the already-validated
 * command — and may be sync or async; the returned Result is awaited. Pure
 * composition: no clock, no randomness, no I/O of its own.
 */
export async function withIdempotency<T>(
  registry: IdempotencyRegistry,
  command: CommandEnvelope<unknown>,
  execute: () => Result<T, DomainError> | Promise<Result<T, DomainError>>,
): Promise<Result<IdempotentExecution<T>, DomainError>> {
  const fingerprint = commandFingerprint(command);
  const context: DomainErrorContext = {
    scope: command.scope,
    correlationId: command.causality.correlationId,
  };
  const lookedUp = registry.lookup(
    command.scope,
    command.idempotencyKey,
    fingerprint,
    context,
  );
  if (!lookedUp.ok) return lookedUp;
  const entry = lookedUp.value;
  if (entry.status === 'replay') {
    return ok({ replayed: true, value: entry.outcome as T });
  }
  const executed = await execute();
  if (!executed.ok) return executed;
  const recorded = registry.record(
    command.scope,
    command.idempotencyKey,
    fingerprint,
    executed.value,
    context,
  );
  if (!recorded.ok) return recorded;
  return ok({ replayed: false, value: executed.value });
}
