// Office browser host — /api/actions (OFF-DEPLOY): the A8 approval-gated
// action surface, one route, two stages.
//
// The body is the envelope `{ stage, request }` (plus `approval` for the
// completing stage): `request` is the untrusted approval-decision request
// parsed FAIL-CLOSED inside the gateway (parseApprovalDecisionRequest:
// instanceId, expectedVersion, approvalKey, basis — the A4 evidence
// reference — an optional note and idempotency key).
//
// - stage 'propose' → actions.proposeApprovalDecision: routes the
//   approval-required action into the workflow-engine-backed authority and
//   returns the live approval reference awaiting its decision — or, when the
//   same action (its idempotency key) already executed, replays the recorded
//   executed outcome.
// - stage 'complete' → actions.completeApprovalDecision: drives the routed
//   approval to 'approved' and re-enters the gateway with the approval
//   evidence; the handler executes the shell's own approval command path and
//   the executed audit event lands in the ledger. The `approval` object is
//   the reference the propose stage returned, posted back verbatim; a
//   malformed reference fails typed downstream (the workflow store's own
//   not-found), never a throw.
//
// Response semantics: 200 with the typed decision value; 4xx with the typed
// rejection body (400 input rejections, 403 unauthorized, 404 not-found, 422
// other domain rejections); 503 for an operational failure.
import { getHostRuntime } from '../../../server/runtime';
import {
  isRecord,
  operationalFailureResponse,
  readJsonBody,
  rejectionResponse,
} from '../../../server/http';
import { parseApprovalReferenceInput } from '@office/host-gateway';
import type { HostInputRejection, HostRuntime } from '@office/host-gateway';

export const dynamic = 'force-dynamic';

/**
 * The typed approval reference the complete stage passes back, extracted
 * from the gateway's own surface (never imported from @office/actions —
 * apps/host imports exactly @office/web + @office/host-gateway).
 */
type ApprovalReference = Parameters<HostRuntime['actions']['completeApprovalDecision']>[1];

type ActionEnvelope =
  | { readonly stage: 'propose'; readonly request: unknown }
  | { readonly stage: 'complete'; readonly request: unknown; readonly approval: ApprovalReference };

const invalidEnvelope = (message: string): HostInputRejection => ({
  code: 'invalid-request',
  message,
  details: [],
});

const parseActionEnvelope = (
  raw: unknown,
): { readonly ok: true; readonly value: ActionEnvelope } | { readonly ok: false; readonly error: HostInputRejection } => {
  if (!isRecord(raw) || !('request' in raw)) {
    return {
      ok: false,
      error: invalidEnvelope(
        `expected { stage: 'propose' | 'complete', request, approval? }, received ${typeof raw}`,
      ),
    };
  }
  if (raw.stage !== 'propose' && raw.stage !== 'complete') {
    return {
      ok: false,
      error: invalidEnvelope(
        `expected stage 'propose' or 'complete', received '${String(raw.stage)}'`,
      ),
    };
  }
  if (raw.stage === 'propose') {
    return { ok: true, value: { stage: 'propose', request: raw.request } };
  }
  // The approval reference is untrusted client input: parsed FAIL-CLOSED
  // through the gateway's own parser (the landed EntityId + kebab grammar),
  // never a cast — a malformed reference is a typed 400 rejection.
  const approval = parseApprovalReferenceInput(raw.approval);
  if (!approval.ok) {
    return {
      ok: false,
      error: approval.error,
    };
  }
  return {
    ok: true,
    value: {
      stage: 'complete',
      request: raw.request,
      approval: approval.value,
    },
  };
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!body.ok) return Response.json(body.error, { status: 400 });
    const envelope = parseActionEnvelope(body.value);
    if (!envelope.ok) return Response.json(envelope.error, { status: 400 });
    const runtime = await getHostRuntime();
    if (envelope.value.stage === 'propose') {
      const proposed = await runtime.actions.proposeApprovalDecision(envelope.value.request);
      if (!proposed.ok) return rejectionResponse(proposed.error);
      return Response.json(proposed.value);
    }
    const completed = await runtime.actions.completeApprovalDecision(
      envelope.value.request,
      envelope.value.approval,
    );
    if (!completed.ok) return rejectionResponse(completed.error);
    return Response.json(completed.value);
  } catch (cause) {
    return operationalFailureResponse(cause);
  }
}
