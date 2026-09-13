// OFF-018 — fail-closed parsing of the runtime's own value objects: the
// branded identities (AgentRunId, ToolName), the run input (goal/scope/agent
// actor/plan), and the typed action proposal. Total parsers, strict keys,
// closed vocabularies, dotted error paths — the same conventions every
// landed @office package enforces.
import { describe, expect, it } from 'vitest';
import { isActionProposal } from '@office/actions';
import {
  AGENT_RUN_STATUSES,
  TOOL_KINDS,
  isAgentRunId,
  isToolName,
  parseAgentRunId,
  parseToolName,
} from './vocabulary';
import {
  isAgentRunInput,
  parseAgentRunInput,
} from './run';
import {
  isProposedAction,
  parseProposedAction,
  proposedAction,
  toGatewayProposal,
} from './proposals';
import {
  AGENT_ACTOR,
  CORRELATION_ID,
  GOAL_RECORD_PROGRESS,
  PROJECT_1,
  USER_ID,
  budgetRevisionDraft,
  documentRef,
  envelope,
  projectScopeOf,
  standardRetrievalPlan,
  unwrap,
} from './test-support';

// ----- the branded identities -------------------------------------------------------------------

describe('parseAgentRunId (opaque, causation-compatible tokens)', () => {
  it('accepts the grammar and rejects everything else fail-closed', () => {
    expect(unwrap(parseAgentRunId('run-0001'))).toBe('run-0001');
    expect(isAgentRunId('run-0001')).toBe(true);
    expect(parseAgentRunId('run-1').ok).toBe(false); // 7 characters
    expect(parseAgentRunId('run 0001').ok).toBe(false); // whitespace
    expect(parseAgentRunId('run-0001\n').ok).toBe(false);
    expect(parseAgentRunId(42).ok).toBe(false);
    expect(parseAgentRunId(null).ok).toBe(false);
    expect(isAgentRunId('short')).toBe(false);
  });
});

describe('parseToolName (lowercase kebab-case)', () => {
  it('accepts the registry grammar and rejects malformed names', () => {
    expect(unwrap(parseToolName('model-proposer'))).toBe('model-proposer');
    expect(unwrap(parseToolName('relationship-traversal'))).toBe('relationship-traversal');
    expect(isToolName('memory-lookup')).toBe(true);
    expect(parseToolName('Model-Proposer').ok).toBe(false);
    expect(parseToolName('mo').ok).toBe(false);
    expect(parseToolName('model-').ok).toBe(false);
    expect(parseToolName('model--proposer').ok).toBe(false);
    expect(parseToolName('model_proposer').ok).toBe(false);
  });
});

describe('the closed vocabularies', () => {
  it('fixes the run statuses and the tool kinds', () => {
    expect(AGENT_RUN_STATUSES).toStrictEqual([
      'running',
      'awaiting-approval',
      'executed',
      'denied',
    ]);
    expect(TOOL_KINDS).toStrictEqual(['read', 'propose-action']);
  });
});

// ----- the run input ------------------------------------------------------------------------------

describe('parseAgentRunInput (total, fail-closed, strict keys)', () => {
  const rawInput = {
    goal: GOAL_RECORD_PROGRESS,
    scope: projectScopeOf(PROJECT_1),
    actor: AGENT_ACTOR,
    contextRefs: [documentRef()],
    retrievalPlan: standardRetrievalPlan(),
    proposingTool: 'model-proposer',
    correlationId: CORRELATION_ID,
  };

  it('round-trips a fully valid run input', () => {
    const parsed = unwrap(parseAgentRunInput(rawInput));
    expect(parsed.goal).toBe(GOAL_RECORD_PROGRESS);
    expect(parsed.actor).toStrictEqual(AGENT_ACTOR);
    expect(parsed.proposingTool).toBe('model-proposer');
    expect(parsed.retrievalPlan).toHaveLength(3);
    expect(isAgentRunInput(rawInput)).toBe(true);
  });

  it('rejects a non-agent actor (an agent run is performed by an agent actor)', () => {
    const result = parseAgentRunInput({
      ...rawInput,
      actor: { kind: 'user', actorId: USER_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-value');
      expect(result.error.path).toBe('actor.kind');
    }
  });

  it('rejects unknown keys, missing fields, and malformed plan steps at their paths', () => {
    const extra = parseAgentRunInput({ ...rawInput, extra: true });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.code).toBe('unknown-field');
      expect(extra.error.path).toBe('extra');
    }
    const missing = parseAgentRunInput({ ...rawInput, goal: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('missing-field');
      expect(missing.error.path).toBe('goal');
    }
    const badStep = parseAgentRunInput({
      ...rawInput,
      retrievalPlan: [{ tool: 'relationship-traversal', query: { kind: 'memory-lessons' }, extra: 1 }],
    });
    expect(badStep.ok).toBe(false);
    if (!badStep.ok) {
      expect(badStep.error.code).toBe('unknown-field');
      expect(badStep.error.path).toBe('retrievalPlan[0].extra');
    }
    const badTool = parseAgentRunInput({ ...rawInput, proposingTool: 'Not A Tool' });
    expect(badTool.ok).toBe(false);
    if (!badTool.ok) expect(badTool.error.path).toBe('proposingTool');
    const badGoal = parseAgentRunInput({ ...rawInput, goal: '' });
    expect(badGoal.ok).toBe(false);
    if (!badGoal.ok) expect(badGoal.error.code).toBe('invalid-value');
  });
});

// ----- the typed action proposal -------------------------------------------------------------------

describe('parseProposedAction / proposedAction / toGatewayProposal', () => {
  it('round-trips a validated proposal from plain parts', () => {
    const action = proposedAction({
      command: envelope({ note: 'foundation poured' }, 'field.recordProgress'),
      subject: documentRef(),
      evidence: [{ slot: 'observation', ref: 'change-event:e-1' }],
      confidence: 'medium',
      rationale: 'Grounded on the captured change event.',
      resourceScope: null,
      approval: null,
    });
    expect(isProposedAction(action)).toBe(true);
    expect(action.evidence).toStrictEqual([{ slot: 'observation', ref: 'change-event:e-1' }]);
    expect(action.approval).toBeNull();
    // Round-trips through the total parser unchanged.
    expect(unwrap(parseProposedAction(action))).toStrictEqual(action);
  });

  it('rejects unknown keys, empty rationales, and invalid confidences at their paths', () => {
    const valid = budgetRevisionDraft();
    const extra = parseProposedAction({ ...valid, extra: 1 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.code).toBe('unknown-field');
      expect(extra.error.path).toBe('extra');
    }
    const emptyRationale = parseProposedAction({ ...valid, rationale: '' });
    expect(emptyRationale.ok).toBe(false);
    if (!emptyRationale.ok) expect(emptyRationale.error.path).toBe('rationale');
    const badConfidence = parseProposedAction({ ...valid, confidence: 'ultra' });
    expect(badConfidence.ok).toBe(false);
    if (!badConfidence.ok) expect(badConfidence.error.path).toBe('confidence');
    const badApproval = parseProposedAction({
      ...valid,
      approval: { instanceId: 'nope', approvalKey: 'action' },
    });
    expect(badApproval.ok).toBe(false);
    if (!badApproval.ok) expect(badApproval.error.path).toBe('approval.instanceId');
    // The trusted builder throws loud on the same defect.
    expect(() =>
      proposedAction({
        command: valid.command,
        confidence: 'ultra',
        rationale: 'x',
      }),
    ).toThrow(TypeError);
  });

  it('converts to the gateway’s ActionProposal shape (evidence refs verbatim, no rationale leak)', () => {
    const action = proposedAction({
      command: envelope({ note: 'foundation poured' }, 'field.recordProgress'),
      subject: documentRef(),
      evidence: [
        { slot: 'observation', ref: 'change-event:e-1' },
        { slot: 'corroboration', ref: 'revision:e-2' },
      ],
      confidence: 'high',
      rationale: 'The observation and its corroborating revision justify the record.',
      resourceScope: projectScopeOf(PROJECT_1),
      approval: null,
    });
    const gatewayProposal = toGatewayProposal(action);
    expect(isActionProposal(gatewayProposal)).toBe(true);
    expect(gatewayProposal.command).toStrictEqual(action.command);
    expect(gatewayProposal.evidence).toStrictEqual(action.evidence);
    expect(gatewayProposal.confidence).toBe('high');
    expect(gatewayProposal.resourceScope).toStrictEqual(projectScopeOf(PROJECT_1));
    // The rationale stays in the agent's own records — the gateway shape has
    // no such field to carry.
    expect('rationale' in gatewayProposal).toBe(false);
  });
});
