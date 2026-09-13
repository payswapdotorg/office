// OFF-018 — the agent's own audit trail: the five payload parsers (total,
// fail-closed, strict keys — consumers of the trail re-validate every record
// they read), the envelope builder (every envelope it emits satisfies the
// canonical DomainEventEnvelope contract, source 'system', causation intact),
// and the AgentEventSink ports (the in-memory recorder + the typed failure).
import { parseEntityId, parseEntityKind } from '@office/contracts';
import type { EntityId, EntityKind } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import { parseDomainEventEnvelope, parseEventName } from '@office/contracts';
import type { DomainEventEnvelope } from '@office/contracts';
import {
  AGENT_AUDIT_DECISIONS,
  agentEventEnvelope,
  agentSinkFailure,
  auditDecisionOf,
  createInMemoryAgentEventSink,
  failingAgentEventSink,
  parseActionProposedPayload,
  parseEvidenceGatheredPayload,
  parseGatewayDecisionPayload,
  parseRunCompletedPayload,
  parseRunStartedPayload,
} from './execution-records';
import {
  AGENT_ACTOR,
  CORRELATION_ID,
  FAKE_EXECUTOR,
  PROJECT_1,
  T0,
  expectFail,
  projectScopeOf,
  unwrap,
} from './test-support';

/** Fixture helper: a branded EntityKind from a known-good literal. */
const entityKindOf = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity kind: ${raw}`);
  return parsed.value;
};

/** Fixture helper: a branded EntityId from a known-good literal. */
const entityIdOf = (raw: string): EntityId => {
  const parsed = parseEntityId(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity id: ${raw}`);
  return parsed.value;
};


const RUN_ID = 'run-0001';
const COMMAND_NAME = 'cost.commitBudgetRevision';
const KEY = 'agt-00001';
const APPROVAL = { instanceId: entityIdOf('office-ent-v1-0000000000000001'), approvalKey: 'action' };

// ----- the payload parsers ----------------------------------------------------------------------

describe('parseRunStartedPayload (strict keys, closed vocabularies)', () => {
  const valid = {
    runId: RUN_ID,
    goal: 'Commit the justified budget revision.',
    actorKind: 'agent',
    actorId: 'office-ent-v1-a2b3c4d5e6f708192a3b4c5d6e7f8a9',
    modelId: 'mock-model-fixture-v1',
    tools: ['relationship-traversal', 'model-proposer'],
    correlationId: CORRELATION_ID,
  };

  it('round-trips the run-started record', () => {
    expect(unwrap(parseRunStartedPayload(valid))).toStrictEqual(valid);
  });

  it('rejects unknown keys, bad actor kinds, and malformed tool names', () => {
    const extra = parseRunStartedPayload({ ...valid, extra: 1 });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error.code).toBe('unknown-field');
    const badKind = parseRunStartedPayload({ ...valid, actorKind: 'robot' });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.error.path).toBe('actorKind');
    const badTool = parseRunStartedPayload({ ...valid, tools: ['Bad Tool'] });
    expect(badTool.ok).toBe(false);
    if (!badTool.ok) expect(badTool.error.path).toBe('tools[0]');
  });
});

describe('parseEvidenceGatheredPayload (every item with its retrieval)', () => {
  const valid = {
    runId: RUN_ID,
    items: [
      {
        kind: 'entity',
        ref: 'change-event:office-ent-v1-c1a2b3c4d5e6f708192a3b4c5d6e7f8a',
        tool: 'relationship-traversal',
        retrievedAt: T0,
      },
    ],
  };

  it('round-trips the evidence-gathered record', () => {
    expect(unwrap(parseEvidenceGatheredPayload(valid))).toStrictEqual(valid);
  });

  it('rejects a non-array items field and malformed item refs', () => {
    expect(parseEvidenceGatheredPayload({ ...valid, items: 'none' }).ok).toBe(false);
    const badRef = parseEvidenceGatheredPayload({
      ...valid,
      items: [{ ...valid.items[0]!, ref: 'has space' }],
    });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) expect(badRef.error.path).toBe('items[0].ref');
  });
});

describe('parseActionProposedPayload (the proposal with its evidence refs)', () => {
  const valid = {
    runId: RUN_ID,
    commandName: COMMAND_NAME,
    idempotencyKey: KEY,
    confidence: 'high',
    rationale: 'The revision evidence and margin assessment justify the commit.',
    evidence: [
      { slot: 'justification', ref: 'revision:office-ent-v1-d2b3c4d5e6f708192a3b4c5d6e7f8a9' },
      { slot: 'margin-assessment', ref: 'asm-budget-revision-0001' },
    ],
  };

  it('round-trips the action-proposed record', () => {
    expect(unwrap(parseActionProposedPayload(valid))).toStrictEqual(valid);
  });

  it('rejects unknown keys, bad confidence, and malformed evidence slots', () => {
    expect(parseActionProposedPayload({ ...valid, extra: true }).ok).toBe(false);
    const badConfidence = parseActionProposedPayload({ ...valid, confidence: 'ultra' });
    expect(badConfidence.ok).toBe(false);
    if (!badConfidence.ok) expect(badConfidence.error.path).toBe('confidence');
    const badSlot = parseActionProposedPayload({
      ...valid,
      evidence: [{ slot: 'Bad Slot', ref: 'asm-budget-revision-0001' }],
    });
    expect(badSlot.ok).toBe(false);
    if (!badSlot.ok) expect(badSlot.error.path).toBe('evidence[0].slot');
  });
});

describe('parseGatewayDecisionPayload (the gateway decision, verbatim)', () => {
  it('round-trips executed, routed, and denied decisions', () => {
    const executed = unwrap(
      parseGatewayDecisionPayload({
        runId: RUN_ID,
        commandName: COMMAND_NAME,
        idempotencyKey: KEY,
        decision: 'executed',
        replayed: false,
        approval: null,
        approvalStatus: null,
        denialCode: null,
      }),
    );
    expect(executed.decision).toBe('executed');
    const routed = unwrap(
      parseGatewayDecisionPayload({
        runId: RUN_ID,
        commandName: COMMAND_NAME,
        idempotencyKey: KEY,
        decision: 'routed-to-approval',
        replayed: false,
        approval: APPROVAL,
        approvalStatus: 'pending',
        denialCode: null,
      }),
    );
    expect(routed.approval).toStrictEqual(APPROVAL);
    const denied = unwrap(
      parseGatewayDecisionPayload({
        runId: RUN_ID,
        commandName: COMMAND_NAME,
        idempotencyKey: KEY,
        decision: 'denied',
        replayed: false,
        approval: null,
        approvalStatus: null,
        denialCode: 'actor-kind-not-permitted',
      }),
    );
    expect(denied.denialCode).toBe('actor-kind-not-permitted');
  });

  it('rejects a decision outside the closed vocabulary and a malformed approval reference', () => {
    const base = {
      runId: RUN_ID,
      commandName: COMMAND_NAME,
      idempotencyKey: KEY,
      replayed: false,
      approval: null,
      approvalStatus: null,
      denialCode: null,
    };
    const badDecision = parseGatewayDecisionPayload({ ...base, decision: 'maybe' });
    expect(badDecision.ok).toBe(false);
    if (!badDecision.ok) expect(badDecision.error.path).toBe('decision');
    const badApproval = parseGatewayDecisionPayload({
      ...base,
      decision: 'routed-to-approval',
      approval: { instanceId: 'not-an-entity-id', approvalKey: 'action' },
    });
    expect(badApproval.ok).toBe(false);
    if (!badApproval.ok) expect(badApproval.error.path).toBe('approval.instanceId');
  });
});

describe('parseRunCompletedPayload (the terminal record)', () => {
  const valid = {
    runId: RUN_ID,
    status: 'executed',
    executedCount: 1,
    routedCount: 0,
    deniedCount: 0,
    pendingApprovals: [],
  };

  it('round-trips the run-completed record', () => {
    expect(unwrap(parseRunCompletedPayload(valid))).toStrictEqual(valid);
  });

  it('rejects unknown statuses and non-integer counts', () => {
    const badStatus = parseRunCompletedPayload({ ...valid, status: 'finished' });
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.error.path).toBe('status');
    const badCount = parseRunCompletedPayload({ ...valid, executedCount: -1 });
    expect(badCount.ok).toBe(false);
    if (!badCount.ok) expect(badCount.error.path).toBe('executedCount');
  });
});

// ----- the envelope builder ----------------------------------------------------------------------

/** Valid envelope-builder inputs around a fixed run-started payload. */
const inputsOf = (causationToken: string) => ({
  eventName: unwrap(parseEventName('agents.agentRunStarted')),
  scope: projectScopeOf(PROJECT_1),
  actor: AGENT_ACTOR,
  correlationId: CORRELATION_ID,
  causationToken,
  occurredAt: T0,
  subject: null,
  payload: { runId: RUN_ID },
});

describe('agentEventEnvelope (the canonical contract, source system)', () => {
  it('builds a contract-valid envelope with the run as its own cause', () => {
    const envelope = agentEventEnvelope(inputsOf(RUN_ID));
    const checked = parseDomainEventEnvelope(envelope);
    expect(checked.ok).toBe(true);
    const validated = checked.ok ? checked.value : null;
    expect(validated?.source).toBe('system');
    expect(validated?.actor).toStrictEqual(AGENT_ACTOR);
    expect(validated?.causality.causationId).toBe(RUN_ID);
    expect(validated?.causality.correlationId).toBe(CORRELATION_ID);
    expect((envelope as DomainEventEnvelope<{ runId: string }>).payload.runId).toBe(RUN_ID);
    expect((envelope as DomainEventEnvelope).entityRefs).toStrictEqual({
      before: null,
      after: null,
    });
  });

  it('carries the proposal subject on both entity-ref sides and validates against the contract', () => {
    const subject = {
      entityKind: entityKindOf('budget-revision'),
      entityId: entityIdOf('office-ent-v1-e3c4d5e6f708192a3b4c5d6e7f8a9b'),
    };
    const envelope = agentEventEnvelope({
      ...inputsOf(KEY),
      eventName: unwrap(parseEventName('agents.agentActionProposed')),
      subject,
      payload: { runId: RUN_ID, commandName: COMMAND_NAME },
    });
    expect(parseDomainEventEnvelope(envelope).ok).toBe(true);
    expect((envelope as DomainEventEnvelope).entityRefs).toStrictEqual({
      before: subject,
      after: subject,
    });
    expect((envelope as DomainEventEnvelope).causality.causationId).toBe(KEY);
  });

  it('throws loudly on a causation token outside the CausationId grammar', () => {
    expect(() => agentEventEnvelope(inputsOf('bad causation token'))).toThrow(TypeError);
  });
});

// ----- the sink ports -----------------------------------------------------------------------------

describe('the AgentEventSink ports', () => {
  it('the in-memory sink records appends with the caller’s executor and flattens events', async () => {
    const sink = createInMemoryAgentEventSink();
    const first = await sink.appendEvents(FAKE_EXECUTOR, [
      agentEventEnvelope(inputsOf(RUN_ID)),
    ]);
    expect(first.ok).toBe(true);
    expect(sink.appends).toHaveLength(1);
    expect(sink.appends[0]?.executor).toBe(FAKE_EXECUTOR);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventName).toBe('agents.agentRunStarted');
  });

  it('the failing sink fails typed with the agent-sink-rejected code', async () => {
    const sink = failingAgentEventSink('ledger unavailable');
    const result = await sink.appendEvents(FAKE_EXECUTOR, []);
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.details[0]?.code).toBe('agent-sink-rejected');
    expect(agentSinkFailure('reason').details[0]?.code).toBe('agent-sink-rejected');
  });
});

// ----- the decision vocabulary ---------------------------------------------------------------------

describe('the audit decision vocabulary', () => {
  it('maps the gateway vocabulary onto the audit vocabulary (duplicate-observed replays as executed)', () => {
    expect(AGENT_AUDIT_DECISIONS).toStrictEqual(['executed', 'routed-to-approval', 'denied']);
    expect(auditDecisionOf('executed')).toBe('executed');
    expect(auditDecisionOf('routed-to-approval')).toBe('routed-to-approval');
    expect(auditDecisionOf('denied')).toBe('denied');
    expect(auditDecisionOf('duplicate-observed')).toBe('executed');
  });
});
