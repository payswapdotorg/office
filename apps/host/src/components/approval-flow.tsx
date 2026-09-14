'use client';

// Office browser host — the A8 approval-gated action flow (OFF-DEPLOY).
//
// The interactive surface of the REAL action gateway: the approval decision
// of the live workflow instance is routed through /api/actions in the two
// stages the A8 discipline prescribes. First the propose stage routes the
// approval-required action into the workflow-engine-backed authority (the
// live approval reference comes back — one action, one final outcome); then
// the complete stage drives the routed approval to approved and executes
// the shell's own approval command path, the executed audit event landing in
// the ledger. Both stages post to the app's OWN route with RELATIVE URLs and
// render the typed outcome verbatim (a 4xx body is a typed rejection view,
// never a thrown error). @office/web is imported TYPE-ONLY (erased at
// compile time; the package's node:crypto dependency must never enter the
// client bundle); the server hands this component view-model JSON as props.
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { CommandOutcome } from './command-outcome';
import type { SubmissionOutcome } from './command-outcome';

export interface ApprovalFlowProps {
  /** The live workflow instance awaiting its approval decision. */
  readonly instanceId: string;
  readonly definitionKey: string;
  /** The instance's current version (the optimistic-concurrency guard). */
  readonly expectedVersion: number;
  /** The pending approval step's key inside that instance. */
  readonly approvalKey: string;
  readonly approvalTitle: string;
}

/** The approval reference JSON the propose stage returns (structural view). */
interface ApprovalReferenceJson {
  readonly instanceId: string;
  readonly approvalKey: string;
}

/** The propose stage's typed value (the route serializes it verbatim). */
type ProposeValue =
  | { readonly decision: 'routed-to-approval'; readonly approval: ApprovalReferenceJson }
  | { readonly decision: 'executed'; readonly replayed: boolean; readonly value: SubmissionOutcome };

/** The complete stage's typed value. */
interface CompleteValue {
  readonly decision: 'executed';
  readonly replayed: boolean;
  readonly value: SubmissionOutcome;
}

/** A typed rejection body the 4xx responses carry. */
interface RejectionBody {
  readonly code: string;
  readonly message: string;
}

export function ApprovalFlow(props: ApprovalFlowProps) {
  const [basis, setBasis] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [approval, setApproval] = useState<ApprovalReferenceJson | null>(null);
  const [executed, setExecuted] = useState<SubmissionOutcome | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [rejection, setRejection] = useState<RejectionBody | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const post = async (body: unknown): Promise<{ readonly ok: boolean; readonly json: unknown }> => {
    const response = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, json: await response.json() };
  };

  const propose = async (): Promise<void> => {
    setPending(true);
    setRejection(null);
    setFailure(null);
    try {
      const { ok, json } = await post({
        stage: 'propose',
        request: {
          instanceId: props.instanceId,
          expectedVersion: props.expectedVersion,
          approvalKey: props.approvalKey,
          ...(note !== '' ? { note } : {}),
          basis,
        },
      });
      if (!ok) {
        setRejection(json as RejectionBody);
        return;
      }
      const value = json as ProposeValue;
      if (value.decision === 'routed-to-approval') {
        setApproval(value.approval);
      } else {
        setExecuted(value.value);
        setReplayed(value.replayed);
      }
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setPending(false);
    }
  };

  const complete = async (): Promise<void> => {
    if (approval === null) return;
    setPending(true);
    setRejection(null);
    setFailure(null);
    try {
      const { ok, json } = await post({
        stage: 'complete',
        request: {
          instanceId: props.instanceId,
          expectedVersion: props.expectedVersion,
          approvalKey: props.approvalKey,
          ...(note !== '' ? { note } : {}),
          basis,
        },
        approval,
      });
      if (!ok) {
        setRejection(json as RejectionBody);
        return;
      }
      const value = json as CompleteValue;
      setExecuted(value.value);
      setReplayed(value.replayed);
      setApproval(null);
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setPending(false);
    }
  };

  if (executed !== null) {
    return (
      <section aria-labelledby="approval-executed-head">
        <h3 id="approval-executed-head">Approval decision executed</h3>
        <p>{replayed ? 'Replayed — the action had already executed (one action, one final outcome).' : ''}</p>
        <CommandOutcome outcome={executed} />
      </section>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void propose();
      }}
    >
      <h3>Approval-gated action — {props.approvalTitle}</h3>
      <p>
        The approval decision on workflow instance <code>{props.instanceId}</code>{' '}
        (<code>{props.definitionKey}</code>, v{props.expectedVersion}, step{' '}
        <code>{props.approvalKey}</code>) is approval-gated: proposing it routes the action
        into the approval authority; completing it drives the decision and executes the
        command with ledger audit.
      </p>
      <p>
        <label htmlFor="approval-basis">Evidence basis (the A4 evidence reference)</label>
        <input
          id="approval-basis"
          name="basis"
          value={basis}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setBasis(event.target.value)}
          required
        />
      </p>
      <p>
        <label htmlFor="approval-note">Note (optional)</label>
        <input
          id="approval-note"
          name="note"
          value={note}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setNote(event.target.value)}
        />
      </p>
      {approval === null ? (
        <button type="submit" disabled={pending}>
          {pending ? 'Routing…' : 'Propose approval decision'}
        </button>
      ) : (
        <section aria-labelledby="approval-routed-head">
          <h4 id="approval-routed-head">Awaiting the approval decision</h4>
          <p>
            Routed: instance <code>{approval.instanceId}</code>, step{' '}
            <code>{approval.approvalKey}</code>. Completing drives the approval to approved
            and executes the gated action.
          </p>
          <button type="button" onClick={() => void complete()} disabled={pending}>
            {pending ? 'Executing…' : 'Complete approval decision (approve)'}
          </button>
        </section>
      )}
      {failure !== null ? <p role="alert">{failure}</p> : null}
      {rejection !== null ? (
        <p role="alert">
          Rejected (<code>{rejection.code}</code>): {rejection.message}
        </p>
      ) : null}
    </form>
  );
}
