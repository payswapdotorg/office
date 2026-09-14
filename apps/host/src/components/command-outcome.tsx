'use client';

// Office browser host — the typed command-outcome view (OFF-DEPLOY).
//
// The shared presentational client component both interactive surfaces
// render their POST result with: the typed CommandOutcomeView from
// @office/web's command surface (status executed/replayed/rejected, the
// provenance receipt, the ledger event, and the displayable rejection). It
// imports @office/web TYPE-ONLY — type-only imports are erased at compile
// time, and @office/web pulls node:crypto, so it must never enter the client
// bundle; the values arrive as JSON from the app's own API routes.
import type { CommandOutcomeView } from '@office/web';

/** The typed input-rejection body the API routes answer 400 with. */
export interface InputRejectionView {
  readonly code: string;
  readonly message: string;
  readonly details: readonly { readonly code: string; readonly message: string; readonly path: string | null }[];
}

/** Either shape the /api routes can answer a submission with. */
export type SubmissionOutcome = CommandOutcomeView | { readonly rejected: InputRejectionView };

const isInputRejection = (
  outcome: SubmissionOutcome,
): outcome is { readonly rejected: InputRejectionView } => 'rejected' in outcome;

/** Render one typed command outcome view (or input rejection) verbatim. */
export function CommandOutcome({ outcome }: { readonly outcome: SubmissionOutcome }) {
  if (isInputRejection(outcome)) {
    return (
      <section aria-live="polite" aria-label="Request rejected">
        <p role="alert">
          <strong>Invalid request</strong> — <code>{outcome.rejected.code}</code>:{' '}
          {outcome.rejected.message}
        </p>
        {outcome.rejected.details.length > 0 ? (
          <ul>
            {outcome.rejected.details.map((detail) => (
              <li key={`${detail.code}:${detail.message}`}>
                {detail.code} — {detail.message}
                {detail.path !== null ? ` (${detail.path})` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }
  return (
    <section aria-live="polite" aria-label="Command outcome">
      <p>
        <strong>{outcome.status}</strong> — {outcome.command.commandName}
      </p>
      <dl>
        <div>
          <dt>Operation</dt>
          <dd>{outcome.operationId ?? '—'}</dd>
        </div>
        <div>
          <dt>Event</dt>
          <dd>
            {outcome.eventName ?? '—'}
            {outcome.eventId !== null ? ` (${outcome.eventId})` : ''}
          </dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>
            {outcome.command.actorKind} {outcome.command.actorId ?? '(system)'}
          </dd>
        </div>
        <div>
          <dt>Issued at</dt>
          <dd>{outcome.command.issuedAt}</dd>
        </div>
      </dl>
      {outcome.rejection !== null ? (
        <div role="alert">
          <p>
            Rejection <code>{outcome.rejection.code}</code>: {outcome.rejection.message}
          </p>
          {outcome.rejection.details.length > 0 ? (
            <ul>
              {outcome.rejection.details.map((detail) => (
                <li key={`${detail.code}:${detail.message}`}>
                  {detail.code} — {detail.message}
                  {detail.path !== null ? ` (${detail.path})` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
