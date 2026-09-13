// Office field/offline web client — the field board read surface (OFF-031).
//
// The field session's DISPLAYABLE view of the field world: THE project board
// (the project header + the recent field observations + the open issues,
// folded from the session's OWN consumed event stream through the field
// domain's public read model — the client's view of ONE project state, A11:
// a VIEW, never a second source of truth) and the single field-event view
// (the reconciled state of one contested observation, read through the
// field store's A12-scoped load).
//
// Both views are pure, deterministic projections: the same world + the same
// session + the same consumed stream always project the byte-identical view
// (A7 — run-twice identical). Reads are fail-closed and A12-gated by the
// LANDED read surfaces themselves: a foreign tenant's row is a typed
// not-found (no existence oracle) and a same-tenant/foreign-project row is a
// typed unauthorized (the store's second boundary) — typed Results, never
// throws, never partial data.
import { FIELD_EVENT_NAMES, createProjectReadModel } from '@office/domain-field';
import type { FieldEventSummary, OpenIssueRecord } from '@office/domain-field';
import type { Timestamp } from '@office/contracts';
import { parseEntityId } from '@office/contracts';
import type { DomainError, Result } from '@office/domain-kernel';
import type { LedgerEvent } from '@office/events';
import type { SeededFieldWorld } from '../session/world';
import type { FieldDataPlane } from '../session/stream';
import type { FieldSession } from '../session/session';

/**
 * The structural read executor the identity repositories read with (an
 * opaque handle — the in-memory repositories ignore it; a real runtime's
 * repository binds its connection through it). Structural typing keeps the
 * persistence package OUT of this app entirely (not even TYPE-ONLY).
 */
const readExecutor = { query: async () => ({ rows: [], rowCount: 0 }) } as const;

/** The displayable view of ONE field observation (the reconciled state). */
export interface FieldEventView {
  readonly kind: 'field-event-view';
  readonly fieldEventId: string;
  /** Lifecycle status ('resolved' is terminal). */
  readonly status: 'open' | 'resolved';
  /** The aggregate's optimistic-concurrency version (the causal basis). */
  readonly version: number;
  readonly category: string;
  readonly summary: string;
  readonly location: string;
  /** When it was observed (CLIENT clock — data, not ordering authority). */
  readonly observedAt: Timestamp;
  readonly observedBy: string;
  /** The append-only evidence links (both sides after a reconciled merge). */
  readonly evidence: readonly {
    readonly entityKind: string;
    readonly entityId: string;
    readonly revisionId: string;
  }[];
}

/**
 * Project ONE field observation into its displayable view through the field
 * store's A12-scoped load: the session's scope decides visibility (a foreign
 * tenant's aggregate is a typed not-found with no existence oracle; a
 * same-tenant/foreign-project aggregate is a typed unauthorized — the second
 * boundary). Malformed ids are typed input rejections. Never a throw.
 */
export function fieldEventView(
  world: SeededFieldWorld,
  session: FieldSession,
  fieldEventId: string,
): Result<FieldEventView, DomainError | { readonly code: string; readonly received: string }> {
  const id = parseEntityId(fieldEventId);
  if (!id.ok) {
    return { ok: false, error: { code: 'invalid-field-event-id', received: fieldEventId } };
  }
  const loaded = world.stores.field.findFieldEvent(session.scope, id.value);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const state = loaded.value;
  return {
    ok: true,
    value: {
      kind: 'field-event-view',
      fieldEventId: state.entityId,
      status: state.status,
      version: state.version,
      category: state.category,
      summary: state.summary,
      location: state.location,
      observedAt: state.observedAt,
      observedBy: state.observedBy,
      evidence: state.evidence.map((ref) => ({
        entityKind: ref.entityKind,
        entityId: ref.entityId,
        revisionId: ref.revisionId,
      })),
    },
  };
}

/** The field session's project board view (its own view of ONE project state). */
export interface FieldBoardView {
  readonly kind: 'field-board-view';
  readonly projectId: string;
  readonly projectName: string;
  readonly projectStatus: string;
  /** The recent field observations, newest capture first (the fold's order). */
  readonly recentFieldEvents: readonly FieldEventSummary[];
  /** The currently-open issues, in raise order. */
  readonly openIssues: readonly OpenIssueRecord[];
}

/**
 * Does this ledger event belong to the field domain's event vocabulary (the
 * board folds ONLY the field domain's envelopes — the identity events in
 * the stream are not the board's inputs)?
 */
const isFieldEvent = (event: LedgerEvent): boolean =>
  (FIELD_EVENT_NAMES as readonly string[]).includes(event.envelope.eventName);

/**
 * Project THE field board view: the project header (the identity package's
 * A12-scoped repository load) + the recent observations and open issues
 * folded from the session's OWN consumed event stream through the field
 * domain's public read model (createProjectReadModel — the same projection
 * the runtime folds from the ledger). The board is therefore exactly what
 * the session has CONSUMED — after a reconnect + synchronize it reflects the
 * reconciled state, because the client's own stream carries it (A11/A12).
 *
 * Deterministic: the same consumed stream always folds the same board (A7).
 * Fail-closed: a foreign session's project load is a typed not-found (both
 * directions — the repository's A12 visibility, no existence oracle); a
 * fold failure is a typed invariant violation (never a partial board).
 */
export async function fieldBoardView(
  world: SeededFieldWorld,
  session: FieldSession,
  plane: FieldDataPlane,
): Promise<Result<FieldBoardView, DomainError | { readonly code: string; readonly received: string }>> {
  const project = await world.stores.projects.findById(readExecutor, session.scope, session.projectId);
  if (!project.ok) return { ok: false, error: project.error };
  const readModel = createProjectReadModel();
  for (const event of plane.consumedEvents) {
    if (!isFieldEvent(event)) continue;
    const folded = readModel.apply(event.envelope);
    if (!folded.ok) return { ok: false, error: folded.error };
  }
  return {
    ok: true,
    value: {
      kind: 'field-board-view',
      projectId: project.value.entityId,
      projectName: project.value.name,
      projectStatus: project.value.status,
      recentFieldEvents: readModel.recentFieldEvents(session.projectId, 20),
      openIssues: readModel.openIssues(session.projectId),
    },
  };
}
