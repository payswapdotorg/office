// Office browser host — the control-tower page (OFF-DEPLOY).
//
// A server component: the portfolio exception-set view rendered from
// @office/web's own controlTowerView composition, resolved through the
// gateway's read surface with the landed deterministic scan parts (injected
// scan identity + assessment-id sequence + fixed detected-at instant — never
// the wall clock). Every ranked exception carries its full evidence chain
// (event entries link into the evidence ledger) and its suggested next
// actions, rendered as SUGGESTIONS ONLY — never executed from this page.
import { getHostRuntime } from '../../server/runtime';
import type { ControlTowerScanParts } from '@office/web';

export const dynamic = 'force-dynamic';

/** The deterministic scan identity (the landed injected-parts pattern). */
const SCAN_PARTS: ControlTowerScanParts = {
  scanId: 'scan-0001',
  assessmentIds: ['assessment-0001'],
  detectedAt: '2026-09-14T10:00:00.000Z' as ControlTowerScanParts['detectedAt'],
};

export default async function ControlTowerPage() {
  const runtime = await getHostRuntime();
  const scanned = runtime.reads.controlTower(undefined, SCAN_PARTS);

  if (!scanned.ok) {
    return (
      <section aria-labelledby="control-tower-unavailable">
        <h2 id="control-tower-unavailable">Control tower unavailable</h2>
        <p>
          The control-tower scan rejected this load (
          <code>{scanned.error.code}</code>): {scanned.error.message}
        </p>
      </section>
    );
  }

  const view = scanned.value;

  return (
    <>
      <section aria-labelledby="control-tower-head">
        <h2 id="control-tower-head">Control tower</h2>
        <p>
          Scan <code>{view.scanId}</code>, detected {view.detectedAt} —{' '}
          {view.exceptionCount} exceptions in ranked priority order.
        </p>
      </section>
      {view.items.length === 0 ? (
        <p>No exceptions detected in this scan.</p>
      ) : (
        <ol>
          {view.items.map((item) => (
            <li key={item.exceptionId}>
              <h3>
                #{item.rank} — {item.title}
              </h3>
              <dl>
                <div>
                  <dt>Kind</dt>
                  <dd>{item.kind}</dd>
                </div>
                <div>
                  <dt>Severity</dt>
                  <dd>
                    {item.severityLevel}
                    {item.severityReasons.length > 0
                      ? ` (${item.severityReasons.join('; ')})`
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>Priority score</dt>
                  <dd>
                    severity {item.priorityScore.severity} + economic{' '}
                    {item.priorityScore.economic} = {item.priorityScore.total}
                  </dd>
                </div>
                <div>
                  <dt>Economic impact</dt>
                  <dd>
                    {item.economicImpact.amountMinor === null ||
                    item.economicImpact.currency === null
                      ? 'not quantified'
                      : `${item.economicImpact.currency} ${(
                          item.economicImpact.amountMinor / 100
                        ).toFixed(2)}`}
                  </dd>
                </div>
              </dl>
              <h4>Affected entities</h4>
              <ul>
                {item.affectedEntities.map((entity) => (
                  <li key={`${entity.entityKind}:${entity.entityId}`}>
                    {entity.entityKind} <code>{entity.entityId}</code>
                  </li>
                ))}
              </ul>
              <h4>Evidence chain</h4>
              <ul>
                {item.evidence.map((entry, index) => (
                  <li key={`${entry.referenceId}:${index}`}>
                    {entry.kind === 'event' ? (
                      <>
                        event{' '}
                        <a href={`/evidence?event=${entry.referenceId}`}>
                          <code>{entry.referenceId}</code>
                        </a>
                        {entry.eventName !== null ? ` (${entry.eventName})` : ''}
                        {entry.occurredAt !== null ? ` at ${entry.occurredAt}` : ''}
                      </>
                    ) : (
                      <>
                        {entry.kind} <code>{entry.referenceId}</code>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <h4>Suggested next actions (suggestions only — never executed)</h4>
              <ul>
                {item.suggestedActions.map((action) => (
                  <li key={`${item.exceptionId}:${action.commandName}:${action.title}`}>
                    <strong>{action.title}</strong> — {action.rationale} (
                    {action.confidenceLevel}
                    {action.confidenceReasons.length > 0
                      ? `: ${action.confidenceReasons.join('; ')}`
                      : ''}
                    )
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
