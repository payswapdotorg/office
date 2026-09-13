// Office field/offline web client — THE golden scenario (OFF-031).
//
// THE named acceptance: capture on a DISCONNECTED network → RECONNECT →
// SYNCHRONIZE → SHOW CONFLICT STATE — end to end through PUBLIC package
// surfaces, in memory, deterministically, with ZERO direct database access:
//
//   1. the CONNECTED SEED: both clients (the field session + the office-side
//      twin) subscribe over the seeded field world — one organization, one
//      project, ONE open field observation (the contested target), one open
//      issue; the field board loads from the session's own consumed stream;
//   2. DISCONNECT: the field session drops offline (the engine stops
//      consuming its stream);
//   3. the office twin mutates the SAME targets ONLINE (the window the field
//      client will not have seen — the divergence);
//   4. CAPTURE: the field session captures three mutations OFFLINE — a new
//      observation (open), an evidence link on the contested field event
//      (PROTECTED), an issue resolution (open) — queued, counted, and
//      displayable (the queue state view shows the pending count, the
//      entries, and the protection classes);
//   5. RECONNECT + SYNCHRONIZE: the engine's exactly-once drain applies the
//      observation cleanly (the server world reflects it through the typed
//      command path), parks the PROTECTED evidence capture as an explicit
//      conflict (never applied — structurally no auto-resolution), and
//      supersedes the OPEN issue resolution deterministically (committed
//      server side stands, recorded + audited); the sync report becomes a
//      displayable view model and the cursor/token state is displayable;
//   6. the CONFLICT STATE: both surfaced conflicts are displayable view
//      models carrying BOTH SIDES + provenance; the PROTECTED conflict shows
//      the no-auto-resolution state and the ONLY exit (the typed explicit
//      resolution command as a user action); the OPEN conflict shows the
//      deterministic supersession outcome;
//   7. THE EXPLICIT RESOLUTION: the field user resolves the protected
//      conflict explicitly (merge strategy, the diverging event as audit
//      evidence, the RECONCILED evidence attachment at the field event's
//      CURRENT version) — the reconciled mutation re-enters the queue
//      discipline and applies EXACTLY ONCE;
//   8. THE QUEUE IS EMPTY and the views reflect the RECONCILED state: the
//      field event carries BOTH sides' evidence (the merge), the board
//      re-derives from the session's own consumed stream, and both clients
//      converge on the world's actual ledger state.
//
// Run-twice identity closes the scenario: a SECOND, independently seeded
// world + sessions + planes, operated identically, produces the
// byte-identical view models (A7: every view is a deterministic projection).
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import type { OperationId } from '@office/sync';
import { CAPTURE_FIELD_EVENT_COMMAND, RESOLVE_ISSUE_COMMAND } from '@office/domain-field';
import { ATTACH_FIELD_EVENT_EVIDENCE_COMMAND } from './session/world';
import {
  captureEvidenceAttachment,
  captureFieldObservation,
  captureIssueResolution,
  conflictStateView,
  disconnect,
  fieldBoardView,
  fieldEventView,
  offlineQueueView,
  resolveProtectedConflict,
  submitEvidenceAttachment,
  submitIssueResolution,
  syncStatusView,
  synchronize,
} from './index';
import {
  FIELD_ACTOR,
  FIELD_EVIDENCE,
  OFFICE_EVIDENCE,
  sequentialOpaqueIds,
  unwrapField,
  fieldHarnessOf,
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

describe('THE golden scenario — capture offline, reconnect, synchronize, show conflict state', () => {
  it('seeds connected, disconnects, captures offline, reconnects, synchronizes, surfaces the conflict, resolves it explicitly, and converges', async () => {
    const harness = await fieldHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession, fieldPlane, officeSession, officePlane } = harness;
    const fieldEventId = world.identities.fieldEventId;
    const issueId = world.identities.issueId;

    // ---- 1. THE CONNECTED SEED ------------------------------------------
    // Both clients subscribed over the seeded world: the field session's
    // causal-token basis is the seed itself (4 events), the board loads from
    // its OWN consumed stream.
    expect(fieldPlane.engine.connected).toBe(true);
    expect(officePlane.engine.connected).toBe(true);
    const seedStatus = unwrapField(syncStatusView(fieldPlane, fieldSession), 'seed status');
    expect(seedStatus.connected).toBe(true);
    // The project slice carries the three PROJECT-scope seed events (project
    // created, observation captured, issue raised) — the tenant-scope
    // organization event is invisible to every project-scope subscription by
    // design (A12: the slice is the project's own stream, no existence
    // oracle), so the session's causal-token basis is position 3.
    expect(seedStatus.consumedPosition).toBe(3);
    expect(seedStatus.pendingCount).toBe(0);
    const seedBoard = unwrapField(
      await fieldBoardView(world, fieldSession, fieldPlane),
      'seed board',
    );
    expect(seedBoard.projectName).toBe('Reference Field Works');
    expect(seedBoard.recentFieldEvents).toHaveLength(1);
    expect(seedBoard.recentFieldEvents[0]?.status).toBe('open');
    expect(seedBoard.openIssues).toHaveLength(1);
    expect(seedBoard.openIssues[0]?.title).toBe('Curing blanket shortfall at grid B3');

    // ---- 2. DISCONNECT --------------------------------------------------
    const offline = disconnect(fieldPlane, fieldSession);
    expect(offline.ok).toBe(true);
    const offlineStatus = unwrapField(syncStatusView(fieldPlane, fieldSession), 'offline status');
    expect(offlineStatus.connected).toBe(false);
    // The causal token is FROZEN at the slice's head (the next capture's basis).
    expect(offlineStatus.consumedPosition).toBe(3);

    // ---- 3. THE OFFICE TWIN MUTATES ONLINE (the divergence) --------------
    const officeAttach = await submitEvidenceAttachment(
      officePlane,
      officeSession,
      { fieldEventId, expectedVersion: 1, evidence: [OFFICE_EVIDENCE] },
      '2026-09-14T09:30:00.000Z' as Timestamp,
    );
    expect(officeAttach.status).toBe('executed');
    expect(officeAttach.eventName).toBe('field.fieldEventEvidenceAttached');
    const officeAttachEventId = officeAttach.eventId as string;
    const officeResolve = await submitIssueResolution(
      officePlane,
      officeSession,
      {
        issueId,
        expectedVersion: 1,
        resolutionNote: 'Materials restocked and confirmed by the site store',
      },
      '2026-09-14T09:35:00.000Z' as Timestamp,
    );
    expect(officeResolve.status).toBe('executed');
    expect(officeResolve.eventName).toBe('field.issueResolved');
    expect(unwrapField(officePlane.consume(), 'office consume').length).toBe(2);

    // ---- 4. CAPTURE FIELD OBSERVATIONS OFFLINE (queued/counted/displayable)
    const observation = await captureFieldObservation(
      fieldPlane,
      fieldSession,
      {
        category: 'site-condition',
        summary: 'Grid B4 formwork alignment checked',
        detail: 'Alignment within tolerance; ready for the pour.',
        location: 'level-2/grid-b4',
        observedAt: '2026-09-14T09:58:00.000Z',
        observedBy: FIELD_ACTOR,
      },
      '2026-09-14T10:00:00.000Z' as Timestamp,
    );
    expect(observation.status).toBe('queued');
    expect(observation.command.commandName).toBe(CAPTURE_FIELD_EVENT_COMMAND);
    expect(observation.command.protection).toBe('open');
    expect(observation.entry?.state).toBe('pending');
    expect(observation.entry?.localSequence).toBe(1);
    expect(observation.entry?.targetKind).toBe('project');
    expect(observation.rejection).toBeNull();

    const evidence = await captureEvidenceAttachment(
      fieldPlane,
      fieldSession,
      { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      '2026-09-14T10:05:00.000Z' as Timestamp,
    );
    expect(evidence.status).toBe('queued');
    expect(evidence.command.commandName).toBe(ATTACH_FIELD_EVENT_EVIDENCE_COMMAND);
    expect(evidence.command.protection).toBe('protected');
    expect(evidence.entry?.localSequence).toBe(2);
    expect(evidence.entry?.targetKind).toBe('field-event');
    expect(evidence.entry?.targetId).toBe(fieldEventId);
    const evidenceOperationId = evidence.entry?.operationId as string;

    const issueResolution = await captureIssueResolution(
      fieldPlane,
      fieldSession,
      {
        issueId,
        expectedVersion: 1,
        resolutionNote: 'Curing blankets restocked from the level 1 store',
      },
      '2026-09-14T10:10:00.000Z' as Timestamp,
    );
    expect(issueResolution.status).toBe('queued');
    expect(issueResolution.command.commandName).toBe(RESOLVE_ISSUE_COMMAND);
    expect(issueResolution.command.protection).toBe('open');
    expect(issueResolution.entry?.localSequence).toBe(3);

    // THE queue state view: pending count, entries, protection classes.
    const queueView = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'queue view');
    expect(queueView.pendingCount).toBe(3);
    expect(queueView.entryCount).toBe(3);
    expect(queueView.capacity).toBe(1024);
    expect(queueView.entries.map((entry) => entry.protection)).toEqual([
      'open',
      'protected',
      'open',
    ]);
    expect(queueView.entries.map((entry) => entry.state)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(queueView.entries.map((entry) => entry.commandName)).toEqual([
      CAPTURE_FIELD_EVENT_COMMAND,
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      RESOLVE_ISSUE_COMMAND,
    ]);
    // Every entry carries its client-generated deterministic operation id
    // (the command's idempotency key — the A8 offline rule).
    for (const entry of queueView.entries) {
      expect(entry.operationId).toMatch(/^office-op-v1-/);
      expect(entry.issuedAt).toBeTypeOf('string');
    }

    // ---- 5. RECONNECT + SYNCHRONIZE (the exactly-once drain) ------------
    const report = unwrapField(
      await synchronize(fieldPlane, fieldSession, '2026-09-14T11:00:00.000Z' as Timestamp),
      'synchronize',
    );
    // The catchup: exactly the missed window (the office twin's 2 events).
    expect(report.catchupCount).toBe(2);
    expect(report.catchup.map((event) => event.eventName)).toEqual([
      'field.fieldEventEvidenceAttached',
      'field.issueResolved',
    ]);
    // The drain: the observation applied cleanly; the PROTECTED evidence
    // capture conflicted (parked); the OPEN issue resolution superseded.
    expect(report.counts).toEqual({
      catchup: 2,
      applied: 1,
      rejected: 0,
      conflicted: 1,
      superseded: 1,
    });
    expect(report.applied[0]?.eventName).toBe('field.fieldEventCaptured');
    expect(report.applied[0]?.replayed).toBe(false);
    expect(report.conflicted[0]?.protection).toBe('protected');
    expect(report.superseded[0]?.conflictId).toBeTypeOf('string');
    expect(report.remainingPending).toBe(0);
    // The client's own replayed effect consumed live after the drain.
    expect(report.replayedOwnEffects.map((event) => event.eventName)).toEqual([
      'field.fieldEventCaptured',
    ]);
    // The cursor/token state advanced (displayable): 3 seed slice events +
    // the 2-event catchup window + the client's own replayed effect.
    expect(report.consumedPosition).toBe(6);

    // THE server world reflects the captures through the typed command
    // path: the observation's command executed under its operation id.
    const observationOperationId = queueView.entries[0]?.operationId as string;
    const observationJournalEntry = world.commandJournal.find(
      (entry) => entry.idempotencyKey === observationOperationId,
    );
    expect(observationJournalEntry?.outcome).toBe('executed');
    expect(observationJournalEntry?.eventName).toBe('field.fieldEventCaptured');

    // THE structural no-auto-resolution proof: the parked PROTECTED capture
    // never reached the command path (no journal entry, no applied event,
    // and the contested field event still carries only the office side).
    expect(
      world.commandJournal.filter((entry) => entry.idempotencyKey === evidenceOperationId),
    ).toHaveLength(0);
    expect(world.sync.journal.eventOf(evidenceOperationId as OperationId)).toBeNull();
    const contestedBeforeResolution = unwrapField(
      fieldEventView(world, fieldSession, fieldEventId),
      'contested before resolution',
    );
    expect(contestedBeforeResolution.version).toBe(2);
    expect(contestedBeforeResolution.evidence).toHaveLength(1);
    expect(contestedBeforeResolution.evidence[0]?.revisionId).toBe(OFFICE_EVIDENCE.revisionId);

    // The queue after the synchronize: nothing pending; the terminal states
    // are displayable.
    const queueAfterSync = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'queue after');
    expect(queueAfterSync.pendingCount).toBe(0);
    expect(queueAfterSync.entries.map((entry) => entry.state)).toEqual([
      'applied',
      'conflicted',
      'superseded',
    ]);

    // ---- 6. THE CONFLICT STATE (displayable view models) -----------------
    const conflictState = unwrapField(
      conflictStateView(world, fieldPlane, fieldSession),
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
    // BOTH SIDES: the field session's parked capture + the office twin's
    // online mutation (deterministic side order, same target).
    const sideOperations = [
      protectedConflict?.first.operationId,
      protectedConflict?.second.operationId,
    ].sort();
    expect(sideOperations).toEqual([evidenceOperationId, officeAttach.operationId].sort());
    for (const side of [protectedConflict?.first, protectedConflict?.second]) {
      expect(side?.operationKind).toBe('attach-field-evidence');
      expect(side?.targetKind).toBe('field-event');
      expect(side?.targetId).toBe(fieldEventId);
      expect(side?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // PROVENANCE: the contested project's scope, the detection time, the
    // protocol's detector.
    expect(protectedConflict?.provenance.projectId).toBe(world.identities.projectId);
    expect(protectedConflict?.provenance.detectedBy).toBe('system');
    expect(protectedConflict?.provenance.detectedAt).toBe('2026-09-14T11:00:00.000Z');

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
      expect(openConflict.disposition.strategy).toBe(
        openConflict.first.operationId === officeResolve.operationId
          ? 'first-operation-wins'
          : 'second-operation-wins',
      );
      // The diverging ledger event (the office twin's resolution) is the
      // audit evidence of the supersession.
      expect(openConflict.disposition.auditEventRefs).toEqual([officeResolve.eventId]);
    }

    // ---- 7. THE EXPLICIT RESOLUTION (the ONLY exit — a user action) ------
    const resolution = await resolveProtectedConflict(
      fieldPlane,
      fieldSession,
      {
        conflictId: protectedConflict?.conflictId as string,
        strategy: 'merge',
        auditEventRefs: [officeAttachEventId],
        reconciled: {
          fieldEventId,
          expectedVersion: 2,
          evidence: [FIELD_EVIDENCE],
        },
      },
      '2026-09-14T11:30:00.000Z' as Timestamp,
    );
    expect(resolution.status).toBe('resolved');
    expect(resolution.rejection).toBeNull();
    expect(resolution.conflict?.state).toBe('resolved');
    expect(resolution.conflict?.strategy).toBe('merge');
    expect(resolution.conflict?.resolvedBy).toBe(FIELD_ACTOR);
    // The reconciled mutation re-entered the queue and applied EXACTLY ONCE.
    expect(resolution.entry?.state).toBe('applied');
    expect(resolution.entry?.protection).toBe('protected');
    expect(resolution.entry?.localSequence).toBe(4);
    expect(resolution.outcome?.status).toBe('applied');
    expect(resolution.outcome?.eventId).toBeTypeOf('string');
    const resolutionOperationId = resolution.entry?.operationId as string;
    const resolutionJournalEntry = world.commandJournal.find(
      (entry) => entry.idempotencyKey === resolutionOperationId,
    );
    expect(resolutionJournalEntry?.outcome).toBe('executed');
    expect(resolutionJournalEntry?.eventName).toBe('field.fieldEventEvidenceAttached');

    // ---- 8. THE QUEUE IS EMPTY + THE VIEWS REFLECT THE RECONCILED STATE -
    const finalQueue = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'final queue');
    expect(finalQueue.pendingCount).toBe(0);
    expect(finalQueue.entryCount).toBe(4);
    expect(finalQueue.entries.map((entry) => entry.state)).toEqual([
      'applied',
      'conflicted',
      'superseded',
      'applied',
    ]);

    // No conflict remains unresolved.
    const finalConflicts = unwrapField(
      conflictStateView(world, fieldPlane, fieldSession),
      'final conflicts',
    );
    expect(finalConflicts.unresolvedCount).toBe(0);
    const resolvedProtected = finalConflicts.conflicts.find(
      (conflict) => conflict.protection === 'protected',
    );
    expect(resolvedProtected?.state).toBe('resolved');
    if (resolvedProtected?.disposition.kind === 'resolved') {
      expect(resolvedProtected.disposition.strategy).toBe('merge');
      expect(resolvedProtected.disposition.resolvedBy).toBe(FIELD_ACTOR);
      expect(resolvedProtected.disposition.auditEventRefs).toEqual([officeAttachEventId]);
    }

    // The contested field event carries BOTH SIDES' evidence (the merge):
    // the office twin's link AND the field crew's reconciled link.
    const reconciled = unwrapField(
      fieldEventView(world, fieldSession, fieldEventId),
      'reconciled field event',
    );
    expect(reconciled.version).toBe(3);
    expect(reconciled.status).toBe('open');
    expect(reconciled.evidence).toHaveLength(2);
    expect(reconciled.evidence.map((ref) => ref.revisionId).sort()).toEqual(
      [OFFICE_EVIDENCE.revisionId, FIELD_EVIDENCE.revisionId].sort(),
    );

    // The board re-derives from the session's OWN consumed stream: the
    // offline-captured observation joined the recent events and the issue
    // is closed (the office twin's resolution is in the stream).
    const finalBoard = unwrapField(
      await fieldBoardView(world, fieldSession, fieldPlane),
      'final board',
    );
    expect(finalBoard.recentFieldEvents).toHaveLength(2);
    expect(finalBoard.recentFieldEvents[0]?.summary).toBe('Grid B4 formwork alignment checked');
    expect(finalBoard.openIssues).toHaveLength(0);

    // The sync audit discipline (freeze A3): the five consequential sync
    // transitions were audited through the shared sink.
    const auditNames = world.sync.audit.sink.events.map((event) => event.eventName);
    expect(auditNames).toEqual([
      'sync.mutationReplayed',
      'sync.conflictSurfaced',
      'sync.conflictAutoResolved',
      'sync.conflictResolved',
      'sync.mutationReplayed',
    ]);

    // CONVERGENCE: both clients consumed exactly the world's PROJECT-slice
    // events, once each, in the same causal order — no duplicates, no losses
    // (the tenant-scope organization seed event is outside every project
    // slice by design, so both clients' streams are the seven project-scope
    // events of the world's eight).
    expect(officePlane.consume().ok).toBe(true);
    const fieldIds = fieldPlane.consumedEvents.map((event) => event.eventId);
    const officeIds = officePlane.consumedEvents.map((event) => event.eventId);
    expect(officeIds).toEqual(fieldIds);
    const projectSliceIds = world.ledgerEvents
      .filter((event) => event.envelope.scope.kind === 'project')
      .map((event) => event.eventId);
    expect(new Set(fieldIds)).toEqual(new Set(projectSliceIds));
    expect(fieldIds).toHaveLength(7);
    expect(world.ledgerEvents).toHaveLength(8);
    // The office twin saw the conflict surface too (every client's stream).
    expect(officePlane.engine.conflictsNotified).toHaveLength(2);
  });

  it('proves run-twice identity: a second, independently seeded scenario yields the identical view models', async () => {
    const operate = async () => {
      const harness = await fieldHarnessOf({
        now: clockOf(),
        newOpaqueId: sequentialOpaqueIds(),
      });
      const { world, fieldSession, fieldPlane, officeSession, officePlane } = harness;
      const fieldEventId = world.identities.fieldEventId;
      const issueId = world.identities.issueId;
      const seedStatus = unwrapField(syncStatusView(fieldPlane, fieldSession), 'seed status');
      const seedBoard = unwrapField(
        await fieldBoardView(world, fieldSession, fieldPlane),
        'seed board',
      );
      unwrapField(disconnect(fieldPlane, fieldSession), 'disconnect');
      const officeAttach = await submitEvidenceAttachment(
        officePlane,
        officeSession,
        { fieldEventId, expectedVersion: 1, evidence: [OFFICE_EVIDENCE] },
        '2026-09-14T09:30:00.000Z' as Timestamp,
      );
      await submitIssueResolution(
        officePlane,
        officeSession,
        {
          issueId,
          expectedVersion: 1,
          resolutionNote: 'Materials restocked and confirmed by the site store',
        },
        '2026-09-14T09:35:00.000Z' as Timestamp,
      );
      unwrapField(officePlane.consume(), 'office consume');
      const observation = await captureFieldObservation(
        fieldPlane,
        fieldSession,
        {
          category: 'site-condition',
          summary: 'Grid B4 formwork alignment checked',
          detail: 'Alignment within tolerance; ready for the pour.',
          location: 'level-2/grid-b4',
          observedAt: '2026-09-14T09:58:00.000Z',
          observedBy: FIELD_ACTOR,
        },
        '2026-09-14T10:00:00.000Z' as Timestamp,
      );
      const evidence = await captureEvidenceAttachment(
        fieldPlane,
        fieldSession,
        { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
        '2026-09-14T10:05:00.000Z' as Timestamp,
      );
      await captureIssueResolution(
        fieldPlane,
        fieldSession,
        {
          issueId,
          expectedVersion: 1,
          resolutionNote: 'Curing blankets restocked from the level 1 store',
        },
        '2026-09-14T10:10:00.000Z' as Timestamp,
      );
      const queueView = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'queue view');
      const report = unwrapField(
        await synchronize(fieldPlane, fieldSession, '2026-09-14T11:00:00.000Z' as Timestamp),
        'synchronize',
      );
      const conflictState = unwrapField(
        conflictStateView(world, fieldPlane, fieldSession),
        'conflict state',
      );
      const protectedConflict = conflictState.conflicts.find(
        (conflict) => conflict.protection === 'protected',
      );
      const resolution = await resolveProtectedConflict(
        fieldPlane,
        fieldSession,
        {
          conflictId: protectedConflict?.conflictId as string,
          strategy: 'merge',
          auditEventRefs: [officeAttach.eventId as string],
          reconciled: { fieldEventId, expectedVersion: 2, evidence: [FIELD_EVIDENCE] },
        },
        '2026-09-14T11:30:00.000Z' as Timestamp,
      );
      const finalQueue = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'final queue');
      const finalConflicts = unwrapField(
        conflictStateView(world, fieldPlane, fieldSession),
        'final conflicts',
      );
      const reconciled = unwrapField(
        fieldEventView(world, fieldSession, fieldEventId),
        'reconciled field event',
      );
      const finalBoard = unwrapField(
        await fieldBoardView(world, fieldSession, fieldPlane),
        'final board',
      );
      return {
        seedStatus,
        seedBoard,
        observation,
        evidence,
        queueView,
        report,
        conflictState,
        resolution,
        finalQueue,
        finalConflicts,
        reconciled,
        finalBoard,
      };
    };

    const first = await operate();
    const second = await operate();
    expect(second.seedStatus).toStrictEqual(first.seedStatus);
    expect(second.seedBoard).toStrictEqual(first.seedBoard);
    expect(second.observation).toStrictEqual(first.observation);
    expect(second.evidence).toStrictEqual(first.evidence);
    expect(second.queueView).toStrictEqual(first.queueView);
    expect(second.report).toStrictEqual(first.report);
    expect(second.conflictState).toStrictEqual(first.conflictState);
    expect(second.resolution).toStrictEqual(first.resolution);
    expect(second.finalQueue).toStrictEqual(first.finalQueue);
    expect(second.finalConflicts).toStrictEqual(first.finalConflicts);
    expect(second.reconciled).toStrictEqual(first.reconciled);
    expect(second.finalBoard).toStrictEqual(first.finalBoard);
  });

  it('surfaces typed rejections as displayable view models, never throws (the lifecycle and input gates)', async () => {
    const harness = await fieldHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession, fieldPlane, officeSession, officePlane } = harness;
    const fieldEventId = world.identities.fieldEventId;

    // An OFFLINE capture while still CONNECTED is the engine's typed
    // session-state rejection — displayed, never thrown.
    const connected = await captureFieldObservation(
      fieldPlane,
      fieldSession,
      {
        category: 'site-condition',
        summary: 'A capture that must be typed-rejected while connected',
        location: 'level-1/grid-a1',
        observedAt: '2026-09-14T10:15:00.000Z',
        observedBy: FIELD_ACTOR,
      },
      '2026-09-14T10:15:00.000Z' as Timestamp,
    );
    expect(connected.status).toBe('rejected');
    expect(connected.entry).toBeNull();
    expect(connected.rejection?.code).toBe('invariant-violation');
    expect(connected.rejection?.details[0]?.code).toBe('sync-session-state');

    // A malformed field event id is a typed input rejection (displayable).
    const malformed = await captureEvidenceAttachment(
      fieldPlane,
      fieldSession,
      { fieldEventId: 'not-a-canonical-id', expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      '2026-09-14T10:20:00.000Z' as Timestamp,
    );
    expect(malformed.status).toBe('rejected');
    expect(malformed.rejection?.code).toBe('invalid-field-event-id');

    // Nothing captured so far.
    expect(fieldPlane.engine.queue.size).toBe(0);

    // The disconnected discipline: an ONLINE submission while disconnected
    // is the engine's typed session-state rejection — displayed.
    unwrapField(disconnect(fieldPlane, fieldSession), 'disconnect');
    const disconnectedSubmission = await submitEvidenceAttachment(
      fieldPlane,
      fieldSession,
      { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      '2026-09-14T10:25:00.000Z' as Timestamp,
    );
    expect(disconnectedSubmission.status).toBe('rejected');
    expect(disconnectedSubmission.rejection?.details[0]?.code).toBe('sync-session-state');

    // A resolution of an UNKNOWN conflict id is the engine's typed
    // not-found — displayed (and nothing re-entered the queue). Reconnect
    // first (the still-empty queue drains with no effect) so the probe
    // exercises the engine's conflict-lookup gate itself, not the
    // session-state gate that fronts it.
    unwrapField(
      await synchronize(fieldPlane, fieldSession, '2026-09-14T10:28:00.000Z' as Timestamp),
      'reconnect',
    );
    const unknownConflict = await resolveProtectedConflict(
      fieldPlane,
      fieldSession,
      {
        conflictId: 'office-scf-v1-00000000000000000000000000000000',
        strategy: 'merge',
        auditEventRefs: ['office-evt-v1-00000000000000000000000000000000'],
        reconciled: { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      },
      '2026-09-14T10:30:00.000Z' as Timestamp,
    );
    expect(unknownConflict.status).toBe('rejected');
    expect(unknownConflict.rejection?.code).toBe('not-found');
    expect(fieldPlane.engine.queue.size).toBe(0);

    // A malformed conflict id / audit ref is a typed input rejection.
    const malformedConflict = await resolveProtectedConflict(
      fieldPlane,
      fieldSession,
      {
        conflictId: 'not-a-conflict-id',
        strategy: 'merge',
        auditEventRefs: ['office-evt-v1-00000000000000000000000000000000'],
        reconciled: { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      },
      '2026-09-14T10:35:00.000Z' as Timestamp,
    );
    expect(malformedConflict.status).toBe('rejected');
    expect(malformedConflict.rejection?.code).toBe('invalid-conflict-id');

    // The office session's malformed evidence link is a typed input
    // rejection on the online twin too.
    const malformedEvidence = await submitEvidenceAttachment(
      officePlane,
      officeSession,
      {
        fieldEventId,
        expectedVersion: 1,
        evidence: [
          { entityKind: 'document', entityId: 'nope', revisionId: 'also-nope' },
        ],
      },
      '2026-09-14T10:40:00.000Z' as Timestamp,
    );
    expect(malformedEvidence.status).toBe('rejected');
    expect(malformedEvidence.rejection?.code).toBe('invalid-evidence-entity-id');
    expect(malformedEvidence.eventId).toBeNull();

    // NOTHING executed: the world's ledger still carries exactly the seed.
    expect(world.ledgerEvents).toHaveLength(4);
  });

  it("keeps a stale reconciled version a displayable, retryable rejection (the domain's typed concurrency gate)", async () => {
    const harness = await fieldHarnessOf({
      now: clockOf(),
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession, fieldPlane, officeSession, officePlane } = harness;
    const fieldEventId = world.identities.fieldEventId;

    unwrapField(disconnect(fieldPlane, fieldSession), 'disconnect');
    const officeAttach = await submitEvidenceAttachment(
      officePlane,
      officeSession,
      { fieldEventId, expectedVersion: 1, evidence: [OFFICE_EVIDENCE] },
      '2026-09-14T09:30:00.000Z' as Timestamp,
    );
    expect(officeAttach.status).toBe('executed');
    unwrapField(officePlane.consume(), 'office consume');

    const evidence = await captureEvidenceAttachment(
      fieldPlane,
      fieldSession,
      { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      '2026-09-14T10:05:00.000Z' as Timestamp,
    );
    expect(evidence.status).toBe('queued');
    unwrapField(
      await synchronize(fieldPlane, fieldSession, '2026-09-14T11:00:00.000Z' as Timestamp),
      'synchronize',
    );
    const conflictState = unwrapField(
      conflictStateView(world, fieldPlane, fieldSession),
      'conflict state',
    );
    const protectedConflict = conflictState.conflicts.find(
      (conflict) => conflict.protection === 'protected',
    );

    // The resolution's reconciled mutation carries a STALE expected version
    // (1, while the field event is at 2): the command path's typed
    // concurrency-conflict surfaces as a displayable rejected outcome and
    // the re-entered entry stays PENDING (retryable — nothing lost).
    const stale = await resolveProtectedConflict(
      fieldPlane,
      fieldSession,
      {
        conflictId: protectedConflict?.conflictId as string,
        strategy: 'merge',
        auditEventRefs: [officeAttach.eventId as string],
        reconciled: { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      },
      '2026-09-14T11:30:00.000Z' as Timestamp,
    );
    expect(stale.status).toBe('resolved');
    expect(stale.outcome?.status).toBe('rejected');
    expect(stale.entry?.state).toBe('pending');
    const queueView = unwrapField(offlineQueueView(fieldPlane, fieldSession), 'queue view');
    expect(queueView.pendingCount).toBe(1);
    expect(queueView.entries[queueView.entries.length - 1]?.commandName).toBe(
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
    );
    // The conflict record itself was resolved (the explicit decision), the
    // contested state untouched by the stale attempt.
    const stillContested = unwrapField(
      fieldEventView(world, fieldSession, fieldEventId),
      'still contested',
    );
    expect(stillContested.version).toBe(2);
    expect(stillContested.evidence).toHaveLength(1);
  });
});
