// Office browser host — the evidence page (OFF-DEPLOY).
//
// A server component: the ledger browser over the gateway's evidence read
// surface. The landing view is the evidence overview (the slice summarized
// by the event-name vocabulary's domain segments + the aggregate streams).
// Navigating with `?event=<id>` (the links on every event reference) renders
// the event's own evidence view AND its A3 causality chain — walked
// backwards to the originating command; an unknown id renders the typed
// not-found rejection honestly (A12: no existence oracle), never a throw.
import { getHostRuntime } from '../../server/runtime';

export const dynamic = 'force-dynamic';

interface EvidencePageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EvidencePage({ searchParams }: EvidencePageProps) {
  const params = await searchParams;
  const runtime = await getHostRuntime();
  const overview = runtime.reads.evidenceOverview();
  const eventParam = typeof params.event === 'string' ? params.event : null;
  const event =
    eventParam === null ? null : runtime.reads.evidenceEvent(undefined, eventParam);
  const causality =
    event !== null && event.ok && eventParam !== null
      ? runtime.reads.causalityChain(undefined, eventParam)
      : null;

  return (
    <>
      <section aria-labelledby="evidence-overview-head">
        <h2 id="evidence-overview-head">Evidence ledger</h2>
        <p>
          {overview.eventCount} events across {overview.aggregateCount} aggregate streams.
        </p>
        <h3>Events by domain</h3>
        <table>
          <caption>The slice summarized by the event-name vocabulary</caption>
          <thead>
            <tr>
              <th scope="col">Domain</th>
              <th scope="col">Events</th>
            </tr>
          </thead>
          <tbody>
            {overview.domains.map((domain) => (
              <tr key={domain.domain}>
                <td>{domain.domain}</td>
                <td>{domain.eventCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Aggregate streams</h3>
        <table>
          <caption>The slice&apos;s aggregate streams, deterministically ordered</caption>
          <thead>
            <tr>
              <th scope="col">Aggregate</th>
              <th scope="col">Events</th>
              <th scope="col">Latest event</th>
            </tr>
          </thead>
          <tbody>
            {overview.aggregates.map((aggregate) => (
              <tr key={`${aggregate.entityKind}:${aggregate.entityId}`}>
                <td>
                  {aggregate.entityKind} <code>{aggregate.entityId}</code>
                </td>
                <td>{aggregate.eventCount}</td>
                <td>
                  <a href={`/evidence?event=${aggregate.lastEventId}`}>
                    <code>{aggregate.lastEventId}</code>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {event !== null && !event.ok ? (
        <section aria-labelledby="evidence-not-found">
          <h2 id="evidence-not-found">Event not found</h2>
          <p>
            The evidence event <code>{eventParam}</code> is not visible to this session (
            <code>{event.error.code}</code>): {event.error.message}
          </p>
        </section>
      ) : null}

      {event !== null && event.ok ? (
        <>
          <section aria-labelledby="evidence-event-head">
            <h2 id="evidence-event-head">Event {event.value.eventId}</h2>
            <p>
              <strong>{event.value.eventName}</strong> — sequence {event.value.sequence} on{' '}
              {event.value.aggregateKind} <code>{event.value.aggregateId}</code>, occurred{' '}
              {event.value.occurredAt}, actor {event.value.actorKind}{' '}
              {event.value.actorId ?? '(system)'}, correlation{' '}
              <code>{event.value.correlationId}</code>, causation{' '}
              {event.value.causationId === null
                ? 'root'
                : event.value.causation.kind === 'root'
                  ? 'root'
                  : `${event.value.causation.kind} ${event.value.causation.referenceId}`}
              .
            </p>
            <h3>Payload (domain-validated at append)</h3>
            <pre>
              <code>{JSON.stringify(event.value.payload, null, 2)}</code>
            </pre>
          </section>
          {causality !== null && causality.ok ? (
            <section aria-labelledby="causality-head">
              <h2 id="causality-head">Causality chain (back to the origin)</h2>
              <p>
                Depth {causality.value.depth} — entry[i] was caused by entry[i+1]; the last
                entry is the chain&apos;s origin.
              </p>
              <ol>
                {causality.value.entries.map((entry, index) => (
                  <li key={`${index}:${entry.kind}`}>
                    {entry.kind === 'event' ? (
                      <>
                        event <code>{entry.event.eventId}</code> —{' '}
                        {entry.event.eventName} (sequence {entry.event.sequence})
                      </>
                    ) : entry.kind === 'command' ? (
                      <>
                        command <code>{entry.command.idempotencyKey}</code> —{' '}
                        {entry.command.commandName} ({entry.command.outcome}
                        {entry.command.rejectionCode !== null
                          ? `: ${entry.command.rejectionCode}`
                          : ''}
                        )
                      </>
                    ) : (
                      <>
                        unresolved causation <code>{entry.referenceId}</code>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {causality !== null && !causality.ok ? (
            <p>No causality chain resolved for this event.</p>
          ) : null}
          <p>
            <a href="/evidence">Back to the evidence overview</a>
          </p>
        </>
      ) : null}
    </>
  );
}
