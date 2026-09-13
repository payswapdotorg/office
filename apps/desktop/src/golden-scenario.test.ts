// Office desktop client protocol/reference shell — THE golden scenario
// (OFF-032).
//
// THE named acceptance: the desktop reference host READS AND WRITES the SAME
// seeded project as the web and field shells — over THE SAME
// sync/client-sync client protocol — then goes OFFLINE, captures, RECONNECTS,
// drains exactly once, surfaces the conflict state, and resolves it
// explicitly; a WEB-STYLE CLIENT and the DESKTOP HOST over ONE shared server
// world converge on the identical reconciled state (A12: all clients share
// ONE project state). End to end through PUBLIC package surfaces, in memory,
// deterministically, with ZERO direct database access and NO
// platform-specific domain model (every domain term arrives from the shared
// contracts/domain packages):
//
//   1. THE CONNECTED SEED: the reference desktop host (validated against the
//      platform shell host-port contract) + a web-style twin client both
//      subscribe over the seeded world — one organization, one project, a
//      three-activity serial programme with a baseline (the deterministic
//      critical path), a budget with two cost items, and ONE committed
//      purchase order (the contested commercial aggregate); the workspace
//      view model loads over the subscribed slice;
//   2. THE DESKTOP HOST WRITES ONLINE: a progress record through the typed
//      command path — the canonical world's journal reflects it;
//   3. DISCONNECT: the desktop host drops offline (the engine stops
//      consuming its stream);
//   4. THE WEB-STYLE TWIN MUTATES THE SAME TARGETS ONLINE (the window the
//      desktop host will not have seen — the divergence): progress on the
//      SAME activity + the purchase order CLOSED;
//   5. CAPTURE: the desktop host captures three mutations OFFLINE — an
//      activity update (OPEN), the staged purchase-order amendment on the
//      contested commitment (PROTECTED), a new budget cost item (PROTECTED,
//      uncontested) — queued, counted, and displayable;
//   6. RECONNECT + SYNCHRONIZE: the engine's exactly-once drain supersedes
//      the OPEN activity update deterministically (the committed server
//      side stands, recorded + audited), PARKS the PROTECTED amendment as an
//      explicit conflict (never applied — structurally no auto-resolution),
//      and applies the cost item cleanly through the typed command path
//      (the world reflects it under its operation id); the sync report
//      becomes a displayable view model and the cursor/token state is
//      displayable;
//   7. THE CONFLICT STATE: both surfaced conflicts are displayable view
//      models carrying BOTH SIDES + provenance; the PROTECTED conflict shows
//      the no-auto-resolution state and the ONLY exit (the typed explicit
//      resolution command as a user action); the OPEN conflict shows the
//      deterministic supersession outcome;
//   8. THE EXPLICIT RESOLUTION: the desktop user resolves the protected
//      conflict explicitly (merge strategy, the diverging close event as
//      audit evidence, the staged amended scope re-entering as a SUCCESSOR
//      purchase order against the same budget) — the reconciled mutation
//      re-enters the queue discipline and applies EXACTLY ONCE;
//   9. THE QUEUE IS EMPTY and the workspace reflects the RECONCILED state
//      (the successor commitment committed alongside the closed one), and
//      BOTH CLIENTS CONVERGE on the world's actual project-slice stream —
//      the cross-client convergence proof (A12).
//
// Run-twice identity closes the scenario: a SECOND, independently seeded
// world + sessions + planes, operated identically, produces the
// byte-identical view models (A7: every view is a deterministic projection).
import { describe, expect, it } from 'vitest';
import type { EntityId, Timestamp } from '@office/contracts';
import type { OperationId } from '@office/sync';
import { capability } from '@office/authz';
import { ACTIVITY_KIND, RECORD_PROGRESS_COMMAND, UPDATE_ACTIVITY_COMMAND } from '@office/domain-schedule';
import { AMEND_COMMITMENT_COMMAND, RECORD_COST_ITEM_COMMAND } from '@office/domain-cost';
import {
  captureActivityUpdate,
  captureCommitmentAmend,
  captureCostItem,
  conflictStateView,
  desktopWorkspaceView,
  disconnect,
  entityRefOf,
  offlineQueueView,
  resolveProtectedConflict,
  submitCommitmentClose,
  submitProgress,
  syncStatusView,
  synchronize,
  validateDesktopHostPort,
  DESKTOP_HOST_PORT_CONTRACT,
} from './index';
import type { DesktopMutationRequest } from './index';
import {
  DESKTOP_ACTOR,
  PROJECT_1,
  TENANT_A,
  desktopHarnessOf,
  sequentialOpaqueIds,
  unwrapDesktop,
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

/** The contested activity (A-200, the serial chain's middle link). */
const secondActivityOf = (activityIds: readonly EntityId[]): EntityId => {
  const second = activityIds[1];
  if (second === undefined) throw new TypeError('the seeded programme must carry three activities');
  return second;
};

describe('THE golden scenario — read, write, go offline, capture, reconnect, synchronize, resolve, converge', () => {
  it('drives the reference desktop host over the seeded project end to end and converges with the web-style twin', async () => {
    const harness = await desktopHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, host, desktopSession, desktopPlane, officeSession, officePlane } = harness;
    const { scheduleId, activityIds, budgetId, costItemIds, commitmentId } = world.identities;
    const secondActivity = secondActivityOf(activityIds);

    // ---- 0. THE REFERENCE HOST satisfies the platform shell contract -----
    // The host-port contract is typed and fail-closed: the reference host
    // validates, and the descriptor names EXACTLY the port's own members.
    const port = unwrapDesktop(validateDesktopHostPort(host), 'host port');
    expect(port).toBe(host);
    for (const section of DESKTOP_HOST_PORT_CONTRACT) {
      const members = Object.keys(
        (host as unknown as Record<string, Record<string, unknown>>)[section.name] ?? {},
      );
      expect(section.members.map((member) => member.name).sort()).toEqual([...members].sort());
    }
    const resolvedSession = unwrapDesktop(
      host.identity.resolveSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: DESKTOP_ACTOR }),
      'host identity port',
    );
    expect(resolvedSession.projectId).toBe(world.identities.projectId);

    // ---- 1. THE CONNECTED SEED ------------------------------------------
    // Both clients subscribed over the seeded world: the desktop host's
    // causal-token basis is the seed itself (12 PROJECT-scope events — the
    // tenant-scope organization event is invisible to every project-scope
    // subscription by design, A12: the slice is the project's own stream),
    // and the workspace loads over the session's OWN consumed stream.
    expect(desktopPlane.engine.connected).toBe(true);
    expect(officePlane.engine.connected).toBe(true);
    const seedStatus = unwrapDesktop(
      host.data.syncStatus(desktopSession, desktopPlane),
      'seed status',
    );
    expect(seedStatus.connected).toBe(true);
    expect(seedStatus.consumedPosition).toBe(12);
    expect(seedStatus.pendingCount).toBe(0);
    const seedWorkspace = unwrapDesktop(
      await host.data.workspace(desktopSession, desktopPlane, '2026-09-14T09:00:00.000Z' as Timestamp),
      'seed workspace',
    );
    expect(seedWorkspace.kind).toBe('desktop-project-workspace');
    expect(seedWorkspace.header.projectName).toBe('Reference Campus Works');
    expect(seedWorkspace.header.projectStatus).toBe('active');
    expect(seedWorkspace.header.organizationName).toBe('Reference Operator Organization');
    expect(seedWorkspace.schedule.name).toBe('Reference master programme');
    expect(seedWorkspace.schedule.version).toBe(7);
    expect(seedWorkspace.schedule.activityCount).toBe(3);
    expect(seedWorkspace.schedule.dependencyCount).toBe(2);
    expect(seedWorkspace.schedule.baselineCount).toBe(1);
    expect(seedWorkspace.schedule.currentBaselineId).toBeTypeOf('string');
    // The serial chain A-100 → A-200 → A-300: 20 + 35 + 15 = 70 working units.
    expect(seedWorkspace.schedule.forecastProjectDuration).toBe(70);
    expect(seedWorkspace.schedule.criticalPathLength).toBe(3);
    expect(seedWorkspace.schedule.activities.map((activity) => activity.code)).toEqual([
      'A-100',
      'A-200',
      'A-300',
    ]);
    // THE cost-position read model: budgeted 4,000.00 + 6,000.00 (minor
    // units) against the committed 10,500.00 purchase order.
    expect(seedWorkspace.cost.currency).toBe('EUR');
    expect(seedWorkspace.cost.budgetVersion).toBe(3);
    expect(seedWorkspace.cost.budgetedMinor).toBe(1_000_000);
    expect(seedWorkspace.cost.committedMinor).toBe(1_050_000);
    expect(seedWorkspace.cost.invoicedMinor).toBe(0);
    expect(seedWorkspace.cost.paidMinor).toBe(0);
    expect(seedWorkspace.cost.remainingBudgetMinor).toBe(-50_000);
    expect(seedWorkspace.cost.committedVarianceMinor).toBe(50_000);
    expect(seedWorkspace.cost.overCommittedCostItemIds).toEqual([costItemIds[0]]);
    expect(seedWorkspace.slice.consumedPosition).toBe(12);
    expect(seedWorkspace.slice.consumedEventCount).toBe(12);
    expect(seedWorkspace.pendingCaptureCount).toBe(0);

    // ---- 2. THE DESKTOP HOST WRITES ONLINE (the typed command path) -----
    // A progress record through `schedule.recordProgress`: the canonical
    // world's own command journal records the execution under the
    // submission's operation id (the idempotency key — the A8 rule).
    const progress = await submitProgress(
      desktopPlane,
      desktopSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 7,
        percentComplete: 40,
        remainingDuration: 21,
      },
      '2026-09-14T09:10:00.000Z' as Timestamp,
    );
    expect(progress.status).toBe('executed');
    expect(progress.eventName).toBe('schedule.progressRecorded');
    expect(progress.operationId).toMatch(/^office-op-v1-/);
    expect(progress.rejection).toBeNull();
    const progressJournal = world.commandJournal.find(
      (entry) => entry.idempotencyKey === progress.operationId,
    );
    expect(progressJournal?.outcome).toBe('executed');
    expect(progressJournal?.eventName).toBe('schedule.progressRecorded');
    // The desktop host consumes its own replayed effect (its causal basis).
    expect(unwrapDesktop(desktopPlane.consume(), 'own consume')).toHaveLength(1);

    // ---- 3. DISCONNECT --------------------------------------------------
    const offline = host.commands.disconnect(desktopPlane, desktopSession);
    expect(offline.ok).toBe(true);
    const offlineStatus = unwrapDesktop(
      host.data.syncStatus(desktopSession, desktopPlane),
      'offline status',
    );
    expect(offlineStatus.connected).toBe(false);
    // The causal token is FROZEN at the slice's head (the next capture's basis).
    expect(offlineStatus.consumedPosition).toBe(13);

    // ---- 4. THE WEB-STYLE TWIN MUTATES THE SAME TARGETS ONLINE ----------
    // (the divergence window the desktop host will not have seen). The
    // twin first consumes the desktop host's own online write — its causal
    // basis catches up to the SAME observed slice position (13) the desktop
    // host's captures will be composed against (the conflict model's
    // concurrency basis) — then diverges on the SAME targets.
    expect(unwrapDesktop(officePlane.consume(), 'twin catches up')).toHaveLength(1);
    const twinProgress = await submitProgress(
      officePlane,
      officeSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 8,
        percentComplete: 65,
        remainingDuration: 12,
      },
      '2026-09-14T09:20:00.000Z' as Timestamp,
    );
    expect(twinProgress.status).toBe('executed');
    expect(twinProgress.eventName).toBe('schedule.progressRecorded');
    const twinClose = await submitCommitmentClose(
      officePlane,
      officeSession,
      {
        commitmentId,
        expectedVersion: 1,
        reason: 'Package re-scoped after the frame review',
      },
      '2026-09-14T09:25:00.000Z' as Timestamp,
    );
    expect(twinClose.status).toBe('executed');
    expect(twinClose.eventName).toBe('cost.commitmentClosed');
    // The twin's own two divergence mutations consumed live.
    expect(unwrapDesktop(officePlane.consume(), 'office consume')).toHaveLength(2);

    // ---- 5. CAPTURE OFFLINE (queued / counted / displayable) -------------
    // The staged activity update (OPEN tracking state).
    const activityUpdate = await captureActivityUpdate(
      desktopPlane,
      desktopSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 8,
        changes: { plannedDuration: 32 },
      },
      '2026-09-14T09:40:00.000Z' as Timestamp,
    );
    expect(activityUpdate.status).toBe('queued');
    expect(activityUpdate.command.commandName).toBe(UPDATE_ACTIVITY_COMMAND);
    expect(activityUpdate.command.protection).toBe('open');
    expect(activityUpdate.entry?.state).toBe('pending');
    expect(activityUpdate.entry?.localSequence).toBe(1);
    expect(activityUpdate.entry?.targetKind).toBe('activity');
    expect(activityUpdate.entry?.targetId).toBe(secondActivity);
    expect(activityUpdate.rejection).toBeNull();

    // The staged purchase-order amendment on the contested commitment
    // (PROTECTED commercial state).
    const amendment = await captureCommitmentAmend(
      desktopPlane,
      desktopSession,
      {
        commitmentId,
        expectedVersion: 1,
        budgetId,
        reason: 'Staged scope revision prepared offline',
        lines: [
          {
            costItemId: costItemIds[0] as string,
            description: 'Concrete works package — staged amendment',
            amountMinor: 980_000,
          },
        ],
      },
      '2026-09-14T09:45:00.000Z' as Timestamp,
    );
    expect(amendment.status).toBe('queued');
    expect(amendment.command.commandName).toBe(AMEND_COMMITMENT_COMMAND);
    expect(amendment.command.protection).toBe('protected');
    expect(amendment.entry?.localSequence).toBe(2);
    expect(amendment.entry?.targetKind).toBe('commitment');
    expect(amendment.entry?.targetId).toBe(commitmentId);
    const amendmentOperationId = amendment.entry?.operationId as string;

    // The uncontested budget cost item (PROTECTED, but no divergence: the
    // twin's mutations never touched the budget aggregate).
    const costItem = await captureCostItem(
      desktopPlane,
      desktopSession,
      {
        budgetId,
        expectedVersion: 3,
        code: 'SCAF',
        description: 'Scaffolding and access',
        unit: 'm2',
        quantityMilli: 1_200,
        unitRateMinor: 25_000,
      },
      '2026-09-14T09:50:00.000Z' as Timestamp,
    );
    expect(costItem.status).toBe('queued');
    expect(costItem.command.commandName).toBe(RECORD_COST_ITEM_COMMAND);
    expect(costItem.command.protection).toBe('protected');
    expect(costItem.entry?.localSequence).toBe(3);
    expect(costItem.entry?.targetKind).toBe('budget');
    expect(costItem.entry?.targetId).toBe(budgetId);

    // THE queue state view: pending count, entries, protection classes.
    const queueView = unwrapDesktop(
      host.data.queue(desktopSession, desktopPlane),
      'queue view',
    );
    expect(queueView.pendingCount).toBe(3);
    expect(queueView.entryCount).toBe(3);
    expect(queueView.capacity).toBe(1024);
    expect(queueView.entries.map((entry) => entry.protection)).toEqual([
      'open',
      'protected',
      'protected',
    ]);
    expect(queueView.entries.map((entry) => entry.state)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(queueView.entries.map((entry) => entry.commandName)).toEqual([
      UPDATE_ACTIVITY_COMMAND,
      AMEND_COMMITMENT_COMMAND,
      RECORD_COST_ITEM_COMMAND,
    ]);
    // Every entry carries its client-generated deterministic operation id
    // (the command's idempotency key — the A8 offline rule).
    for (const entry of queueView.entries) {
      expect(entry.operationId).toMatch(/^office-op-v1-/);
      expect(entry.issuedAt).toBeTypeOf('string');
    }

    // ---- 6. RECONNECT + SYNCHRONIZE (the exactly-once drain) ------------
    const report = unwrapDesktop(
      await host.commands.synchronize(
        desktopPlane,
        desktopSession,
        '2026-09-14T10:00:00.000Z' as Timestamp,
      ),
      'synchronize',
    );
    // The catchup: exactly the missed window (the web-style twin's 2 events).
    expect(report.catchupCount).toBe(2);
    expect(report.catchup.map((event) => event.eventName)).toEqual([
      'schedule.progressRecorded',
      'cost.commitmentClosed',
    ]);
    // The drain: the OPEN activity update superseded; the PROTECTED amendment
    // conflicted (parked); the cost item applied cleanly.
    expect(report.counts).toEqual({
      catchup: 2,
      applied: 1,
      rejected: 0,
      conflicted: 1,
      superseded: 1,
    });
    expect(report.applied[0]?.eventName).toBe('cost.costItemRecorded');
    expect(report.applied[0]?.replayed).toBe(false);
    expect(report.conflicted[0]?.protection).toBe('protected');
    expect(report.conflicted[0]?.operationId).toBe(amendmentOperationId);
    expect(report.superseded[0]?.conflictId).toBeTypeOf('string');
    expect(report.remainingPending).toBe(0);
    // The client's own replayed effect consumed live after the drain.
    expect(report.replayedOwnEffects.map((event) => event.eventName)).toEqual([
      'cost.costItemRecorded',
    ]);
    // The cursor/token state advanced (displayable): 12 seed slice events +
    // the 2-event catchup window + the client's own replayed effect.
    expect(report.consumedPosition).toBe(16);

    // THE server world reflects the capture through the typed command path:
    // the cost item's command executed under its operation id.
    const costItemOperationId = queueView.entries[2]?.operationId as string;
    const costItemJournal = world.commandJournal.find(
      (entry) => entry.idempotencyKey === costItemOperationId,
    );
    expect(costItemJournal?.outcome).toBe('executed');
    expect(costItemJournal?.eventName).toBe('cost.costItemRecorded');

    // THE structural no-auto-resolution proof: the parked PROTECTED
    // amendment never reached the command path (no journal entry, no applied
    // operation, and the contested commitment still carries only the twin's
    // closed state — its version was never bumped by the desktop side).
    expect(
      world.commandJournal.filter((entry) => entry.idempotencyKey === amendmentOperationId),
    ).toHaveLength(0);
    expect(world.sync.journal.eventOf(amendmentOperationId as OperationId)).toBeNull();

    // The queue after the synchronize: nothing pending; the terminal states
    // are displayable.
    const queueAfterSync = unwrapDesktop(
      host.data.queue(desktopSession, desktopPlane),
      'queue after',
    );
    expect(queueAfterSync.pendingCount).toBe(0);
    expect(queueAfterSync.entries.map((entry) => entry.state)).toEqual([
      'superseded',
      'conflicted',
      'applied',
    ]);

    // ---- 7. THE CONFLICT STATE (displayable view models) -----------------
    const conflictState = unwrapDesktop(
      host.data.conflictState(desktopSession, desktopPlane),
      'conflict state',
    );
    expect(conflictState.unresolvedCount).toBe(1);
    expect(conflictState.conflicts).toHaveLength(2);

    // THE PROTECTED conflict: both sides + provenance + the no-auto-
    // resolution state whose ONLY exit is the explicit resolution command.
    const protectedConflict = conflictState.conflicts.find(
      (conflict) => conflict.protection === 'protected',
    );
    expect(protectedConflict).toBeDefined();
    expect(protectedConflict?.state).toBe('detected');
    expect(protectedConflict?.disposition.kind).toBe('awaiting-explicit-resolution');
    if (protectedConflict?.disposition.kind === 'awaiting-explicit-resolution') {
      expect(protectedConflict.disposition.autoResolvable).toBe(false);
      expect(protectedConflict.disposition.exit).toBe('explicit-resolution-command');
    }
    // BOTH SIDES: the desktop host's parked amendment + the web-style twin's
    // online close (deterministic side order, same target).
    const sideOperations = [
      protectedConflict?.first.operationId,
      protectedConflict?.second.operationId,
    ].sort();
    expect(sideOperations).toEqual([amendmentOperationId, twinClose.operationId].sort());
    expect(
      [protectedConflict?.first.operationKind, protectedConflict?.second.operationKind].sort(),
    ).toEqual(['amend-commitment', 'close-commitment']);
    for (const side of [protectedConflict?.first, protectedConflict?.second]) {
      expect(side?.targetKind).toBe('commitment');
      expect(side?.targetId).toBe(commitmentId);
      expect(side?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(side?.position).toBeTypeOf('number');
    }
    // PROVENANCE: the contested project's scope, the detection time, the
    // protocol's detector.
    expect(protectedConflict?.provenance.projectId).toBe(world.identities.projectId);
    expect(protectedConflict?.provenance.tenantId).toBe(TENANT_A);
    expect(protectedConflict?.provenance.detectedBy).toBe('system');
    expect(protectedConflict?.provenance.detectedAt).toBe('2026-09-14T10:00:00.000Z');

    // THE OPEN conflict: the deterministic supersession outcome (the
    // committed server side stands; recorded + audited, never silent).
    const openConflict = conflictState.conflicts.find(
      (conflict) => conflict.protection === 'open',
    );
    expect(openConflict).toBeDefined();
    expect(openConflict?.state).toBe('resolved');
    if (openConflict?.disposition.kind === 'superseded') {
      expect(openConflict.disposition.autoResolvable).toBe(true);
      expect(openConflict.disposition.resolvedBy).toBe('system');
      // The diverging ledger event (the twin's progress record) is the audit
      // evidence of the supersession.
      expect(openConflict.disposition.auditEventRefs).toEqual([twinProgress.eventId]);
    }
    expect(
      [openConflict?.first.operationKind, openConflict?.second.operationKind].sort(),
    ).toEqual(['record-activity-progress', 'update-activity']);
    for (const side of [openConflict?.first, openConflict?.second]) {
      expect(side?.targetKind).toBe('activity');
      expect(side?.targetId).toBe(secondActivity);
    }

    // ---- 8. THE EXPLICIT RESOLUTION (the ONLY exit — a user action) ------
    // The MERGE: the office's close stands, and the staged amended scope
    // re-enters as a SUCCESSOR purchase order against the same budget.
    const resolution = await host.commands.resolveConflict(
      desktopPlane,
      desktopSession,
      {
        conflictId: protectedConflict?.conflictId as string,
        strategy: 'merge',
        auditEventRefs: [twinClose.eventId as string],
        reconciled: {
          budgetId,
          number: 'PO-0002',
          commitmentKind: 'purchase-order',
          description: 'Structural frame package — reconciled staged scope',
          currency: 'EUR',
          lines: [
            {
              costItemId: costItemIds[0] as string,
              description: 'Concrete works package — staged amendment',
              amountMinor: 980_000,
            },
          ],
        },
      },
      '2026-09-14T10:30:00.000Z' as Timestamp,
    );
    expect(resolution.status).toBe('resolved');
    expect(resolution.rejection).toBeNull();
    expect(resolution.conflict?.state).toBe('resolved');
    expect(resolution.conflict?.strategy).toBe('merge');
    expect(resolution.conflict?.resolvedBy).toBe(DESKTOP_ACTOR);
    // The reconciled mutation re-entered the queue and applied EXACTLY ONCE.
    expect(resolution.entry?.state).toBe('applied');
    expect(resolution.entry?.protection).toBe('protected');
    expect(resolution.entry?.localSequence).toBe(4);
    expect(resolution.outcome?.status).toBe('applied');
    expect(resolution.outcome?.eventId).toBeTypeOf('string');
    const resolutionOperationId = resolution.entry?.operationId as string;
    const resolutionJournal = world.commandJournal.find(
      (entry) => entry.idempotencyKey === resolutionOperationId,
    );
    expect(resolutionJournal?.outcome).toBe('executed');
    expect(resolutionJournal?.eventName).toBe('cost.commitmentCreated');

    // ---- 9. THE QUEUE IS EMPTY + THE VIEWS REFLECT THE RECONCILED STATE -
    const finalQueue = unwrapDesktop(
      host.data.queue(desktopSession, desktopPlane),
      'final queue',
    );
    expect(finalQueue.pendingCount).toBe(0);
    expect(finalQueue.entryCount).toBe(4);
    expect(finalQueue.entries.map((entry) => entry.state)).toEqual([
      'superseded',
      'conflicted',
      'applied',
      'applied',
    ]);

    // No conflict remains unresolved.
    const finalConflicts = unwrapDesktop(
      host.data.conflictState(desktopSession, desktopPlane),
      'final conflicts',
    );
    expect(finalConflicts.unresolvedCount).toBe(0);
    const resolvedProtected = finalConflicts.conflicts.find(
      (conflict) => conflict.protection === 'protected',
    );
    expect(resolvedProtected?.state).toBe('resolved');
    if (resolvedProtected?.disposition.kind === 'resolved') {
      expect(resolvedProtected.disposition.strategy).toBe('merge');
      expect(resolvedProtected.disposition.resolvedBy).toBe(DESKTOP_ACTOR);
      expect(resolvedProtected.disposition.auditEventRefs).toEqual([twinClose.eventId]);
    }

    // The workspace reflects the RECONCILED commercial position: the budget
    // at version 4 (the applied cost item), budgeted 1,030,000 minor, and
    // BOTH commitments committed — the closed purchase order AND the
    // successor carrying the staged amended scope (1,050,000 + 980,000).
    const finalWorkspace = unwrapDesktop(
      await host.data.workspace(
        desktopSession,
        desktopPlane,
        '2026-09-14T11:00:00.000Z' as Timestamp,
      ),
      'final workspace',
    );
    expect(finalWorkspace.cost.budgetVersion).toBe(4);
    expect(finalWorkspace.cost.budgetedMinor).toBe(1_030_000);
    expect(finalWorkspace.cost.committedMinor).toBe(2_030_000);
    expect(finalWorkspace.cost.remainingBudgetMinor).toBe(-1_000_000);
    expect(finalWorkspace.cost.committedVarianceMinor).toBe(1_000_000);
    expect(finalWorkspace.pendingCaptureCount).toBe(0);
    expect(finalWorkspace.slice.consumedPosition).toBe(17);
    // The schedule carries the committed progress state (the twin's record —
    // the superseded desktop update never landed): A-200 stands at 65%
    // complete with 12 remaining working units, so the serial chain's
    // forecast projects 20 + 12 + 15 = 47.
    expect(finalWorkspace.schedule.version).toBe(9);
    expect(finalWorkspace.schedule.forecastProjectDuration).toBe(47);

    // The sync audit discipline (freeze A3): the five consequential sync
    // transitions were audited through the shared sink, in causal order —
    // the open supersession, the protected surfacing, the clean replay, the
    // explicit resolution, and the reconciled mutation's replay.
    const auditNames = world.sync.audit.sink.events.map((event) => event.eventName);
    expect(auditNames).toEqual([
      'sync.conflictAutoResolved',
      'sync.conflictSurfaced',
      'sync.mutationReplayed',
      'sync.conflictResolved',
      'sync.mutationReplayed',
    ]);

    // ---- THE CROSS-CLIENT CONVERGENCE PROOF (A12) ------------------------
    // Both clients consumed exactly the world's PROJECT-slice events, once
    // each, in the same causal order — no duplicates, no losses (the
    // tenant-scope organization seed event is outside every project slice by
    // design, so both clients' streams are the seventeen project-scope
    // events of the world's eighteen).
    expect(officePlane.consume().ok).toBe(true);
    const desktopIds = desktopPlane.consumedEvents.map((event) => event.eventId);
    const officeIds = officePlane.consumedEvents.map((event) => event.eventId);
    expect(officeIds).toEqual(desktopIds);
    const projectSliceIds = world.ledgerEvents
      .filter((event) => event.envelope.scope.kind === 'project')
      .map((event) => event.eventId);
    expect(new Set(desktopIds)).toEqual(new Set(projectSliceIds));
    expect(desktopIds).toHaveLength(17);
    expect(world.ledgerEvents).toHaveLength(18);
    // The web-style twin saw the conflict surface too (every client's stream).
    expect(officePlane.engine.conflictsNotified).toHaveLength(2);
    expect(desktopPlane.engine.conflictsNotified).toHaveLength(2);
  });

  it('proves run-twice identity: a second, independently seeded scenario yields the identical view models', async () => {
    const operate = async () => {
      const harness = await desktopHarnessOf({
        now: clockOf(),
        newOpaqueId: sequentialOpaqueIds(),
      });
      const { world, desktopSession, desktopPlane, officeSession, officePlane } = harness;
      const { scheduleId, activityIds, budgetId, costItemIds, commitmentId } = world.identities;
      const secondActivity = secondActivityOf(activityIds);
      const seedStatus = unwrapDesktop(
        syncStatusView(desktopPlane, desktopSession),
        'seed status',
      );
      const seedWorkspace = unwrapDesktop(
        await desktopWorkspaceView(
          world,
          desktopSession,
          desktopPlane,
          '2026-09-14T09:00:00.000Z' as Timestamp,
        ),
        'seed workspace',
      );
      await submitProgress(
        desktopPlane,
        desktopSession,
        {
          scheduleId,
          activityId: secondActivity,
          expectedVersion: 7,
          percentComplete: 40,
          remainingDuration: 21,
        },
        '2026-09-14T09:10:00.000Z' as Timestamp,
      );
      unwrapDesktop(desktopPlane.consume(), 'own consume');
      // The twin's causal basis catches up to the same observed slice
      // position before it diverges (the conflict model's concurrency basis).
      unwrapDesktop(officePlane.consume(), 'twin catches up');
      unwrapDesktop(disconnect(desktopPlane, desktopSession), 'disconnect');
      const twinProgress = await submitProgress(
        officePlane,
        officeSession,
        {
          scheduleId,
          activityId: secondActivity,
          expectedVersion: 8,
          percentComplete: 65,
          remainingDuration: 12,
        },
        '2026-09-14T09:20:00.000Z' as Timestamp,
      );
      const twinClose = await submitCommitmentClose(
        officePlane,
        officeSession,
        {
          commitmentId,
          expectedVersion: 1,
          reason: 'Package re-scoped after the frame review',
        },
        '2026-09-14T09:25:00.000Z' as Timestamp,
      );
      unwrapDesktop(officePlane.consume(), 'office consume');
      const activityUpdate = await captureActivityUpdate(
        desktopPlane,
        desktopSession,
        {
          scheduleId,
          activityId: secondActivity,
          expectedVersion: 8,
          changes: { plannedDuration: 32 },
        },
        '2026-09-14T09:40:00.000Z' as Timestamp,
      );
      const amendment = await captureCommitmentAmend(
        desktopPlane,
        desktopSession,
        {
          commitmentId,
          expectedVersion: 1,
          budgetId,
          reason: 'Staged scope revision prepared offline',
          lines: [
            {
              costItemId: costItemIds[0] as string,
              description: 'Concrete works package — staged amendment',
              amountMinor: 980_000,
            },
          ],
        },
        '2026-09-14T09:45:00.000Z' as Timestamp,
      );
      const costItem = await captureCostItem(
        desktopPlane,
        desktopSession,
        {
          budgetId,
          expectedVersion: 3,
          code: 'SCAF',
          description: 'Scaffolding and access',
          unit: 'm2',
          quantityMilli: 1_200,
          unitRateMinor: 25_000,
        },
        '2026-09-14T09:50:00.000Z' as Timestamp,
      );
      const queueView = unwrapDesktop(
        offlineQueueView(desktopPlane, desktopSession),
        'queue view',
      );
      const report = unwrapDesktop(
        await synchronize(desktopPlane, desktopSession, '2026-09-14T10:00:00.000Z' as Timestamp),
        'synchronize',
      );
      const conflictState = unwrapDesktop(
        conflictStateView(world, desktopPlane, desktopSession),
        'conflict state',
      );
      const protectedConflict = conflictState.conflicts.find(
        (conflict) => conflict.protection === 'protected',
      );
      const resolution = await resolveProtectedConflict(
        desktopPlane,
        desktopSession,
        {
          conflictId: protectedConflict?.conflictId as string,
          strategy: 'merge',
          auditEventRefs: [twinClose.eventId as string],
          reconciled: {
            budgetId,
            number: 'PO-0002',
            commitmentKind: 'purchase-order',
            description: 'Structural frame package — reconciled staged scope',
            currency: 'EUR',
            lines: [
              {
                costItemId: costItemIds[0] as string,
                description: 'Concrete works package — staged amendment',
                amountMinor: 980_000,
              },
            ],
          },
        },
        '2026-09-14T10:30:00.000Z' as Timestamp,
      );
      const finalQueue = unwrapDesktop(
        offlineQueueView(desktopPlane, desktopSession),
        'final queue',
      );
      const finalConflicts = unwrapDesktop(
        conflictStateView(world, desktopPlane, desktopSession),
        'final conflicts',
      );
      const finalWorkspace = unwrapDesktop(
        await desktopWorkspaceView(
          world,
          desktopSession,
          desktopPlane,
          '2026-09-14T11:00:00.000Z' as Timestamp,
        ),
        'final workspace',
      );
      expect(officePlane.consume().ok).toBe(true);
      return {
        seedStatus,
        seedWorkspace,
        twinProgress,
        activityUpdate,
        amendment,
        costItem,
        queueView,
        report,
        conflictState,
        resolution,
        finalQueue,
        finalConflicts,
        finalWorkspace,
        consumedEventIds: desktopPlane.consumedEvents.map((event) => event.eventId),
      };
    };

    const first = await operate();
    const second = await operate();
    expect(second.seedStatus).toStrictEqual(first.seedStatus);
    expect(second.seedWorkspace).toStrictEqual(first.seedWorkspace);
    expect(second.twinProgress).toStrictEqual(first.twinProgress);
    expect(second.activityUpdate).toStrictEqual(first.activityUpdate);
    expect(second.amendment).toStrictEqual(first.amendment);
    expect(second.costItem).toStrictEqual(first.costItem);
    expect(second.queueView).toStrictEqual(first.queueView);
    expect(second.report).toStrictEqual(first.report);
    expect(second.conflictState).toStrictEqual(first.conflictState);
    expect(second.resolution).toStrictEqual(first.resolution);
    expect(second.finalQueue).toStrictEqual(first.finalQueue);
    expect(second.finalConflicts).toStrictEqual(first.finalConflicts);
    expect(second.finalWorkspace).toStrictEqual(first.finalWorkspace);
    expect(second.consumedEventIds).toStrictEqual(first.consumedEventIds);
  });

  it('surfaces typed rejections as displayable view models, never throws (the lifecycle and input gates)', async () => {
    const harness = await desktopHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, desktopSession, desktopPlane, officeSession, officePlane } = harness;
    const { scheduleId, activityIds, budgetId, costItemIds } = world.identities;
    const secondActivity = secondActivityOf(activityIds);
    const FIXED_NOW = '2026-09-14T12:00:00.000Z' as Timestamp;

    // An OFFLINE capture while still CONNECTED is the engine's typed
    // session-state rejection — displayed, never thrown.
    const connected = await captureCostItem(
      desktopPlane,
      desktopSession,
      {
        budgetId,
        expectedVersion: 3,
        code: 'PROBE',
        description: 'A capture that must be typed-rejected while connected',
        unit: 'ea',
        quantityMilli: 1,
        unitRateMinor: 1,
      },
      FIXED_NOW,
    );
    expect(connected.status).toBe('rejected');
    expect(connected.entry).toBeNull();
    expect(connected.rejection?.code).toBe('invariant-violation');
    expect(connected.rejection?.details[0]?.code).toBe('sync-session-state');

    // A malformed budget id is a typed input rejection (displayable).
    const malformed = await captureCostItem(
      desktopPlane,
      desktopSession,
      {
        budgetId: 'not-a-canonical-id',
        expectedVersion: 3,
        code: 'PROBE',
        description: 'A malformed identity probe',
        unit: 'ea',
        quantityMilli: 1,
        unitRateMinor: 1,
      },
      FIXED_NOW,
    );
    expect(malformed.status).toBe('rejected');
    expect(malformed.rejection?.code).toBe('invalid-budget-id');

    // Nothing captured so far.
    expect(desktopPlane.engine.queue.size).toBe(0);

    // The disconnected discipline: an ONLINE submission while disconnected
    // is the engine's typed session-state rejection — displayed.
    unwrapDesktop(disconnect(desktopPlane, desktopSession), 'disconnect');
    const disconnectedSubmission = await submitProgress(
      desktopPlane,
      desktopSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 7,
        percentComplete: 50,
        remainingDuration: 17,
      },
      FIXED_NOW,
    );
    expect(disconnectedSubmission.status).toBe('rejected');
    expect(disconnectedSubmission.rejection?.details[0]?.code).toBe('sync-session-state');

    // A resolution of an UNKNOWN conflict id is the engine's typed
    // not-found — displayed (and nothing re-entered the queue). Reconnect
    // first (the still-empty queue drains with no effect) so the probe
    // exercises the engine's conflict-lookup gate itself, not the
    // session-state gate that fronts it.
    unwrapDesktop(
      await synchronize(desktopPlane, desktopSession, '2026-09-14T12:05:00.000Z' as Timestamp),
      'reconnect',
    );
    const unknownConflict = await resolveProtectedConflict(
      desktopPlane,
      desktopSession,
      {
        conflictId: 'office-scf-v1-00000000000000000000000000000000',
        strategy: 'merge',
        auditEventRefs: ['office-evt-v1-00000000000000000000000000000000'],
        reconciled: {
          budgetId,
          number: 'PO-0009',
          commitmentKind: 'purchase-order',
          description: 'An unknown-conflict probe',
          currency: 'EUR',
          lines: [
            { costItemId: costItemIds[0] as string, description: 'probe', amountMinor: 1 },
          ],
        },
      },
      FIXED_NOW,
    );
    expect(unknownConflict.status).toBe('rejected');
    expect(unknownConflict.rejection?.code).toBe('not-found');
    expect(desktopPlane.engine.queue.size).toBe(0);

    // A malformed conflict id is a typed input rejection.
    const malformedConflict = await resolveProtectedConflict(
      desktopPlane,
      desktopSession,
      {
        conflictId: 'not-a-conflict-id',
        strategy: 'merge',
        auditEventRefs: ['office-evt-v1-00000000000000000000000000000000'],
        reconciled: {
          budgetId,
          number: 'PO-0009',
          commitmentKind: 'purchase-order',
          description: 'A malformed-conflict probe',
          currency: 'EUR',
          lines: [
            { costItemId: costItemIds[0] as string, description: 'probe', amountMinor: 1 },
          ],
        },
      },
      FIXED_NOW,
    );
    expect(malformedConflict.status).toBe('rejected');
    expect(malformedConflict.rejection?.code).toBe('invalid-conflict-id');

    // The web-style twin's malformed commitment close is a typed input
    // rejection on the online path too.
    const malformedClose = await submitCommitmentClose(
      officePlane,
      officeSession,
      { commitmentId: 'nope', expectedVersion: 1, reason: 'A malformed identity probe' },
      FIXED_NOW,
    );
    expect(malformedClose.status).toBe('rejected');
    expect(malformedClose.rejection?.code).toBe('invalid-commitment-id');
    expect(malformedClose.eventId).toBeNull();

    // NOTHING executed: the world's ledger still carries exactly the seed.
    expect(world.ledgerEvents).toHaveLength(13);
  });

  it('keeps a stale expected version a displayable, retryable drain rejection (the domain typed concurrency gate)', async () => {
    const harness = await desktopHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, desktopSession, desktopPlane } = harness;
    const { budgetId } = world.identities;

    unwrapDesktop(disconnect(desktopPlane, desktopSession), 'disconnect');
    // A cost item captured against a STALE budget version (2, while the
    // budget is at 3): no divergence on the budget aggregate, so the drain
    // reaches the typed command path — where the cost domain's own
    // concurrency-conflict surfaces as a displayable REJECTED outcome and
    // the entry stays PENDING (retryable — nothing lost).
    const stale = await captureCostItem(
      desktopPlane,
      desktopSession,
      {
        budgetId,
        expectedVersion: 2,
        code: 'PROBE',
        description: 'A stale-version capture that must stay retryable',
        unit: 'ea',
        quantityMilli: 1,
        unitRateMinor: 1,
      },
      '2026-09-14T09:40:00.000Z' as Timestamp,
    );
    expect(stale.status).toBe('queued');
    const report = unwrapDesktop(
      await synchronize(desktopPlane, desktopSession, '2026-09-14T10:00:00.000Z' as Timestamp),
      'synchronize',
    );
    expect(report.counts).toEqual({
      catchup: 0,
      applied: 0,
      rejected: 1,
      conflicted: 0,
      superseded: 0,
    });
    expect(report.rejected[0]?.code).toBe('concurrency-conflict');
    expect(report.rejected[0]?.operationId).toBe(stale.entry?.operationId);
    expect(report.remainingPending).toBe(1);
    const queueView = unwrapDesktop(
      offlineQueueView(desktopPlane, desktopSession),
      'queue view',
    );
    expect(queueView.pendingCount).toBe(1);
    expect(queueView.entries[0]?.state).toBe('pending');
    // The world's journal recorded the rejected command (typed, never lost).
    const staleJournal = world.commandJournal.find(
      (entry) => entry.idempotencyKey === stale.entry?.operationId,
    );
    expect(staleJournal?.outcome).toBe('rejected');
    expect(staleJournal?.rejectionCode).toBe('concurrency-conflict');
    // And the world's ledger still carries exactly the seed.
    expect(world.ledgerEvents).toHaveLength(13);
  });

  it('drives the full client loop through THE platform shell host-port contract itself (typed and fail-closed)', async () => {
    const harness = await desktopHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, host, desktopSession } = harness;
    const { scheduleId, activityIds } = world.identities;
    const secondActivity = secondActivityOf(activityIds);

    // THE fail-closed candidate validation: every malformed host port is a
    // typed rejection naming the offending path — never a silent partial host.
    const notAnObject = validateDesktopHostPort(null);
    expect(notAnObject.ok).toBe(false);
    if (!notAnObject.ok) expect(notAnObject.error.code).toBe('host-port-not-an-object');
    const wrongKind = validateDesktopHostPort({});
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe('host-port-kind');
    const memberMissing = validateDesktopHostPort({
      kind: 'desktop-host-port',
      identity: {},
      data: {},
      commands: {},
    });
    expect(memberMissing.ok).toBe(false);
    if (!memberMissing.ok) {
      expect(memberMissing.error.code).toBe('host-port-member-missing');
      expect(memberMissing.error.code === 'host-port-member-missing' && memberMissing.error.path).toBe(
        'identity.resolveSession',
      );
    }
    const completePort = {
      identity: { resolveSession: () => null },
      data: {
        openPlane: () => null,
        workspace: () => null,
        queue: () => null,
        syncStatus: () => null,
        conflictState: () => null,
      },
      commands: {
        submit: () => null,
        capture: () => null,
        synchronize: () => null,
        disconnect: () => null,
        resolveConflict: () => null,
      },
    };
    const unknownSection = validateDesktopHostPort({
      kind: 'desktop-host-port',
      ...completePort,
      extra: {},
    });
    expect(unknownSection.ok).toBe(false);
    if (!unknownSection.ok) {
      expect(unknownSection.error.code).toBe('host-port-unknown-section');
      expect(unknownSection.error.code === 'host-port-unknown-section' && unknownSection.error.path).toBe(
        'extra',
      );
    }
    const notCallable = validateDesktopHostPort({
      kind: 'desktop-host-port',
      identity: { resolveSession: 'not-a-function' },
      data: completePort.data,
      commands: completePort.commands,
    });
    expect(notCallable.ok).toBe(false);
    if (!notCallable.ok) {
      expect(notCallable.error.code).toBe('host-port-member-not-callable');
      expect(
        notCallable.error.code === 'host-port-member-not-callable' && notCallable.error.path,
      ).toBe('identity.resolveSession');
    }

    // THE port-driven loop: open the session's plane through the DATA port,
    // write ONLINE through the COMMAND port's generic typed executor,
    // disconnect, capture OFFLINE through the same executor, synchronize,
    // and read every view back through the DATA port.
    const plane = await host.data.openPlane(desktopSession, {
      now: clockOf(),
      serial: 3,
      ordinal: 3,
    });
    expect(plane.engine.connected).toBe(true);
    const request: DesktopMutationRequest = {
      commandName: RECORD_PROGRESS_COMMAND,
      payload: {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 7,
        percentComplete: 25,
        remainingDuration: 26,
        actualStart: null,
        actualFinish: null,
      },
      target: entityRefOf(ACTIVITY_KIND, secondActivity),
      operationKind: 'record-activity-progress',
      requiredCapability: capability('schedule.write'),
      protection: 'open',
    };
    const submitted = await host.commands.submit(plane, desktopSession, request, '2026-09-14T09:10:00.000Z' as Timestamp);
    expect(submitted.status).toBe('executed');
    expect(submitted.eventName).toBe('schedule.progressRecorded');
    expect(unwrapDesktop(plane.consume(), 'port plane consume')).toHaveLength(1);

    expect(host.commands.disconnect(plane, desktopSession).ok).toBe(true);
    // The offline capture composes against the schedule's CURRENT version
    // (8 — the client's own online write is in its causal basis now).
    const captured = host.commands.capture(
      plane,
      desktopSession,
      {
        ...request,
        payload: {
          ...request.payload,
          expectedVersion: 8,
          percentComplete: 30,
          remainingDuration: 24,
        },
      },
      '2026-09-14T09:40:00.000Z' as Timestamp,
    );
    expect(captured.status).toBe('queued');
    expect(captured.entry?.state).toBe('pending');

    const report = unwrapDesktop(
      await host.commands.synchronize(plane, desktopSession, '2026-09-14T10:00:00.000Z' as Timestamp),
      'port synchronize',
    );
    expect(report.counts).toEqual({
      catchup: 0,
      applied: 1,
      rejected: 0,
      conflicted: 0,
      superseded: 0,
    });
    // Every data-port read resolves over the port-driven plane.
    expect(unwrapDesktop(host.data.syncStatus(desktopSession, plane), 'status').connected).toBe(true);
    expect(unwrapDesktop(host.data.queue(desktopSession, plane), 'queue').pendingCount).toBe(0);
    expect(
      unwrapDesktop(host.data.conflictState(desktopSession, plane), 'conflicts').conflicts,
    ).toStrictEqual([]);
    const workspace = unwrapDesktop(
      await host.data.workspace(desktopSession, plane, '2026-09-14T11:00:00.000Z' as Timestamp),
      'port workspace',
    );
    // The twice-recorded progress landed on the schedule (version 9 — the
    // port-driven online write + the port-driven offline capture).
    expect(workspace.schedule.version).toBe(9);
    expect(workspace.pendingCaptureCount).toBe(0);
  });
});
