// Office domain kernel — transactional command interface (OFF-003).
//
// CommandHandler: the typed interface every domain module (OFF-007+) uses to
// execute commands transactionally. It receives an ALREADY-VALIDATED
// CommandEnvelope (boundary parsing of untrusted input happens upstream,
// against @office/contracts) plus a transaction-bound execution context, and
// returns a typed Result — domain failures are values, never exceptions.
//
// Interface only: the kernel defines the shape; the transaction itself, the
// event ledger, and the outbox are owned by OFF-004/OFF-005. The context's
// suppliers are injected by the executing runtime — the kernel itself never
// reads a wall clock or generates randomness (determinism rule).
import type { CommandEnvelope, EntityId, Timestamp } from '@office/contracts';
import type { DomainError } from './errors';
import type { Result } from './result';

/**
 * Transaction-bound execution context handed to a CommandHandler. The
 * transaction handle is opaque to the kernel: the executing runtime
 * (OFF-004) owns its type and lifecycle. Suppliers are injected — never
 * Date.now/Math.random inside kernel or handler logic.
 */
export interface CommandExecutionContext<Tx = unknown> {
  /** Opaque transaction handle the handler's persistence operations join. */
  readonly transaction: Tx;
  /** Injected clock supplier: the canonical 'now' for this execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id supplier: fresh Office-issued entity ids. */
  readonly newEntityId: () => EntityId;
}

/** The typed result of a command execution: value or typed DomainError. */
export type CommandResult<T> = Result<T, DomainError>;

/**
 * Executes one already-validated command inside a transaction boundary.
 * Handlers must: check scope coverage (A12 backstop), check optimistic
 * concurrency, check invariants on the NEXT state, and only then commit via
 * the transaction — returning typed failures for every expected rejection.
 */
export type CommandHandler<P = unknown, Tx = unknown, T = unknown> = (
  command: CommandEnvelope<P>,
  context: CommandExecutionContext<Tx>,
) => Promise<CommandResult<T>>;
