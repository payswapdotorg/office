// Office desktop client protocol/reference shell — the A12 scope self-gate
// (OFF-032).
//
// Freeze A12 (ONE project state, all clients share it — the desktop is a
// CLIENT of the same protocol): the desktop shell's EVERY surface resolves
// through ONE typed session record, and a foreign tenant's or a foreign
// project's address is a TYPED rejection — never data, never an existence
// oracle, never a throw. Both directions are proven here:
//
//   - a foreign session (tenant B, or tenant A on another project) probing
//     the seeded desktop world's real identities: offline captures, online
//     submissions, the workspace read view, the queue/status/conflict views,
//     and the synchronize flow all typed-reject with ZERO effects;
//   - both foreign directions receive the IDENTICAL typed rejection (the
//     surfaces never reveal which side of the boundary an address sits on —
//     no existence oracle);
//   - malformed session identities are typed input rejections (displayable).
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  captureActivityUpdate,
  captureCommitmentAmend,
  conflictStateView,
  createDesktopSession,
  desktopWorkspaceView,
  disconnect,
  offlineQueueView,
  openDesktopDataPlane,
  submitCommitmentClose,
  submitProgress,
  syncStatusView,
  synchronize,
} from './index';
import {
  DESKTOP_ACTOR,
  PROJECT_1,
  PROJECT_OTHER,
  TENANT_A,
  TENANT_B,
  desktopHarnessOf,
  sequentialOpaqueIds,
  sessionOf,
} from './test-support';

const FIXED_NOW = (): Timestamp => '2026-09-14T12:00:00.000Z' as Timestamp;

describe('A12 — every surface resolves through ONE typed session (cross-scope typed-rejected both directions)', () => {
  it('rejects malformed session identities as typed, displayable input rejections', () => {
    const badTenant = createDesktopSession({ tenantId: 'not-a-tenant', projectId: PROJECT_1, actorId: DESKTOP_ACTOR });
    expect(badTenant.ok).toBe(false);
    if (!badTenant.ok) expect(badTenant.error.code).toBe('invalid-tenant-id');

    const badProject = createDesktopSession({ tenantId: TENANT_A, projectId: 'x', actorId: DESKTOP_ACTOR });
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.error.code).toBe('invalid-project-id');

    const badActor = createDesktopSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: 'nope' });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.code).toBe('invalid-actor');
  });

  it('typed-rejects a foreign session OFFLINE capture with NO effect (both directions)', async () => {
    const harness = await desktopHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;
    const { scheduleId, activityIds, budgetId, commitmentId } = world.identities;
    const secondActivity = activityIds[1] as string;

    // Direction 1: tenant B's session (naming the REAL project id). The
    // disconnect surface itself resolves through the session: a foreign
    // session's disconnect is the typed A12 rejection (never an effect — the
    // engine session stays connected, and the capture below is rejected by
    // the SAME scope gate before the engine is ever reached).
    const foreignTenantSession = sessionOf(TENANT_B, PROJECT_1, DESKTOP_ACTOR);
    const foreignTenantPlane = await openDesktopDataPlane(world, foreignTenantSession, {
      now: FIXED_NOW,
      serial: 3,
      ordinal: 3,
    });
    const foreignDisconnect = disconnect(foreignTenantPlane, foreignTenantSession);
    expect(foreignDisconnect.ok).toBe(false);
    if (!foreignDisconnect.ok) {
      expect(foreignDisconnect.error.code).toBe('session-scope-uncovered');
    }
    const captureTenant = await captureActivityUpdate(
      foreignTenantPlane,
      foreignTenantSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 7,
        changes: { plannedDuration: 30 },
      },
      FIXED_NOW(),
    );
    expect(captureTenant.status).toBe('rejected');
    expect(captureTenant.entry).toBeNull();
    expect(captureTenant.rejection?.code).toBe('unauthorized');
    expect(captureTenant.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // Direction 2: tenant A's session on a foreign project.
    const foreignProjectSession = sessionOf(TENANT_A, PROJECT_OTHER, DESKTOP_ACTOR);
    const foreignProjectPlane = await openDesktopDataPlane(world, foreignProjectSession, {
      now: FIXED_NOW,
      serial: 4,
      ordinal: 4,
    });
    const foreignDisconnect2 = disconnect(foreignProjectPlane, foreignProjectSession);
    expect(foreignDisconnect2.ok).toBe(false);
    if (!foreignDisconnect2.ok) {
      expect(foreignDisconnect2.error.code).toBe('session-scope-uncovered');
    }
    const captureProject = await captureCommitmentAmend(
      foreignProjectPlane,
      foreignProjectSession,
      {
        commitmentId,
        expectedVersion: 1,
        budgetId,
        reason: 'A foreign project probe that must never land',
        lines: [],
      },
      FIXED_NOW(),
    );
    expect(captureProject.status).toBe('rejected');
    expect(captureProject.rejection?.code).toBe('unauthorized');
    expect(captureProject.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // NO effect landed: neither foreign queue captured anything and the
    // world's ledger still carries exactly the seed.
    expect(foreignTenantPlane.engine.queue.size).toBe(0);
    expect(foreignProjectPlane.engine.queue.size).toBe(0);
    expect(world.ledgerEvents).toHaveLength(13);
  });

  it('typed-rejects a foreign session ONLINE submission with NO effect (both directions)', async () => {
    const harness = await desktopHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;
    const { scheduleId, activityIds, commitmentId } = world.identities;
    const secondActivity = activityIds[1] as string;

    const foreignTenantSession = sessionOf(TENANT_B, PROJECT_1, DESKTOP_ACTOR);
    const foreignTenantPlane = await openDesktopDataPlane(world, foreignTenantSession, {
      now: FIXED_NOW,
      serial: 3,
      ordinal: 3,
    });
    const submissionTenant = await submitProgress(
      foreignTenantPlane,
      foreignTenantSession,
      {
        scheduleId,
        activityId: secondActivity,
        expectedVersion: 7,
        percentComplete: 10,
        remainingDuration: 31,
      },
      FIXED_NOW(),
    );
    expect(submissionTenant.status).toBe('rejected');
    expect(submissionTenant.eventId).toBeNull();
    expect(submissionTenant.rejection?.code).toBe('unauthorized');
    expect(submissionTenant.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    const foreignProjectSession = sessionOf(TENANT_A, PROJECT_OTHER, DESKTOP_ACTOR);
    const foreignProjectPlane = await openDesktopDataPlane(world, foreignProjectSession, {
      now: FIXED_NOW,
      serial: 4,
      ordinal: 4,
    });
    const submissionProject = await submitCommitmentClose(
      foreignProjectPlane,
      foreignProjectSession,
      { commitmentId, expectedVersion: 1, reason: 'A foreign project probe' },
      FIXED_NOW(),
    );
    expect(submissionProject.status).toBe('rejected');
    expect(submissionProject.rejection?.code).toBe('unauthorized');
    expect(submissionProject.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // NO effect landed: the ledger still carries exactly the seed.
    expect(world.ledgerEvents).toHaveLength(13);
  });

  it('typed-rejects the workspace read view for a foreign session with the IDENTICAL rejection both directions (no existence oracle)', async () => {
    const harness = await desktopHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, desktopSession, desktopPlane } = harness;

    // Direction 1: tenant B's session (naming the REAL project id), over its
    // own plane on the seeded world — a typed unauthorized rejection.
    const foreignTenant = sessionOf(TENANT_B, PROJECT_1, DESKTOP_ACTOR);
    const foreignTenantPlane = await openDesktopDataPlane(world, foreignTenant, {
      now: FIXED_NOW,
      serial: 3,
      ordinal: 3,
    });
    const tenantRead = await desktopWorkspaceView(world, foreignTenant, foreignTenantPlane, FIXED_NOW());
    expect(tenantRead.ok).toBe(false);

    // Direction 2: tenant A's session on a foreign project, over its own
    // plane on the same world.
    const foreignProject = sessionOf(TENANT_A, PROJECT_OTHER, DESKTOP_ACTOR);
    const foreignProjectPlane = await openDesktopDataPlane(world, foreignProject, {
      now: FIXED_NOW,
      serial: 4,
      ordinal: 4,
    });
    const projectRead = await desktopWorkspaceView(world, foreignProject, foreignProjectPlane, FIXED_NOW());
    expect(projectRead.ok).toBe(false);

    // NO existence oracle: both directions receive the IDENTICAL typed
    // rejection (same code, same detail) — the surface never reveals which
    // side of the boundary the address sits on.
    if (!tenantRead.ok && !projectRead.ok) {
      expect(projectRead.error.code).toBe(tenantRead.error.code);
      expect(projectRead.error.code).toBe('unauthorized');
      expect(
        (projectRead.error as { details?: readonly { code: string }[] }).details?.[0]?.code,
      ).toBe((tenantRead.error as { details?: readonly { code: string }[] }).details?.[0]?.code);
    }

    // The seeded session still reads the whole workspace (the control).
    const own = await desktopWorkspaceView(world, desktopSession, desktopPlane, FIXED_NOW());
    expect(own.ok).toBe(true);
  });

  it('typed-rejects the queue/status/conflict/synchronize surfaces for a foreign session (the session-scoped surfaces)', async () => {
    const harness = await desktopHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, desktopSession, desktopPlane } = harness;
    const foreign = sessionOf(TENANT_B, PROJECT_1, DESKTOP_ACTOR);

    // The desktop session's own planes are wired over the seeded world; a
    // foreign session may not resolve ANY of their session-scoped views.
    expect(offlineQueueView(desktopPlane, foreign).ok).toBe(false);
    expect(syncStatusView(desktopPlane, foreign).ok).toBe(false);
    expect(conflictStateView(world, desktopPlane, foreign).ok).toBe(false);
    const sync = await synchronize(desktopPlane, foreign, FIXED_NOW());
    expect(sync.ok).toBe(false);
    if (!sync.ok) expect(sync.error.code).toBe('session-scope-uncovered');

    // The seeded session still resolves every one (the control).
    expect(offlineQueueView(desktopPlane, desktopSession).ok).toBe(true);
    expect(syncStatusView(desktopPlane, desktopSession).ok).toBe(true);
    expect(conflictStateView(world, desktopPlane, desktopSession).ok).toBe(true);
    // And the seeded session's synchronize (still connected) is the engine's
    // own typed lifecycle rejection — never data, never a throw.
    const ownSync = await synchronize(desktopPlane, desktopSession, FIXED_NOW());
    expect(ownSync.ok).toBe(false);
    if (!ownSync.ok) expect(ownSync.error.code).toBe('sync-rejected');
  });
});
