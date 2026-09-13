// Office web application shell — THE golden scenario (OFF-030).
//
// THE named acceptance: a SEEDED project is operated END-TO-END through the
// shell, every step through PUBLIC package surfaces, in memory,
// deterministically, with ZERO direct database access:
//
//   1. the workspace LOADS (the full view model over the seeded world);
//   2. a field observation is RECORDED through the command surface and
//      reflected (the live stream fans it out; the workspace re-derives);
//   3. the workflow approval is SUBMITTED through the command surface and
//      reflected (the approvals section shows the submitted step);
//   4. the cost position RE-PROJECTS (a new cost item through the command
//      surface moves budgeted/remaining/committed in the workspace view);
//   5. the control tower's exception impact UPDATES (the same scan identity
//      over the re-projected ledger: the cost-overrun exception's economic
//      impact grows with the recorded item);
//   6. evidence navigation walks the FULL causality chain from the
//      control-tower item's evidence back to the ORIGINATING COMMAND — the
//      ledger event the recordCostItem binding appended, its A3 causation id
//      (the online operation id), and the world's command journal entry.
//
// Run-twice identity closes the scenario: a SECOND, independently seeded
// world + session + plane, operated identically, produces the byte-identical
// view models (A7: every view is a deterministic projection).
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  CAPTURE_FIELD_EVENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  advanceWorkflowInstance,
  captureFieldObservation,
  controlTowerView,
  causalityChainOf,
  correlationChainOf,
  currentEvidencePage,
  backEvidencePage,
  evidencePageView,
  openEvidenceNavigation,
  projectWorkspace,
  pushEvidencePage,
  recordCostItem,
  submitWorkflowApproval,
} from './index';
import {
  OPERATOR,
  SEED_CORRELATION,
  WEB_SESSION_CORRELATION,
  sequentialOpaqueIds,
  shellHarnessOf,
  unwrapShell,
} from './test-support';

// The fixed deterministic clock: one tick per call, 60s apart, from a fixed
// epoch — never the wall clock.
const BASE_EPOCH_MS = Date.UTC(2026, 8, 14, 8, 0, 0);
const clockOf = (startMs = BASE_EPOCH_MS, stepSeconds = 60): (() => Timestamp) => {
  let at = startMs;
  return () => {
    at += stepSeconds * 1000;
    return new Date(at).toISOString() as Timestamp;
  };
};

/** The control-tower scan identity (deterministic, injected). */
const SCAN_PARTS = {
  scanId: 'scan-0001',
  assessmentIds: ['assessment-0001'],
  detectedAt: '2026-09-14T10:00:00.000Z' as Timestamp,
};

describe('THE golden scenario — a seeded project operated end-to-end through the shell', () => {
  it('loads the workspace, records a field observation, submits the approval, re-projects the cost position, updates the control tower, and walks the causality chain back to the originating command', async () => {
    const harness = await shellHarnessOf({ now: clockOf(), newOpaqueId: sequentialOpaqueIds() });
    const { world, session, plane } = harness;

    // ---- 1. THE WORKSPACE LOADS (the full seeded view model). -----------
    const workspace = unwrapShell(await projectWorkspace(world, session), 'workspace load');
    expect(workspace.kind).toBe('project-workspace');
    expect(workspace.header.projectName).toBe('Reference Campus Works');
    expect(workspace.header.projectStatus).toBe('active');
    expect(workspace.header.organizationName).toBe('Reference Operator Organization');
    expect(workspace.schedule.activityCount).toBe(3);
    expect(workspace.schedule.baselineCount).toBe(1);
    expect(workspace.schedule.forecastProjectDuration).toBe(70);
    expect(workspace.cost.budgetedMinor).toBe(1_000_000);
    expect(workspace.cost.committedMinor).toBe(1_050_000);
    expect(workspace.cost.remainingBudgetMinor).toBe(-50_000);
    expect(workspace.cost.overCommittedCostItemIds).toEqual([world.identities.costItemIds[0]]);
    expect(workspace.commitments.contracts).toHaveLength(1);
    expect(workspace.commitments.contracts[0]?.executionStatus).toBe('executed');
    expect(workspace.commitments.changeEvents).toHaveLength(1);
    expect(workspace.commitments.changeEvents[0]?.status).toBe('proposed');
    expect(workspace.documents.documents).toHaveLength(1);
    expect(workspace.documents.documents[0]?.revisionCount).toBe(1);
    expect(workspace.approvals.instances).toHaveLength(1);
    expect(workspace.approvals.instances[0]?.currentState).toBe('draft');
    expect(workspace.approvals.instances[0]?.approvals[0]?.status).toBe('pending');
    expect(workspace.field.recentEvents).toHaveLength(0);

    // ---- 2. A FIELD OBSERVATION IS RECORDED THROUGH THE COMMAND SURFACE. -
    const capture = await captureFieldObservation(
      plane,
      session,
      {
        category: 'site-condition',
        summary: 'Level 3 slab cracking observed at grid C4',
        detail: 'Hairline cracking across the pour joint; monitoring before cover.',
        location: 'level-3/grid-c4',
        observedAt: '2026-09-14T09:05:00.000Z',
        observedBy: OPERATOR,
      },
      clockOf()(),
    );
    expect(capture.status).toBe('executed');
    expect(capture.command.commandName).toBe(CAPTURE_FIELD_EVENT_COMMAND);
    expect(capture.command.actorId).toBe(OPERATOR);
    expect(capture.eventName).toBe('field.fieldEventCaptured');
    expect(capture.eventId).not.toBeNull();
    expect(capture.rejection).toBeNull();
    const captureEventId = capture.eventId as string;

    // The live stream fans the command's event out to the session (A12:
    // every client consumes the SAME project state's stream).
    const delivered = plane.consume();
    expect(delivered.ok).toBe(true);
    if (delivered.ok) {
      expect(delivered.value.some((event) => event.eventId === captureEventId)).toBe(true);
    }

    // The workspace re-derives and REFLECTS the observation (A7 fold).
    const afterCapture = unwrapShell(await projectWorkspace(world, session), 'workspace after capture');
    expect(afterCapture.field.recentEvents).toHaveLength(1);
    expect(afterCapture.field.recentEvents[0]?.summary).toBe(
      'Level 3 slab cracking observed at grid C4',
    );
    expect(afterCapture.field.recentEvents[0]?.status).toBe('open');
    expect(afterCapture.field.openIssues).toHaveLength(0);

    // ---- 3. THE WORKFLOW APPROVAL IS SUBMITTED AND REFLECTED. -----------
    const instanceId = world.identities.workflowInstanceId;
    const submission = await submitWorkflowApproval(
      plane,
      session,
      { instanceId, expectedVersion: 1, approvalKey: 'manager' },
      clockOf()(),
    );
    expect(submission.status).toBe('executed');
    expect(submission.command.commandName).toBe(SUBMIT_APPROVAL_COMMAND);
    expect(submission.eventName).toBe('workflows.approvalSubmitted');

    const afterApproval = unwrapShell(
      await projectWorkspace(world, session),
      'workspace after approval',
    );
    const approval = afterApproval.approvals.instances[0]?.approvals.find(
      (step) => step.key === 'manager',
    );
    expect(approval?.status).toBe('submitted');
    expect(approval?.submittedBy).toBe(OPERATOR);
    expect(approval?.submittedAt).not.toBeNull();
    expect(afterApproval.approvals.instances[0]?.version).toBe(2);

    // ---- 4. THE COST POSITION RE-PROJECTS. ------------------------------
    // The control tower is scanned BEFORE the cost item, so the update in
    // step 5 is the effect of the shell's own command.
    const towerBefore = unwrapShell(
      controlTowerView(world, session, SCAN_PARTS),
      'control tower before the cost item',
    );
    expect(towerBefore.exceptionCount).toBe(1);
    const overrunBefore = towerBefore.items[0];
    expect(overrunBefore?.kind).toBe('cost-overrun');
    expect(overrunBefore?.economicImpact.amountMinor).toBe(50_000);

    const recorded = await recordCostItem(
      plane,
      session,
      {
        budgetId: world.identities.budgetId,
        expectedVersion: 3,
        code: 'REBAR',
        description: 'Additional reinforcement for the level 3 modification',
        unit: 't',
        quantityMilli: 4_000,
        unitRateMinor: 25_000,
      },
      clockOf()(),
    );
    expect(recorded.status).toBe('executed');
    expect(recorded.command.commandName).toBe(RECORD_COST_ITEM_COMMAND);
    expect(recorded.eventName).toBe('cost.costItemRecorded');
    expect(recorded.operationId).not.toBeNull();
    const costEventId = recorded.eventId as string;
    const costOperationId = recorded.operationId as string;

    const afterCost = unwrapShell(await projectWorkspace(world, session), 'workspace after cost item');
    expect(afterCost.cost.budgetedMinor).toBe(1_100_000);
    expect(afterCost.cost.budgetVersion).toBe(4);
    expect(afterCost.cost.remainingBudgetMinor).toBe(50_000);
    expect(afterCost.cost.committedMinor).toBe(1_050_000);
    expect(afterCost.cost.overCommittedCostItemIds).toEqual([world.identities.costItemIds[0]]);

    // ---- 5. THE CONTROL TOWER'S EXCEPTION IMPACT UPDATES. ---------------
    const towerAfter = unwrapShell(
      controlTowerView(world, session, SCAN_PARTS),
      'control tower after the cost item',
    );
    expect(towerAfter.exceptionCount).toBe(1);
    const overrunAfter = towerAfter.items[0];
    expect(overrunAfter?.kind).toBe('cost-overrun');
    // The projected cost grew by the post-change cost item (100_000 minor):
    // the exception's economic impact updates from 50_000 to 150_000.
    expect(overrunAfter?.economicImpact.amountMinor).toBe(150_000);
    // The priority composition reflects the update: the ECONOMIC contribution
    // (and the total) re-rank with the grown impact. The severity LEVEL is
    // threshold-driven (3/20 of contracted value stays 'moderate' — the
    // documented ECONOMIC_SHARE_THRESHOLDS escalate at 1/5), so the score's
    // economic term is the update's carrier, not the severity term.
    expect(overrunAfter?.priorityScore.economic).not.toBe(overrunBefore?.priorityScore.economic);
    expect(overrunAfter?.priorityScore.total).not.toBe(overrunBefore?.priorityScore.total);
    // Every claim stays evidence-chained (A4) — including the recorded item.
    const costEvidence = overrunAfter?.evidence.find(
      (entry) => entry.kind === 'event' && entry.referenceId === costEventId,
    );
    expect(costEvidence).toBeDefined();
    expect(costEvidence?.eventName).toBe('cost.costItemRecorded');
    // SUGGESTIONS ONLY: the suggested next actions are typed command
    // references, never executed by the shell.
    for (const action of overrunAfter?.suggestedActions ?? []) {
      expect(typeof action.commandName).toBe('string');
      expect(action.payload).toBeTypeOf('object');
    }
    expect((overrunAfter?.suggestedActions ?? []).length).toBeGreaterThan(0);

    // ---- 6. EVIDENCE NAVIGATION WALKS THE FULL CAUSALITY CHAIN. --------
    // From the control-tower item's evidence entry (the recorded cost item's
    // ledger event) BACK to the ORIGINATING COMMAND through typed pages.
    let navigation = openEvidenceNavigation();
    expect(currentEvidencePage(navigation).page).toBe('evidence-overview');

    // overview → the event page (the ledger record of the cost item).
    navigation = unwrapShell(
      pushEvidencePage(world, session, navigation, { page: 'evidence-event', eventId: costEventId }),
      'push event page',
    );
    const eventPage = unwrapShell(evidencePageView(world, session, navigation), 'event page');
    if (eventPage.page !== 'evidence-event') {
      throw new Error(`expected the evidence-event page, got ${eventPage.page}`);
    }
    expect(eventPage.event.eventName).toBe('cost.costItemRecorded');
    // The ledger anchors the recorded-item event to the CREATED cost item
    // (the domain's landed aggregate semantics), not the budget root — the
    // payload carries the same id (cross-field consistency).
    expect(eventPage.event.aggregateKind).toBe('cost-item');
    expect(eventPage.event.aggregateId).toBe(String(eventPage.event.payload.costItemId));
    expect(eventPage.event.aggregateId).not.toBe(world.identities.budgetId);
    // The A3 link: the event's causation id IS the online operation id —
    // the deterministic idempotency key of the shell's command dispatch.
    expect(eventPage.event.causationId).toBe(costOperationId);
    expect(eventPage.event.causation.kind).toBe('command');

    // event → the causality page (the walked chain).
    navigation = unwrapShell(
      pushEvidencePage(world, session, navigation, {
        page: 'evidence-causality',
        eventId: costEventId,
      }),
      'push causality page',
    );
    const chainPage = unwrapShell(evidencePageView(world, session, navigation), 'causality page');
    if (chainPage.page !== 'evidence-causality') {
      throw new Error(`expected the evidence-causality page, got ${chainPage.page}`);
    }
    expect(chainPage.chain.depth).toBe(2);
    const origin = chainPage.chain.entries[chainPage.chain.entries.length - 1];
    expect(origin?.kind).toBe('command');
    if (origin?.kind === 'command') {
      expect(origin.command.commandName).toBe(RECORD_COST_ITEM_COMMAND);
      expect(origin.command.idempotencyKey).toBe(costOperationId);
      expect(origin.command.actorId).toBe(OPERATOR);
      expect(origin.command.outcome).toBe('executed');
      expect(origin.command.eventId).toBe(costEventId);
      expect(origin.command.eventName).toBe('cost.costItemRecorded');
    }

    // causality → the originating command's own page.
    navigation = unwrapShell(
      pushEvidencePage(world, session, navigation, {
        page: 'evidence-command',
        idempotencyKey: costOperationId,
      }),
      'push command page',
    );
    const commandPage = unwrapShell(evidencePageView(world, session, navigation), 'command page');
    if (commandPage.page !== 'evidence-command') {
      throw new Error(`expected the evidence-command page, got ${commandPage.page}`);
    }
    expect(commandPage.command.commandName).toBe(RECORD_COST_ITEM_COMMAND);

    // Back semantics (typed, deterministic, no router): pop back to the
    // chain, the event, the overview — and typed-reject at the root.
    navigation = unwrapShell(backEvidencePage(navigation), 'back to causality');
    expect(currentEvidencePage(navigation).page).toBe('evidence-causality');
    navigation = unwrapShell(backEvidencePage(navigation), 'back to event');
    expect(currentEvidencePage(navigation).page).toBe('evidence-event');
    navigation = unwrapShell(backEvidencePage(navigation), 'back to overview');
    expect(currentEvidencePage(navigation).page).toBe('evidence-overview');
    expect(backEvidencePage(navigation).ok).toBe(false);

    // The SAME walk resolves the change event's chain back to the SEED's
    // originating command (the whole world is command-provenanced).
    const changeEntry = overrunAfter?.evidence.find(
      (entry) => entry.kind === 'event' && entry.eventName === 'contracts.changeEventRaised',
    );
    expect(changeEntry).toBeDefined();
    const changeChain = unwrapShell(
      causalityChainOf(world, session, (changeEntry as { referenceId: string }).referenceId),
      'change event chain',
    );
    const changeOrigin = changeChain.entries[changeChain.entries.length - 1];
    expect(changeOrigin?.kind).toBe('command');
    if (changeOrigin?.kind === 'command') {
      expect(changeOrigin.command.commandName).toBe('contracts.raiseChangeEvent');
      expect(changeOrigin.command.correlationId).toBe(SEED_CORRELATION);
    }

    // The session's OWN correlation chain carries every shell-issued event.
    const sessionChain = unwrapShell(
      correlationChainOf(world, session, WEB_SESSION_CORRELATION),
      'session correlation chain',
    );
    expect(sessionChain.eventCount).toBe(3);
    expect(sessionChain.events.map((event) => event.eventName)).toEqual([
      'field.fieldEventCaptured',
      'workflows.approvalSubmitted',
      'cost.costItemRecorded',
    ]);
  });

  it('proves run-twice identity: a second, independently seeded shell operated identically yields the identical view models', async () => {
    const operate = async () => {
      const harness = await shellHarnessOf({ now: clockOf(), newOpaqueId: sequentialOpaqueIds() });
      const { world, session, plane } = harness;
      const workspaceBefore = unwrapShell(await projectWorkspace(world, session), 'load');
      await captureFieldObservation(
        plane,
        session,
        {
          category: 'site-condition',
          summary: 'Level 3 slab cracking observed at grid C4',
          location: 'level-3/grid-c4',
          observedAt: '2026-09-14T09:05:00.000Z',
          observedBy: OPERATOR,
        },
        clockOf()(),
      );
      await submitWorkflowApproval(
        plane,
        session,
        { instanceId: world.identities.workflowInstanceId, expectedVersion: 1, approvalKey: 'manager' },
        clockOf()(),
      );
      await recordCostItem(
        plane,
        session,
        {
          budgetId: world.identities.budgetId,
          expectedVersion: 3,
          code: 'REBAR',
          description: 'Additional reinforcement for the level 3 modification',
          unit: 't',
          quantityMilli: 4_000,
          unitRateMinor: 25_000,
        },
        clockOf()(),
      );
      const workspaceAfter = unwrapShell(await projectWorkspace(world, session), 'reload');
      const tower = unwrapShell(controlTowerView(world, session, SCAN_PARTS), 'tower');
      const chain = unwrapShell(
        causalityChainOf(
          world,
          session,
          tower.items[0]?.evidence.find((entry) => entry.eventName === 'cost.costItemRecorded')
            ?.referenceId as string,
        ),
        'chain',
      );
      return {
        workspaceBefore,
        workspaceAfter,
        tower,
        chain,
        journal: world.commandJournal.map((entry) => ({
          commandName: entry.commandName,
          outcome: entry.outcome,
          eventName: entry.eventName,
        })),
      };
    };

    const first = await operate();
    const second = await operate();
    expect(second.workspaceBefore).toStrictEqual(first.workspaceBefore);
    expect(second.workspaceAfter).toStrictEqual(first.workspaceAfter);
    expect(second.tower).toStrictEqual(first.tower);
    expect(second.chain).toStrictEqual(first.chain);
    expect(second.journal).toStrictEqual(first.journal);
  });

  it('replays an unconfirmed retry through the online path (the deterministic operation id is the idempotency key)', async () => {
    const harness = await shellHarnessOf({ now: clockOf(), newOpaqueId: sequentialOpaqueIds() });
    const { world, session, plane } = harness;
    const now = clockOf(Date.UTC(2026, 8, 14, 12, 0, 0));
    const input = {
      category: 'site-condition',
      summary: 'Rebar cover confirmed at grid D2',
      location: 'level-2/grid-d2',
      observedAt: '2026-09-14T12:05:00.000Z',
      observedBy: OPERATOR,
    };
    const first = await captureFieldObservation(plane, session, input, now());
    expect(first.status).toBe('executed');
    // Same position + same operation kind + same payload → the SAME operation
    // id: an unconfirmed retry REPLAYS the recorded outcome, never a second
    // effect (no consume between the two submissions).
    const retry = await captureFieldObservation(plane, session, input, now());
    expect(retry.status).toBe('replayed');
    expect(retry.operationId).toBe(first.operationId);
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.command.commandName).toBe(CAPTURE_FIELD_EVENT_COMMAND);
    // Exactly ONE field event exists in the world's ledger.
    const fieldEvents = world.ledgerEvents.filter(
      (event) => event.envelope.eventName === 'field.fieldEventCaptured',
    );
    expect(fieldEvents).toHaveLength(1);
  });

  it('surfaces typed rejections as displayable view models, never throws', async () => {
    const harness = await shellHarnessOf({ now: clockOf(), newOpaqueId: sequentialOpaqueIds() });
    const { world, session, plane } = harness;
    const now = clockOf(Date.UTC(2026, 8, 14, 13, 0, 0));

    // A stale expected version is a typed concurrency conflict — displayed,
    // never thrown; the journal records the rejection.
    const stale = await recordCostItem(
      plane,
      session,
      {
        budgetId: world.identities.budgetId,
        expectedVersion: 99,
        code: 'REBAR',
        description: 'Stale attempt',
        unit: 't',
        quantityMilli: 1_000,
        unitRateMinor: 10_000,
      },
      now(),
    );
    expect(stale.status).toBe('rejected');
    expect(stale.eventId).toBeNull();
    expect(stale.rejection?.code).toBe('concurrency-conflict');
    expect(stale.rejection?.message).toContain('budget');

    // A malformed instance id is a typed input rejection (displayable).
    const malformed = await submitWorkflowApproval(
      plane,
      session,
      { instanceId: 'not-a-canonical-id', expectedVersion: 1, approvalKey: 'manager' },
      now(),
    );
    expect(malformed.status).toBe('rejected');
    expect(malformed.rejection?.code).toBe('invalid-instance-id');

    // An unbound transition key is the workflow engine's typed rejection.
    const rejected = await advanceWorkflowInstance(
      plane,
      session,
      {
        instanceId: world.identities.workflowInstanceId,
        expectedVersion: 1,
        transitionKey: 'no-such-transition',
      },
      now(),
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection?.code).toBe('invariant-violation');

    // Nothing executed: the workspace still shows the pending approval.
    const workspace = unwrapShell(await projectWorkspace(world, session), 'reload');
    expect(workspace.approvals.instances[0]?.approvals[0]?.status).toBe('pending');
  });
});
