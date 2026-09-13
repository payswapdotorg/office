// OFF-017 acceptance — the @office/workflows-backed approval authority: the
// production seam of the approval-required routing, driven against the REAL
// workflow engine (in-memory store + commands + sink, the same wiring the
// workflows package's own suites use) THROUGH the REAL gateway. This is the
// proof that the workflows package's API is workable for approval routing
// (the item's named stop condition) and that THE approval acceptance — an
// approval-required action NEVER executes without the workflow approval
// completing — holds through the production adapter, not just the stub:
//
// - routing starts a REAL workflow instance from the pinned PUBLISHED
//   definition and reports the approval 'pending' (the handler never runs);
// - force-execute while the engine's approval is still pending → typed
//   rejection, handler never invoked;
// - the action executes ONLY after the engine's approval completed
//   (submit + approve through the engine's capability-gated commands), with
//   the approval provenance (reference/status/decider/decidedAt) carried into
//   the executed audit event;
// - a REJECTED engine approval blocks execution with the typed rejection;
// - no published definition in the action's scope → typed not-found (the
//   gateway never creates workflow definitions);
// - a published definition declaring a different decision gate than the
//   descriptor → typed routing mismatch (fail-closed wiring check);
// - A12: a definition published in ANOTHER project of the same tenant is
//   invisible to the routing (typed not-found, no existence oracle);
// - the routing is idempotent at the engine: the same action key re-opens the
//   SAME approval instance (replayed, no second instance, no second event).
import { describe, expect, it } from 'vitest';
import { parseTimestamp } from '@office/contracts';
import type { DomainEventEnvelope } from '@office/contracts';
import { createInMemoryIdempotencyRegistry } from '@office/domain-kernel';
import {
  AGENT,
  FAKE_EXECUTOR,
  MANAGER,
  PROJECT_2,
  actorOf,
  envelope,
  fullGrant,
  makeCountingHandler,
  makeWorkflowEngine,
  projectScopeOf,
  proposal,
  publishActionApprovalDefinition,
  rejectThroughEngine,
  approveThroughEngine,
  subjectRef,
  unwrap,
  workflowOperatorGrant,
} from './test-support';
import {
  CANONICAL_DESCRIPTORS,
  COMMIT_BUDGET_REVISION,
} from './test-support';
import { createWorkflowApprovalAuthority } from './workflow-approval';
import type { ApprovalRoutingRequest } from './approval';
import { createInMemoryActionRegistry } from './registry';
import { createInMemoryActionHandlers } from './handlers';
import { createInMemoryEventSink } from './audit-events';
import type { ActionAuditPayload, InMemoryEventSink } from './audit-events';
import { createActionGateway } from './gateway';
import type { ActionGateway, ActionResult } from './gateway';

// ----- the real-engine gateway wiring --------------------------------------------------------

/** The gateway wired through the REAL workflow engine's approval authority. */
interface EngineHarness {
  readonly gateway: ActionGateway;
  readonly engine: ReturnType<typeof makeWorkflowEngine>;
  readonly sink: InMemoryEventSink;
  readonly invocations: { readonly count: () => number };
}

/**
 * Wire the REAL gateway with the workflow-engine-backed approval authority
 * (deterministic fixed clock, counting handler for the approval fixture, the
 * canonical descriptor registry).
 */
const makeHarness = (): EngineHarness => {
  const engine = makeWorkflowEngine();
  const authority = createWorkflowApprovalAuthority({
    commands: engine.commands,
    store: engine.store,
    authorization: workflowOperatorGrant,
  });
  const counting = makeCountingHandler();
  const sink = createInMemoryEventSink();
  const gateway = createActionGateway({
    registry: createInMemoryActionRegistry(CANONICAL_DESCRIPTORS),
    handlers: createInMemoryActionHandlers({
      [COMMIT_BUDGET_REVISION.commandName as string]: counting.handler,
    }),
    idempotencyRegistry: createInMemoryIdempotencyRegistry(),
    eventSink: sink,
    approvalAuthority: authority,
    now: () => unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
    newEntityId: () => AGENT,
    executor: FAKE_EXECUTOR,
  });
  return {
    gateway,
    engine,
    sink,
    invocations: { count: () => counting.invocations.count },
  };
};

/** The approval reference a routed result carries (fails loud when not routed). */
const approvalOf = (result: { readonly ok: boolean; readonly value?: unknown }): {
  readonly instanceId: string;
  readonly approvalKey: string;
} => {
  if (!result.ok) {
    throw new Error(`expected a routing outcome, got: ${JSON.stringify(result)}`);
  }
  const value = result.value as ActionResult | undefined;
  if (value === undefined || value.decision !== 'routed-to-approval') {
    throw new Error(`expected 'routed-to-approval', got: ${JSON.stringify(value)}`);
  }
  return value.approval;
};

/** The audit payloads of the recorded sink events, in order. */
const payloads = (sink: InMemoryEventSink): ActionAuditPayload[] =>
  sink.events.map((event) => (event as DomainEventEnvelope<ActionAuditPayload>).payload);

/** The denial detail code of a typed failure (its first detail). */
const denialCodeOf = (error: { readonly details: readonly { readonly code: string }[] }): string =>
  error.details[0]?.code ?? '';

/** The canonical approval-required proposal (evidence + confidence met). */
const commitCommand = () =>
  envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
    actor: actorOf('agent', AGENT),
  });

const commitProposal = (
  command: ReturnType<typeof commitCommand>,
  approval: { readonly instanceId: string; readonly approvalKey: string } | null = null,
) =>
  proposal(command, {
    subject: subjectRef(),
    evidence: [
      { slot: 'justification', ref: 'note-0001' },
      { slot: 'margin-assessment', ref: 'margin-0001' },
    ],
    confidence: 'high',
    approval,
  });

// ----- the production seam against the real engine -------------------------------------------

describe('the workflow-engine-backed approval authority (the production seam)', () => {
  it('routes an approval-required action into a REAL pending workflow instance (handler never invoked)', async () => {
    const harness = makeHarness();
    await publishActionApprovalDefinition(harness.engine);
    const command = commitCommand();
    const result = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(result.ok).toBe(true);
    const approval = result.ok ? approvalOf(result) : null;
    expect(approval?.approvalKey).toBe('action');

    // A REAL instance exists in the engine, its approval step 'pending'.
    const instances = harness.engine.store.instances();
    expect(instances).toHaveLength(1);
    const instance = instances[0];
    expect(instance?.entityId).toBe(approval?.instanceId);
    expect(instance?.approvals[0]?.key).toBe('action');
    expect(instance?.approvals[0]?.status).toBe('pending');

    // The handler never ran; the routing was audited.
    expect(harness.invocations.count()).toBe(0);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]?.eventName).toBe('actions.actionRoutedToApproval');
    expect(payloads(harness.sink)[0]?.approvalStatus).toBe('pending');
  });

  it('NEVER executes while the engine approval is pending: force-execute → typed rejection', async () => {
    const harness = makeHarness();
    await publishActionApprovalDefinition(harness.engine);
    const command = commitCommand();
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const approval = routed.ok ? approvalOf(routed) : null;
    expect(approval).not.toBeNull();

    const forced = await harness.gateway.executeAction(
      commitProposal(command, approval),
      fullGrant,
    );
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.error.code).toBe('forbidden');
      expect(denialCodeOf(forced.error)).toBe('approval-not-completed');
    }
    expect(harness.invocations.count()).toBe(0);
    // The engine holds exactly ONE instance for the action (idempotent re-open).
    expect(harness.engine.store.instances()).toHaveLength(1);
  });

  it('executes ONLY after the engine approval completed, carrying the approval provenance', async () => {
    const harness = makeHarness();
    await publishActionApprovalDefinition(harness.engine);
    const command = commitCommand();
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    const approval = routed.ok ? approvalOf(routed) : null;
    expect(approval).not.toBeNull();

    // Drive the approval to 'approved' through the engine's capability-gated
    // command surface (submit + approve, a human approver).
    if (approval) {
      await approveThroughEngine(harness.engine, approval.instanceId);
    }

    const executed = await harness.gateway.executeAction(
      commitProposal(command, approval),
      fullGrant,
    );
    expect(executed.ok).toBe(true);
    if (executed.ok) {
      expect(executed.value.decision).toBe('executed');
      expect(executed.value.replayed).toBe(false);
    }
    expect(harness.invocations.count()).toBe(1);
    const payload = payloads(harness.sink).at(-1);
    expect(payload?.decision).toBe('executed');
    expect(payload?.approval?.instanceId).toBe(approval?.instanceId);
    expect(payload?.approvalStatus).toBe('approved');
    expect(payload?.decidedBy).toBe(MANAGER);
    expect(payload?.decidedAt).not.toBeNull();
  });

  it('a REJECTED engine approval blocks execution with the typed rejection', async () => {
    const harness = makeHarness();
    await publishActionApprovalDefinition(harness.engine);
    const command = commitCommand();
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    const approval = routed.ok ? approvalOf(routed) : null;
    expect(approval).not.toBeNull();
    if (approval) {
      await rejectThroughEngine(harness.engine, approval.instanceId);
    }

    const forced = await harness.gateway.executeAction(
      commitProposal(command, approval),
      fullGrant,
    );
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.error.code).toBe('forbidden');
      expect(denialCodeOf(forced.error)).toBe('approval-rejected');
    }
    expect(harness.invocations.count()).toBe(0);
  });

  it('fails typed not-found when no definition is published in the action scope (definitions are never created here)', async () => {
    const harness = makeHarness();
    // No publishActionApprovalDefinition call: nothing is published.
    const command = commitCommand();
    const result = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(denialCodeOf(result.error)).toBe('approval-definition-not-published');
      expect(result.error.message).toContain('never creates workflow definitions');
    }
    expect(harness.invocations.count()).toBe(0);
    expect(harness.engine.store.instances()).toHaveLength(0);
  });

  it('fails typed routing mismatch when the published definition declares a different decision gate', async () => {
    const harness = makeHarness();
    // The definition's approval requires 'documents.write' — the descriptor
    // declares 'cost.write': the wiring disagrees, fail-closed.
    await publishActionApprovalDefinition(harness.engine, {
      approvalCapability: 'documents.write',
    });
    const command = commitCommand();
    const result = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(denialCodeOf(result.error)).toBe('approval-routing-mismatch');
    }
    expect(harness.invocations.count()).toBe(0);
    expect(harness.engine.store.instances()).toHaveLength(0);
  });

  it('A12: a definition published in ANOTHER project is invisible to the routing (typed not-found)', async () => {
    const harness = makeHarness();
    await publishActionApprovalDefinition(harness.engine, {
      scope: projectScopeOf(PROJECT_2),
    });
    const command = commitCommand(); // commanded in PROJECT_1
    const result = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(denialCodeOf(result.error)).toBe('approval-definition-not-published');
    }
    expect(harness.engine.store.instances()).toHaveLength(0);
  });

  it('re-opening the same action re-opens the SAME approval instance (engine idempotency)', async () => {
    const engine = makeWorkflowEngine();
    await publishActionApprovalDefinition(engine);
    const authority = createWorkflowApprovalAuthority({
      commands: engine.commands,
      store: engine.store,
      authorization: workflowOperatorGrant,
    });
    const routing = COMMIT_BUDGET_REVISION.approval;
    if (routing === null) throw new Error('fixture invariant broken: approval routing missing');
    const request: ApprovalRoutingRequest = {
      command: commitCommand(),
      subject: subjectRef(),
      routing,
    };
    const first = await authority.openApproval(request);
    expect(first.ok).toBe(true);
    const second = await authority.openApproval(request);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.reference.instanceId).toBe(first.value.reference.instanceId);
      expect(second.value.replayed).toBe(true);
      expect(first.value.replayed).toBe(false);
    }
    expect(engine.store.instances()).toHaveLength(1); // no second instance
  });
});
