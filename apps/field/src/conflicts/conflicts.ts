// Office field/offline web client — the conflict state surface (OFF-031).
//
// THE acceptance core: diverged captures surface as DISPLAYABLE CONFLICT
// VIEW MODELS carrying BOTH SIDES + PROVENANCE (the contested target, the
// deterministic side order, each side's operation identity, the detection
// time and detector), and the conflict's DOMAIN-DECLARED protection class
// decides what may happen next (freeze A9 — never silent last-write-wins):
//
//   * a PROTECTED conflict (the evidence-link capture) shows the
//     NO-AUTO-RESOLUTION state — the replay engine has no path that applies
//     the parked entry — and the ONLY exit: the TYPED EXPLICIT RESOLUTION
//     COMMAND surfaced as a USER ACTION (resolveProtectedConflict below);
//     the reconciled mutation re-enters the queue discipline and replays
//     exactly once;
//   * an OPEN conflict shows the DETERMINISTIC SUPERSESSION outcome — the
//     committed server-side operation stands (never reverted), the
//     supersession recorded as a RESOLVED conflict record with the standing
//     strategy, the system actor, and the diverging event as audit evidence:
//     explicit and audited, never silent.
//
// Every view is a pure projection over the engine's own typed records (the
// conflict records delivered to the session's stream + the queue entries'
// protection classes + the drain reports). No I/O, no clock reads (the `now`
// of the resolution is injected), no state of its own. Typed Results
// throughout — rejections are displayable view models, never throws.
import { capability } from '@office/authz';
import type { Capability } from '@office/authz';
import { parseConflictRecordId, parseOperationKind } from '@office/sync';
import type {
  ClientOperation,
  ConflictRecord,
  ConflictResolutionStrategy,
  OperationKind,
} from '@office/sync';
import { parseLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import { FIELD_EVENT_KIND } from '@office/domain-field';
import { parseEntityId } from '@office/contracts';
import type { Timestamp } from '@office/contracts';
import { domainError } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  ConflictResolutionCommand,
  ConflictResolutionReport,
  ProtectionClass,
  QueueEntry,
} from '@office/client-sync';
import type { FieldDataPlane } from '../session/stream';
import { FIELD_SESSION_CORRELATION } from '../session/stream';
import type { FieldSession } from '../session/session';
import { ATTACH_FIELD_EVENT_EVIDENCE_COMMAND } from '../session/world';
import type { SeededFieldWorld } from '../session/world';
import { entityRefOf, sessionCoversScope } from '../session/session';
import type {
  CaptureEvidenceAttachmentInput,
  QueueEntryView,
  RejectionView,
} from '../capture/capture';
import { queueEntryViewOf, rejectionViewOf } from '../capture/capture';

/** The write capability the reconciled evidence mutation requires. */
const WORK_CAPABILITY: Capability = capability('work.write');

/**
 * The reconciled mutation's operation kind (`attach-field-evidence` — the
 * same domain-owned vocabulary the capture binding declares), derived ONCE
 * through @office/sync's public fail-closed parseOperationKind so the
 * branded OperationKind is bound through a public package surface only (a
 * wiring typo is a LOUD error, never a raw-string cast).
 */
const ATTACH_FIELD_EVIDENCE_OPERATION_KIND: OperationKind = (() => {
  const parsed = parseOperationKind('attach-field-evidence');
  if (!parsed.ok) {
    throw new TypeError(
      `field client wiring error (attach-evidence operation kind): ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
})();

// ---------------------------------------------------------------------------
// The displayable conflict view models (both sides + provenance).
// ---------------------------------------------------------------------------

/** One side of a conflict (the deterministic side order is the record's). */
export interface ConflictSideView {
  /** The side's operation id (the offline id or the online deterministic id). */
  readonly operationId: string;
  /** The side's domain operation kind (e.g. 'attach-field-evidence'). */
  readonly operationKind: string;
  /** The acting actor of the side's operation. */
  readonly actorKind: string;
  readonly actorId: string | null;
  /** The slice position the side composed against (its causal token). */
  readonly position: number;
  /** The canonical digest of the side's command payload. */
  readonly payloadDigest: string;
  /** The contested canonical entity (both sides address the same target). */
  readonly targetKind: string;
  readonly targetId: string;
}

/** The conflict's provenance (where, when, and by whom it was detected). */
export interface ConflictProvenanceView {
  readonly conflictId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly detectedAt: Timestamp;
  /** The protocol's detector (the system actor of the drain's conflict path). */
  readonly detectedBy: 'system';
}

/**
 * The deterministic disposition of one conflict — the ONLY displayable path
 * forward (freeze A9's offline-conflict decision: explicit resolution,
 * never silent last-write-wins):
 *
 * - 'awaiting-explicit-resolution': a DETECTED conflict whose parked entry
 *   is PROTECTED — no auto-resolution exists; the only exit is the typed
 *   explicit resolution command as a USER ACTION;
 * - 'superseded': an OPEN divergence the protocol resolved deterministically
 *   (the committed server side stands; recorded + audited, never silent);
 * - 'resolved': a conflict resolved by an EXPLICIT user resolution (the
 *   reconciled mutation re-entered the queue and applied).
 */
export type ConflictDisposition =
  | {
      readonly kind: 'awaiting-explicit-resolution';
      readonly autoResolvable: false;
      readonly exit: 'explicit-resolution-command';
    }
  | {
      readonly kind: 'superseded';
      readonly autoResolvable: true;
      readonly strategy: ConflictResolutionStrategy;
      readonly resolvedBy: 'system';
      readonly resolvedAt: Timestamp;
      readonly auditEventRefs: readonly string[];
    }
  | {
      readonly kind: 'resolved';
      readonly autoResolvable: false;
      readonly strategy: ConflictResolutionStrategy;
      readonly resolvedBy: string;
      readonly resolvedAt: Timestamp;
      readonly auditEventRefs: readonly string[];
    };

/** ONE displayable conflict view model (both sides + provenance + disposition). */
export interface ConflictView {
  readonly kind: 'conflict-view';
  readonly conflictId: string;
  /** The parked capture's domain-declared protection class (freeze A9). */
  readonly protection: ProtectionClass;
  /** Lifecycle state: 'detected' (awaiting resolution) or 'resolved'. */
  readonly state: 'detected' | 'resolved';
  /** The deterministically-FIRST side (operation id ascending). */
  readonly first: ConflictSideView;
  /** The deterministically-SECOND side (operation id ascending). */
  readonly second: ConflictSideView;
  readonly provenance: ConflictProvenanceView;
  /** The ONLY displayable path forward. */
  readonly disposition: ConflictDisposition;
}

/** The session's conflict state view (every conflict it has been notified of). */
export interface ConflictStateView {
  readonly kind: 'conflict-state-view';
  readonly conflicts: readonly ConflictView[];
  /** The conflicts still awaiting an explicit resolution (detected). */
  readonly unresolvedCount: number;
}

/** Project one conflict record's side into its displayable view (pure). */
const sideViewOf = (side: ClientOperation): ConflictSideView => ({
  operationId: side.operationId,
  operationKind: side.operationKind,
  actorKind: side.actor.kind,
  actorId: side.actor.kind === 'user' ? side.actor.actorId : null,
  position: side.position,
  payloadDigest: side.payloadDigest,
  targetKind: side.target.entityKind,
  targetId: side.target.entityId,
});

/** Project one conflict record + its parked entry into the displayable view. */
const conflictViewOf = (record: ConflictRecord, protection: ProtectionClass): ConflictView => {
  const resolution = record.resolution;
  const resolvedByKind = resolution?.resolvedBy.kind ?? null;
  const disposition: ConflictDisposition =
    record.state === 'detected'
      ? { kind: 'awaiting-explicit-resolution', autoResolvable: false, exit: 'explicit-resolution-command' }
      : resolvedByKind === 'system'
        ? {
            kind: 'superseded',
            autoResolvable: true,
            strategy: resolution?.strategy ?? 'merge',
            resolvedBy: 'system',
            resolvedAt: resolution?.resolvedAt ?? record.detectedAt,
            auditEventRefs: [...(resolution?.auditEventRefs ?? [])],
          }
        : {
            kind: 'resolved',
            autoResolvable: false,
            strategy: resolution?.strategy ?? 'merge',
            resolvedBy:
              resolution?.resolvedBy.kind === 'user' ? resolution.resolvedBy.actorId : 'unknown',
            resolvedAt: resolution?.resolvedAt ?? record.detectedAt,
            auditEventRefs: [...(resolution?.auditEventRefs ?? [])],
          };
  return {
    kind: 'conflict-view',
    conflictId: record.conflictId,
    protection,
    state: record.state,
    first: sideViewOf(record.first),
    second: sideViewOf(record.second),
    provenance: {
      conflictId: record.conflictId,
      tenantId: record.tenantId,
      projectId: record.projectId,
      detectedAt: record.detectedAt,
      detectedBy: 'system',
    },
    disposition,
  };
};

/**
 * Project the session's conflict state: every conflict record delivered to
 * the session's stream (in notification order — the client's OWN knowledge
 * of what diverged, both sides + provenance), each composed with the
 * CURRENT stored record of the shared conflict log (the app's stand-in for
 * the server's conflict state — an explicit resolution updates the stored
 * record without re-notifying the stream, so the log is the current-state
 * oracle the notified snapshot is reconciled against) and the parked queue
 * entry's domain-declared protection class. A session that does not cover
 * the world the plane is wired over is a typed unauthorized rejection
 * (A12). Deterministic: the same records + queue always project the same
 * view (A7).
 */
export function conflictStateView(
  world: SeededFieldWorld,
  plane: FieldDataPlane,
  session: FieldSession,
): Result<ConflictStateView, DomainError> {
  if (!sessionCoversScope(session, plane.worldScope)) {
    return {
      ok: false,
      error: rejectionDomainError(session),
    };
  }
  const engine = plane.engine;
  const conflicts = engine.conflictsNotified.map((notified) => {
    // The parked queue entry owns the conflict's protection class (the
    // domain-declared divergence gate — freeze A9).
    const entry = engine.queue.entries.find(
      (candidate) =>
        (candidate.state.status === 'conflicted' || candidate.state.status === 'superseded') &&
        candidate.state.conflictId === notified.conflictId,
    );
    const protection: ProtectionClass = entry?.protection ?? 'protected';
    // The current stored record (identical sides; possibly a resolution the
    // stream was not re-notified of — the explicit resolution's effect).
    const current = world.sync.conflicts.conflictOf(notified.conflictId) ?? notified;
    return conflictViewOf(current, protection);
  });
  return {
    ok: true,
    value: {
      kind: 'conflict-state-view',
      conflicts,
      unresolvedCount: conflicts.filter((conflict) => conflict.state === 'detected').length,
    },
  };
}

/** The typed unauthorized DomainError of the A12 session gate. */
const rejectionDomainError = (session: FieldSession): DomainError =>
  domainError(
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
  );

// ---------------------------------------------------------------------------
// THE typed explicit resolution command (the only exit — a USER ACTION).
// ---------------------------------------------------------------------------

/**
 * The typed input of the explicit resolution USER ACTION: the surfaced
 * conflict, the explicit strategy (sides in the record's canonical order),
 * the ledger events proving the reconciliation (>= 1 — a resolution without
 * an audit trail is typed-rejected), and the RECONCILED evidence attachment
 * whose mutation re-enters the queue discipline (the merged links with the
 * CURRENT expected version of the contested field event).
 */
export interface ResolveConflictInput {
  /** The surfaced conflict being resolved (the view's conflict id). */
  readonly conflictId: string;
  /** The explicit strategy (sides in the record's canonical order). */
  readonly strategy: ConflictResolutionStrategy;
  /**
   * Ledger events proving the reconciliation — at least one (typically the
   * diverging event the conflict's provenance names).
   */
  readonly auditEventRefs: readonly string[];
  /** The RECONCILED evidence attachment (the merged links, current version). */
  readonly reconciled: CaptureEvidenceAttachmentInput;
}

/** The displayable view of the explicit resolution's typed outcome. */
export interface ResolutionOutcomeView {
  /** 'resolved' — the resolution landed; 'rejected' — displayable. */
  readonly status: 'resolved' | 'rejected';
  readonly conflictId: string;
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedBy: string;
  /** The conflict's post-resolution state (null on rejection). */
  readonly conflict: {
    readonly state: 'detected' | 'resolved';
    readonly strategy: ConflictResolutionStrategy | null;
    readonly resolvedBy: string | null;
    readonly resolvedAt: Timestamp | null;
    readonly auditEventRefs: readonly string[];
  } | null;
  /** The re-entered queue entry (null on the idempotent no-op / rejection). */
  readonly entry: QueueEntryView | null;
  /** The re-entered entry's drain outcome (null on the no-op / rejection). */
  readonly outcome: { readonly status: 'applied' | 'rejected'; readonly eventId: string | null; readonly replayed: boolean | null } | null;
  /** The displayable rejection (null unless status is 'rejected'). */
  readonly rejection: RejectionView | null;
}

/**
 * THE explicit resolution — the ONLY exit from a PROTECTED conflict, typed
 * end to end as a USER ACTION: the field user names the surfaced conflict,
 * the explicit strategy, the ledger events proving the reconciliation, and
 * the RECONCILED evidence attachment (the merged links with the field
 * event's CURRENT version — the reconciliation of both sides). The engine
 * re-enters the reconciled mutation into the queue discipline (a fresh
 * deterministic operation id, the current causal token) and replays it
 * through the typed command path EXACTLY ONCE; an identical re-resolution
 * is the idempotent no-op. Rejections (unknown conflict, malformed ids, a
 * resolution without an audit trail, the domain's own typed gates) are
 * displayable view models — never throws.
 */
export async function resolveProtectedConflict(
  plane: FieldDataPlane,
  session: FieldSession,
  input: ResolveConflictInput,
  now: Timestamp,
): Promise<ResolutionOutcomeView> {
  const conflictId = parseConflictRecordId(input.conflictId);
  if (!conflictId.ok) {
    return resolutionRejected(input, 'invalid-conflict-id', input.conflictId);
  }
  const fieldEventId = parseEntityId(input.reconciled.fieldEventId);
  if (!fieldEventId.ok) {
    return resolutionRejected(input, 'invalid-field-event-id', input.reconciled.fieldEventId);
  }
  const evidence: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly revisionId: string;
  }[] = [];
  for (const [index, ref] of input.reconciled.evidence.entries()) {
    const entityId = parseEntityId(ref.entityId);
    if (!entityId.ok) {
      return resolutionRejected(
        input,
        'invalid-evidence-entity-id',
        `evidence[${index}]: ${ref.entityId}`,
      );
    }
    const revisionId = parseEntityId(ref.revisionId);
    if (!revisionId.ok) {
      return resolutionRejected(
        input,
        'invalid-revision-id',
        `evidence[${index}]: ${ref.revisionId}`,
      );
    }
    evidence.push({
      entityKind: ref.entityKind,
      entityId: entityId.value,
      revisionId: revisionId.value,
    });
  }
  const auditEventRefs: LedgerEventId[] = [];
  for (const ref of input.auditEventRefs) {
    const parsed = parseLedgerEventId(ref);
    if (!parsed.ok) {
      return resolutionRejected(input, 'invalid-audit-event-ref', ref);
    }
    auditEventRefs.push(parsed.value);
  }

  const command: ConflictResolutionCommand = {
    conflictId: conflictId.value,
    strategy: input.strategy,
    resolvedBy: session.actor,
    auditEventRefs,
    mutation: {
      commandName: ATTACH_FIELD_EVENT_EVIDENCE_COMMAND,
      scope: session.scope,
      actor: session.actor,
      correlationId: FIELD_SESSION_CORRELATION,
      issuedAt: now,
      payload: {
        fieldEventId: input.reconciled.fieldEventId,
        expectedVersion: input.reconciled.expectedVersion,
        evidence,
      },
      target: entityRefOf(FIELD_EVENT_KIND, fieldEventId.value),
      operationKind: ATTACH_FIELD_EVIDENCE_OPERATION_KIND,
      protection: 'protected',
      requiredCapability: WORK_CAPABILITY,
    },
  };

  const resolved = await plane.resolveConflict(command, now);
  if (!resolved.ok) {
    return {
      status: 'rejected',
      conflictId: input.conflictId,
      strategy: input.strategy,
      resolvedBy: session.actor.actorId,
      conflict: null,
      entry: null,
      outcome: null,
      rejection: rejectionViewOf(resolved.error),
    };
  }
  return resolutionViewOf(input, session, resolved.value, plane);
}

/**
 * The re-entered entry's CURRENT record: the report's entry is the
 * re-entry SNAPSHOT (state 'pending', its fresh operation id + causal
 * token), while the engine's own queue already carries the terminal state
 * the drain marked — the view projects the queue's current record (falling
 * back to the report's snapshot), never an invented state.
 */
const currentEntryOf = (plane: FieldDataPlane, entry: QueueEntry): QueueEntry =>
  plane.engine.queue.entries.find(
    (candidate) => candidate.operationId === entry.operationId,
  ) ?? entry;

/** Project the engine's resolution report into the displayable outcome view. */
const resolutionViewOf = (
  input: ResolveConflictInput,
  session: FieldSession,
  report: ConflictResolutionReport,
  plane: FieldDataPlane,
): ResolutionOutcomeView => ({
  status: 'resolved',
  conflictId: input.conflictId,
  strategy: input.strategy,
  resolvedBy: session.actor.actorId,
  conflict: {
    state: report.conflict.state,
    strategy: report.conflict.resolution?.strategy ?? null,
    resolvedBy:
      report.conflict.resolution?.resolvedBy.kind === 'user' &&
      typeof report.conflict.resolution.resolvedBy.actorId === 'string'
        ? report.conflict.resolution.resolvedBy.actorId
        : report.conflict.resolution?.resolvedBy.kind ?? null,
    resolvedAt: report.conflict.resolution?.resolvedAt ?? null,
    auditEventRefs: [...(report.conflict.resolution?.auditEventRefs ?? [])],
  },
  entry: report.entry === null ? null : queueEntryViewOf(currentEntryOf(plane, report.entry)),
  outcome:
    report.outcome === null
      ? null
      : report.outcome.status === 'applied'
        ? {
            status: 'applied',
            eventId: report.outcome.eventId,
            replayed: report.outcome.replayed,
          }
        : { status: 'rejected', eventId: null, replayed: null },
  rejection: null,
});

/** A typed INPUT rejection of the resolution action (displayable, never a throw). */
const resolutionRejected = (
  input: ResolveConflictInput,
  code: string,
  received: string,
): ResolutionOutcomeView => ({
  status: 'rejected',
  conflictId: input.conflictId,
  strategy: input.strategy,
  resolvedBy: '',
  conflict: null,
  entry: null,
  outcome: null,
  rejection: {
    code,
    message: `invalid canonical id '${received}'`,
    details: [{ code, message: received, path: null }],
  },
});
