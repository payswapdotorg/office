// Office adapter-schedule — the multi-stream schedule sync driver (OFF-023).
//
// An orchestration over the OFF-020 SDK's sync engine with THE typed
// conflict rules layered in:
//
//   1. runScheduleSync drives one page-or-exhausted pass of every declared
//      schedule object-kind stream — in the SCHEDULE HIERARCHY order (the
//      project schedule first, then its activities, then the dependency
//      links between them, then the baselines) — so parent mappings are
//      established before children reference them, with per-stream cursors
//      persisted through the SDK's cursor store (positional restart safety)
//      and replay safety layered on the SourceRef-derived command
//      idempotency keys (the same provider object version never proposes
//      twice);
//   2. after the project-schedule stream (whose mapping the divergence
//      detection needs), the PRE-FLIGHT pass runs the conflict rules over
//      the injected provider divergence view: dependency-cycle
//      introductions and in-place baseline re-baselining attempts are
//      recorded as explicit Conflict records (both sides, never
//      auto-resolved) and QUARANTINED — their provider objects are filtered
//      from the activity-dependency and baseline streams of THIS run, so no
//      mapping is created or advanced and NO command is ever proposed for a
//      divergent provider change (the canonical side stays untouched until
//      the conflict is resolved explicitly);
//   3. every conflict the run produced — the engine's own both-sides-moved
//      divergences (the concurrent activity-date change rule) AND the
//      quarantined divergences — is classified with its typed rule kind in
//      the outcome (conflictRules), so the runtime sees WHICH named rule
//      fired for every record.
//
// No engine logic is reimplemented here: every page goes through the SDK's
// runSync (authorization, cursor membership, fail-closed snapshot parsing,
// stream-consistency guards, the full reconcile branches), and this module
// only sequences the streams, runs the pre-flight detection, applies the
// quarantine, and aggregates the outcomes. Deterministic: same provider
// data, same stores, same injected clock/id suppliers → the same mappings,
// cursors, conflicts, and command proposals.
import { runSync } from '@office/adapters-sdk';
import type {
  Adapter,
  AdapterAuthorization,
  AdapterCommandTranslator,
  AdapterJsonObject,
  Conflict,
  ConflictId,
  ProviderObjectKind,
  ProviderSystemId,
  SyncApplication,
  SyncCursor,
  SyncEngineDeps,
  SyncOutcome,
} from '@office/adapters-sdk';
import type { CommandEnvelope } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { SCHEDULE_OBJECT_FAMILY, ACTIVITY_DEPENDENCY_OBJECT_KIND, ACTIVITY_OBJECT_KIND, BASELINE_OBJECT_KIND } from './vocabulary';
import type { ScheduleDivergenceView } from './conflict-rules';
import {
  classifyScheduleConflict,
  detectScheduleDivergences,
} from './conflict-rules';
import type {
  DetectedScheduleDivergence,
  ScheduleConflictKind,
} from './conflict-rules';

/** Defensive bound on pages pulled per stream per run (typed failure past it). */
export const MAX_SYNC_PAGES_PER_STREAM = 1000;

/** One object-kind stream's aggregated outcome across its pages. */
export interface ScheduleSyncStreamOutcome {
  /** The stream's object kind. */
  readonly objectKind: ProviderObjectKind;
  /** Per-snapshot reconciliation, in provider stream order across pages. */
  readonly applications: readonly SyncApplication[];
  /** The conflicts detected by this run on this stream (detected state, both sides). */
  readonly conflicts: readonly Conflict[];
  /** The stream's effective cursor after the run (null when never advanced). */
  readonly cursor: SyncCursor | null;
  /** Whether the provider reports more items past the run's position. */
  readonly hasMore: boolean;
}

/** One conflict's typed classification in the run's outcome. */
export interface ScheduleConflictClassification {
  /** The conflict record's deterministic id. */
  readonly conflictId: ConflictId;
  /** Which named schedule conflict rule fired. */
  readonly kind: ScheduleConflictKind;
  /**
   * Whether the divergent provider object was QUARANTINED by the pre-flight
   * rules (true) or detected by the engine's both-sides-moved branch (false).
   */
  readonly quarantined: boolean;
}

/** The whole runScheduleSync result. */
export interface ScheduleSyncOutcome {
  /** Per-stream outcomes, in the schedule hierarchy (canonical) stream order. */
  readonly streams: readonly ScheduleSyncStreamOutcome[];
  /** Every proposed canonical command, in stream + provider order. */
  readonly commands: readonly CommandEnvelope<AdapterJsonObject>[];
  /** Every conflict detected by the run, in stream + provider order. */
  readonly conflicts: readonly Conflict[];
  /** Every conflict's typed rule classification, in conflict order. */
  readonly conflictRules: readonly ScheduleConflictClassification[];
}

/**
 * The quarantining wrapper over the base adapter: one object kind's page
 * results have every quarantined provider object's snapshots REMOVED before
 * the engine sees them. The underlying positional cursor token, checkpoint,
 * and hasMore are preserved, so every provider object is still visited
 * exactly once per run — the quarantined ones are simply never delivered to
 * the reconcile loop (no mapping, no proposal, no canonical write).
 */
const quarantiningAdapter = (
  base: Adapter,
  quarantined: ReadonlyMap<ProviderObjectKind, ReadonlySet<string>>,
): Adapter => ({
  ...base,
  async sync(request) {
    const pulled = await base.sync(request);
    if (!pulled.ok) return pulled;
    const excluded = quarantined.get(request.objectKind);
    if (excluded === undefined || excluded.size === 0) return pulled;
    const snapshots = pulled.value.snapshots.filter(
      (snapshot) => !excluded.has(snapshot.source.objectId),
    );
    return ok({ ...pulled.value, snapshots });
  },
});

/**
 * Run one schedule sync pass: for each declared object-kind stream, in the
 * schedule hierarchy order (project-schedule, activity, activity-dependency,
 * baseline — parents map before children), pull pages through the SDK's
 * runSync engine until the stream is exhausted (or the page bound trips, a
 * typed invariant-violation — never an unbounded loop). After the
 * project-schedule stream, the typed conflict rules' pre-flight detection
 * runs over the injected divergence view: detected divergences are recorded
 * as explicit Conflicts and their provider objects quarantined from the
 * dependency and baseline streams. Every failure is a typed DomainError,
 * propagated as-is: a failed stream stops the whole run with nothing from
 * later streams applied.
 */
export async function runScheduleSync(
  request: {
    readonly authorization: AdapterAuthorization;
    readonly adapter: Adapter;
    readonly translator: AdapterCommandTranslator;
    readonly systemId: ProviderSystemId;
    /** Page size: integer 1..SYNC_MAX_LIMIT (the engine validates). */
    readonly limit: number;
    /**
     * The injected provider divergence view (the conflict rules' pre-flight
     * port — the adapter's own view of the provider's dependencies and
     * baselines; the deterministic fixture derives it, the runtime wires the
     * real provider client's data into it).
     */
    readonly divergenceView: ScheduleDivergenceView;
  },
  deps: SyncEngineDeps,
): Promise<Result<ScheduleSyncOutcome, DomainError>> {
  const streams: ScheduleSyncStreamOutcome[] = [];
  const commands: CommandEnvelope<AdapterJsonObject>[] = [];
  const conflicts: Conflict[] = [];
  const classifications: ScheduleConflictClassification[] = [];

  // The pre-flight divergence pass runs once the project-schedule stream has
  // established the schedule mapping the detection records against. Its
  // quarantines apply to the activity-dependency and baseline streams below.
  let divergences: readonly DetectedScheduleDivergence[] = [];

  const recordDivergences = async (): Promise<Result<undefined, DomainError>> => {
    const detected = await detectScheduleDivergences({
      tenantId: request.authorization.context.scope.tenantId,
      adapterKind: request.adapter.kind,
      systemId: request.systemId,
      view: request.divergenceView,
      mappings: deps.mappings,
      canonicalVersionOf: deps.canonicalVersionOf,
      actor: request.authorization.context.actor,
      now: deps.now(),
    });
    if (!detected.ok) return detected;
    divergences = detected.value;
    for (const divergence of divergences) {
      // Detection composes the record; the driver persists it — an idempotent
      // append (conflict ids are derived from both sides, so re-detection of
      // the same divergence is a no-op in the store).
      const appended = await deps.conflicts.append(divergence.conflict);
      if (!appended.ok) return appended;
      conflicts.push(appended.value);
      classifications.push({
        conflictId: appended.value.conflictId,
        kind: divergence.rule,
        quarantined: true,
      });
    }
    return ok(undefined);
  };

  const quarantine = (): ReadonlyMap<ProviderObjectKind, ReadonlySet<string>> => {
    const byKind = new Map<ProviderObjectKind, ReadonlySet<string>>();
    const dependencies = new Set<string>();
    const baselines = new Set<string>();
    for (const divergence of divergences) {
      if (divergence.quarantinedObjectKind === 'activity-dependency') {
        dependencies.add(divergence.quarantinedObjectId);
      } else {
        baselines.add(divergence.quarantinedObjectId);
      }
    }
    if (dependencies.size > 0) byKind.set(ACTIVITY_DEPENDENCY_OBJECT_KIND, dependencies);
    if (baselines.size > 0) byKind.set(BASELINE_OBJECT_KIND, baselines);
    return byKind;
  };

  // SCHEDULE_OBJECT_FAMILY's first member is the project-schedule root (the
  // schedule hierarchy discipline): parents map before children, so the
  // pre-flight pass after that stream always finds the schedule mapping.
  for (const objectKind of SCHEDULE_OBJECT_FAMILY) {
    if (objectKind === ACTIVITY_OBJECT_KIND) {
      const recorded = await recordDivergences();
      if (!recorded.ok) return recorded;
    }

    const effectiveAdapter =
      objectKind === ACTIVITY_DEPENDENCY_OBJECT_KIND || objectKind === BASELINE_OBJECT_KIND
        ? quarantiningAdapter(request.adapter, quarantine())
        : request.adapter;

    const applications: SyncApplication[] = [];
    const streamConflicts: Conflict[] = [];
    let cursor: SyncCursor | null = null;
    let hasMore = false;

    for (let page = 0; page < MAX_SYNC_PAGES_PER_STREAM; page += 1) {
      const run = await runSync(
        {
          authorization: request.authorization,
          adapter: effectiveAdapter,
          translator: request.translator,
          systemId: request.systemId,
          objectKind,
          cursor,
          limit: request.limit,
        },
        deps,
      );
      if (!run.ok) return run;
      const outcome: SyncOutcome = run.value;
      applications.push(...outcome.applications);
      for (const application of outcome.applications) {
        if (application.command !== null) commands.push(application.command);
      }
      streamConflicts.push(...outcome.conflicts);
      conflicts.push(...outcome.conflicts);
      cursor = outcome.cursor;
      hasMore = outcome.hasMore;
      if (!outcome.hasMore) break;
    }

    if (hasMore) {
      return fail(
        domainError(
          'invariant-violation',
          `the '${objectKind}' stream still reports more items after ${MAX_SYNC_PAGES_PER_STREAM} pages of ${request.limit} — refusing an unbounded sync loop (the provider stream is divergent)`,
          [
            {
              code: 'schedule-sync-page-bound',
              message: String(MAX_SYNC_PAGES_PER_STREAM),
              path: null,
            },
          ],
          { scope: request.authorization.context.scope },
        ),
      );
    }

    streams.push({
      objectKind,
      applications,
      conflicts: streamConflicts,
      cursor,
      hasMore,
    });
  }

  // Classify every engine-detected conflict (the quarantined ones are already
  // classified above — the SDK's conflict ids keep the two sets disjoint).
  const quarantinedIds = new Set(classifications.map((entry) => entry.conflictId));
  for (const conflict of conflicts) {
    if (quarantinedIds.has(conflict.conflictId)) continue;
    const classified = classifyScheduleConflict(conflict);
    if (!classified.ok) return classified;
    classifications.push({
      conflictId: conflict.conflictId,
      kind: classified.value,
      quarantined: false,
    });
  }

  return ok({ streams, commands, conflicts, conflictRules: classifications } satisfies ScheduleSyncOutcome);
}
