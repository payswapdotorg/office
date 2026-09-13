// Office web application shell — the A12 scope self-gate (OFF-030).
//
// Freeze A12 (ONE project state, all clients share it): the shell's EVERY
// surface resolves through ONE typed session record, and a foreign tenant's
// or a foreign project's address is a TYPED rejection — never data, never an
// existence oracle, never a throw. Both directions are proven here:
//
//   - a foreign session (tenant B, or tenant A on another project) probing
//     the seeded world's real identities: workspace loads, evidence walkers,
//     evidence navigation pushes, and command submissions all typed-reject;
//   - the seeded session probing addresses it cannot see (a well-formed but
//     unknown ledger event id) receives the SAME typed not-found a foreign
//     session receives (no existence oracle);
//   - the control tower of a foreign session is EMPTY (invisible rows are
//     absent), not an error, not the tenant's exceptions;
//   - malformed session identities are typed input rejections (displayable).
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '@office/contracts';
import {
  aggregateHistory,
  captureFieldObservation,
  causalityChainOf,
  correlationChainOf,
  createWebSession,
  evidenceEventOf,
  openEvidenceNavigation,
  openWebDataPlane,
  projectWorkspace,
  pushEvidencePage,
  controlTowerView,
} from './index';
import {
  OPERATOR,
  PROJECT_1,
  PROJECT_OTHER,
  SEED_CORRELATION,
  TENANT_A,
  TENANT_B,
  sequentialOpaqueIds,
  sessionOf,
  shellHarnessOf,
} from './test-support';

const SCAN_PARTS = {
  scanId: 'scan-0001',
  assessmentIds: ['assessment-0001'],
  detectedAt: '2026-09-14T10:00:00.000Z' as Timestamp,
};

describe('A12 — every surface resolves through ONE typed session (cross-scope typed-rejected both directions)', () => {
  it('rejects malformed session identities as typed, displayable input rejections', () => {
    const badTenant = createWebSession({ tenantId: 'not-a-tenant', projectId: PROJECT_1, actorId: OPERATOR });
    expect(badTenant.ok).toBe(false);
    if (!badTenant.ok) expect(badTenant.error.code).toBe('invalid-tenant-id');

    const badProject = createWebSession({ tenantId: TENANT_A, projectId: 'x', actorId: OPERATOR });
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.error.code).toBe('invalid-project-id');

    const badActor = createWebSession({ tenantId: TENANT_A, projectId: PROJECT_1, actorId: 'nope' });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.error.code).toBe('invalid-actor');
  });

  it('typed-rejects the workspace load for a foreign tenant AND a foreign project (both directions)', async () => {
    const harness = await shellHarnessOf({
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;

    // Direction 1: tenant B's session names tenant A's REAL project id.
    const foreignTenant = await projectWorkspace(world, sessionOf(TENANT_B, PROJECT_1, OPERATOR));
    expect(foreignTenant.ok).toBe(false);
    if (!foreignTenant.ok) {
      expect(foreignTenant.error.code).toBe('not-found');
      expect(foreignTenant.error.message).toContain(PROJECT_1);
    }

    // Direction 2: tenant A's session names a project that is not its own.
    const foreignProject = await projectWorkspace(world, sessionOf(TENANT_A, PROJECT_OTHER, OPERATOR));
    expect(foreignProject.ok).toBe(false);
    if (!foreignProject.ok) {
      expect(foreignProject.error.code).toBe('not-found');
      expect(foreignProject.error.message).toContain(PROJECT_OTHER);
    }

    // The seeded session still loads (the control: the rejections above are
    // the scope gate, not a broken world).
    const own = await projectWorkspace(world, harness.session);
    expect(own.ok).toBe(true);
  });

  it('typed-rejects every evidence walker and navigation push for a foreign session', async () => {
    const harness = await shellHarnessOf({
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;
    const foreign = sessionOf(TENANT_B, PROJECT_1, OPERATOR);
    const seededEvent = world.ledgerEvents[0];
    expect(seededEvent).toBeDefined();
    const eventId = (seededEvent as { readonly eventId: string }).eventId;

    // The walkers: the foreign session cannot resolve ANY of the world's
    // real evidence addresses.
    const event = evidenceEventOf(world, foreign, eventId);
    expect(event.ok).toBe(false);
    if (!event.ok) {
      expect(event.error.code).toBe('not-found');
      expect(event.error.details[0]?.code).toBe('evidence-not-visible');
    }

    const aggregate = aggregateHistory(world, foreign, 'budget', world.identities.budgetId);
    expect(aggregate.ok).toBe(false);
    if (!aggregate.ok) expect(aggregate.error.details[0]?.code).toBe('evidence-not-visible');

    const correlation = correlationChainOf(world, foreign, SEED_CORRELATION);
    expect(correlation.ok).toBe(false);
    if (!correlation.ok) expect(correlation.error.details[0]?.code).toBe('evidence-not-visible');

    const chain = causalityChainOf(world, foreign, eventId);
    expect(chain.ok).toBe(false);
    if (!chain.ok) expect(chain.error.details[0]?.code).toBe('evidence-not-visible');

    // The navigation: pushing a page that addresses a real event id under a
    // foreign session is a typed navigation rejection (the page never enters
    // the stack — the address is resolved fail-closed FIRST).
    const pushed = pushEvidencePage(world, foreign, openEvidenceNavigation(), {
      page: 'evidence-event',
      eventId,
    });
    expect(pushed.ok).toBe(false);
    if (!pushed.ok) {
      expect(pushed.error.code).toBe('not-found');
      expect(pushed.error.details[0]?.code).toBe('evidence-not-visible');
    }
  });

  it('answers the seeded session with the SAME typed not-found for an address it cannot see (no existence oracle)', async () => {
    const harness = await shellHarnessOf({
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world, session } = harness;
    // A well-formed ledger event id that does not exist anywhere: the seeded
    // session receives exactly the typed not-found a foreign session
    // receives for a REAL id — the surface never reveals which is which.
    const unknown = evidenceEventOf(world, session, 'office-evt-v1-deadbeefdeadbeefdeadbeefdeadbeef');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('not-found');
      expect(unknown.error.details[0]?.code).toBe('evidence-not-visible');
    }
    const foreign = evidenceEventOf(world, sessionOf(TENANT_B, PROJECT_1, OPERATOR), world.ledgerEvents[0]?.eventId ?? '');
    expect(foreign.ok).toBe(false);
    if (!foreign.ok && !unknown.ok) {
      expect(foreign.error.code).toBe(unknown.error.code);
      expect(foreign.error.details[0]?.code).toBe(unknown.error.details[0]?.code);
    }
  });

  it('shows a foreign session an EMPTY control tower (invisible rows are absent)', async () => {
    const harness = await shellHarnessOf({
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;

    const foreignTenant = controlTowerView(world, sessionOf(TENANT_B, PROJECT_1, OPERATOR), SCAN_PARTS);
    expect(foreignTenant.ok).toBe(true);
    if (foreignTenant.ok) expect(foreignTenant.value.exceptionCount).toBe(0);

    const foreignProject = controlTowerView(world, sessionOf(TENANT_A, PROJECT_OTHER, OPERATOR), SCAN_PARTS);
    expect(foreignProject.ok).toBe(true);
    if (foreignProject.ok) expect(foreignProject.value.exceptionCount).toBe(0);

    // The seeded session still sees the portfolio (the control).
    const own = controlTowerView(world, harness.session, SCAN_PARTS);
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.value.exceptionCount).toBeGreaterThan(0);
  });

  it('typed-rejects a foreign session command submission with NO effect (both directions)', async () => {
    const harness = await shellHarnessOf({
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      newOpaqueId: sequentialOpaqueIds(),
    });
    const { world } = harness;

    // Direction 1: tenant B's session (naming the real project id).
    const foreignTenantPlane = await openWebDataPlane(world, sessionOf(TENANT_B, PROJECT_1, OPERATOR), {
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      serial: 2,
      ordinal: 2,
    });
    const capture = await captureFieldObservation(
      foreignTenantPlane,
      sessionOf(TENANT_B, PROJECT_1, OPERATOR),
      {
        category: 'site-condition',
        summary: 'A foreign tenant probe that must never land',
        location: 'level-1/grid-a1',
        observedAt: '2026-09-14T08:05:00.000Z',
        observedBy: OPERATOR,
      },
      '2026-09-14T08:00:00.000Z' as Timestamp,
    );
    expect(capture.status).toBe('rejected');
    expect(capture.eventId).toBeNull();
    expect(capture.rejection?.code).toBe('unauthorized');
    expect(capture.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // Direction 2: tenant A's session on a foreign project.
    const foreignProjectSession = sessionOf(TENANT_A, PROJECT_OTHER, OPERATOR);
    const foreignProjectPlane = await openWebDataPlane(world, foreignProjectSession, {
      now: () => '2026-09-14T08:00:00.000Z' as Timestamp,
      serial: 3,
      ordinal: 3,
    });
    const foreignCapture = await captureFieldObservation(
      foreignProjectPlane,
      foreignProjectSession,
      {
        category: 'site-condition',
        summary: 'A foreign project probe that must never land',
        location: 'level-1/grid-a1',
        observedAt: '2026-09-14T08:05:00.000Z',
        observedBy: OPERATOR,
      },
      '2026-09-14T08:00:00.000Z' as Timestamp,
    );
    expect(foreignCapture.status).toBe('rejected');
    expect(foreignCapture.rejection?.code).toBe('unauthorized');
    expect(foreignCapture.rejection?.details[0]?.code).toBe('session-scope-uncovered');

    // NO effect landed: the ledger carries exactly zero field events (the
    // seeded world records none), and the seeded workspace is unchanged.
    const fieldEvents = world.ledgerEvents.filter(
      (event) => event.envelope.eventName === 'field.fieldEventCaptured',
    );
    expect(fieldEvents).toHaveLength(0);
    const workspace = await projectWorkspace(world, harness.session);
    expect(workspace.ok).toBe(true);
    if (workspace.ok) expect(workspace.value.field.recentEvents).toHaveLength(0);
  });
});
