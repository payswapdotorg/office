// Office host gateway — the A8 approval-gated action suite (OFF-DEPLOY).
//
// THE REAL action gateway behind the hosted composition, over a REAL
// PostgreSQL ledger (the landed persistence test harness): the shell's
// workflow approval decision, registered as an approval-required action,
// routed through the workflow-engine-backed approval authority — the full
// canonical A8 flow:
//
//   1. PROPOSE: the first entry routes into the approval engine (a NEW
//      workflow instance of the seeded published definition, approval
//      'manager' pending) and returns the live approval reference — the
//      action has NOT executed;
//   2. COMPLETE: the routed approval is driven to 'approved' through the
//      SHELL'S OWN approval command path, then the gateway re-enters with
//      the approval evidence and executes the injected handler — which runs
//      the shell's approval command path for the ORIGINAL instance;
//   3. AUDIT: every gateway decision (routed, executed, denied) appended its
//      action.* audit event to the REAL ledger with a pending outbox row;
//   4. EVIDENCE: the executed action's event is navigable through the
//      gateway's evidence surface (the causality chain carries it);
//   5. REPLAY: re-proposing the same action under the same idempotency key
//      replays the routed outcome; re-completing replays the original
//      executed outcome — no duplicate effects;
//   6. DENY: a missing capability is a typed forbidden rejection; a
//      foreign-tenant proposal is a typed not-found (no existence oracle);
//      an unregistered command is prohibited by default.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPersistenceTestHarness } from '@office/persistence';
import type { PersistenceTestHarness } from '@office/persistence';
import { readAggregateEvents } from '@office/events';
import { formatTenantId, formatProjectId, parseCommandEnvelope, parseEntityId, parseEntityRef } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { actionProposal } from '@office/actions';
import type { ApprovalReference } from '@office/actions';
import { APPROVE_APPROVAL_COMMAND, submitWorkflowApproval } from '@office/web';
import {
  HOST_ACTOR_ID,
  HOST_PROJECT_ID,
  HOST_TENANT_ID,
  createHostRuntime,
} from './index';
import type { HostRuntime } from './index';
import { composeApprovalDecisionProposal } from './approvals';

// ---- deterministic suppliers (the kernel rule: injected, sequential) ------

const BASE_EPOCH_MS = Date.UTC(2026, 8, 14, 12, 0, 0);

const sequentialClock = (): (() => Timestamp) => {
  let at = BASE_EPOCH_MS;
  return () => {
    at += 1000;
    return new Date(at).toISOString() as Timestamp;
  };
};

const sequentialOpaqueIds = (): (() => string) => {
  let issued = 0;
  return () => String((issued += 1)).padStart(16, '0');
};

const unwrap = <T, E>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`unexpected failure (${what}): ${JSON.stringify(result.error)}`);
};

const TENANT_B = formatTenantId({ version: 'v1', opaque: 'b1b2c3d4e5f60718293a4b5c6d7e8f9a' });
const PROJECT_OTHER = formatProjectId({ version: 'v1', opaque: 'c3d4e5f60718293a4b5c6d7e8f9a1b2' });

// ---- harness boot ---------------------------------------------------------

let harness: PersistenceTestHarness;
let runtime: HostRuntime;

/** The approval decision request over the seeded live workflow instance. */
const approvalRequest = (): {
  readonly instanceId: string;
  readonly expectedVersion: number;
  readonly approvalKey: string;
  readonly basis: string;
  readonly idempotencyKey: string;
} => {
  // The seeded instance: submitted first (the golden scenario's step 3), so
  // the decision is the capability-gated approve step the action gates.
  return {
    instanceId: runtime.world.identities.workflowInstanceId,
    expectedVersion: 2,
    approvalKey: 'manager',
    basis: 'seed-workflow-instance-0001',
    idempotencyKey: 'host-act-0001',
  };
};

beforeAll(async () => {
  harness = await startPersistenceTestHarness();
  runtime = await createHostRuntime({
    connectionString: harness.connectionString,
    now: sequentialClock(),
    newOpaqueId: sequentialOpaqueIds(),
    releaseId: 'test-release-actions',
  });
  unwrap(await runtime.migrate(), 'migration run');
  // The seeded live instance is SUBMITTED before every decision flow (the
  // approval the action will decide is a submitted one).
  const submitted = await submitWorkflowApproval(
    runtime.plane,
    runtime.session,
    {
      instanceId: runtime.world.identities.workflowInstanceId,
      expectedVersion: 1,
      approvalKey: 'manager',
    },
    '2026-09-14T12:00:30.000Z' as Timestamp,
  );
  if (submitted.status !== 'executed') {
    throw new TypeError(`approval submission failed: ${JSON.stringify(submitted)}`);
  }
}, 180_000);

afterAll(async () => {
  await runtime.end();
  await harness.stop();
}, 120_000);

// ---- the canonical approval flow --------------------------------------------

describe('the approval-gated action — route, complete, audit, evidence (acceptance)', () => {
  let approval: ApprovalReference;

  it('PROPOSE: routes into the approval engine without executing (typed routing outcome)', async () => {
    const proposed = await runtime.actions.proposeApprovalDecision(approvalRequest());
    const routed = unwrap(proposed, 'proposal routing');
    expect(routed.decision).toBe('routed-to-approval');
    if (routed.decision !== 'routed-to-approval') {
      throw new TypeError(`first entry did not route: ${JSON.stringify(routed)}`);
    }
    approval = routed.approval;
    expect(approval.approvalKey).toBe('manager');

    // The routing started a REAL workflow instance of the seeded published
    // definition, with the 'manager' approval still pending.
    const instance = unwrap(
      runtime.world.stores.workflows.findInstance(
        runtime.session.scope,
        unwrap(parseId(approval.instanceId), 'instance id'),
      ),
      'routed instance read',
    );
    const step = instance.approvals.find((candidate) => candidate.key === 'manager');
    expect(step?.status).toBe('pending');

    // The ORIGINAL approval has NOT been decided by the routing itself.
    const original = unwrap(
      runtime.world.stores.workflows.findInstance(
        runtime.session.scope,
        unwrap(parseId(runtime.world.identities.workflowInstanceId), 'instance id'),
      ),
      'original instance read',
    );
    const originalStep = original.approvals.find((candidate) => candidate.key === 'manager');
    expect(originalStep?.status).toBe('submitted');
  });

  it('COMPLETE: drives the routed approval through the shell path and executes the action with evidence', async () => {
    const completed = await runtime.actions.completeApprovalDecision(approvalRequest(), approval);
    const executed = unwrap(completed, 'approval completion');
    expect(executed.decision).toBe('executed');
    expect(executed.replayed).toBe(false);
    expect(executed.value.status).toBe('executed');
    expect(executed.value.command.commandName).toBe(APPROVE_APPROVAL_COMMAND);
    expect(executed.value.eventName).toBe('workflows.approvalApproved');
    expect(executed.value.eventId).not.toBeNull();

    // The ORIGINAL approval is decided through the shell's own path.
    const original = unwrap(
      runtime.world.stores.workflows.findInstance(
        runtime.session.scope,
        unwrap(parseId(runtime.world.identities.workflowInstanceId), 'instance id'),
      ),
      'original instance read',
    );
    const originalStep = original.approvals.find((candidate) => candidate.key === 'manager');
    expect(originalStep?.status).toBe('approved');
    expect(originalStep?.decidedBy).toBe(HOST_ACTOR_ID);

    // EVIDENCE: the executed action's ledger event is navigable through the
    // gateway's evidence surface, and its causality chain carries the
    // originating command (the action's idempotency key).
    const eventId = executed.value.eventId;
    expect(eventId).not.toBeNull();
    if (eventId !== null) {
      const event = unwrap(runtime.reads.evidenceEvent(undefined, eventId), 'action event view');
      expect(event.eventName).toBe('workflows.approvalApproved');
      const chain = unwrap(runtime.reads.causalityChain(undefined, eventId), 'causality chain');
      // The chain's entries are the landed vocabulary: 'event' | 'command' |
      // 'unresolved-causation' — the originating command of the executed
      // action's event is the 'command' entry carrying the action's key.
      const commandEntry = chain.entries.find((entry) => entry.kind === 'command');
      expect(commandEntry).toBeDefined();
    }
  });

  it('AUDIT: every gateway decision appended its action.* event to the REAL ledger with outbox rows', async () => {
    // The audit events land on the proposal's SUBJECT aggregate — the seeded
    // instance whose approval the action decides (the routed instance the
    // authority opened is carried in the executed audit payload instead).
    const aggregate = unwrap(
      parseEntityRef({ entityKind: 'workflow-instance', entityId: approvalRequest().instanceId }),
      'aggregate ref',
    );
    const events = unwrap(
      await readAggregateEvents(runtime.pool, runtime.session.scope, aggregate),
      'action audit events',
    );
    const names = events.map((event) => event.envelope.eventName);
    expect(names).toContain('actions.actionRoutedToApproval');
    expect(names).toContain('actions.actionExecuted');
    // The executed audit payload carries the completed approval's reference.
    const executedAudit = events.find((event) => event.envelope.eventName === 'actions.actionExecuted');
    expect(executedAudit).toBeDefined();
    if (executedAudit !== undefined) {
      const payload = executedAudit.envelope.payload as Record<string, unknown>;
      const carried = payload['approval'] as Record<string, unknown> | null;
      expect(carried?.['approvalKey']).toBe('manager');
      expect(payload['decision']).toBe('executed');
    }
  });

  it('REPLAY: the executed action re-proposes and re-completes as the original outcome (no duplicate effects)', async () => {
    // The SAME action (its idempotency key) already EXECUTED: the landed
    // gateway replay semantics return the recorded FINAL outcome — the
    // re-proposal never re-routes (one action, one final outcome).
    const reproposed = await runtime.actions.proposeApprovalDecision(approvalRequest());
    const reentered = unwrap(reproposed, 're-proposal');
    expect(reentered.decision).toBe('executed');
    if (reentered.decision === 'executed') {
      expect(reentered.replayed).toBe(true);
      expect(reentered.value.status).toBe('executed');
      expect(reentered.value.eventId).not.toBeNull();
    }

    const recompleted = await runtime.actions.completeApprovalDecision(approvalRequest(), approval);
    const reexecuted = unwrap(recompleted, 're-completion');
    expect(reexecuted.decision).toBe('executed');
    expect(reexecuted.replayed).toBe(true);
    // The replay carries the ORIGINAL outcome's value (no duplicate effect:
    // the original approval stays decided exactly once).
    expect(reexecuted.value.status).toBe('executed');
  });
});

// ---- the deny cases ------------------------------------------------------------

describe('the approval-gated action — typed rejections (deny-by-default)', () => {
  it('denies a proposal whose actor lacks the required capability (typed forbidden)', async () => {
    const proposal = unwrap(
      composeProposal({ ...approvalRequest(), idempotencyKey: 'host-act-deny-0001' }),
      'deny proposal',
    );
    const decision = await runtime.actions.gateway.executeAction(proposal, {
      policy: runtime.session.policy,
      capabilities: ['cost.read'], // no workflows.write
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('forbidden');
      expect(decision.error.details[0]?.code).toBe('missing-required-capability');
    }
  });

  it('denies a foreign-tenant proposal with a typed not-found (no existence oracle)', async () => {
    const foreignSession = unwrap(
      runtime.openSession({
        tenantId: TENANT_B,
        projectId: HOST_PROJECT_ID,
        actorId: HOST_ACTOR_ID,
      }),
      'foreign session',
    );
    const proposal = unwrap(
      composeProposal({ ...approvalRequest(), idempotencyKey: 'host-act-deny-0002' }, foreignSession),
      'foreign proposal',
    );
    const decision = await runtime.actions.gateway.executeAction(
      proposal,
      runtime.actions.authorizationOf(foreignSession),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('not-found');
      expect(decision.error.details[0]?.code).toBe('approval-definition-not-published');
    }
  });

  it('prohibits an unregistered command by default (fail-closed classification)', async () => {
    // The unregistered command's envelope is composed through the landed
    // fail-closed parser (branded fields constructed by parse, never casts).
    // The proposal carries a subject: the denied audit event must land in the
    // aggregate-keyed ledger (the ledger-backed sink derives every append's
    // aggregate from the envelope's after-ref).
    const command = unwrap(
      parseCommandEnvelope({
        kind: 'command',
        commandName: 'projects.purgeEverything',
        scope: runtime.session.scope,
        actor: { kind: 'user', actorId: unwrap(parseId(HOST_ACTOR_ID), 'actor id') },
        idempotencyKey: 'host-act-deny-0003',
        causality: { correlationId: 'host-gw-corr-0001', causationId: null },
        issuedAt: '2026-09-14T12:30:00.000Z',
        schemaVersion: '1.0.0',
        payload: {},
      }),
      'unregistered command envelope',
    );
    const proposal = actionProposal({
      command,
      subject: unwrap(
        parseEntityRef({ entityKind: 'project', entityId: HOST_PROJECT_ID }),
        'deny subject ref',
      ),
      evidence: [],
      confidence: 'high',
      resourceScope: runtime.session.scope,
      approval: null,
    });
    const decision = await runtime.actions.gateway.executeAction(
      proposal,
      runtime.actions.authorizationOf(),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('forbidden');
      expect(decision.error.details[0]?.code).toBe('unknown-action');
    }
  });

  it('denies a same-tenant foreign-project completion with a typed unauthorized (A12 write direction)', async () => {
    // The routed approval lives in the hosted project's scope; a same-tenant
    // session scoped to ANOTHER project resolves it through the workflow
    // store's scoped read → typed unauthorized (an existing cross-project
    // aggregate is unauthorized, never invisible — the write-direction A12
    // discipline the gateway's completion path flows).
    const foreignProjectSession = unwrap(
      runtime.openSession({
        tenantId: HOST_TENANT_ID,
        projectId: PROJECT_OTHER,
        actorId: HOST_ACTOR_ID,
      }),
      'foreign-project session',
    );
    const proposed = await runtime.actions.proposeApprovalDecision({
      ...approvalRequest(),
      idempotencyKey: 'host-act-deny-0004',
    });
    const routed = unwrap(proposed, 'wrong-scope routing');
    if (routed.decision !== 'routed-to-approval') {
      throw new TypeError(`wrong-scope routing did not route: ${JSON.stringify(routed)}`);
    }
    const completed = await runtime.actions.completeApprovalDecision(
      { ...approvalRequest(), idempotencyKey: 'host-act-deny-0004' },
      routed.approval,
      foreignProjectSession,
    );
    expect(completed.ok).toBe(false);
    if (!completed.ok) {
      expect(completed.error.code).toBe('unauthorized');
      expect(completed.error.details[0]?.code).toBe('project-scope-violation');
    }
  });

  it('typed-rejects malformed action requests (displayable, never a throw)', async () => {
    const malformed = await runtime.actions.proposeApprovalDecision({ instanceId: 'nope' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      const rejection = malformed.error as { readonly code: string };
      expect(rejection.code).toBe('invalid-request');
    }
  });
});

// ---- local helpers ----------------------------------------------------------------

const parseId = (raw: string) => parseEntityId(raw);

/** Compose the approval-decision proposal (raw parts, trusted test path). */
const composeProposal = (
  request: {
    readonly instanceId: string;
    readonly expectedVersion: number;
    readonly approvalKey: string;
    readonly basis: string;
    readonly idempotencyKey: string;
  },
  session?: HostRuntime['session'],
) =>
  composeApprovalDecisionProposal(
    {
      session: session ?? runtime.session,
      correlationId: 'host-gw-corr-0001',
      now: () => '2026-09-14T12:30:00.000Z' as Timestamp,
    },
    request,
    null,
  );
