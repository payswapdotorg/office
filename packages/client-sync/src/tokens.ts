// Office client-sync — causal/version tokens & the divergence check
// (OFF-029, freeze A9/A12).
//
// THE CAUSAL/VERSION TOKEN: every queued mutation carries the project-slice
// position the client had CONSUMED when it composed it (QueueEntry's
// `basePosition`). The token is the mutation's view of the world — the
// server's divergence check compares the BASE VERSION of the addressed
// target (how many slice events addressed it at positions <= the token)
// against the ACTUAL version (at the current head): a moved target means
// the world the mutation was composed against is gone, and the mutation
// must be surfaced as an explicit conflict — never silently applied over
// diverged state, and never silently discarded.
//
// The check is pure and deterministic over the slice's canonical order:
// the same slice and the same token always yield the same assessment,
// regardless of read timing. Events the client's OWN causal chain produced
// (its own earlier captures, replayed or submitted) are part of the
// client's knowledge, not divergence: the queue's local causal chain
// (queue.ts) orders them, and the replay applies them in that order.
import type { EntityRef } from '@office/contracts';
import type { LedgerEvent } from '@office/events';
import type { SliceEntry, SlicePosition } from '@office/sync';

/**
 * The causal/version token: the project-slice position the client had
 * consumed when it composed the mutation (QueueEntry.basePosition). An
 * alias of @office/sync's SlicePosition — the token IS a slice position,
 * named for its role in the offline protocol.
 */
export type CausalToken = SlicePosition;

/**
 * Does this ledger event address (mutate) the target entity? The event's
 * aggregate is the canonical "which entity moved" signal — the same
 * convention the ledger-backed sinks derive their append aggregates from.
 */
export function addressesTarget(event: LedgerEvent, target: EntityRef): boolean {
  return (
    event.aggregate.entityKind === target.entityKind &&
    event.aggregate.entityId === target.entityId
  );
}

/** The typed divergence assessment of one queued mutation's causal token. */
export interface DivergenceAssessment {
  /** 'clean' when the target has not moved past the token; else 'diverged'. */
  readonly status: 'clean' | 'diverged';
  /** The assessed target entity. */
  readonly target: EntityRef;
  /** The mutation's causal token (its last-seen slice position). */
  readonly basePosition: SlicePosition;
  /** BASE VERSION: slice events addressing the target at positions <= the token. */
  readonly baseVersion: number;
  /** ACTUAL VERSION: slice events addressing the target at positions <= head. */
  readonly actualVersion: number;
  /**
   * The first event addressing the target strictly AFTER the token that the
   * client's own causal chain did NOT produce — the divergence's cause —
   * exactly when status === 'diverged' (else null).
   */
  readonly divergingEvent: LedgerEvent | null;
}

/**
 * THE server-side divergence check (pure, deterministic): assess one
 * mutation's causal token against the project slice. `entries` is the full
 * ordered slice (the deterministic (occurredAt, eventId) order); the
 * `ownEventIds` set carries the ledger event ids the CLIENT's own causal
 * chain produced (its online submissions and its own earlier replayed
 * captures) — those are knowledge, not divergence.
 */
export function assessTargetDivergence(input: {
  readonly entries: readonly SliceEntry[];
  readonly target: EntityRef;
  readonly basePosition: SlicePosition;
  readonly ownEventIds: ReadonlySet<string>;
}): DivergenceAssessment {
  let baseVersion = 0;
  let actualVersion = 0;
  let divergingEvent: LedgerEvent | null = null;
  for (const entry of input.entries) {
    if (!addressesTarget(entry.event, input.target)) continue;
    actualVersion += 1;
    if (entry.position <= input.basePosition) {
      baseVersion += 1;
      continue;
    }
    if (divergingEvent === null && !input.ownEventIds.has(entry.event.eventId)) {
      divergingEvent = entry.event;
    }
  }
  return {
    status: divergingEvent === null ? 'clean' : 'diverged',
    target: input.target,
    basePosition: input.basePosition,
    baseVersion,
    actualVersion,
    divergingEvent,
  };
}
