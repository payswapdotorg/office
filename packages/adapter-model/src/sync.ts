// Office adapter-model — the multi-stream model sync driver (OFF-022).
//
// A THIN orchestration over the OFF-020 SDK's sync engine: runModelSync
// drives one page-or-exhausted pass of every declared model object-kind
// stream — in the MODEL HIERARCHY order (models first, then model versions,
// then elements, then classification entries) — so parent mappings are
// established before children reference them, with per-stream cursors
// persisted through the SDK's cursor store (positional restart safety) and
// replay safety layered on the SourceRef-derived command idempotency keys
// (the same provider object version never proposes twice).
//
// No engine logic is reimplemented here: every page goes through the SDK's
// runSync (authorization, cursor membership, fail-closed snapshot parsing,
// stream-consistency guards, the full reconcile branches), and this module
// only sequences the streams and aggregates the outcomes. Deterministic:
// same provider data, same stores, same injected clock/id suppliers → the
// same mappings, cursors, conflicts, and command proposals.
import { runSync } from '@office/adapters-sdk';
import type {
  Adapter,
  AdapterAuthorization,
  AdapterCommandTranslator,
  AdapterJsonObject,
  Conflict,
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
import { MODEL_OBJECT_FAMILY } from './vocabulary';

/** Defensive bound on pages pulled per stream per run (typed failure past it). */
export const MAX_SYNC_PAGES_PER_STREAM = 1000;

/** One object-kind stream's aggregated outcome across its pages. */
export interface ModelSyncStreamOutcome {
  /** The stream's object kind. */
  readonly objectKind: ProviderObjectKind;
  /** Per-snapshot reconciliation, in provider stream order across pages. */
  readonly applications: readonly SyncApplication[];
  /** The conflicts detected by this run (detected state, both sides). */
  readonly conflicts: readonly Conflict[];
  /** The stream's effective cursor after the run (null when never advanced). */
  readonly cursor: SyncCursor | null;
  /** Whether the provider reports more items past the run's position. */
  readonly hasMore: boolean;
}

/** The whole runModelSync result. */
export interface ModelSyncOutcome {
  /** Per-stream outcomes, in the model hierarchy (canonical) stream order. */
  readonly streams: readonly ModelSyncStreamOutcome[];
  /** Every proposed canonical command, in stream + provider order. */
  readonly commands: readonly CommandEnvelope<AdapterJsonObject>[];
  /** Every conflict detected by the run, in stream + provider order. */
  readonly conflicts: readonly Conflict[];
}

/**
 * Run one model sync pass: for each declared object-kind stream, in the
 * model hierarchy order (model, model-version, element,
 * element-classification — parents map before children), pull pages through
 * the SDK's runSync engine until the stream is exhausted (or the page bound
 * trips, a typed invariant-violation — never an unbounded loop). Every
 * failure is the engine's typed DomainError, propagated as-is: a failed
 * stream stops the whole run with nothing from later streams applied.
 */
export async function runModelSync(
  request: {
    readonly authorization: AdapterAuthorization;
    readonly adapter: Adapter;
    readonly translator: AdapterCommandTranslator;
    readonly systemId: ProviderSystemId;
    /** Page size: integer 1..SYNC_MAX_LIMIT (the engine validates). */
    readonly limit: number;
  },
  deps: SyncEngineDeps,
): Promise<Result<ModelSyncOutcome, DomainError>> {
  const streams: ModelSyncStreamOutcome[] = [];
  const commands: CommandEnvelope<AdapterJsonObject>[] = [];
  const conflicts: Conflict[] = [];

  for (const objectKind of MODEL_OBJECT_FAMILY) {
    const applications: SyncApplication[] = [];
    const streamConflicts: Conflict[] = [];
    let cursor: SyncCursor | null = null;
    let hasMore = false;

    for (let page = 0; page < MAX_SYNC_PAGES_PER_STREAM; page += 1) {
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
              code: 'model-sync-page-bound',
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

  return ok({ streams, commands, conflicts } satisfies ModelSyncOutcome);
}
