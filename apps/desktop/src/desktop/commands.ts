// Office desktop client protocol/reference shell — the typed command surface
// (OFF-032).
//
// The desktop shell's typed command bindings over the session's data plane:
// each binding is a typed function that (1) validates its input fail-closed
// (canonical ids through the contracts grammars; payloads through the LANDED
// schedule/cost domains' own payload shapes), (2) submits the mutation
// through the ONLINE typed path while connected or captures it into
// @office/client-sync's LocalQueue while DISCONNECTED, with the
// DOMAIN-DECLARED protection class of the mutation, and (3) returns a typed,
// displayable outcome view — rejections are view models (code + message +
// details), NEVER throws.
//
// THE protection-class declarations of the desktop shell's mutations (freeze
// A9 — domain-specific, never silent last-write-wins):
//   * SCHEDULE mutations (activity updates, progress records) — 'open':
//     operational tracking state, non-commercial by domain declaration: on
//     divergence the committed server side stands, the supersession recorded
//     and audited;
//   * COST mutations (budget cost items, commitments) — 'protected':
//     material commercial state: on divergence the capture is PARKED with no
//     auto-resolution path; the ONLY exit is the typed explicit resolution
//     command (conflicts.ts).
//
// The bindings NEVER write canonical state directly: they flow through the
// landed packages' public command surfaces (the world's generic typed
// dispatch — authorization, invariants, optimistic concurrency, audit events
// all run inside those packages). The desktop shell NEVER constructs an
// action gateway: the A8 seam below is TYPE-ONLY (@office/actions types) —
// the HOST wires the real gateway over the same proposal shape later.
//
// Mirrors the landed @office/web and @office/field-client command-surface
// disciplines (the structural templates — mirrored, never imported: apps do
// not import apps).
import type { ActionGateway, ActionProposal } from '@office/actions';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import { parseEntityId } from '@office/contracts';
import type { EntityRef, Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { ACTIVITY_KIND } from '@office/domain-schedule';
import { BUDGET_KIND, COMMITMENT_KIND } from '@office/domain-cost';
import {
  AMEND_COMMITMENT_COMMAND,
  CLOSE_COMMITMENT_COMMAND,
  RECORD_COST_ITEM_COMMAND,
} from '@office/domain-cost';
import { RECORD_PROGRESS_COMMAND, UPDATE_ACTIVITY_COMMAND } from '@office/domain-schedule';
import type { ProtectionClass, QueueEntry } from '@office/client-sync';
import type { DesktopDataPlane, DesktopMutationRequest } from '../session/stream';
import type { DesktopSession } from '../session/session';
import { entityRefOf, sessionCoversScope } from '../session/session';

// ---------------------------------------------------------------------------
// The A8 gateway seam — TYPE-ONLY (the desktop shell never constructs one).
// ---------------------------------------------------------------------------

/**
 * The typed gateway seam a platform host binds over the desktop shell's
 * command surface: exactly the A8 execution chokepoint's shape
 * (@office/actions' ActionGateway — `executeAction(proposal, authorization)`),
 * imported TYPE-ONLY. The desktop shell composes proposals a bound gateway
 * accepts; it never constructs, holds, or calls a gateway itself (freeze A8:
 * the shell commands through the landed domain command surfaces above, not
 * through a second chokepoint).
 */
export type DesktopActionGateway = Pick<ActionGateway, 'executeAction'>;

/**
 * The gateway-ready proposal shape the desktop shell composes for every
 * command binding (a structural subset of @office/actions' ActionProposal —
 * the command, its subject, its evidence links, its confidence, and the
 * target resource scope; the approval reference stays null until a routed
 * approval exists).
 */
export type DesktopCommandProposal = Pick<
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

/** The provenance receipt of one command the session composed. */
export interface CommandReceiptView {
  readonly commandName: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly issuedAt: Timestamp;
  readonly protection: ProtectionClass;
}

/** One displayable queue entry (the capture's queued form). */
export interface QueueEntryView {
  /** The capture's dense 1-based local sequence (the deterministic drain order). */
  readonly localSequence: number;
  /** The client-generated deterministic operation id (the idempotency key). */
  readonly operationId: string;
  readonly commandName: string;
  /** The domain-declared protection class (freeze A9). */
  readonly protection: ProtectionClass;
  /** The entry's lifecycle state (pending until the drain resolves it terminally). */
  readonly state: 'pending' | 'applied' | 'conflicted' | 'superseded';
  /** The ledger event the replay appended (applied entries only). */
  readonly eventId: string | null;
  /** The surfaced conflict record (conflicted/superseded entries only). */
  readonly conflictId: string | null;
  /** The CLIENT-OBSERVED capture instant (payload data, never ordering authority). */
  readonly issuedAt: Timestamp;
  /** The mutating actor's id (null for system actors). */
  readonly actorId: string | null;
  /** The canonical entity the captured mutation addresses (the A12 target). */
  readonly targetKind: string;
  readonly targetId: string;
}

/** The typed outcome view of one OFFLINE capture dispatch. */
export interface CaptureOutcomeView {
  /** 'queued' — the capture landed in the LocalQueue; 'rejected' — displayable. */
  readonly status: 'queued' | 'rejected';
  readonly command: CommandReceiptView;
  /** The queued entry's displayable view (null on rejection). */
  readonly entry: QueueEntryView | null;
  /** The displayable rejection (null unless status is 'rejected'). */
  readonly rejection: RejectionView | null;
}

/** The typed outcome view of one ONLINE submission (the connected twin). */
export interface SubmissionOutcomeView {
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

const receiptOf = (
  commandName: string,
  session: DesktopSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
): CommandReceiptView => ({
  commandName,
  actorKind: session.actor.kind,
  actorId: session.actor.actorId,
  issuedAt,
  protection,
});

/** Project one queue entry into its displayable view (pure). */
export const queueEntryViewOf = (entry: QueueEntry): QueueEntryView => ({
  localSequence: entry.localSequence,
  operationId: entry.operationId,
  commandName: entry.command.commandName,
  protection: entry.protection,
  state: entry.state.status,
  eventId: entry.state.status === 'applied' ? entry.state.eventId : null,
  conflictId:
    entry.state.status === 'conflicted' || entry.state.status === 'superseded'
      ? entry.state.conflictId
      : null,
  issuedAt: entry.command.issuedAt,
  actorId: entry.command.actor.kind === 'user' ? entry.command.actor.actorId : null,
  targetKind: entry.target.entityKind,
  targetId: entry.target.entityId,
});

/** Project a typed capture Result into its displayable outcome view (pure). */
const captureOutcomeOf = (
  commandName: string,
  session: DesktopSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
  captured: Result<QueueEntry, DomainError | { readonly code: string }>,
): CaptureOutcomeView => {
  if (!captured.ok) {
    const error = captured.error as DomainError;
    const isDomainError = typeof (error as { message?: unknown }).message === 'string';
    return {
      status: 'rejected',
      command: receiptOf(commandName, session, issuedAt, protection),
      entry: null,
      rejection: isDomainError
        ? rejectionViewOf(error)
        : { code: (captured.error as { readonly code: string }).code, message: '', details: [] },
    };
  }
  return {
    status: 'queued',
    command: receiptOf(commandName, session, issuedAt, protection),
    entry: queueEntryViewOf(captured.value),
    rejection: null,
  };
};

/** Project a typed online-submission Result into its displayable view (pure). */
const submissionOutcomeOf = (
  commandName: string,
  session: DesktopSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
  submitted:
    | { readonly ok: true; readonly value: { readonly operationId: string; readonly eventId: string; readonly eventName: string; readonly replayed: boolean } }
    | { readonly ok: false; readonly error: DomainError | { readonly code: string } },
): SubmissionOutcomeView => {
  if (!submitted.ok) {
    const error = submitted.error as DomainError;
    const isDomainError = typeof (error as { message?: unknown }).message === 'string';
    return {
      status: 'rejected',
      command: receiptOf(commandName, session, issuedAt, protection),
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
    command: receiptOf(commandName, session, issuedAt, protection),
    operationId: submitted.value.operationId,
    eventId: submitted.value.eventId,
    eventName: submitted.value.eventName,
    rejection: null,
  };
};

/** A typed INPUT rejection, surfaced as a displayable rejected outcome (never a throw). */
const inputRejectionOf = (
  commandName: string,
  session: DesktopSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
  code: string,
  received: string,
): CaptureOutcomeView => ({
  status: 'rejected',
  command: receiptOf(commandName, session, issuedAt, protection),
  entry: null,
  rejection: {
    code,
    message: `invalid canonical id '${received}'`,
    details: [{ code, message: received, path: null }],
  },
});

/** A typed INPUT rejection for the online twin (displayable, never a throw). */
const submissionRejectionOf = (
  commandName: string,
  session: DesktopSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
  code: string,
  received: string,
): SubmissionOutcomeView => ({
  status: 'rejected',
  command: receiptOf(commandName, session, issuedAt, protection),
  operationId: null,
  eventId: null,
  eventName: null,
  rejection: {
    code,
    message: `invalid canonical id '${received}'`,
    details: [{ code, message: received, path: null }],
  },
});

// ---------------------------------------------------------------------------
// The generic typed executors (the host-port's command-executor port and the
// typed bindings below all flow through these two).
// ---------------------------------------------------------------------------

/**
 * THE generic ONLINE command executor: submit one composed desktop mutation
 * through the typed path (the connected twin — this is the exact surface the
 * host-port's command executor port exposes). Typed Results, never throws.
 */
export async function submitDesktopMutation(
  plane: DesktopDataPlane,
  session: DesktopSession,
  request: DesktopMutationRequest,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  return submissionOutcomeOf(
    request.commandName,
    session,
    now,
    request.protection,
    await plane.submit(request, now),
  );
}

/**
 * THE generic OFFLINE capture executor: capture one composed desktop
 * mutation into the bounded LocalQueue while DISCONNECTED. Typed Results,
 * never throws.
 */
export function captureDesktopMutation(
  plane: DesktopDataPlane,
  session: DesktopSession,
  request: DesktopMutationRequest,
  now: Timestamp,
): CaptureOutcomeView {
  return captureOutcomeOf(
    request.commandName,
    session,
    now,
    request.protection,
    plane.capture(request, now),
  );
}

// ---------------------------------------------------------------------------
// The typed command bindings of the schedule/cost domains' real command
// paths (every canonical id parsed fail-closed; every branded vocabulary
// term arrives from the shared domain packages — never a local string).
// ---------------------------------------------------------------------------

/** The write capability every COST mutation of this surface requires. */
const COST_CAPABILITY: Capability = capability('cost.write');
/** The write capability every SCHEDULE mutation of this surface requires. */
const SCHEDULE_CAPABILITY: Capability = capability('schedule.write');

/** The typed budget target of a cost-item binding (fail-closed). */
const budgetTarget = (
  input: { readonly budgetId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const budgetId = parseEntityId(input.budgetId);
  if (!budgetId.ok) {
    return { ok: false, error: { code: 'invalid-budget-id', received: input.budgetId } };
  }
  return { ok: true, value: entityRefOf(BUDGET_KIND, budgetId.value) };
};

/** The typed activity target of a schedule binding (fail-closed). */
const activityTarget = (
  input: { readonly activityId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const activityId = parseEntityId(input.activityId);
  if (!activityId.ok) {
    return { ok: false, error: { code: 'invalid-activity-id', received: input.activityId } };
  }
  return { ok: true, value: entityRefOf(ACTIVITY_KIND, activityId.value) };
};

/** The typed commitment target of a commitment binding (fail-closed). */
const commitmentTarget = (
  input: { readonly commitmentId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const commitmentId = parseEntityId(input.commitmentId);
  if (!commitmentId.ok) {
    return { ok: false, error: { code: 'invalid-commitment-id', received: input.commitmentId } };
  }
  return { ok: true, value: entityRefOf(COMMITMENT_KIND, commitmentId.value) };
};

// ---- the cost-item binding (budget target, PROTECTED commercial state) ----

/** The record-cost-item binding input (the budget's next cost item). */
export interface RecordCostItemInput {
  /** The budget the cost item lands on (canonical id). */
  readonly budgetId: string;
  /** The client's last-observed version of the budget (causal basis). */
  readonly expectedVersion: number;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
};

/**
 * Submit one cost item through the ONLINE typed path (`cost.recordCostItem`)
 * — the reference host's write surface and the web-style twin's mutations.
 * Protection class 'protected': budget cost items are material commercial
 * state — a diverged capture parks for explicit resolution, never silent
 * supersession (freeze A9).
 */
export async function submitCostItem(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: RecordCostItemInput,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  const target = budgetTarget(input);
  if (!target.ok) {
    return submissionRejectionOf(
      RECORD_COST_ITEM_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  return submitDesktopMutation(
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
      target: target.value,
      operationKind: 'record-cost-item',
      requiredCapability: COST_CAPABILITY,
      protection: 'protected',
    },
    now,
  );
}

/**
 * Capture one cost item while DISCONNECTED through the cost domain's
 * recording command (`cost.recordCostItem`) — the offline-style capture path.
 */
export async function captureCostItem(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: RecordCostItemInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const target = budgetTarget(input);
  if (!target.ok) {
    return inputRejectionOf(
      RECORD_COST_ITEM_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  return captureDesktopMutation(
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
      target: target.value,
      operationKind: 'record-cost-item',
      requiredCapability: COST_CAPABILITY,
      protection: 'protected',
    },
    now,
  );
}

// ---- the activity-progress binding (activity target, OPEN tracking state) ----

/** The record-activity-progress binding input. */
export interface RecordProgressInput {
  /** The schedule owning the activity (canonical id). */
  readonly scheduleId: string;
  /** The activity the progress lands on (canonical id). */
  readonly activityId: string;
  /** The client's last-observed version of the schedule (causal basis). */
  readonly expectedVersion: number;
  readonly percentComplete: number;
  readonly remainingDuration: number;
}

/**
 * Submit one activity progress record through the ONLINE typed path
 * (`schedule.recordProgress`) — the web-style twin's divergence mutation.
 * Protection class 'open': operational tracking state — on divergence the
 * committed server side stands, the supersession recorded and audited.
 */
export async function submitProgress(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: RecordProgressInput,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  const target = activityTarget(input);
  if (!target.ok) {
    return submissionRejectionOf(
      RECORD_PROGRESS_COMMAND,
      session,
      now,
      'open',
      target.error.code,
      target.error.received,
    );
  }
  return submitDesktopMutation(
    plane,
    session,
    {
      commandName: RECORD_PROGRESS_COMMAND,
      payload: {
        scheduleId: input.scheduleId,
        activityId: input.activityId,
        expectedVersion: input.expectedVersion,
        percentComplete: input.percentComplete,
        remainingDuration: input.remainingDuration,
        actualStart: null,
        actualFinish: null,
      },
      target: target.value,
      operationKind: 'record-activity-progress',
      requiredCapability: SCHEDULE_CAPABILITY,
      protection: 'open',
    },
    now,
  );
}

// ---- the activity-update binding (activity target, OPEN tracking state) ----

/** The update-activity binding input (at least one change field). */
export interface UpdateActivityInput {
  readonly scheduleId: string;
  readonly activityId: string;
  /** The client's last-observed version of the schedule (causal basis). */
  readonly expectedVersion: number;
  readonly changes: {
    readonly code?: string;
    readonly name?: string;
    readonly plannedDuration?: number;
  };
}

/**
 * Capture one activity update while DISCONNECTED through the schedule
 * domain's update command (`schedule.updateActivity`). Protection class
 * 'open': operational tracking state — on divergence the committed server
 * side stands, the supersession recorded and audited (never silent).
 */
export async function captureActivityUpdate(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: UpdateActivityInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const target = activityTarget(input);
  if (!target.ok) {
    return inputRejectionOf(
      UPDATE_ACTIVITY_COMMAND,
      session,
      now,
      'open',
      target.error.code,
      target.error.received,
    );
  }
  return captureDesktopMutation(
    plane,
    session,
    {
      commandName: UPDATE_ACTIVITY_COMMAND,
      payload: {
        scheduleId: input.scheduleId,
        activityId: input.activityId,
        expectedVersion: input.expectedVersion,
        ...(input.changes.code !== undefined ? { code: input.changes.code } : {}),
        ...(input.changes.name !== undefined ? { name: input.changes.name } : {}),
        ...(input.changes.plannedDuration !== undefined
          ? { plannedDuration: input.changes.plannedDuration }
          : {}),
      },
      target: target.value,
      operationKind: 'update-activity',
      requiredCapability: SCHEDULE_CAPABILITY,
      protection: 'open',
    },
    now,
  );
}

// ---- the commitment bindings (commitment target, PROTECTED commercial state) ----

/** One commitment line input (the closed line vocabulary of the cost domain). */
export interface CommitmentLineInput {
  readonly costItemId: string;
  readonly description: string;
  readonly amountMinor: number;
}

/** The parsed commitment-line payload rows (fail-closed canonical ids). */
const commitmentLinesOf = (
  input: readonly CommitmentLineInput[],
): Result<
  readonly { readonly costItemId: string; readonly description: string; readonly amountMinor: number }[],
  { readonly code: string; readonly received: string }
> => {
  const rows: {
    readonly costItemId: string;
    readonly description: string;
    readonly amountMinor: number;
  }[] = [];
  for (const [index, line] of input.entries()) {
    const costItemId = parseEntityId(line.costItemId);
    if (!costItemId.ok) {
      return {
        ok: false,
        error: { code: 'invalid-cost-item-id', received: `lines[${index}]: ${line.costItemId}` },
      };
    }
    rows.push({
      costItemId: costItemId.value,
      description: line.description,
      amountMinor: line.amountMinor,
    });
  }
  return { ok: true, value: rows };
};

/** The amend-commitment binding input (the staged commercial mutation). */
export interface AmendCommitmentInput {
  /** The commitment being amended (canonical id). */
  readonly commitmentId: string;
  /** The client's last-observed version of the commitment (causal basis). */
  readonly expectedVersion: number;
  /** The budget the commitment draws against (canonical id). */
  readonly budgetId: string;
  readonly reason: string | null;
  readonly lines: readonly CommitmentLineInput[];
}

/**
 * Capture one commitment amendment while DISCONNECTED through the cost
 * domain's amendment command (`cost.amendCommitment`). Protection class
 * 'protected': commitments are material commercial state — a diverged
 * capture is PARKED with structurally no auto-resolution; the ONLY exit is
 * the typed explicit resolution command (freeze A9).
 */
export async function captureCommitmentAmend(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: AmendCommitmentInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const target = commitmentTarget(input);
  if (!target.ok) {
    return inputRejectionOf(
      AMEND_COMMITMENT_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  const budgetId = parseEntityId(input.budgetId);
  if (!budgetId.ok) {
    return inputRejectionOf(
      AMEND_COMMITMENT_COMMAND,
      session,
      now,
      'protected',
      'invalid-budget-id',
      input.budgetId,
    );
  }
  const lines = commitmentLinesOf(input.lines);
  if (!lines.ok) {
    return inputRejectionOf(
      AMEND_COMMITMENT_COMMAND,
      session,
      now,
      'protected',
      lines.error.code,
      lines.error.received,
    );
  }
  return captureDesktopMutation(
    plane,
    session,
    {
      commandName: AMEND_COMMITMENT_COMMAND,
      payload: {
        commitmentId: input.commitmentId,
        expectedVersion: input.expectedVersion,
        budgetId: input.budgetId,
        reason: input.reason,
        lines: lines.value,
      },
      target: target.value,
      operationKind: 'amend-commitment',
      requiredCapability: COST_CAPABILITY,
      protection: 'protected',
    },
    now,
  );
}

/** The close-commitment binding input (the office twin's divergence mutation). */
export interface CloseCommitmentInput {
  /** The commitment being closed (canonical id). */
  readonly commitmentId: string;
  /** The client's last-observed version of the commitment (causal basis). */
  readonly expectedVersion: number;
  readonly reason: string;
}

/**
 * Submit one commitment close through the ONLINE typed path
 * (`cost.closeCommitment`) — the web-style twin's divergence mutation on the
 * contested commercial aggregate. The close's ledger event addresses the
 * commitment itself, so any offline capture composed against the same
 * commitment diverges on reconnect.
 */
export async function submitCommitmentClose(
  plane: DesktopDataPlane,
  session: DesktopSession,
  input: CloseCommitmentInput,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  const target = commitmentTarget(input);
  if (!target.ok) {
    return submissionRejectionOf(
      CLOSE_COMMITMENT_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  return submitDesktopMutation(
    plane,
    session,
    {
      commandName: CLOSE_COMMITMENT_COMMAND,
      payload: {
        commitmentId: input.commitmentId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      },
      target: target.value,
      operationKind: 'close-commitment',
      requiredCapability: COST_CAPABILITY,
      protection: 'protected',
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// The offline queue's displayable state (queue state displayable: pending
// count, entries, protection classes — freeze A9's bounded local queue).
// ---------------------------------------------------------------------------

/** The desktop session's offline queue view (the disconnected captures' state). */
export interface OfflineQueueView {
  readonly kind: 'offline-queue-view';
  /** The entries still pending replay (the queue is empty at zero). */
  readonly pendingCount: number;
  /** The queue's bounded capacity (freeze A9). */
  readonly capacity: number;
  /** The number of captured entries (all states, in local-sequence order). */
  readonly entryCount: number;
  /** Every entry in deterministic local-sequence order (all states). */
  readonly entries: readonly QueueEntryView[];
}

/**
 * Project the session's offline queue into its displayable view model: the
 * pending count, the bounded capacity, and every entry (local sequence,
 * deterministic operation id, command name, protection class, lifecycle
 * state, effect/conflict references). Deterministic: the same queue always
 * projects the same view (A7). A12: a session that does not cover the world
 * the plane is wired over is a typed unauthorized rejection — the queue view
 * is the session's own client-side state, resolved only through its own
 * session scope.
 */
export function offlineQueueView(
  plane: DesktopDataPlane,
  session: DesktopSession,
): Result<OfflineQueueView, DomainError> {
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
  const queue = plane.engine.queue;
  return {
    ok: true,
    value: {
      kind: 'offline-queue-view',
      pendingCount: queue.pending.length,
      capacity: queue.capacity,
      entryCount: queue.size,
      entries: queue.entries.map((entry) => queueEntryViewOf(entry)),
    },
  };
}
