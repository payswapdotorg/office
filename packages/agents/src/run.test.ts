// OFF-018 acceptance — THE agent runtime, proven against the REAL action
// gateway wired through the deterministic harness. Every named acceptance of
// the item is proven HERE:
//
// - an agent CANNOT mutate state except through OFF-017: every proposal goes
//   through executeAction() — the COUNTING gateway plus per-command
//   handler-invocation counting prove gateway-mediated execution, and the
//   unevidenced-consequential rejections prove the runtime never reaches the
//   gateway with a proposal that violates freeze A4 (the structural
//   no-persistence/no-domain half of the proof lives in boundary.test.ts);
// - every consequential recommendation carries evidence: an approval-required
//   or reversible proposal with an empty/unqualified EvidenceSet, or citing
//   refs the run never retrieved, is typed-rejected BEFORE the gateway call;
//   executed proposals carry their evidence refs into BOTH audit trails (the
//   agent's own action-proposed record and the gateway's executed record);
// - determinism: two identically-built harnesses produce byte-identical runs
//   and audit trails (the run-twice proof — injected clock/id suppliers, the
//   fixture-scripted model, no Date.now/Math.random anywhere);
// - A12: runs are tenant-scoped; cross-tenant evidence retrieval is
//   typed-rejected; the agent actor is deny-by-default at the gateway (the
//   systematic actor-kind × command-class matrix);
// - the approval handoff: a routed proposal parks the run awaiting-approval
//   with the approval linked, and the run completes ONLY on resolution;
// - execution records: the five lifecycle envelopes flow through the
//   AgentEventSink port in order, with causality + correlation intact.
import { parseEntityId } from '@office/contracts';
import type { EntityId } from '@office/contracts';
import { describe, expect, it } from 'vitest';
import type { DomainEventEnvelope } from '@office/contracts';
import type { Actor } from '@office/contracts';
import type { InMemoryEventSink } from '@office/actions';
import { failingAgentEventSink } from './execution-records';
import type { InMemoryAgentEventSink } from './execution-records';
import {
  parseActionProposedPayload,
  parseEvidenceGatheredPayload,
  parseGatewayDecisionPayload,
  parseRunCompletedPayload,
  parseRunStartedPayload,
} from './execution-records';
import type { AgentRunInput, AgentRunRecord } from './run';
import type { ApprovalReference } from '@office/actions';
import type { AgentHarness } from './test-support';
import {
  AGENT_ACTOR,
  ASSESSMENT_FOREIGN,
  CHANGE_EVENT_EVIDENCE_REF,
  CORRELATION_ID,
  GOAL_COMMIT_BUDGET,
  GOAL_LIST_COST_ITEMS,
  GOAL_PURGE_LEDGER,
  GOAL_RECORD_PROGRESS,
  GOAL_SUBMIT_DAILY_LOG,
  GOAL_UNEVIDENCED_COMMIT,
  MANAGER_ID,
  TENANT_B,
  canonicalScripts,
  envelope,
  expectFail,
  expectOk,
  fullGrant,
  makeAgentHarness,
  runInput,
  tenantScopeOf,
  unbackedBudgetRevisionDraft,
  unwrap,
} from './test-support';

/** Fixture helper: a branded EntityId from a known-good literal. */
const entityIdOf = (raw: string): EntityId => {
  const parsed = parseEntityId(raw);
  if (!parsed.ok) throw new TypeError(`fixture entity id: ${raw}`);
  return parsed.value;
};


// ----- assertion helpers -------------------------------------------------------------------

const GOAL_UNBACKED_COMMIT =
  'Commit the budget revision citing evidence the run never retrieved.';
const GOAL_UNEVIDENCED_PROGRESS =
  'Record the field progress observation without any evidence.';
const GOAL_EVIDENCED_DAILY_LOG =
  'Submit the daily log for project one grounding on the captured change event.';

/** The agent sink’s recorded events (the default in-memory sink). */
const agentEventsOf = (harness: AgentHarness): readonly DomainEventEnvelope[] =>
  (harness.agentSink as InMemoryAgentEventSink).events;

const agentEventNamesOf = (harness: AgentHarness): readonly string[] =>
  agentEventsOf(harness).map((event) => event.eventName);

const agentPayloadsOf = <P>(harness: AgentHarness): readonly P[] =>
  agentEventsOf(harness).map((event) => (event as DomainEventEnvelope<P>).payload);

/** The gateway sink’s recorded events (the default in-memory sink). */
const gatewayEventsOf = (harness: AgentHarness): readonly DomainEventEnvelope[] =>
  (harness.gatewaySink as InMemoryEventSink).events;

/** Total handler invocations across the whole harness (the chokepoint proof). */
const totalHandlerInvocations = (harness: AgentHarness): number =>
  Object.values(harness.handlerInvocations).reduce((sum, entry) => sum + entry.count, 0);

/** The denial detail code of a typed failure (its first detail). */
const denialCodeOf = (error: { readonly details: readonly { readonly code: string }[] }): string =>
  error.details[0]?.code ?? '';

/** The approval reference a parked run links (fails loud when not parked). */
const pendingApprovalOf = (run: AgentRunRecord): ApprovalReference => {
  const approval = run.pendingApprovals[0];
  if (approval === undefined) {
    throw new Error(`expected a pending approval, got status '${run.status}'`);
  }
  return approval;
};

// ----- THE named acceptance: gateway-mediated mutation only ----------------------------------

describe('THE gateway-mediated mutation path (the named acceptance)', () => {
  it('executes a reversible proposal ONLY through executeAction (invocation-counting proof)', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    expect(run.status).toBe('executed');
    // THE proof: exactly one gateway call, exactly one handler invocation —
    // the ONLY way the handler ran is executeAction() (freeze A8).
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations['field.recordProgress']?.count).toBe(1);
    expect(totalHandlerInvocations(harness)).toBe(1);
    // The run records the gateway's decision VERBATIM (no reinterpretation).
    expect(run.gatewayDecisions).toHaveLength(1);
    const decision = run.gatewayDecisions[0]?.decision;
    expect(decision && 'outcome' in decision ? decision.outcome.decision : null).toBe('executed');
    expect(run.proposals).toHaveLength(1);
    expect(run.proposals[0]?.proposal.command.commandName).toBe('field.recordProgress');
  });

  it('executes a read-class proposal through the same single gateway path', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_LIST_COST_ITEMS), fullGrant),
    );
    expect(run.status).toBe('executed');
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(harness.handlerInvocations['cost.listCostItems']?.count).toBe(1);
    expect(totalHandlerInvocations(harness)).toBe(1);
  });

  it('records every tool invocation of the run (read tools + the proposing tool)', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    expect(run.toolInvocations.map((invocation) => [invocation.tool, invocation.kind])).toStrictEqual([
      ['relationship-traversal', 'read'],
      ['margin-assessment', 'read'],
      ['memory-lookup', 'read'],
      ['model-proposer', 'propose-action'],
    ]);
    expect(run.toolInvocations[0]?.itemCount).toBe(3); // change-event, revision, budget-revision
    expect(run.toolInvocations[1]?.itemCount).toBe(1);
    expect(run.toolInvocations[2]?.itemCount).toBe(1);
    expect(run.toolInvocations[3]?.proposalCount).toBe(1);
    expect(run.modelId).toBe('mock-model-fixture-v1');
    expect(run.input.goal).toBe(GOAL_RECORD_PROGRESS);
  });
});

// ----- THE named acceptance: consequential recommendations REQUIRE evidence ------------------

describe('consequential recommendations REQUIRE evidence (THE named acceptance)', () => {
  it('rejects an unevidenced approval-required proposal typed BEFORE the gateway (counting proof)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_UNEVIDENCED_COMMIT),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(denialCodeOf(error)).toBe('proposal-without-evidence');
    expect(error.message).toContain('consequential proposal');
    // THE proof: executeAction() was NEVER reached — the model proposed, the
    // runtime typed-rejected, no handler ever ran.
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
    expect(harness.model.invocations.count).toBe(1);
    // The audit trail shows the run aborted BEFORE the action-proposed record.
    expect(agentEventNamesOf(harness)).toStrictEqual([
      'agents.agentRunStarted',
      'agents.agentEvidenceGathered',
    ]);
  });

  it('rejects an unevidenced REVERSIBLE proposal typed before the gateway the same way', async () => {
    const harness = await makeAgentHarness({
      scripts: [
        ...canonicalScripts(),
        {
          goal: GOAL_UNEVIDENCED_PROGRESS,
          drafts: [
            {
              command: envelope({ note: 'foundation poured', percent: 40 }, 'field.recordProgress'),
              subject: null,
              evidence: [],
              confidence: 'medium',
              rationale: 'A reversible proposal carrying no evidence references.',
              resourceScope: null,
            },
          ],
        },
      ],
    });
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_UNEVIDENCED_PROGRESS),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('proposal-without-evidence');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);

    // The canonical unevidenced daily-log script (reversible class) is
    // rejected the same way — the rule binds the CLASS, not the command.
    const dailyLogHarness = await makeAgentHarness();
    const dailyLog = await dailyLogHarness.runtime.runAgentGoal(
      runInput(GOAL_SUBMIT_DAILY_LOG),
      fullGrant,
    );
    expect(dailyLog.ok).toBe(false);
    expect(denialCodeOf(expectFail(dailyLog))).toBe('proposal-without-evidence');
    expect(dailyLogHarness.countedGateway.calls.count).toBe(0);
  });

  it('rejects a consequential proposal citing evidence refs the run never retrieved (unbacked)', async () => {
    const harness = await makeAgentHarness({
      scripts: [
        ...canonicalScripts(),
        { goal: GOAL_UNBACKED_COMMIT, drafts: [unbackedBudgetRevisionDraft()] },
      ],
    });
    const result = await harness.runtime.runAgentGoal(runInput(GOAL_UNBACKED_COMMIT), fullGrant);
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(denialCodeOf(error)).toBe('proposal-evidence-unbacked');
    expect(error.message).toContain('unknown0000000000000000000000000');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
  });

  it('rejects a consequential proposal grounded on an EMPTY evidence set (unqualified)', async () => {
    const harness = await makeAgentHarness();
    // An empty retrieval plan grounds the run on nothing: the consequential
    // proposal is typed-rejected BEFORE the gateway (freeze A4).
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_UNEVIDENCED_COMMIT, { retrievalPlan: [] }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(denialCodeOf(error)).toBe('empty-evidence-set');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
    expect(harness.model.invocations.evidenceCounts).toStrictEqual([0]);
  });

  it('carries the executed proposal’s evidence refs into BOTH audit trails', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    expect(run.status).toBe('executed');
    // The agent's own action-proposed record carries the { slot, ref } list.
    const proposedEvent = agentEventsOf(harness).find(
      (event) => event.eventName === 'agents.agentActionProposed',
    );
    expect(proposedEvent).toBeDefined();
    const proposed = (
      proposedEvent as DomainEventEnvelope<{
        runId: string;
        commandName: string;
        evidence: readonly { slot: string; ref: string }[];
      }>
    ).payload;
    expect(proposed.commandName).toBe('field.recordProgress');
    expect(proposed?.evidence).toStrictEqual([
      {
        slot: 'observation',
        ref: `change-event:${run.input.contextRefs[0]?.entityId ?? ''}`,
      },
    ]);
    expect(proposed?.runId).toBe(run.runId);
    // The gateway's own executed audit event carries the same refs verbatim.
    const executed = gatewayEventsOf(harness).find(
      (event) => event.eventName === 'actions.actionExecuted',
    );
    expect(executed).toBeDefined();
    const executedPayload = (executed as DomainEventEnvelope<{ evidence: unknown[] }>).payload;
    expect(executedPayload.evidence).toStrictEqual(proposed?.evidence);
    // And the run record itself carries the proposal with its refs.
    expect(run.proposals[0]?.proposal.evidence.map((reference) => reference.ref)).toStrictEqual(
      proposed?.evidence.map((reference) => reference.ref),
    );
  });
});

// ----- determinism: the run-twice proof -------------------------------------------------------

describe('determinism — identical harnesses, identical runs (run-twice)', () => {
  const runOnce = async (
    goal: string,
  ): Promise<{ run: AgentRunRecord; events: readonly string[] }> => {
    const harness = await makeAgentHarness();
    const run = expectOk(await harness.runtime.runAgentGoal(runInput(goal), fullGrant));
    return { run, events: agentEventsOf(harness).map((event) => JSON.stringify(event)) };
  };

  it('two identically-built harnesses produce byte-identical EXECUTED runs and trails', async () => {
    const first = await runOnce(GOAL_RECORD_PROGRESS);
    const second = await runOnce(GOAL_RECORD_PROGRESS);
    expect(JSON.stringify(second.run)).toStrictEqual(JSON.stringify(first.run));
    expect(second.events).toStrictEqual(first.events);
    expect(second.run.runId).toBe(first.run.runId);
    expect(second.run.startedAt).toBe(first.run.startedAt);
    expect(second.run.completedAt).toBe(first.run.completedAt);
  });

  it('two identically-built harnesses produce byte-identical AWAITING runs and trails', async () => {
    const first = await runOnce(GOAL_COMMIT_BUDGET);
    const second = await runOnce(GOAL_COMMIT_BUDGET);
    expect(JSON.stringify(second.run)).toStrictEqual(JSON.stringify(first.run));
    expect(second.events).toStrictEqual(first.events);
    expect(first.run.status).toBe('awaiting-approval');
  });

  it('replaying the same harness state mints sequential run ids (deterministic suppliers)', async () => {
    const harness = await makeAgentHarness();
    const first = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    const second = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_LIST_COST_ITEMS), fullGrant),
    );
    expect(first.runId).toBe('run-0001');
    expect(second.runId).toBe('run-0002');
  });
});

// ----- A12: tenant-scoped runs ------------------------------------------------------------------

describe('A12 — tenant-scoped runs and the deny-by-default agent actor', () => {
  it('a tenant-B run cannot retrieve tenant-A evidence (typed not-found, no existence oracle)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, { scope: tenantScopeOf(TENANT_B) }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('not-found');
    expect(denialCodeOf(error)).toBe('entity-not-found');
    // Nothing ran downstream of the failed retrieval.
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.model.invocations.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
  });

  it('cross-tenant evidence retrieval is typed-rejected at the tool boundary (foreign assessment)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, {
        retrievalPlan: [
          { tool: 'margin-assessment', query: { kind: 'margin-assessment', assessmentId: ASSESSMENT_FOREIGN } },
        ],
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('not-found');
    expect(denialCodeOf(error)).toBe('evidence-not-found');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
  });

  it('the agent actor is deny-by-default at the gateway (systematic actor-kind × command matrix)', async () => {
    const expectations: readonly [string, string, 'executed' | 'denied' | 'awaiting-approval'][] =
      [
        [GOAL_LIST_COST_ITEMS, 'cost.listCostItems', 'executed'],
        [GOAL_RECORD_PROGRESS, 'field.recordProgress', 'executed'],
        [GOAL_EVIDENCED_DAILY_LOG, 'documents.submitDailyLog', 'denied'],
        [GOAL_PURGE_LEDGER, 'cost.purgeCostLedger', 'denied'],
        [GOAL_COMMIT_BUDGET, 'cost.commitBudgetRevision', 'awaiting-approval'],
      ];
    for (const [goal, commandName, expectedStatus] of expectations) {
      // The daily-log fixture is human-only (actorKinds: ['user']) — an
      // evidenced agent proposal must STILL be denied at the gateway’s
      // actor-kind gate, exactly like any other actor kind would be.
      const harness = await makeAgentHarness({
        scripts:
          goal === GOAL_EVIDENCED_DAILY_LOG
            ? [
                ...canonicalScripts(),
                {
                  goal,
                  drafts: [
                    {
                      command: envelope({ entry: 'day 12' }, 'documents.submitDailyLog'),
                      subject: null,
                      evidence: [{ slot: 'log-context', ref: CHANGE_EVENT_EVIDENCE_REF }],
                      confidence: 'medium',
                      rationale: 'An evidenced daily log submission by an agent actor.',
                      resourceScope: null,
                    },
                  ],
                },
              ]
            : undefined,
      });
      const run = expectOk(await harness.runtime.runAgentGoal(runInput(goal), fullGrant));
      expect(run.status, `status of '${commandName}'`).toBe(expectedStatus);
      // Every proposal went through the gateway exactly once (decisions are
      // recorded verbatim — denials included).
      expect(harness.countedGateway.calls.count, `gateway calls for '${commandName}'`).toBe(1);
      const handlerCount =
        Object.entries(harness.handlerInvocations)
          .filter(([name]) => name === commandName)
          .reduce((sum, [, counter]) => sum + counter.count, 0);
      expect(handlerCount, `handler invocations of '${commandName}'`).toBe(
        expectedStatus === 'executed' ? 1 : 0,
      );
      if (expectedStatus === 'denied') {
        const denial = run.gatewayDecisions[0]?.decision;
        expect(denial && 'denial' in denial ? denial.denial.code : null).toBe('forbidden');
      }
    }
  });

  it('the user-only daily-log descriptor denies the AGENT actor typed (no actor-kind bypass)', async () => {
    const harness = await makeAgentHarness({
      scripts: [
        ...canonicalScripts(),
        {
          goal: GOAL_EVIDENCED_DAILY_LOG,
          drafts: [
            {
              command: envelope({ entry: 'day 12' }, 'documents.submitDailyLog'),
              subject: null,
              evidence: [{ slot: 'log-context', ref: CHANGE_EVENT_EVIDENCE_REF }],
              confidence: 'medium',
              rationale: 'An evidenced daily log submission by an agent actor.',
              resourceScope: null,
            },
          ],
        },
      ],
    });
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_EVIDENCED_DAILY_LOG), fullGrant),
    );
    expect(run.status).toBe('denied');
    expect(run.completedAt).not.toBeNull();
    const denial = run.gatewayDecisions[0]?.decision;
    expect(
      denial && 'denial' in denial ? denialCodeOf(denial.denial) : null,
    ).toBe('actor-kind-not-permitted');
    expect(totalHandlerInvocations(harness)).toBe(0);
  });
});

// ----- the approval handoff ---------------------------------------------------------------------

describe('the approval handoff (routed → pending → resolved)', () => {
  it('parks a routed run awaiting-approval with the approval linked (no completion yet)', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_COMMIT_BUDGET), fullGrant),
    );
    expect(run.status).toBe('awaiting-approval');
    expect(run.completedAt).toBeNull();
    const approval = pendingApprovalOf(run);
    expect(approval.approvalKey).toBe('action');
    expect(approval.instanceId).toBe('office-ent-v1-0000000000000001');
    // The run LINKS the approval: the routed decision carries it verbatim.
    const routed = run.gatewayDecisions[0]?.decision;
    expect(
      routed && 'outcome' in routed && routed.outcome.decision === 'routed-to-approval'
        ? routed.outcome.approval.instanceId
        : null,
    ).toBe(approval.instanceId);
    // Nothing executed while pending; no run-completed record exists yet.
    expect(harness.handlerInvocations['cost.commitBudgetRevision']?.count).toBe(0);
    expect(harness.countedGateway.calls.count).toBe(1);
    expect(agentEventNamesOf(harness)).not.toContain('agents.agentRunCompleted');
  });

  it('completes the run on an APPROVED resolution (re-enters the gateway, executes once)', async () => {
    const harness = await makeAgentHarness();
    const parked = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_COMMIT_BUDGET), fullGrant),
    );
    const approval = pendingApprovalOf(parked);
    expectOk(harness.approvalAuthority.decide(approval, 'approved', MANAGER_ID));

    const resolved = expectOk(
      await harness.runtime.resolveApproval(
        parked,
        { approval, decided: 'approved' },
        fullGrant,
      ),
    );
    expect(resolved.status).toBe('executed');
    expect(resolved.completedAt).not.toBeNull();
    expect(resolved.pendingApprovals).toStrictEqual([]);
    // The gateway was re-entered exactly once more; the handler ran exactly once.
    expect(harness.countedGateway.calls.count).toBe(2);
    expect(harness.countedGateway.calls.keys).toStrictEqual([
      parked.proposals[0]?.proposal.command.idempotencyKey,
      parked.proposals[0]?.proposal.command.idempotencyKey,
    ]);
    expect(harness.handlerInvocations['cost.commitBudgetRevision']?.count).toBe(1);
    expect(resolved.gatewayDecisions).toHaveLength(2);
    // The completion record arrived only now.
    const completed = agentPayloadsOf<{
      runId: string;
      status: string;
      executedCount: number;
    }>(harness)
      .filter((payload) => payload.runId === parked.runId && 'executedCount' in payload)
      .at(0);
    expect(completed?.status).toBe('executed');
    expect(completed?.executedCount).toBe(1);
    // The gateway's own executed audit carries the approval provenance.
    const executed = gatewayEventsOf(harness).find(
      (event) => event.eventName === 'actions.actionExecuted',
    );
    const executedPayload = (
      executed as DomainEventEnvelope<{
        approval: { instanceId: string } | null;
        approvalStatus: string | null;
        decidedBy: string | null;
      }>
    ).payload;
    expect(executedPayload.approval?.instanceId).toBe(approval.instanceId);
    expect(executedPayload.approvalStatus).toBe('approved');
    expect(executedPayload.decidedBy).toBe(MANAGER_ID);
  });

  it('completes the run DENIED on a REJECTED resolution (typed rejection, nothing executes)', async () => {
    const harness = await makeAgentHarness();
    const parked = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_COMMIT_BUDGET), fullGrant),
    );
    const approval = pendingApprovalOf(parked);
    expectOk(harness.approvalAuthority.decide(approval, 'rejected', MANAGER_ID));

    const resolved = expectOk(
      await harness.runtime.resolveApproval(
        parked,
        { approval, decided: 'rejected' },
        fullGrant,
      ),
    );
    expect(resolved.status).toBe('denied');
    expect(resolved.completedAt).not.toBeNull();
    expect(harness.handlerInvocations['cost.commitBudgetRevision']?.count).toBe(0);
    expect(harness.countedGateway.calls.count).toBe(2);
    const denial = resolved.gatewayDecisions[1]?.decision;
    expect(denial && 'denial' in denial ? denialCodeOf(denial.denial) : null).toBe(
      'approval-rejected',
    );
  });

  it('resolving a run that is not awaiting approval is a typed invariant violation', async () => {
    const harness = await makeAgentHarness();
    const executed = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    const result = await harness.runtime.resolveApproval(
      executed,
      {
        approval: { instanceId: entityIdOf('office-ent-v1-0000000000000009'), approvalKey: 'action' },
        decided: 'approved',
      },
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('run-not-awaiting-approval');
  });

  it('resolving an approval this run does not hold is typed not-found', async () => {
    const harness = await makeAgentHarness();
    const parked = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_COMMIT_BUDGET), fullGrant),
    );
    const result = await harness.runtime.resolveApproval(
      parked,
      {
        approval: { instanceId: entityIdOf('office-ent-v1-0000000000000009'), approvalKey: 'action' },
        decided: 'approved',
      },
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('approval-not-pending');
    expect(harness.countedGateway.calls.count).toBe(1); // no re-entry happened
  });
});

// ----- execution records: the agent audit trail through the EventSink port ---------------------

describe('execution records — the five lifecycle envelopes through the AgentEventSink', () => {
  it('emits run started / evidence gathered / action proposed / gateway decision / run completed, in order', async () => {
    const harness = await makeAgentHarness();
    const run = expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    expect(agentEventNamesOf(harness)).toStrictEqual([
      'agents.agentRunStarted',
      'agents.agentEvidenceGathered',
      'agents.agentActionProposed',
      'agents.agentGatewayDecisionRecorded',
      'agents.agentRunCompleted',
    ]);
    const events = agentEventsOf(harness);
    const key = run.proposals[0]?.proposal.command.idempotencyKey;
    for (const event of events) {
      expect(event.actor).toStrictEqual(AGENT_ACTOR); // the A4 source identity
      expect(event.source).toBe('system'); // platform machinery on the agent's behalf
      expect(event.scope).toStrictEqual(run.input.scope);
      expect(event.causality.correlationId).toBe(CORRELATION_ID); // A3 correlation
    }
    // Causation: the run causes its lifecycle; the command key causes the
    // proposal/decision records (the gateway's own convention).
    expect(events[0]?.causality.causationId).toBe(run.runId);
    expect(events[1]?.causality.causationId).toBe(run.runId);
    expect(events[2]?.causality.causationId).toBe(key);
    expect(events[3]?.causality.causationId).toBe(key);
    expect(events[4]?.causality.causationId).toBe(run.runId);
  });

  it('emits payloads that parse through the audit payload parsers (fail-closed round-trip)', async () => {
    const harness = await makeAgentHarness();
    expectOk(
      await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant),
    );
    const payloads = agentEventsOf(harness).map(
      (event) => (event as DomainEventEnvelope<Record<string, unknown>>).payload,
    );
    expect(unwrap(parseRunStartedPayload(payloads[0])).modelId).toBe('mock-model-fixture-v1');
    expect(unwrap(parseRunStartedPayload(payloads[0])).tools).toStrictEqual([
      'relationship-traversal',
      'margin-assessment',
      'memory-lookup',
      'model-proposer',
    ]);
    const gathered = unwrap(parseEvidenceGatheredPayload(payloads[1]));
    expect(gathered.items.map((item) => [item.kind, item.tool])).toStrictEqual([
      ['entity', 'relationship-traversal'],
      ['entity', 'relationship-traversal'],
      ['entity', 'relationship-traversal'],
      ['margin-assessment', 'margin-assessment'],
      ['memory-outcome', 'memory-lookup'],
    ]);
    const proposed = unwrap(parseActionProposedPayload(payloads[2]));
    expect(proposed.commandName).toBe('field.recordProgress');
    expect(proposed.evidence).toHaveLength(1);
    expect(proposed.evidence[0]?.slot).toBe('observation');
    const decision = unwrap(parseGatewayDecisionPayload(payloads[3]));
    expect(decision.decision).toBe('executed');
    expect(decision.replayed).toBe(false);
    expect(decision.approval).toBeNull();
    const completed = unwrap(parseRunCompletedPayload(payloads[4]));
    expect(completed.status).toBe('executed');
    expect(completed.executedCount).toBe(1);
    expect(completed.pendingApprovals).toStrictEqual([]);
  });

  it('a sink failure aborts the run typed (fail-closed audit — no partial trail is left behind)', async () => {
    const harness = await makeAgentHarness({
      agentSink: failingAgentEventSink('the ledger is unavailable'),
    });
    const result = await harness.runtime.runAgentGoal(runInput(GOAL_RECORD_PROGRESS), fullGrant);
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(denialCodeOf(error)).toBe('agent-sink-rejected');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(totalHandlerInvocations(harness)).toBe(0);
    expect(harness.model.invocations.count).toBe(0);
  });
});

// ----- fail-closed run wiring -------------------------------------------------------------------

describe('fail-closed run wiring (typed rejections, never silent skips)', () => {
  it('rejects an unregistered read tool typed (tool-not-registered)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, {
        retrievalPlan: [{ tool: 'no-such-tool', query: { kind: 'memory-lessons' } }],
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('tool-not-registered');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(harness.model.invocations.count).toBe(0);
  });

  it('rejects a proposing tool in a retrieval step typed (tool-kind-mismatch)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, {
        retrievalPlan: [{ tool: 'model-proposer', query: { kind: 'memory-lessons' } }],
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('tool-kind-mismatch');
    expect(agentEventNamesOf(harness)).toStrictEqual(['agents.agentRunStarted']);
  });

  it('rejects a read tool as the proposing tool typed (tool-kind-mismatch, before the trail opens)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, { proposingTool: 'relationship-traversal' }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    expect(denialCodeOf(expectFail(result))).toBe('tool-kind-mismatch');
    expect(agentEventsOf(harness)).toStrictEqual([]);
  });

  it('rejects a structurally invalid run input typed (a non-agent actor cannot run)', async () => {
    const harness = await makeAgentHarness();
    const invalid = {
      ...runInput(GOAL_RECORD_PROGRESS),
      actor: { kind: 'user', actorId: MANAGER_ID } as unknown as Actor,
    } as AgentRunInput;
    const result = await harness.runtime.runAgentGoal(invalid, fullGrant);
    expect(result.ok).toBe(false);
    const error = expectFail(result);
    expect(error.code).toBe('invariant-violation');
    expect(error.message).toContain('invalid agent run input');
    expect(denialCodeOf(error)).toBe('invalid-value');
    expect(harness.countedGateway.calls.count).toBe(0);
    expect(agentEventsOf(harness)).toStrictEqual([]);
  });

  it('the tenant scope of the run bounds every emitted envelope (A12 in the trail)', async () => {
    const harness = await makeAgentHarness();
    const result = await harness.runtime.runAgentGoal(
      runInput(GOAL_RECORD_PROGRESS, { scope: tenantScopeOf(TENANT_B) }),
      fullGrant,
    );
    expect(result.ok).toBe(false); // the tenant-A evidence is invisible to tenant B
    // The run-started record that WAS emitted carries the run's own scope.
    const started = agentEventsOf(harness).at(0);
    expect(started?.scope).toStrictEqual(tenantScopeOf(TENANT_B));
    expect(started?.eventName).toBe('agents.agentRunStarted');
  });
});
