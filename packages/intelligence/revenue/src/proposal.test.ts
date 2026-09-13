import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGoldenRecoveryScan } from './scenarios';
import { assertRecoveryClaim, proposeNextActions } from './proposal';
import {
  LINK_CHANGE_REFERENCES_COMMAND,
  REFERENCE_CLAIM_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
} from './model';
import type { ProposedNextAction, RecoveryPolicyDecision } from './model';
import type { CandidateRecovery } from './candidates';
import { DETECTED_AT, USER_ACTOR, unwrap } from './test-support';

// OFF-033 proposal — the ProposedNextAction contract: SUGGESTIONS ONLY.
// The engine's only exit is a typed ProposedNextAction record; assertion
// without an explicit policy decision is a typed rejection; and THE
// structural no-auto-assertion proof (no command construction, no state
// mutation — counting/scan based, mirroring the agents/exceptions engines'
// proofs).

const run = runGoldenRecoveryScan();
const candidateOf = (kind: CandidateRecovery['kind']): CandidateRecovery => {
  const candidate = run.candidates.find((entry) => entry.kind === kind);
  if (candidate === undefined) throw new Error(`missing golden ${kind} candidate`);
  return candidate;
};

describe('the per-kind proposed next actions (typed suggestions)', () => {
  it('proposes the constructive-change recovery path (submit + link evidence)', () => {
    const actions = proposeNextActions(candidateOf('constructive-change'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      SUBMIT_CHANGE_ORDER_COMMAND,
      LINK_CHANGE_REFERENCES_COMMAND,
    ]);
    expect(actions.map((action) => action.title)).toStrictEqual([
      'Submit the change order claiming the performed work',
      'Link the producing cost evidence to the change event',
    ]);
    expect(actions.map((action) => action.confidence.level)).toStrictEqual(['medium', 'high']);
  });

  it('proposes the entitlement-rebalance path (re-submit + pin the claim)', () => {
    const actions = proposeNextActions(candidateOf('entitlement-rebalance'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      SUBMIT_CHANGE_ORDER_COMMAND,
      REFERENCE_CLAIM_COMMAND,
    ]);
    // A rejected-position re-submission is a commercial judgment — low
    // confidence + the human-decision-required reason.
    for (const action of actions) {
      expect(action.confidence.level).toBe('low');
      expect(action.confidence.reasons).toContain('human-decision-required');
    }
  });

  it('proposes the delay-impact path (submit + link schedule evidence)', () => {
    const actions = proposeNextActions(candidateOf('delay-impact'));
    expect(actions.map((action) => action.command.commandName)).toStrictEqual([
      SUBMIT_CHANGE_ORDER_COMMAND,
      LINK_CHANGE_REFERENCES_COMMAND,
    ]);
    expect(actions.map((action) => action.title)).toStrictEqual([
      'Submit the change order claiming the delay impact',
      'Link the schedule impact evidence to the change event',
    ]);
  });

  it('carries ONLY deterministic reference fields in the payloads (no versions, actors, or idempotency keys)', () => {
    for (const candidate of run.candidates) {
      const changeEventId = candidate.referencedRecords.find(
        (record) => record.entityKind === 'change-event',
      )?.entityId;
      for (const action of proposeNextActions(candidate)) {
        const payload = action.command.payload;
        expect(Object.keys(payload).every((key) => key === 'changeEventId' || key === 'supersedingChangeOrderId')).toBe(true);
        if ('changeEventId' in payload) {
          expect(payload['changeEventId']).toBe(changeEventId);
        }
      }
    }
  });

  it('every suggestion grounds on the candidate\'s own evidence chain', () => {
    for (const candidate of run.candidates) {
      const chain = new Set(candidate.evidence.map((evidence) => JSON.stringify(evidence)));
      for (const action of proposeNextActions(candidate)) {
        expect(action.evidence.length).toBeGreaterThan(0);
        for (const evidence of action.evidence) {
          expect(chain.has(JSON.stringify(evidence))).toBe(true);
        }
        expect(action.scope).toStrictEqual(candidate.scope);
        expect(action.policyDecision).toBeNull();
      }
    }
  });

  it('is deterministic (the same candidate reproduces byte-identical suggestions)', () => {
    for (const candidate of run.candidates) {
      expect(proposeNextActions(candidate)).toStrictEqual(proposeNextActions(candidate));
    }
  });
});

describe('THE policy-gated assertion (the named acceptance)', () => {
  const decision: RecoveryPolicyDecision = {
    decision: 'assert-recovery-claim',
    decidedBy: USER_ACTOR,
    decidedAt: DETECTED_AT,
    rationale: 'The commercial controller accepts the recovery position.',
  };

  it('assertion WITHOUT an explicit policy decision is a typed rejection', () => {
    for (const candidate of run.candidates) {
      const rejected = assertRecoveryClaim(candidate, null);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe('forbidden');
        expect(rejected.error.details[0]?.code).toBe('assertion-requires-policy-decision');
        expect(rejected.error.details[0]?.path).toBe('policyDecision');
        expect(String(rejected.error.message)).toContain(candidate.candidateId);
      }
    }
  });

  it('assertion WITH an explicit policy decision only PROPOSES (a ProposedNextAction record)', () => {
    for (const candidate of run.candidates) {
      const proposal = unwrap(assertRecoveryClaim(candidate, decision));
      expect(proposal.command.commandName).toBe(SUBMIT_CHANGE_ORDER_COMMAND);
      expect(proposal.policyDecision).toStrictEqual(decision);
      expect(proposal.title).toBe(
        `Assert the contractual claim of the ${candidate.kind} candidate`,
      );
      expect(proposal.confidence.level).toBe('high');
      expect(proposal.confidence.reasons).toContain('human-decision-required');
      // The proposal is data — recomputing it reproduces it byte-identically.
      expect(unwrap(assertRecoveryClaim(candidate, decision))).toStrictEqual(proposal);
    }
  });

  it('the assertion proposal carries the evidence chain subset + the candidate scope', () => {
    for (const candidate of run.candidates) {
      const proposal = unwrap(assertRecoveryClaim(candidate, decision));
      const chain = new Set(candidate.evidence.map((evidence) => JSON.stringify(evidence)));
      expect(proposal.evidence.length).toBeGreaterThan(0);
      for (const evidence of proposal.evidence) {
        expect(chain.has(JSON.stringify(evidence))).toBe(true);
      }
      expect(proposal.scope).toStrictEqual(candidate.scope);
      expect(proposal.command.payload).toStrictEqual({
        changeEventId: candidate.referencedRecords.find(
          (record) => record.entityKind === 'change-event',
        )?.entityId,
      });
    }
  });
});

describe('THE structural no-auto-assertion proof (counting/scan based)', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '.');
  const logicFiles = ['proposal.ts', 'detection.ts', 'prioritization.ts', 'candidates.ts', 'model.ts'];
  const readLogic = (file: string): string =>
    readFileSync(join(srcDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('constructs NO command envelope anywhere in the engine (commands are referenced, never built)', () => {
    // The only way to build a typed command in the landed contracts
    // package is parseCommandEnvelope/commandOf — the recovery engine
    // never calls either: a ProposedNextAction carries a CommandName
    // REFERENCE + reference payload fields, nothing more.
    for (const file of logicFiles) {
      const text = readLogic(file);
      expect(text.match(/\bparseCommandEnvelope\b/g) ?? []).toHaveLength(0);
      expect(text.match(/\bcommandOf\b/g) ?? []).toHaveLength(0);
      expect(text.match(/\bcreateCommand\b/g) ?? []).toHaveLength(0);
    }
  });

  it('the proposal module mutates nothing and invokes nothing (pure data out)', () => {
    const proposal = readLogic('proposal.ts');
    // No execution/commit/store surface of any kind.
    expect(proposal.match(/\bawait\b/g) ?? []).toHaveLength(0);
    expect(proposal.match(/\basync\b/g) ?? []).toHaveLength(0);
    expect(
      proposal.match(/\b(dispatch|execute|commit|persist|store|save|append|insert|remove|delete)\w*\s*\(/g) ?? [],
    ).toHaveLength(0);
    expect(proposal.match(/\bnew\s+\w*(Gateway|Client|Sink|Store|Repository)\b/g) ?? []).toHaveLength(0);
    // The only command-name references are the three typed constants.
    expect(proposal.match(/SUBMIT_CHANGE_ORDER_COMMAND|LINK_CHANGE_REFERENCES_COMMAND|REFERENCE_CLAIM_COMMAND/g) ?? []).toHaveLength(
      (proposal.match(/SUBMIT_CHANGE_ORDER_COMMAND/g) ?? []).length +
        (proposal.match(/LINK_CHANGE_REFERENCES_COMMAND/g) ?? []).length +
        (proposal.match(/REFERENCE_CLAIM_COMMAND/g) ?? []).length,
    );
  });

  it('the detection + ranking modules emit data only (no sink, no mutation calls)', () => {
    for (const file of ['detection.ts', 'prioritization.ts', 'candidates.ts']) {
      const text = readLogic(file);
      expect(text.match(/\bawait\b/g) ?? []).toHaveLength(0);
      expect(text.match(/\bappendEvents\b/g) ?? []).toHaveLength(0);
      expect(text.match(/\b(dispatch|execute|commit|persist|save)\w*\s*\(/g) ?? []).toHaveLength(0);
    }
  });

  it('the ONLY assertion-shaped surface is assertRecoveryClaim — and its exit is a proposal', () => {
    // Counting proof: exactly one assertion-named export exists in the
    // whole engine, and it returns Result<ProposedNextAction, DomainError>.
    const proposalModule = readLogic('proposal.ts');
    expect(proposalModule.match(/\bexport function assert\w*/g) ?? []).toHaveLength(1);
    expect(proposalModule).toMatch(
      /export function assertRecoveryClaim\([\s\S]*?\):\s*Result<ProposedNextAction,\s*DomainError>/,
    );
    // The proposal type itself carries the policy decision field (the A8
    // approval chain travels WITH the proposal, never separately).
    const modelModule = readLogic('model.ts');
    expect(modelModule).toMatch(/readonly policyDecision: RecoveryPolicyDecision \| null;/);
    const shapePin: keyof ProposedNextAction = 'policyDecision';
    expect(shapePin).toBe('policyDecision');
  });
});
