// Office host gateway — the A8 approval-gated action wiring (OFF-DEPLOY).
//
// THE REAL action gateway's hosted action: the workflow approval decision
// (the shell's APPROVE_APPROVAL_COMMAND binding — "the capability-gated
// decision" of apps/web/src/commands/commands.ts), registered as an
// APPROVAL-REQUIRED action. The proposal's command envelope is the approval
// command itself; the descriptor routes it into the workflow-engine-backed
// approval authority (@office/actions' createWorkflowApprovalAuthority over
// @office/web's seeded workflow engine), so deciding a consequential
// approval itself requires a completed approval — freeze A8 end to end. The
// injected handler executes THE SHELL'S OWN approval command path
// (approveWorkflowApproval through the session's data plane), and every
// gateway decision appends its audit event through the REAL PG event ledger
// (the runtime's ledger-backed sink).
import {
  APPROVE_APPROVAL_COMMAND,
  approveWorkflowApproval,
  entityRefOf,
  submitWorkflowApproval,
} from '@office/web';
import type { ApproveWorkflowApprovalInput, SeededWorld, WebDataPlane, WebSession } from '@office/web';
import { actionProposal, defineActionDescriptor } from '@office/actions';
import type { ActionCommandHandler, ActionProposal, ApprovalReference } from '@office/actions';
import { domainError, nextAggregateVersion } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  CURRENT_SCHEMA_VERSION,
  parseCorrelationId,
  parseEntityId,
  parseIdempotencyKey,
} from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import type { ApprovalDecisionRequest, HostInputRejection } from './inputs';

/**
 * The canonical entity kind of a workflow instance, mirrored from the
 * workflows package's own constant (validated fail-closed by the contracts
 * grammar through entityRefOf — a wrong literal is a LOUD parse failure,
 * never a silent mismatch).
 */
const WORKFLOW_INSTANCE_KIND_LITERAL = 'workflow-instance';

/**
 * THE hosted approval-gated action descriptor: the shell's workflow approval
 * decision, class approval-required. Its approval routing targets the seeded
 * world's PUBLISHED 'change-event-approval' definition and its 'manager'
 * approval step (the definition's own declared decision gate: cost.write @
 * policy/change-events@1) — exactly the gate createWorkflowApprovalAuthority
 * verifies before routing (a mismatch is a typed wiring failure).
 */
export const APPROVAL_DECISION_DESCRIPTOR = defineActionDescriptor({
  commandName: APPROVE_APPROVAL_COMMAND,
  title: 'Decide a workflow approval',
  description:
    'Approve a submitted workflow approval through the A8 action gateway (approval-required: the decision itself is approval-gated).',
  actionClass: 'approval-required',
  actorKinds: ['user'],
  requiredCapabilities: ['workflows.write'],
  policyRef: 'policy/host-approval-decisions@1',
  evidenceRequirements: [
    {
      slot: 'approval-basis',
      description: 'The ledger event id or document reference the decision is based on.',
    },
  ],
  requiredConfidence: 'high',
  resourceKind: WORKFLOW_INSTANCE_KIND_LITERAL,
  compensatingCommand: null,
  approval: {
    definitionKey: 'change-event-approval',
    approvalKey: 'manager',
    requiredCapability: 'cost.write',
    policyRef: 'policy/change-events@1',
  },
});

/** The typed failure when a request id does not parse as an instance id. */
export const invalidInstanceRejection = (received: string): HostInputRejection => ({
  code: 'invalid-request',
  message: `invalid workflow instance id '${received}'`,
  details: [{ code: 'invalid-instance-id', message: received, path: 'instanceId' }],
});

/**
 * Resolve the action's idempotency key: the client-issued key when present
 * (A8/ADR-005), otherwise the deterministic derivation from the addressed
 * instance, its expected version, and the approval key — the same addressed
 * decision always proposes the same action.
 */
export const resolveApprovalActionKey = (request: ApprovalDecisionRequest): string =>
  request.idempotencyKey ??
  `host-apv-${request.instanceId}-v${request.expectedVersion}-${request.approvalKey}`;

/** The typed rejection of an unbranded action key (fail-closed, displayable). */
const invalidActionKeyRejection = (received: string): HostInputRejection => ({
  code: 'invalid-request',
  message: `invalid action idempotency key '${received}'`,
  details: [{ code: 'invalid-idempotency-key', message: received, path: 'idempotencyKey' }],
});

/** The typed rejection of an unbranded correlation id (fail-closed, displayable). */
const invalidCorrelationRejection = (received: string): HostInputRejection => ({
  code: 'invalid-request',
  message: `invalid correlation id '${received}'`,
  details: [{ code: 'invalid-correlation-id', message: received, path: 'correlationId' }],
});

/** The parts the proposal composition needs from the runtime. */
export interface ApprovalProposalParts {
  readonly session: WebSession;
  readonly correlationId: string;
  readonly now: () => Timestamp;
}

/**
 * Compose the gateway-ready proposal for one approval decision: the approval
 * command envelope (scope, actor, idempotency key, causality from the
 * hosted session), the workflow-instance subject, the A4 evidence reference
 * filling the descriptor's 'approval-basis' slot, high confidence, and the
 * resource scope the A12 structural check resolves against. `approval` is
 * null on first entry and the routed reference on re-entry.
 */
export const composeApprovalDecisionProposal = (
  parts: ApprovalProposalParts,
  request: ApprovalDecisionRequest,
  approval: ApprovalReference | null,
): Result<ActionProposal, HostInputRejection> => {
  const instanceId = parseEntityId(request.instanceId);
  if (!instanceId.ok) return { ok: false, error: invalidInstanceRejection(request.instanceId) };
  const actorId = parseEntityId(parts.session.actor.actorId);
  if (!actorId.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid-request',
        message: `invalid session actor id '${parts.session.actor.actorId}'`,
        details: [{ code: 'invalid-actor-id', message: parts.session.actor.actorId, path: 'actorId' }],
      },
    };
  }
  // The action key is client-issued-or-derived UNVALIDATED text: brand it
  // through the landed fail-closed parser (never a cast) — a grammar failure
  // is a typed displayable rejection, not a throw.
  const actionKey = parseIdempotencyKey(resolveApprovalActionKey(request));
  if (!actionKey.ok) return { ok: false, error: invalidActionKeyRejection(resolveApprovalActionKey(request)) };
  const correlation = parseCorrelationId(parts.correlationId);
  if (!correlation.ok) return { ok: false, error: invalidCorrelationRejection(parts.correlationId) };
  const proposal = actionProposal({
    command: {
      kind: 'command',
      commandName: APPROVE_APPROVAL_COMMAND,
      scope: parts.session.scope,
      actor: { kind: 'user', actorId: actorId.value },
      idempotencyKey: actionKey.value,
      causality: { correlationId: correlation.value, causationId: null },
      issuedAt: parts.now(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {
        instanceId: request.instanceId,
        expectedVersion: request.expectedVersion,
        approvalKey: request.approvalKey,
        ...(request.note !== undefined ? { note: request.note } : {}),
      },
    },
    subject: entityRefOf(WORKFLOW_INSTANCE_KIND_LITERAL, instanceId.value),
    evidence: [{ slot: 'approval-basis', ref: request.basis }],
    confidence: 'high',
    resourceScope: parts.session.scope,
    approval,
  });
  return { ok: true, value: proposal };
};

/** The parts the injected handler needs from the runtime. */
export interface ApprovalHandlerParts {
  readonly plane: WebDataPlane;
  readonly session: WebSession;
}

/**
 * Advance the session's consumption cursor over its live deliveries (the
 * session's own A9 discipline). The online operation id of every shell
 * command submission derives from (subscription, observed cursor, operation
 * kind): two same-kind submissions at ONE cursor are ONE logical operation —
 * an unconfirmed retry — so the gateway, when IT drives several distinct
 * same-kind shell commands programmatically, consumes the plane's live
 * deliveries between them exactly as the landed shell harness does (each
 * driven submission then derives its own deterministic operation id).
 */
const consumeLive = (
  plane: WebDataPlane,
): Result<true, DomainError> => {
  const consumed = plane.consume();
  return consumed.ok ? { ok: true, value: true } : consumed;
};

/**
 * Create the injected typed command handler: executes THE SHELL'S OWN
 * approval command path (approveWorkflowApproval through the session's data
 * plane, with the gateway's injected clock). The handler's value is the
 * shell's displayable CommandOutcomeView — a typed shell rejection is a
 * displayable outcome (status 'rejected'), not a handler failure.
 */
export const createApprovalDecisionHandler = (
  parts: ApprovalHandlerParts,
): ActionCommandHandler => async (command, context) => {
  const payload = command.payload as Record<string, unknown>;
  const input: ApproveWorkflowApprovalInput = {
    instanceId: String(payload['instanceId'] ?? ''),
    expectedVersion: Number(payload['expectedVersion'] ?? 0),
    approvalKey: String(payload['approvalKey'] ?? ''),
    ...(typeof payload['note'] === 'string' ? { note: payload['note'] } : {}),
  };
  // The session's cursor discipline: the routed approval's decision (same
  // operation kind as this one) was just submitted through this plane — its
  // live delivery must be consumed before the ORIGINAL approval's decision
  // derives its own operation id (two same-kind submissions at one cursor
  // are one logical operation, never two).
  const consumed = consumeLive(parts.plane);
  if (!consumed.ok) return consumed;
  return { ok: true, value: await approveWorkflowApproval(parts.plane, parts.session, input, context.now()) };
};

/** The parts the routed-approval driver needs from the runtime. */
export interface RoutedApprovalParts {
  readonly world: SeededWorld;
  readonly plane: WebDataPlane;
  readonly session: WebSession;
  readonly now: () => Timestamp;
}

/** Surface a shell outcome's typed rejection as a typed DomainError. */
const outcomeFailure = (what: string, outcome: { readonly status: string; readonly rejection: { readonly code: string; readonly message: string } | null }): DomainError =>
  domainError(
    'invariant-violation',
    `${what} was rejected while completing the approval-gated action`,
    [
      {
        code: outcome.rejection?.code ?? 'routed-approval-rejected',
        message: outcome.rejection?.message ?? `status '${outcome.status}'`,
        path: null,
      },
    ],
    { scope: null, correlationId: null },
  );

/**
 * Drive the ROUTED approval (the approval the action's own routing opened)
 * to 'approved' through the SHELL'S OWN approval command path — submit when
 * still pending, then decide — idempotently: an already-approved routing
 * is a no-op, a rejected routing is a typed failure (the action can never
 * force-execute past a rejected approval).
 */
export const driveRoutedApprovalToApproved = async (
  parts: RoutedApprovalParts,
  approval: ApprovalReference,
): Promise<Result<true, DomainError>> => {
  const instanceId = parseEntityId(approval.instanceId);
  if (!instanceId.ok) {
    return {
      ok: false,
      error: domainError(
        'invariant-violation',
        `the routed approval's instance id '${approval.instanceId}' is not canonical`,
        [{ code: 'invalid-instance-id', message: approval.instanceId, path: null }],
        { scope: parts.session.scope, correlationId: null },
      ),
    };
  }
  const loaded = parts.world.stores.workflows.findInstance(parts.session.scope, instanceId.value);
  if (!loaded.ok) return loaded;
  const instance = loaded.value;
  const step = instance.approvals.find((candidate) => candidate.key === approval.approvalKey);
  if (step === undefined) {
    return {
      ok: false,
      error: domainError(
        'not-found',
        `the routed approval's instance ${approval.instanceId} carries no approval '${approval.approvalKey}'`,
        [{ code: 'approval-not-found', message: approval.approvalKey, path: null }],
        { scope: parts.session.scope, correlationId: null },
      ),
    };
  }
  let version = instance.version;
  if (step.status === 'pending') {
    // The session's cursor discipline FIRST: the hosted session's own earlier
    // same-kind submission (the shell's approval-submission path) and this
    // routed submission are distinct logical operations — consume the live
    // deliveries so the routed submission derives its own operation id.
    const consumed = consumeLive(parts.plane);
    if (!consumed.ok) return consumed;
    const submitted = await submitWorkflowApproval(
      parts.plane,
      parts.session,
      { instanceId: approval.instanceId, expectedVersion: version, approvalKey: approval.approvalKey },
      parts.now(),
    );
    if (submitted.status !== 'executed') {
      return { ok: false, error: outcomeFailure('the routed approval submission', submitted) };
    }
    // The landed constructor brands the successor version (never arithmetic
    // on the branded number — nextAggregateVersion validates monotonicity).
    version = nextAggregateVersion(version);
  }
  if (step.status === 'pending' || step.status === 'submitted') {
    const decided = await approveWorkflowApproval(
      parts.plane,
      parts.session,
      { instanceId: approval.instanceId, expectedVersion: version, approvalKey: approval.approvalKey },
      parts.now(),
    );
    if (decided.status !== 'executed') {
      return { ok: false, error: outcomeFailure('the routed approval decision', decided) };
    }
  } else if (step.status === 'rejected') {
    return {
      ok: false,
      error: domainError(
        'forbidden',
        `the routed approval '${approval.approvalKey}' on instance ${approval.instanceId} was rejected — the approval-gated action can never execute`,
        [{ code: 'approval-rejected', message: approval.approvalKey, path: null }],
        { scope: parts.session.scope, correlationId: null },
      ),
    };
  }
  return { ok: true, value: true };
};
