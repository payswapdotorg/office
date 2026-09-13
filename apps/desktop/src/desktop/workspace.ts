// Office desktop client protocol/reference shell — the project workspace view
// model (OFF-032).
//
// THE workspace composition of the desktop shell: one tenant+project scope
// (the desktop session) resolved through the landed domain packages' PUBLIC
// READ SURFACES — the in-memory reference engines of the seeded world —
// composed over the session's SUBSCRIBED SLICE (the data plane's own
// consumed stream: the desktop client's view of ONE project state, A11 — a
// VIEW, never a second source of truth). Every section is a deterministic
// projection of canonical state (same world + same operations → the
// byte-identical view, run-twice), fail-closed at every step: a foreign
// tenant's row is a typed not-found, a same-tenant/foreign-project row is a
// typed unauthorized (freeze A12, both directions, no existence oracle — the
// structural checks run FIRST, before any row is projected).
//
// No DOM, no rendering — the host wires that. No platform-specific domain
// model: every term in the view arrives from the shared contracts/domain
// packages' public surfaces.
import type { Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { costPosition } from '@office/domain-cost';
import type { CostPosition } from '@office/domain-cost';
import { forecastOfSchedule } from '@office/domain-schedule';
import type { SeededDesktopWorld } from '../session/world';
import type { DesktopDataPlane } from '../session/stream';
import type { DesktopSession } from '../session/session';
import { sessionCoversScope } from '../session/session';

/** The structural read handle the identity repositories accept (opaque). */
const readHandle = { query: async () => ({ rows: [], rowCount: 0 }) } as const;

// ---------------------------------------------------------------------------
// The workspace view model (JSON-safe, deterministic).
// ---------------------------------------------------------------------------

/** The workspace header: the project + its owning organization. */
export interface ProjectHeaderView {
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectStatus: string;
  readonly projectVersion: number;
  readonly organizationName: string;
}

/** The schedule summary section. */
export interface ScheduleSummaryView {
  readonly scheduleId: string;
  readonly name: string;
  readonly version: number;
  readonly activityCount: number;
  readonly dependencyCount: number;
  readonly baselineCount: number;
  readonly currentBaselineId: string | null;
  /** The deterministic CPM forecast's project duration (working units). */
  readonly forecastProjectDuration: number;
  readonly criticalPathLength: number;
  readonly activities: readonly {
    readonly activityId: string;
    readonly code: string;
    readonly name: string;
    readonly plannedDuration: number;
  }[];
}

/** The cost position section (THE cost-impact read model, verbatim). */
export interface CostPositionView {
  readonly budgetId: string;
  readonly currency: string;
  readonly budgetVersion: number;
  readonly currentRevisionId: string | null;
  readonly budgetedMinor: number;
  readonly committedMinor: number;
  readonly invoicedMinor: number;
  readonly paidMinor: number;
  readonly remainingBudgetMinor: number;
  readonly committedVarianceMinor: number;
  readonly overCommittedCostItemIds: readonly string[];
}

/** One row of the subscribed-slice section (the session's own stream). */
export interface ConsumedEventView {
  readonly eventId: string;
  readonly eventName: string;
}

/**
 * The subscribed-slice section: the session's OWN consumed stream — exactly
 * what the desktop client has consumed of ONE project state (its cursor
 * discipline), never a second source of truth.
 */
export interface SubscribedSliceView {
  /** The client's LAST CONFIRMED slice position (its causal-token basis). */
  readonly consumedPosition: number;
  /** The number of events the session has consumed (its own view's length). */
  readonly consumedEventCount: number;
  /** The most recently consumed events, newest last (display window). */
  readonly recentEvents: readonly ConsumedEventView[];
}

/** THE desktop project workspace view model (A11: a projection, never a copy). */
export interface DesktopWorkspaceView {
  readonly kind: 'desktop-project-workspace';
  readonly header: ProjectHeaderView;
  readonly schedule: ScheduleSummaryView;
  readonly cost: CostPositionView;
  readonly slice: SubscribedSliceView;
  /** The offline queue's pending count (the disconnected work, displayable). */
  readonly pendingCaptureCount: number;
  readonly generatedAt: Timestamp | null;
}

// ---------------------------------------------------------------------------
// The composition itself.
// ---------------------------------------------------------------------------

/**
 * Compose THE desktop project workspace view model for the session's scope,
 * over the session's subscribed slice. Every section resolves through a
 * landed public read surface; every step is fail-closed (a typed rejection
 * fails the whole load — a partial workspace is never silently served), and
 * the whole composition is deterministic. The `now` of the load (the view's
 * generated-at stamp) is INJECTED by the caller — never a wall clock.
 */
export async function desktopWorkspaceView(
  world: SeededDesktopWorld,
  session: DesktopSession,
  plane: DesktopDataPlane,
  now: Timestamp | null,
): Promise<Result<DesktopWorkspaceView, DomainError>> {
  if (!sessionCoversScope(session, plane.worldScope)) {
    return {
      ok: false,
      error: domainError(
        'unauthorized',
        `the session's scope does not cover this world's project state (session project ${session.projectId})`,
        [
          {
            code: 'session-scope-uncovered',
            message: `tenant ${session.tenantId} project ${session.projectId}`,
            path: null,
          },
        ],
        { scope: session.scope, correlationId: null },
      ),
    };
  }

  // ---- header: the project + organization (A12: foreign tenant/project →
  // typed not-found through the identity repositories' own visibility).
  const project = await world.stores.projects.findById(
    readHandle,
    session.scope,
    session.projectId,
  );
  if (!project.ok) return project;
  if (!sessionCoversScope(session, project.value.scope)) {
    return {
      ok: false,
      error: domainError(
        'unauthorized',
        `the session's project scope does not cover project ${project.value.entityId}`,
        [
          {
            code: 'workspace-scope-coverage',
            message: `session project ${session.projectId} vs project ${project.value.entityId}`,
            path: null,
          },
        ],
        { scope: session.scope, correlationId: null },
      ),
    };
  }
  const organizations = await world.stores.organizations.list(readHandle, {
    kind: 'tenant',
    tenantId: session.tenantId,
  });
  if (!organizations.ok) return organizations;
  const organization = organizations.value[0];

  // ---- schedule: the project's one schedule, loaded scoped (A12 backstop).
  const scheduleState = world.stores.schedule.schedules.find(
    (candidate) =>
      sessionCoversScope(session, candidate.scope) &&
      candidate.scope.kind === 'project' &&
      candidate.scope.projectId === session.projectId,
  );
  let schedule: ScheduleSummaryView = {
    scheduleId: '',
    name: '',
    version: 0,
    activityCount: 0,
    dependencyCount: 0,
    baselineCount: 0,
    currentBaselineId: null,
    forecastProjectDuration: 0,
    criticalPathLength: 0,
    activities: [],
  };
  if (scheduleState !== undefined) {
    const loaded = await world.stores.schedule.runInTransaction((tx) =>
      tx.loadSchedule(session.scope, scheduleState.entityId),
    );
    if (!loaded.ok) return loaded;
    const forecast = forecastOfSchedule(loaded.value);
    if (!forecast.ok) return forecast;
    const activities = Object.values(loaded.value.activities)
      .map((activity) => ({
        activityId: activity.entityId,
        code: activity.code,
        name: activity.name,
        plannedDuration: activity.plannedDuration,
      }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
    schedule = {
      scheduleId: loaded.value.entityId,
      name: loaded.value.name,
      version: loaded.value.version,
      activityCount: activities.length,
      dependencyCount: Object.keys(loaded.value.dependencies).length,
      baselineCount: Object.keys(loaded.value.baselines).length,
      currentBaselineId: loaded.value.currentBaselineId,
      forecastProjectDuration: forecast.value.projectDuration,
      criticalPathLength: forecast.value.criticalPath.length,
      activities,
    };
  }

  // ---- cost position: THE cost-impact read model over the scoped budget.
  const budget = world.stores.cost.budgets.find((candidate) =>
    sessionCoversScope(session, candidate.scope),
  );
  let cost: CostPositionView = {
    budgetId: '',
    currency: '',
    budgetVersion: 0,
    currentRevisionId: null,
    budgetedMinor: 0,
    committedMinor: 0,
    invoicedMinor: 0,
    paidMinor: 0,
    remainingBudgetMinor: 0,
    committedVarianceMinor: 0,
    overCommittedCostItemIds: [],
  };
  if (budget !== undefined) {
    const loaded = await world.stores.cost.runInTransaction((tx) =>
      tx.loadBudget(session.scope, budget.entityId),
    );
    if (!loaded.ok) return loaded;
    const scopedCommitments = world.stores.cost.commitments.filter((candidate) =>
      sessionCoversScope(session, candidate.scope),
    );
    const scopedInvoices = world.stores.cost.invoices.filter((candidate) =>
      sessionCoversScope(session, candidate.scope),
    );
    const position: CostPosition = costPosition(loaded.value, scopedCommitments, scopedInvoices);
    cost = {
      budgetId: position.budgetId,
      currency: position.currency,
      budgetVersion: loaded.value.version,
      currentRevisionId: position.currentRevisionId,
      budgetedMinor: position.budgetedMinor,
      committedMinor: position.committedMinor,
      invoicedMinor: position.invoicedMinor,
      paidMinor: position.paidMinor,
      remainingBudgetMinor: position.remainingBudgetMinor,
      committedVarianceMinor: position.committedVarianceMinor,
      overCommittedCostItemIds: [...position.overCommittedCostItemIds],
    };
  }

  // ---- the subscribed slice: the session's OWN consumed stream (A11/A12).
  const consumed = plane.consumedEvents;
  const slice: SubscribedSliceView = {
    consumedPosition: plane.engine.consumedPosition,
    consumedEventCount: consumed.length,
    recentEvents: consumed.slice(-10).map((event) => ({
      eventId: event.eventId,
      eventName: event.envelope.eventName,
    })),
  };

  return {
    ok: true,
    value: {
      kind: 'desktop-project-workspace',
      header: {
        tenantId: session.tenantId,
        projectId: project.value.entityId,
        projectName: project.value.name,
        projectStatus: project.value.status,
        projectVersion: project.value.version,
        organizationName: organization?.name ?? '',
      },
      schedule,
      cost,
      slice,
      pendingCaptureCount: plane.engine.queue.pending.length,
      generatedAt: now,
    },
  };
}
