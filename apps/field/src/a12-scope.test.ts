// Office field/offline web client — the A12 scope self-gate (OFF-031).
//
// Freeze A12 (ONE project state, all clients share it): the field client's
// EVERY surface resolves through ONE typed session record, and a foreign
// tenant's or a foreign project's address is a TYPED rejection — never
// data, never an existence oracle, never a throw. Both directions are
// proven here:
//
//   - a foreign session (tenant B, or tenant A on another project) probing
//     the seeded field world's real identities: offline captures, online
//     submissions, the field-event and board read views, the queue/status/
//     conflict views, and the synchronize flow all typed-reject with ZERO
//     effects;
//   - the seeded session probing an address it cannot see (a well-formed
//     but unknown field event id) receives the SAME typed not-found a
//     foreign session receives for a REAL id (no existence oracle);
//   - malformed session identities are typed input rejections (displayable).
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  captureEvidenceAttachment,
  captureFieldObservation,
  conflictStateView,
  createFieldSession,
  disconnect,
  fieldBoardView,
  fieldEventView,
  offlineQueueView,
  openFieldDataPlane,
  submitEvidenceAttachment,
  submitIssueResolution,
  syncStatusView,
  synchronize,
} from './index';
import {
  FIELD_ACTOR,
  FIELD_EVIDENCE,
  OFFICE_EVIDENCE,
  PROJECT_1,
  PROJECT_OTHER,
  TENANT_A,
  TENANT_B,
  sequentialOpaqueIds,
  sessionOf,
  unwrapField,
  fieldHarnessOf,
  dataPlaneOf,
} from './test-support';

const FIXED_NOW = (): Timestamp => '2026-09-14T12:00:00.000Z' as Timestamp;

describe('A12 — every surface resolves through ONE typed session (cross-scope typed-rejected both directions)', () => {
  it('rejects malformed session identities as typed, displayable input rejections', () => {
    const badTenant = createFieldSession({ tenantId: 'not-a-tenant', projectId: PROJECT_1, actorId: FIELD_ACTOR });
    expect(badTenant.ok).toBe(false);
    if (!badTenant.ok) expect(badTenant.error.code).toBe('invalid-tenant-id');

    const badProject = createFieldSession({ tenantId: TENANT_A, projectId: 'x', actorId: FIELD_ACTOR });
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.error.code).toBe('invalid-project-id');

    const badActor = createFieldSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: 'nope' });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.code).toBe('invalid-actor');
  });

  it('typed-rejects a foreign session OFFLINE capture with NO effect (both directions)', async () => {
    const harness = await fieldHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;
    const fieldEventId = world.identities.fieldEventId;

    // Direction 1: tenant B's session (naming the real project id). The
    // disconnect surface itself resolves through the session: a foreign
    // session's disconnect is the typed A12 rejection (never an effect — the
    // engine session stays connected, and the capture below is rejected by
    // the SAME scope gate before the engine is ever reached).
    const foreignTenantSession = sessionOf(TENANT_B, PROJECT_1, FIELD_ACTOR);
    const foreignTenantPlane = await openFieldDataPlane(world, foreignTenantSession, {
      now: FIXED_NOW,
      serial: 3,
      ordinal: 3,
    });
    const foreignDisconnect = disconnect(foreignTenantPlane, foreignTenantSession);
    expect(foreignDisconnect.ok).toBe(false);
    if (!foreignDisconnect.ok) {
      expect(foreignDisconnect.error.code).toBe('session-scope-uncovered');
    }
    const captureTenant = await captureFieldObservation(
      foreignTenantPlane,
      foreignTenantSession,
      {
        category: 'site-condition',
        summary: 'A foreign tenant probe that must never land',
        location: 'level-1/grid-a1',
        observedAt: '2026-09-14T12:05:00.000Z',
        observedBy: FIELD_ACTOR,
      },
      FIXED_NOW(),
    );
    expect(captureTenant.status).toBe('rejected');
    expect(captureTenant.entry).toBeNull();
    expect(captureTenant.rejection?.code).toBe('unauthorized');
    expect(captureTenant.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // Direction 2: tenant A's session on a foreign project.
    const foreignProjectSession = sessionOf(TENANT_A, PROJECT_OTHER, FIELD_ACTOR);
    const foreignProjectPlane = await openFieldDataPlane(world, foreignProjectSession, {
      now: FIXED_NOW,
      serial: 4,
      ordinal: 4,
    });
    const foreignDisconnect2 = disconnect(foreignProjectPlane, foreignProjectSession);
    expect(foreignDisconnect2.ok).toBe(false);
    if (!foreignDisconnect2.ok) {
      expect(foreignDisconnect2.error.code).toBe('session-scope-uncovered');
    }
    const captureProject = await captureEvidenceAttachment(
      foreignProjectPlane,
      foreignProjectSession,
      { fieldEventId, expectedVersion: 1, evidence: [FIELD_EVIDENCE] },
      FIXED_NOW(),
    );
    expect(captureProject.status).toBe('rejected');
    expect(captureProject.rejection?.code).toBe('unauthorized');
    expect(captureProject.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // NO effect landed: neither foreign queue captured anything and the
    // world's ledger still carries exactly the seed.
    expect(foreignTenantPlane.engine.queue.size).toBe(0);
    expect(foreignProjectPlane.engine.queue.size).toBe(0);
    expect(world.ledgerEvents).toHaveLength(4);
  });

  it('typed-rejects a foreign session ONLINE submission with NO effect (both directions)', async () => {
    const harness = await fieldHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;
    const fieldEventId = world.identities.fieldEventId;
    const issueId = world.identities.issueId;

    const foreignTenantSession = sessionOf(TENANT_B, PROJECT_1, FIELD_ACTOR);
    const foreignTenantPlane = await dataPlaneOf(world, foreignTenantSession, {
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    }, { serial: 3, ordinal: 3 });
    const submissionTenant = await submitEvidenceAttachment(
      foreignTenantPlane,
      foreignTenantSession,
      { fieldEventId, expectedVersion: 1, evidence: [OFFICE_EVIDENCE] },
      FIXED_NOW(),
    );
    expect(submissionTenant.status).toBe('rejected');
    expect(submissionTenant.eventId).toBeNull();
    expect(submissionTenant.rejection?.code).toBe('unauthorized');
    expect(submissionTenant.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    const foreignProjectSession = sessionOf(TENANT_A, PROJECT_OTHER, FIELD_ACTOR);
    const foreignProjectPlane = await dataPlaneOf(world, foreignProjectSession, {
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    }, { serial: 4, ordinal: 4 });
    const submissionProject = await submitIssueResolution(
      foreignProjectPlane,
      foreignProjectSession,
      { issueId, expectedVersion: 1, resolutionNote: 'A foreign project probe' },
      FIXED_NOW(),
    );
    expect(submissionProject.status).toBe('rejected');
    expect(submissionProject.rejection?.code).toBe('unauthorized');
    expect(submissionProject.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // NO effect landed: the ledger still carries exactly the seed, and the
    // contested field event is untouched.
    expect(world.ledgerEvents).toHaveLength(4);
    const seeded = unwrapField(fieldEventView(world, harness.fieldSession, fieldEventId), 'seeded');
    expect(seeded.version).toBe(1);
    expect(seeded.evidence).toHaveLength(0);
  });

  it('typed-rejects the field read views for a foreign session (both directions)', async () => {
    const harness = await fieldHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession, fieldPlane } = harness;
    const fieldEventId = world.identities.fieldEventId;

    // Direction 1: tenant B's session reading the REAL field event — a
    // typed not-found (the aggregate is invisible).
    const foreignTenant = sessionOf(TENANT_B, PROJECT_1, FIELD_ACTOR);
    const tenantRead = fieldEventView(world, foreignTenant, fieldEventId);
    expect(tenantRead.ok).toBe(false);
    if (!tenantRead.ok) {
      expect(tenantRead.error.code).toBe('not-found');
      expect((tenantRead.error as { details?: { code: string }[] }).details?.[0]?.code).toBe(
        'entity-not-found',
      );
    }

    // Direction 2: tenant A's session on a foreign project reading the REAL
    // field event — the typed unauthorized of the second boundary.
    const foreignProject = sessionOf(TENANT_A, PROJECT_OTHER, FIELD_ACTOR);
    const projectRead = fieldEventView(world, foreignProject, fieldEventId);
    expect(projectRead.ok).toBe(false);
    if (!projectRead.ok) {
      expect(projectRead.error.code).toBe('unauthorized');
    }

    // The board load: a foreign session's project does not exist in this
    // world — the typed not-found of the projects repository (both
    // directions).
    const boardTenant = await fieldBoardView(world, foreignTenant, fieldPlane);
    expect(boardTenant.ok).toBe(false);
    if (!boardTenant.ok) expect(boardTenant.error.code).toBe('not-found');
    const boardProject = await fieldBoardView(world, foreignProject, fieldPlane);
    expect(boardProject.ok).toBe(false);
    if (!boardProject.ok) expect(boardProject.error.code).toBe('not-found');

    // The seeded session still reads (the control).
    const own = fieldEventView(world, fieldSession, fieldEventId);
    expect(own.ok).toBe(true);
    const ownBoard = await fieldBoardView(world, fieldSession, fieldPlane);
    expect(ownBoard.ok).toBe(true);
  });

  it('answers the seeded session with the SAME typed not-found for an address it cannot see (no existence oracle)', async () => {
    const harness = await fieldHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession } = harness;
    const fieldEventId = world.identities.fieldEventId;
    // A well-formed field event id that does not exist anywhere: the seeded
    // session receives exactly the typed not-found a foreign session
    // receives for a REAL id — the surface never reveals which is which.
    const unknown = fieldEventView(
      world,
      fieldSession,
      'office-ent-v1-deadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(unknown.ok).toBe(false);
    const foreign = fieldEventView(world, sessionOf(TENANT_B, PROJECT_1, FIELD_ACTOR), fieldEventId);
    expect(foreign.ok).toBe(false);
    if (!unknown.ok && !foreign.ok) {
      expect(foreign.error.code).toBe(unknown.error.code);
      expect(
        (foreign.error as { details?: { code: string }[] }).details?.[0]?.code,
      ).toBe((unknown.error as { details?: { code: string }[] }).details?.[0]?.code);
    }
  });

  it('typed-rejects the queue/status/conflict/synchronize views for a foreign session (the session-scoped surfaces)', async () => {
    const harness = await fieldHarnessOf({
      now: FIXED_NOW,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, fieldSession, fieldPlane } = harness;
    const foreign = sessionOf(TENANT_B, PROJECT_1, FIELD_ACTOR);

    // The field session's own planes are wired over the seeded world; a
    // foreign session may not resolve ANY of their session-scoped views.
    expect(offlineQueueView(fieldPlane, foreign).ok).toBe(false);
    expect(syncStatusView(fieldPlane, foreign).ok).toBe(false);
    expect(conflictStateView(world, fieldPlane, foreign).ok).toBe(false);
    const sync = await synchronize(fieldPlane, foreign, FIXED_NOW());
    expect(sync.ok).toBe(false);
    if (!sync.ok) expect(sync.error.code).toBe('session-scope-uncovered');

    // The seeded session still resolves every one (the control).
    expect(offlineQueueView(fieldPlane, fieldSession).ok).toBe(true);
    expect(syncStatusView(fieldPlane, fieldSession).ok).toBe(true);
    expect(conflictStateView(world, fieldPlane, fieldSession).ok).toBe(true);
    // And the field session's synchronize (still connected) is the engine's
    // own typed lifecycle rejection — never data, never a throw.
    const ownSync = await synchronize(fieldPlane, fieldSession, FIXED_NOW());
    expect(ownSync.ok).toBe(false);
    if (!ownSync.ok) expect(ownSync.error.code).toBe('sync-rejected');
  });
});
