// Office browser host — THE project workspace page (OFF-DEPLOY).
//
// A server component: it resolves THE hosted runtime through the
// server-only singleton, loads the workspace view model through the
// gateway's scope-checked read surface, and renders the view model's ACTUAL
// sections as semantic HTML — headings, definition lists, tables (every cell
// is a field of ProjectWorkspaceView; no data is invented here, and no
// projection is re-implemented — the page is a view over @office/web's own
// composition). The interactive pieces are the two client components at the
// bottom of the page: the field-capture command form and the A8
// approval-gated action flow, both receiving view-model JSON as props.
import { ApprovalFlow } from '../components/approval-flow';
import { FieldCaptureForm } from '../components/field-capture-form';
import { getHostRuntime } from '../server/runtime';

export const dynamic = 'force-dynamic';

/** Render a minor-units amount in its currency (deterministic formatting). */
const money = (minor: number, currency: string): string =>
  currency === '' ? `${minor} (minor units)` : `${currency} ${(minor / 100).toFixed(2)}`;

export default async function WorkspacePage() {
  const runtime = await getHostRuntime();
  const loaded = await runtime.reads.workspace();

  if (!loaded.ok) {
    return (
      <section aria-labelledby="workspace-unavailable">
        <h2 id="workspace-unavailable">Workspace unavailable</h2>
        <p>
          The workspace view model rejected this load (
          <code>{loaded.error.code}</code>): {loaded.error.message}
        </p>
      </section>
    );
  }

  const view = loaded.value;
  const liveApproval = view.approvals.instances[0] ?? null;
  const pendingStep =
    liveApproval?.approvals.find((step) => step.status === 'pending') ?? null;

  return (
    <>
      <section aria-labelledby="workspace-header">
        <h2 id="workspace-header">{view.header.projectName}</h2>
        <dl>
          <div>
            <dt>Project</dt>
            <dd>
              <code>{view.header.projectId}</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{view.header.projectStatus}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{view.header.projectVersion}</dd>
          </div>
          <div>
            <dt>Organization</dt>
            <dd>{view.header.organizationName}</dd>
          </div>
          <div>
            <dt>Tenant</dt>
            <dd>
              <code>{view.header.tenantId}</code>
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="schedule-summary">
        <h2 id="schedule-summary">Schedule</h2>
        <p>
          {view.schedule.name === ''
            ? 'No schedule recorded for this scope.'
            : `${view.schedule.name} (v${view.schedule.version})`}{' '}
          — {view.schedule.activityCount} activities, {view.schedule.dependencyCount}{' '}
          dependencies, {view.schedule.baselineCount} baselines; forecast duration{' '}
          {view.schedule.forecastProjectDuration} working units over a critical path of{' '}
          {view.schedule.criticalPathLength} activities
          {view.schedule.currentBaselineId !== null
            ? ` (current baseline ${view.schedule.currentBaselineId})`
            : ''}
          .
        </p>
        {view.schedule.activities.length > 0 ? (
          <table>
            <caption>Scheduled activities</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Activity</th>
                <th scope="col">Planned duration</th>
              </tr>
            </thead>
            <tbody>
              {view.schedule.activities.map((activity) => (
                <tr key={activity.activityId}>
                  <td>
                    <code>{activity.code}</code>
                  </td>
                  <td>{activity.name}</td>
                  <td>{activity.plannedDuration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section aria-labelledby="field-status">
        <h2 id="field-status">Field status</h2>
        <p>{view.field.inspectionOutcomeCount} inspection outcomes recorded.</p>
        <h3>Open issues</h3>
        {view.field.openIssues.length > 0 ? (
          <ul>
            {view.field.openIssues.map((issue) => (
              <li key={issue.issueId}>
                <strong>{issue.severity}</strong> — {issue.title} (
                <code>{issue.issueId}</code>)
              </li>
            ))}
          </ul>
        ) : (
          <p>No open issues.</p>
        )}
        <h3>Recent field events</h3>
        {view.field.recentEvents.length > 0 ? (
          <table>
            <caption>Recent field events</caption>
            <thead>
              <tr>
                <th scope="col">Observed at</th>
                <th scope="col">Category</th>
                <th scope="col">Summary</th>
                <th scope="col">Location</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {view.field.recentEvents.map((event) => (
                <tr key={event.fieldEventId}>
                  <td>{event.observedAt}</td>
                  <td>{event.category}</td>
                  <td>{event.summary}</td>
                  <td>
                    <code>{event.location}</code>
                  </td>
                  <td>{event.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No field events recorded yet — capture one below.</p>
        )}
        <FieldCaptureForm />
      </section>

      <section aria-labelledby="cost-position">
        <h2 id="cost-position">Cost position</h2>
        <dl>
          <div>
            <dt>Budgeted</dt>
            <dd>{money(view.cost.budgetedMinor, view.cost.currency)}</dd>
          </div>
          <div>
            <dt>Committed</dt>
            <dd>{money(view.cost.committedMinor, view.cost.currency)}</dd>
          </div>
          <div>
            <dt>Invoiced</dt>
            <dd>{money(view.cost.invoicedMinor, view.cost.currency)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{money(view.cost.paidMinor, view.cost.currency)}</dd>
          </div>
          <div>
            <dt>Remaining budget</dt>
            <dd>{money(view.cost.remainingBudgetMinor, view.cost.currency)}</dd>
          </div>
          <div>
            <dt>Committed variance</dt>
            <dd>{money(view.cost.committedVarianceMinor, view.cost.currency)}</dd>
          </div>
        </dl>
        {view.cost.overCommittedCostItemIds.length > 0 ? (
          <p>
            Over-committed cost items:{' '}
            {view.cost.overCommittedCostItemIds.map((id) => (
              <code key={id}>{id}</code>
            ))}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="commitments">
        <h2 id="commitments">Commitments</h2>
        {view.commitments.contracts.length > 0 ? (
          <table>
            <caption>Executed contracts</caption>
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Title</th>
                <th scope="col">Execution status</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {view.commitments.contracts.map((contract) => (
                <tr key={contract.contractId}>
                  <td>
                    <code>{contract.contractId}</code>
                  </td>
                  <td>{contract.title}</td>
                  <td>{contract.executionStatus}</td>
                  <td>{money(contract.valueMinor, contract.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No contracts in this scope.</p>
        )}
        {view.commitments.changeEvents.length > 0 ? (
          <table>
            <caption>Raised change events</caption>
            <thead>
              <tr>
                <th scope="col">Change event</th>
                <th scope="col">Contract</th>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {view.commitments.changeEvents.map((change) => (
                <tr key={change.changeEventId}>
                  <td>
                    <code>{change.changeEventId}</code>
                  </td>
                  <td>
                    <code>{change.contractId}</code>
                  </td>
                  <td>{change.title}</td>
                  <td>{change.changeType}</td>
                  <td>{change.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No change events raised.</p>
        )}
      </section>

      <section aria-labelledby="documents">
        <h2 id="documents">Documents</h2>
        {view.documents.documents.length > 0 ? (
          <table>
            <caption>The evidence pack</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Revisions</th>
              </tr>
            </thead>
            <tbody>
              {view.documents.documents.map((document) => (
                <tr key={document.documentId}>
                  <td>
                    <code>{document.documentId}</code>
                  </td>
                  <td>{document.title}</td>
                  <td>{document.status}</td>
                  <td>
                    {document.revisionCount}
                    {document.headRevisionId !== null
                      ? ` (head ${document.headRevisionId})`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No documents registered.</p>
        )}
      </section>

      <section aria-labelledby="approvals">
        <h2 id="approvals">Approvals</h2>
        {view.approvals.instances.length > 0 ? (
          <table>
            <caption>Live workflow instances</caption>
            <thead>
              <tr>
                <th scope="col">Instance</th>
                <th scope="col">Definition</th>
                <th scope="col">Subject</th>
                <th scope="col">State</th>
                <th scope="col">Status</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {view.approvals.instances.map((instance) => (
                <tr key={instance.instanceId}>
                  <td>
                    <code>{instance.instanceId}</code>
                  </td>
                  <td>
                    <code>{instance.definitionKey}</code>
                  </td>
                  <td>
                    {instance.subjectKind} <code>{instance.subjectId}</code>
                  </td>
                  <td>{instance.currentState}</td>
                  <td>{instance.status}</td>
                  <td>{instance.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No live workflow instances.</p>
        )}
        {liveApproval !== null && pendingStep !== null ? (
          <ApprovalFlow
            instanceId={liveApproval.instanceId}
            definitionKey={liveApproval.definitionKey}
            expectedVersion={liveApproval.version}
            approvalKey={pendingStep.key}
            approvalTitle={pendingStep.title}
          />
        ) : (
          <p>No pending approval step awaits a decision.</p>
        )}
      </section>
    </>
  );
}
