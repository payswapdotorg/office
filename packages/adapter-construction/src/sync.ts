// Office adapter-construction — the multi-stream construction sync (OFF-021).
//
// The construction sync surface over the SDK's engine: runConstructionSync
// drives every declared object-kind stream (documents, RFIs, change events,
// observations — or the caller's subset) through runSync to exhaustion,
// resuming each stream from its persisted cursor, so one call performs a
// complete initial ingest OR an incremental catch-up:
//
//   - initial sync   — every stream starts at null cursor, pages to
//                      exhaustion, checkpoints each page;
//   - incremental    — later calls resume from the persisted cursors and
//                      observe only what the provider appended/mutated;
//   - restart-safe   — a crashed run restarted from the persisted cursor
//                      re-processes NOTHING already checkpointed (the
//                      adapter's positional tokens), and anything that does
//                      come back at-least-once no-ops through the SDK's
//                      SourceRef-derived command idempotency keys.
//
// The orchestrator owns no state of its own: mappings, cursors, conflicts,
// the canonical version lookup, the clock, and the id supplier are all
// injected (the same SyncEngineDeps ports runSync consumes). Same provider
// data + same cursors → same applications, mappings, conflicts, and proposed
// commands (determinism).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CommandEnvelope } from '@office/contracts';
import type {
  Adapter,
  AdapterAuthorization,
  AdapterCommandTranslator,
  AdapterJsonObject,
  Conflict,
  ProviderSystemId,
  ProviderObjectKind,
  SyncApplication,
  SyncCursor,
  SyncEngineDeps,
  SyncOutcome,
} from '@office/adapters-sdk';
import { runSync } from '@office/adapters-sdk';
import { CONSTRUCTION_OBJECT_KINDS } from './vocabulary';

/** Injected dependencies (the SDK engine ports, unchanged). */
export type ConstructionSyncDeps = SyncEngineDeps;

/** One runConstructionSync request. */
export interface ConstructionSyncRequest {
  readonly authorization: AdapterAuthorization;
  readonly adapter: Adapter;
  readonly translator: AdapterCommandTranslator;
  readonly systemId: ProviderSystemId;
  /** The object-kind streams to sync (defaults to ALL declared kinds). */
  readonly objectKinds?: readonly ProviderObjectKind[];
  /** Page size for every stream page (integer 1..SYNC_MAX_LIMIT). */
  readonly limit: number;
}

/** One object-kind stream's complete sync report. */
export interface ConstructionStreamReport {
  readonly kind: 'construction-stream-report';
  readonly objectKind: ProviderObjectKind;
  /** The per-page engine outcomes, in page order. */
  readonly runs: readonly SyncOutcome[];
  /** Every reconciled application, in provider stream order. */
  readonly applications: readonly SyncApplication[];
  /** Every conflict detected across the pages (both sides recorded). */
  readonly conflicts: readonly Conflict[];
  /** Every proposed command envelope, in proposal order. */
  readonly commands: readonly CommandEnvelope<AdapterJsonObject>[];
  /** The stream's effective cursor after the run (null when never advanced). */
  readonly cursor: SyncCursor | null;
}

/** The whole multi-stream sync report. */
export interface ConstructionSyncReport {
  readonly kind: 'construction-sync-report';
  readonly streams: readonly ConstructionStreamReport[];
}

/** Safety bound: pages per stream per call (a stuck provider cannot loop forever). */
const MAX_PAGES_PER_STREAM = 1000;

/**
 * Run the construction sync: every requested object-kind stream paged to
 * exhaustion through the SDK engine, resuming from the persisted cursors.
 * Every failure is a typed DomainError value; a failed stream aborts the
 * whole call (the runtime wraps calls in its own retry/transaction policy).
 */
export async function runConstructionSync(
  request: ConstructionSyncRequest,
  deps: ConstructionSyncDeps,
): Promise<Result<ConstructionSyncReport, DomainError>> {
  const objectKinds = request.objectKinds ?? CONSTRUCTION_OBJECT_KINDS;
  const streams: ConstructionStreamReport[] = [];
  for (const objectKind of objectKinds) {
    const synced = await syncOneStream(request, deps, objectKind);
    if (!synced.ok) return synced;
    streams.push(synced.value);
  }
  return ok({ kind: 'construction-sync-report', streams } satisfies ConstructionSyncReport);
}

/** Page one stream to exhaustion (local helper). */
const syncOneStream = async (
  request: ConstructionSyncRequest,
  deps: ConstructionSyncDeps,
  objectKind: ProviderObjectKind,
): Promise<Result<ConstructionStreamReport, DomainError>> => {
  const runs: SyncOutcome[] = [];
  const applications: SyncApplication[] = [];
  const conflicts: Conflict[] = [];
  const commands: CommandEnvelope<AdapterJsonObject>[] = [];
  let cursor: SyncCursor | null = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore) {
    if (pages >= MAX_PAGES_PER_STREAM) {
      return fail(
        domainError(
          'invariant-violation',
          `construction sync exceeded ${MAX_PAGES_PER_STREAM} pages on object kind '${objectKind}' — the provider keeps reporting more items; refusing to loop`,
          [{ code: 'sync-page-limit', message: objectKind, path: null }],
          { scope: { kind: 'tenant', tenantId: tenantOf(request) } },
        ),
      );
    }
    // The resume position: the stream's persisted cursor (the runtime's
    // restart point), or null on a fresh start.
    cursor = await deps.cursors.load(streamOf(request, objectKind));
    const run = await runSync(
      {
        authorization: request.authorization,
        adapter: request.adapter,
        translator: request.translator,
        systemId: request.systemId,
        objectKind,
        cursor,
        limit: request.limit,
      },
      deps,
    );
    if (!run.ok) return run;
    runs.push(run.value);
    applications.push(...run.value.applications);
    conflicts.push(...run.value.conflicts);
    for (const application of run.value.applications) {
      if (application.command !== null) commands.push(application.command);
    }
    hasMore = run.value.hasMore;
    pages += 1;
  }

  return ok({
    kind: 'construction-stream-report',
    objectKind,
    runs,
    applications,
    conflicts,
    commands,
    cursor: runs.at(-1)?.cursor ?? null,
  } satisfies ConstructionStreamReport);
};

const tenantOf = (request: ConstructionSyncRequest) =>
  request.authorization.context.scope.tenantId;

const streamOf = (request: ConstructionSyncRequest, objectKind: ProviderObjectKind) => ({
  tenantId: tenantOf(request),
  adapterKind: request.adapter.kind,
  systemId: request.systemId,
  objectKind,
});
