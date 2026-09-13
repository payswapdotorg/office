// Office web application shell — the project workspace view model (OFF-030).
//
// THE workspace composition: one tenant+project scope (the shell session)
// resolved through the landed domain packages' PUBLIC READ SURFACES — the
// in-memory reference engines of the seeded world. Every section is a
// deterministic projection of canonical state (same world + same operations
// → the byte-identical view, run-twice), fail-closed at every step: a
// foreign tenant's row is a typed not-found, a same-tenant/foreign-project
// row is a typed unauthorized (freeze A12, both directions, no existence
// oracle — the structural checks run FIRST, before any row is projected).
//
// This is a VIEW, never a second source of truth (A11): the view model
// carries ids, names, statuses, and derived numbers only; it holds no
// entity data the canonical stores do not already own, and it is rebuilt
// from scratch on every load. No DOM, no rendering — the host wires that.
import type { Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { createProjectReadModel } from '@office/domain-field';
import type { ProjectReadModel } from '@office/domain-field';
import { DOCUMENT_REGISTERED_EVENT } from '@office/domain-documents';
import { costPosition } from '@office/domain-cost';
import type { CostPosition } from '@office/domain-cost';
import { forecastOfSchedule } from '@office/domain-schedule';
import type { SeededWorld } from '../session/world';
import type { WebSession } from '../session/session';
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

/** The field status section (rebuilt from the ledger's field events). */
export interface FieldStatusView {
  readonly recentEvents: readonly {
    readonly fieldEventId: string;
    readonly category: string;
    readonly summary: string;
    readonly location: string;
    readonly observedAt: Timestamp;
    readonly status: string;
  }[];
  readonly openIssues: readonly {
    readonly issueId: string;
    readonly title: string;
    readonly severity: string;
  }[];
  readonly inspectionOutcomeCount: number;
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

/** The commitments section (the commercial position). */
export interface CommitmentsView {
  readonly contracts: readonly {
    readonly contractId: string;
    readonly title: string;
    readonly executionStatus: string;
    readonly currency: string;
    readonly valueMinor: number;
  }[];
  readonly changeEvents: readonly {
    readonly changeEventId: string;
    readonly contractId: string;
    readonly title: string;
    readonly changeType: string;
    readonly status: string;
    readonly evidenceRevisionIds: readonly string[];
  }[];
}

/** The documents section (the evidence pack). */
export interface DocumentsView {
  readonly documents: readonly {
    readonly documentId: string;
    readonly title: string;
    readonly status: string;
    readonly revisionCount: number;
    readonly headRevisionId: string | null;
  }[];
}

/** One approval step of a live workflow instance. */
export interface ApprovalStepView {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly requiredCapability: string;
  readonly submittedBy: string | null;
  readonly submittedAt: Timestamp | null;
}

/** The approvals section (the live workflow instances of the project). */
export interface ApprovalsView {
  readonly instances: readonly {
    readonly instanceId: string;
    readonly definitionKey: string;
    readonly subjectKind: string;
    readonly subjectId: string;
    readonly currentState: string;
    readonly status: string;
    readonly version: number;
    readonly approvals: readonly ApprovalStepView[];
  }[];
}

/** THE project workspace view model (A11: a projection, never a copy). */
export interface ProjectWorkspaceView {
  readonly kind: 'project-workspace';
  readonly header: ProjectHeaderView;
  readonly schedule: ScheduleSummaryView;
  readonly field: FieldStatusView;
  readonly cost: CostPositionView;
  readonly commitments: CommitmentsView;
  readonly documents: DocumentsView;
  readonly approvals: ApprovalsView;
}

// ---------------------------------------------------------------------------
// The composition itself.
// ---------------------------------------------------------------------------

/** Rebuild the field read model from the ledger's field events (A7 fold). */
const fieldReadModelOf = (world: SeededWorld): Result<ProjectReadModel, DomainError> => {
  const model = createProjectReadModel();
  for (const event of world.ledgerEvents) {
    const name = event.envelope.eventName as string;
    if (!(name.startsWith('field.') && name.length > 'field.'.length)) continue;
    const applied = model.apply(event.envelope);
    if (!applied.ok) return applied;
  }
  return { ok: true, value: model };
};

/**
 * Compose THE project workspace view model for the session's scope. Every
 * section resolves through a landed public read surface; every step is
 * fail-closed (a typed rejection fails the whole load — a partial workspace
 * is never silently served), and the whole composition is deterministic.
 */
export async function projectWorkspace(
  world: SeededWorld,
  session: WebSession,
): Promise<Result<ProjectWorkspaceView, DomainError>> {
  // ---- header: the project (A12: foreign tenant/project → typed not-found).
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

  // ---- field status: the read model rebuilt from the ledger (A7).
  const fieldModel = fieldReadModelOf(world);
  if (!fieldModel.ok) return fieldModel;
  const recentEvents = fieldModel.value.recentFieldEvents(session.projectId, 10);
  const openIssues = fieldModel.value.openIssues(session.projectId);
  const field: FieldStatusView = {
    recentEvents: recentEvents.map((event) => ({
      fieldEventId: event.fieldEventId,
      category: event.category,
      summary: event.summary,
      location: event.location,
      observedAt: event.observedAt,
      status: event.status,
    })),
    openIssues: openIssues.map((issue) => ({
      issueId: issue.issueId,
      title: issue.title,
      severity: issue.severity,
    })),
    inspectionOutcomeCount: fieldModel.value.inspectionOutcomes(session.projectId).length,
  };

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

  // ---- commitments: the executed contracts + the raised change events.
  const contractStates = world.stores.contracts.contracts.filter((candidate) =>
    sessionCoversScope(session, candidate.scope),
  );
  const contracts: CommitmentsView['contracts'][number][] = [];
  for (const contract of contractStates) {
    const loaded = await world.stores.contracts.runInTransaction((tx) =>
      tx.loadContract(session.scope, contract.entityId),
    );
    if (!loaded.ok) return loaded;
    contracts.push({
      contractId: loaded.value.entityId,
      title: loaded.value.title,
      executionStatus: loaded.value.executionStatus,
      currency: loaded.value.contractValue.currency,
      valueMinor: loaded.value.contractValue.amount,
    });
  }
  const changeEvents: CommitmentsView['changeEvents'][number][] = [];
  for (const changeEvent of world.stores.contracts.changeEvents.filter((candidate) =>
    sessionCoversScope(session, candidate.scope),
  )) {
    const loaded = await world.stores.contracts.runInTransaction((tx) =>
      tx.loadChangeEvent(session.scope, changeEvent.entityId),
    );
    if (!loaded.ok) return loaded;
    changeEvents.push({
      changeEventId: loaded.value.entityId,
      contractId: loaded.value.contractId,
      title: loaded.value.title,
      changeType: loaded.value.changeType,
      status: loaded.value.status,
      evidenceRevisionIds: loaded.value.evidenceLinks.map((link) => link.revisionId),
    });
  }

  // ---- documents: the project's evidence pack (the registered documents
  // resolved from the ledger stream — A7: the store's own scope-guarded reads
  // then serve each document's details and revision chain).
  const documentRefs = world.ledgerEvents
    .filter(
      (event) =>
        event.envelope.eventName === DOCUMENT_REGISTERED_EVENT &&
        sessionCoversScope(session, event.envelope.scope),
    )
    .map((event) => event.envelope.entityRefs.after)
    .filter((ref): ref is NonNullable<typeof ref> => ref !== null);
  const seenDocumentIds = new Set<string>();
  const documents: DocumentsView['documents'][number][] = [];
  for (const document of documentRefs) {
    if (seenDocumentIds.has(document.entityId)) continue;
    seenDocumentIds.add(document.entityId);
    const loaded = await world.stores.documents.findDocumentById(session.scope, document.entityId);
    if (!loaded.ok) return loaded;
    const chain = await world.stores.documents.revisionChainOf(
      session.scope,
      loaded.value.entityId,
    );
    if (!chain.ok) return chain;
    documents.push({
      documentId: loaded.value.entityId,
      title: loaded.value.title,
      status: loaded.value.status,
      revisionCount: chain.value.length,
      headRevisionId: loaded.value.currentRevisionId,
    });
  }

  // ---- approvals: the live workflow instances over project subjects.
  const instances = world.stores.workflows
    .instances()
    .filter((instance) => sessionCoversScope(session, instance.scope));
  const approvalInstances: ApprovalsView['instances'][number][] = [];
  for (const instance of instances) {
    const loaded = world.stores.workflows.findInstance(session.scope, instance.entityId);
    if (!loaded.ok) return loaded;
    approvalInstances.push({
      instanceId: loaded.value.entityId,
      definitionKey: loaded.value.definitionKey,
      subjectKind: loaded.value.subject.entityKind,
      subjectId: loaded.value.subject.entityId,
      currentState: loaded.value.currentState,
      status: loaded.value.status,
      version: loaded.value.version,
      approvals: loaded.value.approvals.map((approval) => ({
        key: approval.key,
        title: approval.title,
        status: approval.status,
        requiredCapability: approval.requiredCapability,
        submittedBy: approval.submittedBy,
        submittedAt: approval.submittedAt,
      })),
    });
  }
  approvalInstances.sort((left, right) => (left.instanceId < right.instanceId ? -1 : 1));
  documents.sort((left, right) => (left.documentId < right.documentId ? -1 : 1));

  return {
    ok: true,
    value: {
      kind: 'project-workspace',
      header: {
        tenantId: session.tenantId,
        projectId: project.value.entityId,
        projectName: project.value.name,
        projectStatus: project.value.status,
        projectVersion: project.value.version,
        organizationName: organization?.name ?? '',
      },
      schedule,
      field,
      cost,
      commitments: { contracts, changeEvents },
      documents: { documents },
      approvals: { instances: approvalInstances },
    },
  };
}
