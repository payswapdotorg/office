// Office field/offline web client — the offline capture surface (OFF-031).
//
// The field client's typed capture bindings over the session's data plane:
// each binding is a typed function that (1) validates its input fail-closed
// (canonical ids through the contracts grammars; payload shapes through the
// LANDED field domain's own payload structure), (2) captures the mutation
// into @office/client-sync's LocalQueue while DISCONNECTED (or submits the
// connected twin through the online path), with the DOMAIN-DECLARED
// protection class of the mutation, and (3) returns a typed, displayable
// CAPTURE OUTCOME VIEW — rejections are view models (code + message +
// details), NEVER throws.
//
// THE protection-class declarations of the field domain's mutations (freeze
// A9 — domain-specific, never silent last-write-wins):
//   * a NEW field observation ('open') — the crew's raw record, non-commercial
//     by domain declaration: on divergence the committed server side stands,
//     the supersession recorded and audited;
//   * an EVIDENCE LINK on an existing field event ('protected') — evidence
//     links feed contractual change claims, material commercial state: on
//     divergence the capture is PARKED with no auto-resolution path; the
//     ONLY exit is the typed explicit resolution command (conflicts.ts);
//   * an ISSUE RESOLUTION ('open') — non-commercial tracking state.
//
// The bindings NEVER write canonical state directly: they flow through the
// landed packages' public command surfaces (the world's generic typed
// dispatch — authorization, invariants, optimistic concurrency, audit
// events all run inside those packages). The field client NEVER constructs
// an action gateway: the A8 seam below is TYPE-ONLY (@office/actions types)
// — the HOST wires the real gateway over the same proposal shape later.
//
// Mirrors the landed @office/web shell's command-surface discipline (the
// structural template — mirrored, never imported: apps do not import apps).
import type { ActionGateway, ActionProposal } from '@office/actions';
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import {
  CAPTURE_FIELD_EVENT_COMMAND,
  FIELD_EVENT_KIND,
  ISSUE_KIND,
  RESOLVE_ISSUE_COMMAND,
} from '@office/domain-field';
import { PROJECT_KIND } from '@office/domain-projects';
import { parseEntityId } from '@office/contracts';
import type { EntityRef, Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { FieldDataPlane, FieldMutationRequest } from '../session/stream';
import type { FieldSession } from '../session/session';
import { entityRefOf, sessionCoversScope } from '../session/session';
import { ATTACH_FIELD_EVENT_EVIDENCE_COMMAND } from '../session/world';
import type { QueueEntry } from '@office/client-sync';
import type { ProtectionClass } from '@office/client-sync';

// ---------------------------------------------------------------------------
// The A8 gateway seam — TYPE-ONLY (the field client never constructs one).
// ---------------------------------------------------------------------------

/**
 * The typed gateway seam a host binds over the field client's capture
 * surface: exactly the A8 execution chokepoint's shape (@office/actions'
 * ActionGateway — `executeAction(proposal, authorization)`), imported
 * TYPE-ONLY. The field client composes proposals a bound gateway accepts;
 * it never constructs, holds, or calls a gateway itself (freeze A8: the
 * field client captures through the landed domain command surfaces above,
 * not through a second chokepoint).
 */
export type FieldActionGateway = Pick<ActionGateway, 'executeAction'>;

/**
 * The gateway-ready proposal shape the field client composes for every
 * capture binding (a structural subset of @office/actions' ActionProposal —
 * the command, its subject, its evidence links, its confidence, and the
 * target resource scope; the approval reference stays null until a routed
 * approval exists).
 */
export type FieldCaptureProposal = Pick<
  ActionProposal,
  'command' | 'subject' | 'evidence' | 'confidence' | 'resourceScope'
>;

// ---------------------------------------------------------------------------
// The displayable capture outcome views (typed Results — never throws).
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

/** The provenance receipt of one capture the session composed. */
export interface CaptureReceiptView {
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
  readonly command: CaptureReceiptView;
  /** The queued entry's displayable view (null on rejection). */
  readonly entry: QueueEntryView | null;
  /** The displayable rejection (null unless status is 'rejected'). */
  readonly rejection: RejectionView | null;
}

/** The typed outcome view of one ONLINE submission (the connected twin). */
export interface SubmissionOutcomeView {
  /** 'executed' | 'replayed' | 'rejected' — replays carry the original effect. */
  readonly status: 'executed' | 'replayed' | 'rejected';
  readonly command: CaptureReceiptView;
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
  session: FieldSession,
  issuedAt: Timestamp,
  protection: ProtectionClass,
): CaptureReceiptView => ({
  commandName,
  actorKind: session.actor.kind,
  actorId: session.actor.actorId,
  issuedAt,
  protection,
});

/** A typed INPUT rejection, surfaced as a displayable rejected outcome (never a throw). */
const inputRejection = (
  commandName: string,
  session: FieldSession,
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
  session: FieldSession,
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
  session: FieldSession,
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

// ---------------------------------------------------------------------------
// The typed capture bindings of the field domain's real command paths.
// ---------------------------------------------------------------------------

/** The write capability every field mutation of this surface requires. */
const WORK_CAPABILITY: Capability = capability('work.write');

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

/**
 * Capture one field observation while DISCONNECTED through the field
 * domain's capture command (`field.captureFieldEvent`) — the offline-style
 * capture path with the client-observed instant carried as payload data.
 * Protection class 'open': the crew's raw record, non-commercial by domain
 * declaration.
 */
export async function captureFieldObservation(
  plane: FieldDataPlane,
  session: FieldSession,
  input: CaptureFieldObservationInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const request: FieldMutationRequest = {
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
    // A new observation addresses the PROJECT itself (the capture's A12
    // target — the field event's own id is minted by the domain on replay).
    target: entityRefOf(PROJECT_KIND, session.projectId),
    operationKind: 'capture-field-observation',
    requiredCapability: WORK_CAPABILITY,
    protection: 'open',
  };
  return captureOutcomeOf(
    CAPTURE_FIELD_EVENT_COMMAND,
    session,
    now,
    request.protection,
    plane.capture(request, now),
  );
}

/** The attach-evidence binding input (typed links to immutable revisions). */
export interface CaptureEvidenceAttachmentInput {
  /** The OPEN field event the evidence links attach to. */
  readonly fieldEventId: string;
  /** The client's last-observed version of the field event (causal basis). */
  readonly expectedVersion: number;
  /** The evidence links (>= 1, unique triples, canonical ids). */
  readonly evidence: readonly {
    readonly entityKind: string;
    readonly entityId: string;
    readonly revisionId: string;
  }[];
}

/** The typed field-event target of the evidence binding (fail-closed). */
const fieldEventTarget = (
  input: { readonly fieldEventId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const fieldEventId = parseEntityId(input.fieldEventId);
  if (!fieldEventId.ok) {
    return { ok: false, error: { code: 'invalid-field-event-id', received: input.fieldEventId } };
  }
  return { ok: true, value: entityRefOf(FIELD_EVENT_KIND, fieldEventId.value) };
};

/** The parsed evidence-reference payload rows (fail-closed canonical ids). */
const evidenceRowsOf = (
  input: CaptureEvidenceAttachmentInput['evidence'],
): Result<
  readonly { readonly entityKind: string; readonly entityId: string; readonly revisionId: string }[],
  { readonly code: string; readonly received: string }
> => {
  const rows: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly revisionId: string;
  }[] = [];
  for (const [index, ref] of input.entries()) {
    const entityId = parseEntityId(ref.entityId);
    if (!entityId.ok) {
      return {
        ok: false,
        error: { code: 'invalid-evidence-entity-id', received: `evidence[${index}]: ${ref.entityId}` },
      };
    }
    const revisionId = parseEntityId(ref.revisionId);
    if (!revisionId.ok) {
      return {
        ok: false,
        error: { code: 'invalid-revision-id', received: `evidence[${index}]: ${ref.revisionId}` },
      };
    }
    rows.push({
      entityKind: ref.entityKind,
      entityId: entityId.value,
      revisionId: revisionId.value,
    });
  }
  return { ok: true, value: rows };
};

/**
 * Capture one evidence attachment while DISCONNECTED through the field
 * domain's append-only evidence command
 * (`field.attachFieldEventEvidence`). Protection class 'protected':
 * evidence links feed contractual change claims — material commercial
 * state — so a diverged capture is PARKED for EXPLICIT resolution, never
 * silently superseded (freeze A9).
 */
export async function captureEvidenceAttachment(
  plane: FieldDataPlane,
  session: FieldSession,
  input: CaptureEvidenceAttachmentInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const target = fieldEventTarget(input);
  if (!target.ok) {
    return inputRejection(
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  const evidence = evidenceRowsOf(input.evidence);
  if (!evidence.ok) {
    return inputRejection(
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      session,
      now,
      'protected',
      evidence.error.code,
      evidence.error.received,
    );
  }
  const request: FieldMutationRequest = {
    commandName: ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
    payload: {
      fieldEventId: input.fieldEventId,
      expectedVersion: input.expectedVersion,
      evidence: evidence.value,
    },
    target: target.value,
    operationKind: 'attach-field-evidence',
    requiredCapability: WORK_CAPABILITY,
    protection: 'protected',
  };
  return captureOutcomeOf(
    ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
    session,
    now,
    request.protection,
    plane.capture(request, now),
  );
}

/** The resolve-issue binding input (a reason is required). */
export interface CaptureIssueResolutionInput {
  /** The OPEN issue being resolved. */
  readonly issueId: string;
  /** The client's last-observed version of the issue (causal basis). */
  readonly expectedVersion: number;
  readonly resolutionNote: string;
}

/** The typed issue target of the resolution binding (fail-closed). */
const issueTarget = (
  input: { readonly issueId: string },
): Result<EntityRef, { readonly code: string; readonly received: string }> => {
  const issueId = parseEntityId(input.issueId);
  if (!issueId.ok) {
    return { ok: false, error: { code: 'invalid-issue-id', received: input.issueId } };
  }
  return { ok: true, value: entityRefOf(ISSUE_KIND, issueId.value) };
};

/**
 * Capture one issue resolution while DISCONNECTED through the field domain's
 * issue lifecycle command (`field.resolveIssue`). Protection class 'open':
 * non-commercial tracking state — on divergence the committed server side
 * stands, the supersession recorded and audited (never silent).
 */
export async function captureIssueResolution(
  plane: FieldDataPlane,
  session: FieldSession,
  input: CaptureIssueResolutionInput,
  now: Timestamp,
): Promise<CaptureOutcomeView> {
  const target = issueTarget(input);
  if (!target.ok) {
    return inputRejection(
      RESOLVE_ISSUE_COMMAND,
      session,
      now,
      'open',
      target.error.code,
      target.error.received,
    );
  }
  const request: FieldMutationRequest = {
    commandName: RESOLVE_ISSUE_COMMAND,
    payload: {
      issueId: input.issueId,
      expectedVersion: input.expectedVersion,
      resolutionNote: input.resolutionNote,
    },
    target: target.value,
    operationKind: 'resolve-issue',
    requiredCapability: WORK_CAPABILITY,
    protection: 'open',
  };
  return captureOutcomeOf(
    RESOLVE_ISSUE_COMMAND,
    session,
    now,
    request.protection,
    plane.capture(request, now),
  );
}

/**
 * Submit one evidence attachment through the ONLINE path (the connected
 * twin — the office-side session's mutations and the reconciled
 * re-submissions). The same command path, the same idempotency discipline.
 */
export async function submitEvidenceAttachment(
  plane: FieldDataPlane,
  session: FieldSession,
  input: CaptureEvidenceAttachmentInput,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  const target = fieldEventTarget(input);
  if (!target.ok) {
    return submissionRejectionOf(
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      session,
      now,
      'protected',
      target.error.code,
      target.error.received,
    );
  }
  const evidence = evidenceRowsOf(input.evidence);
  if (!evidence.ok) {
    return submissionRejectionOf(
      ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      session,
      now,
      'protected',
      evidence.error.code,
      evidence.error.received,
    );
  }
  const request: FieldMutationRequest = {
    commandName: ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
    payload: {
      fieldEventId: input.fieldEventId,
      expectedVersion: input.expectedVersion,
      evidence: evidence.value,
    },
    target: target.value,
    operationKind: 'attach-field-evidence',
    requiredCapability: WORK_CAPABILITY,
    protection: 'protected',
  };
  return submissionOutcomeOf(
    ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
    session,
    now,
    request.protection,
    await plane.submit(request, now),
  );
}

/** A typed INPUT rejection for the online twin (displayable, never a throw). */
const submissionRejectionOf = (
  commandName: string,
  session: FieldSession,
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

/**
 * Submit one issue resolution through the ONLINE path (the connected twin).
 */
export async function submitIssueResolution(
  plane: FieldDataPlane,
  session: FieldSession,
  input: CaptureIssueResolutionInput,
  now: Timestamp,
): Promise<SubmissionOutcomeView> {
  const target = issueTarget(input);
  if (!target.ok) {
    return submissionRejectionOf(
      RESOLVE_ISSUE_COMMAND,
      session,
      now,
      'open',
      target.error.code,
      target.error.received,
    );
  }
  const request: FieldMutationRequest = {
    commandName: RESOLVE_ISSUE_COMMAND,
    payload: {
      issueId: input.issueId,
      expectedVersion: input.expectedVersion,
      resolutionNote: input.resolutionNote,
    },
    target: target.value,
    operationKind: 'resolve-issue',
    requiredCapability: WORK_CAPABILITY,
    protection: 'open',
  };
  return submissionOutcomeOf(
    RESOLVE_ISSUE_COMMAND,
    session,
    now,
    request.protection,
    await plane.submit(request, now),
  );
}

// ---------------------------------------------------------------------------
// The offline queue's displayable state (queue state displayable: pending
// count, entries, protection classes — freeze A9's bounded local queue).
// ---------------------------------------------------------------------------

/** The field session's offline queue view (the disconnected captures' state). */
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
 * projects the same view (A7). A12: a session that does not cover the
 * world the plane is wired over is a typed unauthorized rejection — the
 * queue view is the session's own client-side state, resolved only through
 * its own session scope.
 */
export function offlineQueueView(
  plane: FieldDataPlane,
  session: FieldSession,
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
