// Office adapter-finance — THE source-version-mapped, non-duplicating
// financial sync engine (OFF-024).
//
// THE named acceptance of this work item lives here: the same provider
// object version NEVER proposes a canonical command twice — whatever path it
// arrives through (a sync page re-delivery, an at-least-once webhook
// redelivery, an intra-page duplicate, or a cursor restart from an older
// position) — and EVERY duplicate attempt is counted and typed-deduplicated.
//
// The engine layers the SDK's runSync (authorization, capability checks,
// fail-closed snapshot parsing, stream-consistency guards, the mapping
// bookkeeping, the conflict branches, cursor checkpoints) under ONE new seam
// the financial acceptance requires: the PROVIDER VERSION LEDGER — the
// source-version mapping recording, per (tenant, provider coordinate,
// provider version), whether a canonical command was proposed from that
// exact version (carrying the command's idempotency key, which the SDK
// derives from the SourceRef + version) and how many times that version was
// observed. The ledger is written by BOTH intake paths (sync and webhook),
// so the two converge on exactly ONE proposal per source version.
//
// The dedup seam is `createVersionMappedSyncAdapter`: a filtering Adapter
// over the finance adapter whose sync() removes, from every pulled page, the
// snapshots of source versions the ledger already PROPOSED from (counting
// each removed snapshot as a duplicate observation). The SDK engine then
// reconciles only fresh versions — closing the one hole the SDK's own
// bookkeeping leaves open (a re-observed version whose canonical create has
// not executed yet would otherwise be re-proposed by the SDK's
// canonical-absent branch). Snapshots of versions that proposed NOTHING
// (conflicts, canonical-ahead no-ops) are never filtered: their branches are
// idempotent by construction (conflict re-detection appends the SAME derived
// id; no-op branches propose nothing).
//
// Replay safety is therefore three-layered, by design:
//   1. POSITIONAL — the adapter's continuation tokens resume AFTER the
//      checkpointed items: a cursor restart re-delivers nothing;
//   2. VERSION-MAPPED — even when a version DOES come back (at-least-once
//      redelivery, an older cursor, an intra-page duplicate), the ledger
//      turns it into a counted typed no-op: no second proposal, ever;
//   3. IDEMPOTENT KEYS — every proposal carries the SDK's SourceRef-derived
//      idempotency key (shared with the webhook path), so the command layer
//      converges even across engine boundaries.
//
// The orchestrator owns no state of its own: mappings, cursors, conflicts,
// the canonical version lookup, the clock, the id supplier, and the version
// ledger are all injected ports. Same provider data + same stores + same
// injected clock/id suppliers → the same mappings, cursors, conflicts,
// ledger, and proposed commands (determinism).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { CommandEnvelope, IdempotencyKey, TenantId, Timestamp } from '@office/contracts';
import { runSync } from '@office/adapters-sdk';
import type {
  Adapter,
  AdapterAuthorization,
  AdapterCommandTranslator,
  AdapterJsonObject,
  Conflict,
  ProviderObjectKind,
  ProviderSnapshot,
  ProviderSystemId,
  ProviderVersion,
  SourceCoordinate,
  SyncApplication,
  SyncCursor,
  SyncEngineDeps,
  SyncOutcome,
} from '@office/adapters-sdk';
import { coordinateOf, sourceCoordinateKeyOf, sourceRefKeyOf } from '@office/adapters-sdk';
import { FINANCE_OBJECT_KINDS } from './vocabulary';

// ---- THE source-version ledger ------------------------------------------------

/** One ledger entry: one exact (tenant, coordinate, version) observation. */
export interface VersionLedgerEntry {
  readonly kind: 'version-ledger-entry';
  /** Owning tenant (freeze A12 — foreign tenants' entries are invisible). */
  readonly tenantId: TenantId;
  /** The provider object's stable identity (version-less). */
  readonly coordinate: SourceCoordinate;
  /** The exact provider version this entry records. */
  readonly version: ProviderVersion;
  /**
   * The idempotency key of the canonical command proposed from this exact
   * source version (the SDK's SourceRef-derived key — identical across the
   * sync and webhook paths), or null when no command was proposed (conflict
   * or no-op observations). Once non-null, never reverts: a version proposes
   * at most once, ever.
   */
  readonly proposalKey: IdempotencyKey | null;
  /** When this version was first observed (injected clock). */
  readonly firstObservedAt: Timestamp;
  /** When this version was last observed (injected clock). */
  readonly lastObservedAt: Timestamp;
  /**
   * Total observations of this exact source version through the finance
   * engines (1 = only the original; every duplicate attempt increments).
   */
  readonly observationCount: number;
}

/**
 * THE source-version ledger port. Implementations MUST key every operation
 * by tenant first (A12: a foreign tenant's entry is indistinguishable from
 * absence). The SQL implementation belongs to the runtime, not this package.
 */
export interface ProviderVersionLedger {
  /** The entry of one exact (coordinate, version), or null when never observed. */
  find(
    tenantId: TenantId,
    coordinate: SourceCoordinate,
    version: ProviderVersion,
  ): Promise<VersionLedgerEntry | null>;
  /** The tenant's entries for one coordinate, in first-observation order. */
  listByCoordinate(
    tenantId: TenantId,
    coordinate: SourceCoordinate,
  ): Promise<readonly VersionLedgerEntry[]>;
  /**
   * Observe one exact source version (the engines' only write): creates the
   * entry on first observation, or increments the observation count on
   * re-observation. A null `proposalKey` never overwrites a recorded key; a
   * NON-null key that differs from the recorded one is a typed
   * invariant-violation (the same source version deterministically derives
   * the same command key — a divergence is a determinism defect, never
   * silently absorbed).
   */
  observe(parts: {
    readonly tenantId: TenantId;
    readonly coordinate: SourceCoordinate;
    readonly version: ProviderVersion;
    readonly proposalKey: IdempotencyKey | null;
    readonly observedAt: Timestamp;
  }): Promise<Result<VersionLedgerEntry, DomainError>>;
}

/** Deterministic in-memory ProviderVersionLedger (the package's test fixture). */
export function createInMemoryProviderVersionLedger(): ProviderVersionLedger {
  const entries = new Map<string, VersionLedgerEntry>();
  const byCoordinate = new Map<string, VersionLedgerEntry[]>();
  const entryKey = (tenantId: TenantId, coordinate: SourceCoordinate, version: ProviderVersion) =>
    `${tenantId}|${sourceCoordinateKeyOf(coordinate)}|${version}`;
  const coordinateKey = (tenantId: TenantId, coordinate: SourceCoordinate) =>
    `${tenantId}|${sourceCoordinateKeyOf(coordinate)}`;
  return {
    async find(tenantId, coordinate, version) {
      return entries.get(entryKey(tenantId, coordinate, version)) ?? null;
    },
    async listByCoordinate(tenantId, coordinate) {
      return [...(byCoordinate.get(coordinateKey(tenantId, coordinate)) ?? [])];
    },
    async observe(parts) {
      const key = entryKey(parts.tenantId, parts.coordinate, parts.version);
      const existing = entries.get(key);
      if (existing === undefined) {
        const entry: VersionLedgerEntry = {
          kind: 'version-ledger-entry',
          tenantId: parts.tenantId,
          coordinate: parts.coordinate,
          version: parts.version,
          proposalKey: parts.proposalKey,
          firstObservedAt: parts.observedAt,
          lastObservedAt: parts.observedAt,
          observationCount: 1,
        };
        entries.set(key, entry);
        const list = byCoordinate.get(coordinateKey(parts.tenantId, parts.coordinate)) ?? [];
        byCoordinate.set(coordinateKey(parts.tenantId, parts.coordinate), [...list, entry]);
        return ok(entry);
      }
      if (
        parts.proposalKey !== null &&
        existing.proposalKey !== null &&
        existing.proposalKey !== parts.proposalKey
      ) {
        return fail(
          domainError(
            'invariant-violation',
            `source version ${parts.coordinate.objectType} ${parts.coordinate.objectId} ${parts.version} already proposed command key ${existing.proposalKey} and a new observation derives ${parts.proposalKey} — the same source version deterministically derives ONE command key`,
            [
              {
                code: 'version-ledger-key-divergence',
                message: `${existing.proposalKey} vs ${parts.proposalKey}`,
                path: 'proposalKey',
              },
            ],
            { scope: { kind: 'tenant', tenantId: parts.tenantId } },
          ),
        );
      }
      const advanced: VersionLedgerEntry = {
        ...existing,
        proposalKey: existing.proposalKey ?? parts.proposalKey,
        lastObservedAt: parts.observedAt,
        observationCount: existing.observationCount + 1,
      };
      entries.set(key, advanced);
      const list = byCoordinate.get(coordinateKey(parts.tenantId, parts.coordinate)) ?? [];
      byCoordinate.set(
        coordinateKey(parts.tenantId, parts.coordinate),
        list.map((entry) => (entry === existing ? advanced : entry)),
      );
      return ok(advanced);
    },
  };
}

// ---- the version-mapped (deduplicating) adapter seam --------------------------

/** Why one snapshot was tallied as a duplicate observation. */
export type DuplicateObservationReason = 'ledger' | 'intra-page';

/** One duplicate observation of an already-proposed source version (counted). */
export interface DuplicateVersionObservation {
  readonly kind: 'duplicate-version-observation';
  /** The re-delivered snapshot (full provenance). */
  readonly snapshot: SyncApplication['snapshot'];
  /** Whether the ledger already carried the proposal, or the same page re-delivered it. */
  readonly reason: DuplicateObservationReason;
}

/**
 * The deduplicating Adapter seam: wraps the finance adapter so every page
 * handed to the SDK engine contains only snapshots of source versions the
 * ledger has NOT proposed from yet. Removed snapshots are tallied (in page
 * order) and counted by the engine through the ledger's observe() — the
 * typed-deduplicated surface of THE acceptance.
 */
export interface VersionMappedAdapter {
  /** The filtering Adapter (same kind/capabilities/lifecycle as the inner one). */
  readonly adapter: Adapter;
  /** The duplicates tallied since the last drain, in page order. */
  drainDuplicates(): readonly DuplicateVersionObservation[];
}

/**
 * Create the version-mapped adapter over one injected adapter + ledger. The
 * wrapper performs no writes: the LEDGER lookups are reads; the engine (or
 * the webhook ingest) performs the observations after the SDK engine
 * reconciles the page.
 */
export function createVersionMappedSyncAdapter(parts: {
  readonly adapter: Adapter;
  readonly ledger: ProviderVersionLedger;
}): VersionMappedAdapter {
  const duplicates: DuplicateVersionObservation[] = [];
  let seenInPage = new Set<string>();
  const inner = parts.adapter;
  return {
    adapter: {
      kind: inner.kind,
      capabilities: inner.capabilities,
      connect: (request) => inner.connect(request),
      healthCheck: (request) => inner.healthCheck(request),
      disconnect: (request) => inner.disconnect(request),
      async sync(request) {
        const pulled = await inner.sync(request);
        if (!pulled.ok) return pulled;
        const fresh: ProviderSnapshot[] = [];
        for (const snapshot of pulled.value.snapshots) {
          const entry = await parts.ledger.find(
            request.tenantId,
            coordinateOf(snapshot.source),
            snapshot.source.version,
          );
          if (entry !== null && entry.proposalKey !== null) {
            duplicates.push({
              kind: 'duplicate-version-observation',
              snapshot,
              reason: 'ledger',
            });
            continue;
          }
          const refKey = sourceRefKeyOf(snapshot.source);
          if (seenInPage.has(refKey)) {
            duplicates.push({
              kind: 'duplicate-version-observation',
              snapshot,
              reason: 'intra-page',
            });
            continue;
          }
          seenInPage.add(refKey);
          fresh.push(snapshot);
        }
        return ok({ ...pulled.value, snapshots: fresh });
      },
    },
    drainDuplicates() {
      const drained = [...duplicates];
      duplicates.length = 0;
      seenInPage = new Set<string>();
      return drained;
    },
  };
}

// ---- the engine ----------------------------------------------------------------

/** Injected dependencies: the SDK engine ports + THE version ledger. */
export interface FinanceSyncDeps extends SyncEngineDeps {
  readonly ledger: ProviderVersionLedger;
}

/** One runFinanceSync request. */
export interface FinanceSyncRequest {
  readonly authorization: AdapterAuthorization;
  readonly adapter: Adapter;
  readonly translator: AdapterCommandTranslator;
  readonly systemId: ProviderSystemId;
  /** The object-kind streams to sync (defaults to ALL declared kinds, in the finance family order). */
  readonly objectKinds?: readonly ProviderObjectKind[];
  /** Page size for every stream page (integer 1..SYNC_MAX_LIMIT). */
  readonly limit: number;
}

/** One object-kind stream's complete sync report. */
export interface FinanceStreamReport {
  readonly kind: 'finance-stream-report';
  readonly objectKind: ProviderObjectKind;
  /** The per-page engine outcomes, in page order. */
  readonly runs: readonly SyncOutcome[];
  /** Every reconciled application, in provider stream order across pages. */
  readonly applications: readonly SyncApplication[];
  /** Every duplicate observation tallied across the pages (THE counting surface). */
  readonly duplicates: readonly DuplicateVersionObservation[];
  /** Every conflict detected across the pages (both sides recorded). */
  readonly conflicts: readonly Conflict[];
  /** Every proposed command envelope, in proposal order. */
  readonly commands: readonly CommandEnvelope<AdapterJsonObject>[];
  /** The stream's effective cursor after the run (null when never advanced). */
  readonly cursor: SyncCursor | null;
}

/** THE dedup summary: every path through the engine, counted. */
export interface FinanceSyncCounts {
  /** Snapshots the engine observed (applications + duplicates). */
  readonly snapshotsObserved: number;
  /** Canonical command proposals composed (at most one per source version, ever). */
  readonly proposals: number;
  /** Applications that established a new mapping + create proposal. */
  readonly mappedCreated: number;
  /** Applications that proposed an update. */
  readonly appliedUpdates: number;
  /** Applications that proposed a deletion. */
  readonly appliedDeletions: number;
  /** Duplicate observations typed-deduplicated (no proposal, counted). */
  readonly duplicateDeduplicated: number;
  /** SDK replay no-ops (same version, canonical quiet, nothing proposed). */
  readonly replayNoOps: number;
  /** Canonical-ahead no-ops (canonical moved, provider quiet). */
  readonly canonicalAhead: number;
  /** Divergences recorded as explicit conflicts (both sides; never auto-resolved). */
  readonly conflictsDetected: number;
  /** Deletions of never-mapped sources (nothing to delete). */
  readonly orphanDeletionsSkipped: number;
}

/** The whole multi-stream finance sync report. */
export interface FinanceSyncReport {
  readonly kind: 'finance-sync-report';
  /** Per-stream reports, in the requested (or finance family) order. */
  readonly streams: readonly FinanceStreamReport[];
  /** Every proposed canonical command, in stream + provider order. */
  readonly commands: readonly CommandEnvelope<AdapterJsonObject>[];
  /** Every conflict detected, in stream + provider order. */
  readonly conflicts: readonly Conflict[];
  /** Every duplicate observation, in stream + provider order. */
  readonly duplicates: readonly DuplicateVersionObservation[];
  /** THE counts. */
  readonly counts: FinanceSyncCounts;
}

/** Safety bound: pages per stream per call (a stuck provider cannot loop forever). */
export const MAX_SYNC_PAGES_PER_STREAM = 1000;

/**
 * Run the finance sync: every requested object-kind stream (default: the
 * finance family order — accounts, cost codes, commitments, invoices,
 * payments, so parent mappings exist before children reference them) paged
 * to exhaustion through the SDK engine under the version-mapped adapter,
 * resuming each stream from its persisted cursor. Every failure is a typed
 * DomainError value; a failed stream aborts the whole call (the runtime
 * wraps calls in its own retry/transaction policy).
 */
export async function runFinanceSync(
  request: FinanceSyncRequest,
  deps: FinanceSyncDeps,
): Promise<Result<FinanceSyncReport, DomainError>> {
  const objectKinds = request.objectKinds ?? FINANCE_OBJECT_KINDS;
  const tenantId = request.authorization.context.scope.tenantId;
  const wrapped = createVersionMappedSyncAdapter({
    adapter: request.adapter,
    ledger: deps.ledger,
  });
  const streams: FinanceStreamReport[] = [];
  const commands: CommandEnvelope<AdapterJsonObject>[] = [];
  const conflicts: Conflict[] = [];
  const duplicates: DuplicateVersionObservation[] = [];
  const counts = {
    snapshotsObserved: 0,
    proposals: 0,
    mappedCreated: 0,
    appliedUpdates: 0,
    appliedDeletions: 0,
    duplicateDeduplicated: 0,
    replayNoOps: 0,
    canonicalAhead: 0,
    conflictsDetected: 0,
    orphanDeletionsSkipped: 0,
  };

  for (const objectKind of objectKinds) {
    const synced = await syncOneStream({
      request,
      deps,
      wrapped,
      objectKind,
      tenantId,
    });
    if (!synced.ok) return synced;
    streams.push(synced.value);
    commands.push(...synced.value.commands);
    conflicts.push(...synced.value.conflicts);
    duplicates.push(...synced.value.duplicates);
    for (const application of synced.value.applications) {
      counts.snapshotsObserved += 1;
      if (application.command !== null) counts.proposals += 1;
      switch (application.outcome) {
        case 'mapped-created':
          counts.mappedCreated += 1;
          break;
        case 'applied-update':
          counts.appliedUpdates += 1;
          break;
        case 'applied-deletion':
          counts.appliedDeletions += 1;
          break;
        case 'replay-no-op':
          counts.replayNoOps += 1;
          break;
        case 'canonical-ahead':
          counts.canonicalAhead += 1;
          break;
        case 'conflict-detected':
          counts.conflictsDetected += 1;
          break;
        case 'orphan-deletion-skipped':
          counts.orphanDeletionsSkipped += 1;
          break;
      }
    }
    counts.snapshotsObserved += synced.value.duplicates.length;
    counts.duplicateDeduplicated += synced.value.duplicates.length;
  }

  return ok({
    kind: 'finance-sync-report',
    streams,
    commands,
    conflicts,
    duplicates,
    counts,
  } satisfies FinanceSyncReport);
}

/** Page one stream to exhaustion (local helper). */
const syncOneStream = async (parts: {
  readonly request: FinanceSyncRequest;
  readonly deps: FinanceSyncDeps;
  readonly wrapped: VersionMappedAdapter;
  readonly objectKind: ProviderObjectKind;
  readonly tenantId: TenantId;
}): Promise<Result<FinanceStreamReport, DomainError>> => {
  const { request, deps, wrapped, objectKind, tenantId } = parts;
  const runs: SyncOutcome[] = [];
  const applications: SyncApplication[] = [];
  const streamConflicts: Conflict[] = [];
  const streamCommands: CommandEnvelope<AdapterJsonObject>[] = [];
  const streamDuplicates: DuplicateVersionObservation[] = [];
  let cursor: SyncCursor | null = null;
  let hasMore = true;
  let pages = 0;

  while (hasMore) {
    if (pages >= MAX_SYNC_PAGES_PER_STREAM) {
      return fail(
        domainError(
          'invariant-violation',
          `finance sync exceeded ${MAX_SYNC_PAGES_PER_STREAM} pages on object kind '${objectKind}' — the provider keeps reporting more items; refusing to loop`,
          [{ code: 'finance-sync-page-limit', message: objectKind, path: null }],
          { scope: { kind: 'tenant', tenantId } },
        ),
      );
    }
    // The resume position: the stream's persisted cursor (the runtime's
    // restart point), or null on a fresh start.
    cursor = await deps.cursors.load(streamOf(request, objectKind));
    const run = await runSync(
      {
        authorization: request.authorization,
        adapter: wrapped.adapter,
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
    streamConflicts.push(...run.value.conflicts);
    for (const application of run.value.applications) {
      if (application.command !== null) streamCommands.push(application.command);
    }

    // THE ledger bookkeeping for this page: every applied snapshot is
    // observed (with its proposal's key when one was composed), and every
    // duplicate the wrapper tallied is observed as a re-observation (the
    // counting surface — the entry exists: its twin was applied this page,
    // or the ledger already carried it).
    const now = deps.now();
    for (const application of run.value.applications) {
      const observed = await deps.ledger.observe({
        tenantId,
        coordinate: coordinateOf(application.snapshot.source),
        version: application.snapshot.source.version,
        proposalKey: application.command !== null ? application.command.idempotencyKey : null,
        observedAt: now,
      });
      if (!observed.ok) return observed;
    }
    for (const duplicate of wrapped.drainDuplicates()) {
      const observed = await deps.ledger.observe({
        tenantId,
        coordinate: coordinateOf(duplicate.snapshot.source),
        version: duplicate.snapshot.source.version,
        proposalKey: null,
        observedAt: now,
      });
      if (!observed.ok) return observed;
      streamDuplicates.push(duplicate);
    }

    hasMore = run.value.hasMore;
    cursor = run.value.cursor;
    pages += 1;
  }

  return ok({
    kind: 'finance-stream-report',
    objectKind,
    runs,
    applications,
    duplicates: streamDuplicates,
    conflicts: streamConflicts,
    commands: streamCommands,
    cursor: runs.at(-1)?.cursor ?? null,
  } satisfies FinanceStreamReport);
};

const streamOf = (request: FinanceSyncRequest, objectKind: ProviderObjectKind) => ({
  tenantId: request.authorization.context.scope.tenantId,
  adapterKind: request.adapter.kind,
  systemId: request.systemId,
  objectKind,
});
