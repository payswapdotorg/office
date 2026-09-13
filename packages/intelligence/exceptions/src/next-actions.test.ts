import { beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '@office/contracts';
import {
  APPROVE_CHANGE_ORDER_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
  RECORD_PROGRESS_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  REVISE_BUDGET_COMMAND,
  SET_BASELINE_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
} from './model';
import type { Exception, NextAction } from './model';
import { suggestNextActions } from './next-actions';
import { runPortfolioScan } from './scenarios';
import type { PortfolioScanRun } from './scenarios';
import {
  ENTITLEMENT_ORDER_3,
  GAP_CHANGE_EVENT,
  COST_CHANGE_EVENT,
  SLIP_ACTIVITY_2,
  SLIP_ACTIVITY_3,
} from './scenarios';

// OFF-019 suggested next actions — the NextAction contract: deterministic
// per-kind typed command references (resolvable through the OFF-017 action
// gateway), each with its evidence subset and deterministic confidence.
// SUGGESTIONS ONLY: every returned value is plain JSON-safe DATA — the
// control tower has no execution path at all (no actor, no idempotency key,
// no aggregate version, no approvals — the proposing caller supplies those).

let run: PortfolioScanRun;

beforeAll(async () => {
  run = await runPortfolioScan();
});

const byKind = (kind: Exception['kind']): Exception => {
  const exception = run.exceptions.find((candidate) => candidate.kind === kind);
  expect(exception, `no ${kind} exception in the golden run`).toBeDefined();
  return exception!;
};

const allSuggestedCommandNames: readonly CommandName[] = [
  RECORD_PROGRESS_COMMAND,
  SET_BASELINE_COMMAND,
  REVISE_BUDGET_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  APPROVE_CHANGE_ORDER_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
];

describe('the per-kind suggestion mapping (OFF-019)', () => {
  it('suggests record-progress + re-baseline for a schedule slip', () => {
    const actions = suggestNextActions(byKind('schedule-slip'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      RECORD_PROGRESS_COMMAND,
      SET_BASELINE_COMMAND,
    ]);
    expect(actions[0]?.command.payload).toStrictEqual({
      activityIds: [SLIP_ACTIVITY_2, SLIP_ACTIVITY_3],
    });
    // The approval-required baseline change carries no reference payload.
    expect(actions[1]?.command.payload).toStrictEqual({});
  });

  it('suggests budget revision + entitlement pursuit for a cost overrun', () => {
    const actions = suggestNextActions(byKind('cost-overrun'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      REVISE_BUDGET_COMMAND,
      SUBMIT_CHANGE_ORDER_COMMAND,
    ]);
    expect(actions[1]?.command.payload).toStrictEqual({ changeEventId: COST_CHANGE_EVENT });
  });

  it('suggests BOTH decisions for an entitlement exposure (never decides)', () => {
    const actions = suggestNextActions(byKind('entitlement-exposure'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      APPROVE_CHANGE_ORDER_COMMAND,
      REJECT_CHANGE_ORDER_COMMAND,
    ]);
    for (const action of actions) {
      expect(action.command.payload).toStrictEqual({ changeOrderIds: [ENTITLEMENT_ORDER_3] });
      // A commercial decision is a human decision — low confidence, always.
      expect(action.confidence.level).toBe('low');
      expect(action.confidence.reasons).toContain('human-decision-required');
    }
  });

  it('suggests resequencing for a dependency risk', () => {
    const actions = suggestNextActions(byKind('dependency-risk'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      UPDATE_ACTIVITY_COMMAND,
    ]);
    expect(actions[0]?.command.payload).toStrictEqual({
      activityIds: [SLIP_ACTIVITY_2, SLIP_ACTIVITY_3],
    });
  });

  it('suggests evidence linking for an evidence gap', () => {
    const actions = suggestNextActions(byKind('evidence-gap'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      LINK_CHANGE_REFERENCES_COMMAND,
    ]);
    expect(actions[0]?.command.payload).toStrictEqual({ changeEventId: GAP_CHANGE_EVENT });
  });
});

describe('every suggestion is typed, evidenced, and confident (OFF-019)', () => {
  const evidenceKeyOf = (evidence: Exception['evidence'][number]): string =>
    evidence.kind === 'assessment'
      ? evidence.assessmentId
      : evidence.kind === 'benchmark'
        ? evidence.benchmarkId
        : evidence.eventId;

  for (const kind of [
    'schedule-slip',
    'cost-overrun',
    'entitlement-exposure',
    'dependency-risk',
    'evidence-gap',
  ] as const) {
    it(`carries the typed descriptor contract for ${kind}`, () => {
      const exception = byKind(kind);
      const actions = suggestNextActions(exception);
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        // Typed command reference over the gateway's own vocabulary.
        expect(allSuggestedCommandNames).toContain(action.command.commandName);
        // The suggestion runs under the exception's own scope.
        expect(action.scope).toStrictEqual(exception.scope);
        // Deterministic human-readable text.
        expect(action.title.length).toBeGreaterThan(0);
        expect(action.rationale.length).toBeGreaterThan(0);
        // Typed confidence with stable machine-readable reasons.
        expect(['low', 'medium', 'high']).toContain(action.confidence.level);
        expect(action.confidence.reasons.length).toBeGreaterThan(0);
        expect([...action.confidence.reasons]).toStrictEqual(
          [...action.confidence.reasons].sort(),
        );
        // The justifying evidence is a SUBSET of the exception's own chain.
        const exceptionEvidenceKeys = new Set(exception.evidence.map(evidenceKeyOf));
        for (const evidence of action.evidence) {
          expect(exceptionEvidenceKeys.has(evidenceKeyOf(evidence))).toBe(true);
        }
      }
    });
  }

  it('cites the benchmark calibration in schedule-slip and cost-overrun confidence', () => {
    for (const kind of ['schedule-slip', 'cost-overrun'] as const) {
      const actions = suggestNextActions(byKind(kind));
      for (const action of actions) {
        expect(action.confidence.reasons).toContain('benchmark-calibrated');
        expect(action.confidence.reasons).toContain('single-assessment-basis');
      }
    }
    // The moneyless kinds carry no benchmark context.
    for (const kind of ['dependency-risk', 'evidence-gap'] as const) {
      const actions = suggestNextActions(byKind(kind));
      for (const action of actions) {
        expect(action.confidence.reasons).not.toContain('benchmark-calibrated');
      }
    }
  });
});

describe('SUGGESTIONS ONLY — no execution path exists (structural, OFF-019)', () => {
  it('returns plain JSON-safe data (every payload round-trips)', () => {
    for (const exception of run.exceptions) {
      for (const action of suggestNextActions(exception)) {
        expect(JSON.parse(JSON.stringify(action.command.payload))).toStrictEqual(
          action.command.payload,
        );
        expect(JSON.parse(JSON.stringify(action.command.commandName))).toBe(
          action.command.commandName,
        );
      }
    }
  });

  it('carries ONLY deterministic reference fields — no execution inputs', () => {
    const forbiddenPayloadKeys = [
      'actor',
      'actorId',
      'idempotencyKey',
      'expectedVersion',
      'aggregateVersion',
      'approvals',
      'approvedBy',
      'token',
      'apiKey',
    ];
    for (const exception of run.exceptions) {
      for (const action of suggestNextActions(exception)) {
        for (const key of Object.keys(action.command.payload)) {
          expect(forbiddenPayloadKeys).not.toContain(key);
        }
        // The NextAction itself carries no execution surface either.
        expect(Object.keys(action)).toStrictEqual([
          'command',
          'scope',
          'title',
          'rationale',
          'confidence',
          'evidence',
        ]);
      }
    }
  });

  it('is deterministic: the same exception yields the identical suggestions', () => {
    for (const exception of run.exceptions) {
      expect(suggestNextActions(exception)).toStrictEqual(suggestNextActions(exception));
    }
    // And the suggestion set is a pure function of the exception: a
    // different exception of the same kind maps to the same command names.
    const slip = byKind('schedule-slip');
    const otherSlip: readonly NextAction[] = suggestNextActions({
      ...slip,
      exceptionId: 'scan-0009#0001' as Exception['exceptionId'],
    });
    expect(otherSlip.map((action) => action.command.commandName)).toStrictEqual(
      suggestNextActions(slip).map((action) => action.command.commandName),
    );
  });
});
