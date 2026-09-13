import { describe, expect, it } from 'vitest';
import type { SliceEntry, SlicePosition } from '@office/sync';
import { addressesTarget, assessTargetDivergence } from './tokens';
import type { DivergenceAssessment } from './tokens';
import {
  ACTOR_A,
  ACTOR_B,
  SCOPE_1,
  TARGET_NOTE,
  TARGET_PROGRESS,
  eventEnvelope,
} from './test-support';
import type { EntityRef } from '@office/contracts';
import type { LedgerEvent } from '@office/events';

// OFF-029 — causal/version tokens and the server-side divergence check: the
// typed rule that decides clean-apply vs conflict for every queued mutation.
// The check is pure and deterministic over the slice's canonical order: the
// BASE VERSION of the addressed target (slice events addressing it at
// positions <= the token) vs the ACTUAL VERSION (at the head), with the
// client's OWN causal-chain events counted as knowledge, never divergence.

const foreignEvent = (position: number, target: EntityRef = TARGET_PROGRESS): LedgerEvent => ({
  eventId: `office-evt-v1-${String(position).padStart(32, '0')}` as LedgerEvent['eventId'],
  envelope: eventEnvelope({
    eventName: 'work.progressRecorded',
    scope: SCOPE_1,
    actor: ACTOR_B,
    occurredAt: `2026-09-15T08:${String(position).padStart(2, '0')}:00.000Z`,
    correlationId: 'corr-1a2b3c4d5e6f',
    payload: { percent: 40 + position },
    entityRef: target,
  }),
  sequence: position as LedgerEvent['sequence'],
  aggregate: target,
});

const entry = (position: number, target: EntityRef = TARGET_PROGRESS): SliceEntry => ({
  event: foreignEvent(position, target),
  position: position as SliceEntry['position'],
});

/** Trusted test cast: a hand-verified causal-token (slice position) constant. */
const token = (n: number): SlicePosition => n as SlicePosition;

describe('addressesTarget', () => {
  it('matches the event aggregate against the canonical target', () => {
    expect(addressesTarget(foreignEvent(1), TARGET_PROGRESS)).toBe(true);
    expect(addressesTarget(foreignEvent(1), TARGET_NOTE)).toBe(false);
    expect(addressesTarget(foreignEvent(1, TARGET_NOTE), TARGET_NOTE)).toBe(true);
  });
});

describe('assessTargetDivergence (base version vs actual)', () => {
  it('assesses CLEAN on an empty slice and counts versions correctly', () => {
    const assessment = assessTargetDivergence({
      entries: [],
      target: TARGET_PROGRESS,
      basePosition: token(0),
      ownEventIds: new Set(),
    });
    expect(assessment.status).toBe('clean');
    expect(assessment.baseVersion).toBe(0);
    expect(assessment.actualVersion).toBe(0);
    expect(assessment.divergingEvent).toBeNull();
  });

  it('assesses CLEAN when the target has not moved past the token (base === actual)', () => {
    const assessment = assessTargetDivergence({
      entries: [entry(1), entry(2), entry(3, TARGET_NOTE)],
      target: TARGET_PROGRESS,
      basePosition: token(2),
      ownEventIds: new Set(),
    });
    expect(assessment.status).toBe('clean');
    expect(assessment.baseVersion).toBe(2);
    expect(assessment.actualVersion).toBe(2);
    // A foreign event on ANOTHER target is not divergence for this one.
    expect(assessment.divergingEvent).toBeNull();
  });

  it('assesses DIVERGED when a foreign event moved the target past the token', () => {
    const diverging = entry(3);
    const assessment = assessTargetDivergence({
      entries: [entry(1), entry(2), diverging, entry(4)],
      target: TARGET_PROGRESS,
      basePosition: token(2),
      ownEventIds: new Set(),
    });
    expect(assessment.status).toBe('diverged');
    expect(assessment.baseVersion).toBe(2);
    expect(assessment.actualVersion).toBe(4);
    // The FIRST foreign event after the token is the divergence's cause.
    expect(assessment.divergingEvent?.eventId).toBe(diverging.event.eventId);
  });

  it('treats the client OWN causal-chain events past the token as knowledge, not divergence', () => {
    const ownThree = entry(3);
    const ownFour = entry(4);
    const assessment: DivergenceAssessment = assessTargetDivergence({
      entries: [entry(1), entry(2), ownThree, ownFour],
      target: TARGET_PROGRESS,
      basePosition: token(2),
      ownEventIds: new Set([ownThree.event.eventId, ownFour.event.eventId]),
    });
    expect(assessment.status).toBe('clean');
    // Actual version still counts every event addressing the target.
    expect(assessment.baseVersion).toBe(2);
    expect(assessment.actualVersion).toBe(4);
    expect(assessment.divergingEvent).toBeNull();

    // A MIXED window: own knowledge plus one foreign event — the foreign one
    // is still the divergence's cause (own events never mask it).
    const mixed = assessTargetDivergence({
      entries: [entry(1), entry(2), ownThree, entry(4)],
      target: TARGET_PROGRESS,
      basePosition: token(2),
      ownEventIds: new Set([ownThree.event.eventId]),
    });
    expect(mixed.status).toBe('diverged');
    expect(mixed.divergingEvent?.eventId).toBe(entry(4).event.eventId);
  });

  it('is deterministic: the same slice and token always yield the same assessment', () => {
    const entries = [entry(1), entry(2), entry(3), entry(4)];
    const first = assessTargetDivergence({
      entries,
      target: TARGET_PROGRESS,
      basePosition: token(1),
      ownEventIds: new Set([entry(3).event.eventId]),
    });
    const second = assessTargetDivergence({
      entries,
      target: TARGET_PROGRESS,
      basePosition: token(1),
      ownEventIds: new Set([entry(3).event.eventId]),
    });
    expect(second).toEqual(first);
    expect(first.status).toBe('diverged');
    expect(first.divergingEvent?.eventId).toBe(entry(2).event.eventId);
    expect(ACTOR_A.kind).toBe('user');
  });
});
