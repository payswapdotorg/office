// Office web application shell — the typed command surface (OFF-030).
//
// The shell's command bindings for the seeded project's REAL command paths:
// each binding is a typed function over the session's data plane that (1)
// validates its input fail-closed through the LANDED domain payload shapes,
// (2) submits the mutation through @office/client-sync's online path (the
// deterministic operation id IS the command's idempotency key — A8/ADR-005),
// and (3) returns a typed, displayable COMMAND OUTCOME VIEW — rejections
// are view models (code + message + details), NEVER throws.
//
// The commands NEVER write canonical state directly: they flow through the
// landed packages' public command surfaces (the world's generic typed
// dispatch — authorization, invariants, optimistic concurrency, audit
// events all run inside those packages). The shell NEVER constructs an
// action gateway: the A8 seam below is TYPE-ONLY (@office/actions types) —
// the HOST wires the real gateway over the same proposal shape later.
import type { ActionGateway, ActionProposal } from '@office/actions';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import { CAPTURE_FIELD_EVENT_COMMAND } from '@office/domain-field';
import { BUDGET_KIND, RECORD_COST_ITEM_COMMAND } from '@office/domain-cost';
import { PROJECT_KIND } from '@office/domain-projects';
import {
  APPROVE_APPROVAL_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
  WORKFLOW_INSTANCE_KIND,
} from '@office/workflows';
import { parseEntityId } from '@office/contracts';
import type { EntityRef, Timestamp } from '@office/contracts';
import type { DomainError, Result } from '@office/domain-kernel';
import type { SeededWorld } from '../session/world';
import type { WebSession } from '../session/session';
import { entityRefOf } from '../session/session';
import type { WebCommandRequest, WebDataPlane } from '../session/stream';

// ---------------------------------------------------------------------------
// The A8 gateway seam — TYPE-ONLY (the shell never constructs a gateway).
// ---------------------------------------------------------------------------

/**
 * The typed gateway seam a host binds over the shell's command surface:
 * exactly the A8 execution chokepoint's shape (@office/actions' ActionGateway
 * — `executeAction(proposal, authorization)`), imported TYPE-ONLY. The shell
 * composes proposals a bound gateway accepts; it never constructs, holds,
 * or calls a gateway itself (freeze A8: the shell executes through the
 * landed domain command surfaces above, not through a second chokepoint).
 */
export type WebActionGateway = Pick<ActionGateway, 'executeAction'>;

/**
 * The gateway-ready proposal shape the shell composes for every binding
 * (a structural subset of @office/actions' ActionProposal — the command,
 * its subject, its evidence links, its confidence, and the target resource
 * scope; the approval reference stays null until a routed approval exists).
 */
export type WebCommandProposal = Pick<
  ActionProposal,
  'command' | 'subject' | 'evidence' | 'confidence' | 'resourceScope'
>;

// ---------------------------------------------------------------------------
// The displayable command outcome views (typed Results — never throws).
// ---------------------------------------------------------------------------

/** One displayable rejection detail (the DomainError detail vocabulary). */
export interface RejectionDetailView {
  readonly code: string;
  readonly message: string;
  readonly path: string | null;
}

/** A displayable typed rejection (a view model, not a thrown error). */
export interface RejectionView {
  readonly code: string;
  readonly message: string;
  readonly details: readonly RejectionDetailView[];
}

/** The provenance receipt of one command the session dispatched. */
export interface CommandReceiptView {
  readonly commandName: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly issuedAt: Timestamp;
}

/** The typed outcome view of one shell command dispatch. */
export interface CommandOutcomeView {
  /** 'executed' | 'replayed' | 'rejected' — replays carry the original effect. */
  readonly status: 'executed' | 'replayed' | 'rejected';
  readonly command: CommandReceiptView;
  /** The data plane's deterministic operation id (the idempotency key). */
  readonly operationId: string | null;
  /** The ledger event the command appended (null on rejection). */
  readonly eventId: string | null;
  readonly eventName: string | null;
  /** The displayable rejection (null unless status is 'rejected'). */
  readonly rejection: RejectionView | null;
}

/** Translate a typed DomainError into its displayable view (pure). */
export const rejectionViewOf = (error: DomainError): RejectionView => ({
  code: error.code,
  message: error.message,
  details: error.details.map((detail) => ({
    code: detail.code,
    message: detail.message,
    path: detail.path,
  })),
});

const receiptOf = (commandName: string, session: WebSession, issuedAt: Timestamp): CommandReceiptView => ({
  commandName,
  actorKind: session.actor.kind,
  actorId: session.actor.actorId,
  issuedAt,
});

/** A typed INPUT rejection, surfaced as a displayable rejected outcome (never a throw). */
const inputRejection = (
  commandName: string,
  session: WebSession,
  issuedAt: Timestamp,
  code: string,
  received: string,
): CommandOutcomeView => ({
  status: 'rejected',
  command: receiptOf(commandName, session, issuedAt),
  operationId: null,
  eventId: null,
  eventName: null,
  rejection: {
    code,
    message: `invalid canonical id '${received}'`,
    details: [{ code, message: received, path: null }],
  },
});

const outcomeOf = (
  commandName: string,
  session: WebSession,
  issuedAt: Timestamp,
  submitted:
    | { readonly ok: true; readonly value: { readonly operationId: string; readonly eventId: string; readonly eventName: string; readonly replayed: boolean } }
    | { readonly ok: false; readonly error: DomainError | { readonly code: string } },
): CommandOutcomeView => {
  if (!submitted.ok) {
    const error = submitted.error as DomainError;
    const isDomainError = typeof (error as { message?: unknown }).message === 'string';
    return {
      status: 'rejected',
      command: receiptOf(commandName, session, issuedAt),
      operationId: null,
      eventId: null,
      eventName: null,
      rejection: isDomainError
        ? rejectionViewOf(error)
        : { code: (submitted.error as { readonly code: string }).code, message: '', details: [] },
    };
  }
  return {
    status: submitted.value.replayed ? 'replayed' : 'executed',
    command: receiptOf(commandName, session, issuedAt),
    operationId: submitted.value.operationId,
    eventId: submitted.value.eventId,
    eventName: submitted.value.eventName,
    rejection: null,
  };
};

/** Submit one typed request through the session's data plane (typed Result). */
const dispatchThroughPlane = async (
  plane: WebDataPlane,
  session: WebSession,
  request: WebCommandRequest,
  now: Timestamp,
): Promise<CommandOutcomeView> =>
  outcomeOf(request.commandName as string, session, now, await plane.submit(request, now));

/** Compose the gateway-ready proposal for one request (TYPE-ONLY A8 shape). */
export const commandProposalOf = (
  world: SeededWorld,
  session: WebSession,
  request: WebCommandRequest,
  now: Timestamp,
  idempotencyKey: string,
): { readonly ok: true; readonly value: WebCommandProposal } | { readonly ok: false; readonly error: RejectionView } => {
  const composed = world.composeCommand({
    commandName: request.commandName,
    payload: request.payload,
    scope: session.scope,
    actor: session.actor,
    idempotencyKey,
    correlationId: 'web-shell-corr-0001',
    issuedAt: now,
  });
  if (!composed.ok) {
    return { ok: false, error: rejectionViewOf(composed.error) };
  }
  return {
    ok: true,
    value: {
      command: composed.value,
      subject: request.target,
      evidence: [],
      confidence: 'high',
      resourceScope: session.scope,
    } satisfies WebCommandProposal,
  };
};

// ---------------------------------------------------------------------------
// The typed bindings of the seeded project's real command paths.
// ---------------------------------------------------------------------------

/** The capture-a-field-observation binding input (the offline-style capture). */
export interface CaptureFieldObservationInput {
  readonly category: string;
  readonly summary: string;
  readonly detail?: string;
  readonly location: string;
  /** CLIENT-observed instant — payload data, never ordering authority. */
  readonly observedAt: string;
  readonly observedBy: string;
  readonly quantity?: { readonly value: number; readonly unit: string };
}

const CAPTURE_FIELD_OPERATION_KIND = 'capture-field-observation';
const WORK_CAPABILITY: Capability = capability('work.write');
const WORKFLOW_CAPABILITY: Capability = capability('workflows.write');
const COST_CAPABILITY: Capability = capability('cost.write');

/**
 * Record a field observation through the field domain's capture command
 * (`field.captureFieldEvent`) — the offline-style capture path with the
 * client-observed instant carried as payload data.
 */
export async function captureFieldObservation(
  plane: WebDataPlane,
  session: WebSession,
  input: CaptureFieldObservationInput,
  now: Timestamp,
): Promise<CommandOutcomeView> {
  return dispatchThroughPlane(
    plane,
    session,
    {
      commandName: CAPTURE_FIELD_EVENT_COMMAND,
      payload: {
        category: input.category,
        summary: input.summary,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        location: input.location,
        observedAt: input.observedAt,
        observedBy: input.observedBy,
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      },
      target: entityRefOf(PROJECT_KIND, session.projectId),
      operationKind: CAPTURE_FIELD_OPERATION_KIND,
      requiredCapability: WORK_CAPABILITY,
    },
    now,
  );
}

/** The submit-a-workflow-approval binding input. */
export interface SubmitWorkflowApprovalInput {
  readonly instanceId: string;
  readonly expectedVersion: number;
  readonly approvalKey: string;
}

/** The typed workflow-instance target of the workflow bindings (fail-closed). */
const workflowInstanceTarget = (
  input: { readonly instanceId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const instanceId = parseEntityId(input.instanceId);
  if (!instanceId.ok) {
    return { ok: false, error: { code: 'invalid-instance-id', received: input.instanceId } };
  }
  return { ok: true, value: entityRefOf(WORKFLOW_INSTANCE_KIND, instanceId.value) };
};

/**
 * Submit one workflow approval request for decision through the workflow
 * engine's approval command (`workflows.submitApproval`).
 */
export async function submitWorkflowApproval(
  plane: WebDataPlane,
  session: WebSession,
  input: SubmitWorkflowApprovalInput,
  now: Timestamp,
): Promise<CommandOutcomeView> {
  const target = workflowInstanceTarget(input);
  if (!target.ok) {
    return inputRejection(
      SUBMIT_APPROVAL_COMMAND,
      session,
      now,
      target.error.code,
      target.error.received,
    );
  }
  return dispatchThroughPlane(
    plane,
    session,
    {
      commandName: SUBMIT_APPROVAL_COMMAND,
      payload: {
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        approvalKey: input.approvalKey,
      },
      target: target.value,
      operationKind: 'submit-workflow-approval',
      requiredCapability: WORKFLOW_CAPABILITY,
    },
    now,
  );
}

/** The approve-a-workflow-approval binding input (the capability-gated decision). */
export interface ApproveWorkflowApprovalInput {
  readonly instanceId: string;
  readonly expectedVersion: number;
  readonly approvalKey: string;
  readonly note?: string;
}

/**
 * Approve a submitted workflow approval — the capability-gated decision
 * (`workflows.approveApproval`): the actor must hold the approval's required
 * capability through the deny-by-default policy (no bypass path; a denial is
 * a displayable rejection view).
 */
export async function approveWorkflowApproval(
  plane: WebDataPlane,
  session: WebSession,
  input: ApproveWorkflowApprovalInput,
  now: Timestamp,
): Promise<CommandOutcomeView> {
  const target = workflowInstanceTarget(input);
  if (!target.ok) {
    return inputRejection(
      APPROVE_APPROVAL_COMMAND,
      session,
      now,
      target.error.code,
      target.error.received,
    );
  }
  return dispatchThroughPlane(
    plane,
    session,
    {
      commandName: APPROVE_APPROVAL_COMMAND,
      payload: {
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        approvalKey: input.approvalKey,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      target: target.value,
      operationKind: 'approve-workflow-approval',
      requiredCapability: WORKFLOW_CAPABILITY,
    },
    now,
  );
}

/** The advance-the-workflow-machine binding input (one guarded transition). */
export interface AdvanceWorkflowInput {
  readonly instanceId: string;
  readonly expectedVersion: number;
  readonly transitionKey: string;
}

/**
 * Execute one typed, guarded transition of the deterministic workflow
 * machine (`workflows.executeTransition`) — how a decided approval carries
 * the instance to its next state.
 */
export async function advanceWorkflowInstance(
  plane: WebDataPlane,
  session: WebSession,
  input: AdvanceWorkflowInput,
  now: Timestamp,
): Promise<CommandOutcomeView> {
  const target = workflowInstanceTarget(input);
  if (!target.ok) {
    return inputRejection(
      EXECUTE_TRANSITION_COMMAND,
      session,
      now,
      target.error.code,
      target.error.received,
    );
  }
  return dispatchThroughPlane(
    plane,
    session,
    {
      commandName: EXECUTE_TRANSITION_COMMAND,
      payload: {
        instanceId: input.instanceId,
        expectedVersion: input.expectedVersion,
        transitionKey: input.transitionKey,
      },
      target: target.value,
      operationKind: 'advance-workflow-instance',
      requiredCapability: WORKFLOW_CAPABILITY,
    },
    now,
  );
}

/** The record-a-cost-item binding input (the budget-side response). */
export interface RecordCostItemInput {
  readonly budgetId: string;
  readonly expectedVersion: number;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
}

/**
 * Record one cost item against the project's budget through the cost
 * domain's recording command (`cost.recordCostItem`) — the mutation the
 * cost position re-projects from.
 */
export async function recordCostItem(
  plane: WebDataPlane,
  session: WebSession,
  input: RecordCostItemInput,
  now: Timestamp,
): Promise<CommandOutcomeView> {
  const budgetId = parseEntityId(input.budgetId);
  if (!budgetId.ok) {
    return inputRejection(
      RECORD_COST_ITEM_COMMAND,
      session,
      now,
      'invalid-budget-id',
      input.budgetId,
    );
  }
  return dispatchThroughPlane(
    plane,
    session,
    {
      commandName: RECORD_COST_ITEM_COMMAND,
      payload: {
        budgetId: input.budgetId,
        expectedVersion: input.expectedVersion,
        code: input.code,
        description: input.description,
        unit: input.unit,
        quantityMilli: input.quantityMilli,
        unitRateMinor: input.unitRateMinor,
      },
      target: entityRefOf(BUDGET_KIND, budgetId.value),
      operationKind: 'record-cost-item',
      requiredCapability: COST_CAPABILITY,
    },
    now,
  );
}

// The canonical command-name constants of the surface's bindings (one source
// of truth: the landed packages' own exported constants).
export { CAPTURE_FIELD_EVENT_COMMAND, RECORD_COST_ITEM_COMMAND, SUBMIT_APPROVAL_COMMAND, APPROVE_APPROVAL_COMMAND, EXECUTE_TRANSITION_COMMAND };
