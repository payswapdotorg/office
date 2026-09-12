// Office adapters-sdk — the sync engine (OFF-020).
//
// runSync drives one page of one object-kind stream through the canonical
// intake path, end to end, deterministically:
//
//   1. authorize — the adapter actor context (requireAdapterActor) and the
//      declared capability through authz's deny-by-default authorize()
//      BEFORE anything moves;
//   2. resume — the presented cursor must belong to exactly this stream
//      (tenant/adapter/system/object-kind), typed-rejected otherwise;
//   3. pull — adapter.sync() returns the page; the engine parses the result
//      fail-closed and validates every snapshot against the requesting
//      stream (a cross-tenant or cross-stream snapshot is a typed rejection,
//      never applied);
//   4. reconcile — per snapshot, the identity mapping decides:
//        no mapping + active object      → issue a canonical id (injected
//                                          supplier), record the mapping,
//                                          propose the create command;
//        no mapping + deleted object     → orphan deletion, skipped;
//        mapping + same provider version
//          AND same canonical version     → REPLAY no-op (idempotent — no
//                                          duplicate mapping or command);
//        mapping + provider moved,
//          canonical quiet                → propose the update/delete
//                                          command, advance the bookkeeping;
//        mapping + provider quiet,
//          canonical moved                → canonical-ahead no-op (the
//                                          canonical side owns the truth;
//                                          outbound push is the runtime's);
//        mapping + BOTH sides moved       → explicit Conflict record
//                                          (detected state, both sides'
//                                          refs/versions, no command, no
//                                          destructive auto-resolution);
//   5. checkpoint — the next cursor is composed from the adapter's token +
//      checkpoint through the injected clock and persisted (monotonic — a
//      cursor never rewinds).
//
// The engine performs no I/O of its own: the Adapter, the stores, the
// canonical-version lookup, the clock, and the id supplier are all injected
// ports. Same inputs → same mappings, cursors, conflicts, and commands.
import { domainError, fail, ok, INITIAL_AGGREGATE_VERSION } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type { EntityKind, TenantId, Timestamp } from '@office/contracts';
import { authorize, resourceScope } from '@office/authz';
import type { Adapter } from './adapter';
import { parseSyncResult, requireAdapterActor } from './adapter';
import { adapterCommandEnvelope, checkCommandEnvelopeRoundTrip } from './commands';
import type {
  AdapterCommandInput,
  AdapterCommandTranslator,
  CanonicalIdSupplier,
  CanonicalVersionLookup,
  EngineClock,
} from './commands';
import { detectedConflict } from './conflict';
import type { Conflict, ConflictStore } from './conflict';
import { assertMappingTenant, recordSourceMapping, sourceMapping } from './mapping';
import type { SourceMapping, SourceMappingStore } from './mapping';
import { coordinateOf } from './source-ref';
import type { ProviderSystemId } from './identity';
import type { ProviderObjectKind } from './identity';
import { checkCursorStream, nextCursor, syncStream } from './cursor';
import type { SyncCursor, SyncCursorStore } from './cursor';
import type { ProviderSnapshot } from './snapshot';
import type { AdapterJsonObject } from './json';
import type { CommandEnvelope } from '@office/contracts';
import type { AdapterAuthorization } from './webhook';

/** The maximum page size one sync may request. */
export const SYNC_MAX_LIMIT = 1000;

/** Injected dependencies of the sync engine (determinism rule). */
export interface SyncEngineDeps {
  readonly mappings: SourceMappingStore;
  readonly cursors: SyncCursorStore;
  readonly conflicts: ConflictStore;
  /** Lookup of the canonical aggregate version (the runtime owns the graph). */
  readonly canonicalVersionOf: CanonicalVersionLookup;
  /** Injected clock — the canonical 'now' of each run. */
  readonly now: EngineClock;
  /** Injected office-issued canonical id supplier (never a provider id). */
  readonly nextCanonicalId: CanonicalIdSupplier;
}

/** One runSync request: authorization, the adapter + translator, the stream. */
export interface RunSyncRequest {
  readonly authorization: AdapterAuthorization;
  readonly adapter: Adapter;
  readonly translator: AdapterCommandTranslator;
  readonly systemId: ProviderSystemId;
  readonly objectKind: ProviderObjectKind;
  /** The resume position (the runtime loads it from the cursor store). */
  readonly cursor: SyncCursor | null;
  /** Page size: integer 1..SYNC_MAX_LIMIT. */
  readonly limit: number;
}

/** The per-snapshot outcome vocabulary of a sync run. */
export type SyncApplicationOutcome =
  | 'mapped-created'
  | 'applied-update'
  | 'applied-deletion'
  | 'replay-no-op'
  | 'canonical-ahead'
  | 'conflict-detected'
  | 'orphan-deletion-skipped';

/** One snapshot's reconciliation result. */
export interface SyncApplication {
  /** The observed snapshot (full provenance). */
  readonly snapshot: ProviderSnapshot;
  /** The mapping AFTER reconciliation (null only for orphan deletions). */
  readonly mapping: SourceMapping | null;
  /** The proposed canonical command, or null for the no-op outcomes. */
  readonly command: CommandEnvelope<AdapterJsonObject> | null;
  /** Which reconciliation branch ran. */
  readonly outcome: SyncApplicationOutcome;
}

/** The whole runSync result. */
export interface SyncOutcome {
  /** Per-snapshot reconciliation, in provider stream order. */
  readonly applications: readonly SyncApplication[];
  /** The conflicts detected by this run (detected state, both sides). */
  readonly conflicts: readonly Conflict[];
  /** The stream's effective cursor after the run (null when never advanced). */
  readonly cursor: SyncCursor | null;
  /** Whether the provider reports more items past this position. */
  readonly hasMore: boolean;
}

/**
 * Run one sync page end to end. Every failure is a typed DomainError value:
 * authorization denials (forbidden/unauthorized), stream mismatches, adapter
 * output violations, and store invariants — a failed run applies nothing
 * beyond the snapshots already reconciled before the failure (the runtime
 * wraps runs in its own transaction when it needs all-or-nothing).
 */
export async function runSync(
  request: RunSyncRequest,
  deps: SyncEngineDeps,
): Promise<Result<SyncOutcome, DomainError>> {
  const actorCheck = requireAdapterActor(request.authorization.context);
  if (!actorCheck.ok) return actorCheck;
  const tenantId = request.authorization.context.scope.tenantId;
  const scope = { kind: 'tenant', tenantId } as const;

  const stream = syncStream({
    tenantId,
    adapterKind: request.adapter.kind,
    systemId: request.systemId,
    objectKind: request.objectKind,
  });

  const declaration = request.adapter.capabilities.objectKinds.find(
    (entry) => entry.objectKind === request.objectKind,
  );
  if (declaration === undefined) {
    return fail(
      domainError(
        'invariant-violation',
        `adapter '${request.adapter.kind}' does not declare object kind '${request.objectKind}'`,
        [{ code: 'object-kind-not-declared', message: request.objectKind, path: 'objectKind' }],
        { scope },
      ),
    );
  }

  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > SYNC_MAX_LIMIT) {
    return fail(
      domainError(
        'invariant-violation',
        `sync limit must be an integer in 1..${SYNC_MAX_LIMIT}, received ${String(request.limit)}`,
        [{ code: 'sync-limit-invalid', message: String(request.limit), path: 'limit' }],
        { scope },
      ),
    );
  }

  if (request.cursor !== null) {
    const membership = checkCursorStream(request.cursor, stream);
    if (!membership.ok) return membership;
  }

  const decision = authorize(
    request.authorization.policy,
    request.authorization.context,
    resourceScope({
      scope,
      resourceKind: declaration.canonicalKind,
      resourceId: null,
      ownerId: null,
    }),
    'write',
    { scope },
  );
  if (!decision.ok) return decision;

  const now = deps.now();
  const pulled = await request.adapter.sync({
    kind: 'sync-request',
    tenantId,
    systemId: request.systemId,
    objectKind: request.objectKind,
    cursor: request.cursor,
    limit: request.limit,
    now,
  });
  if (!pulled.ok) return pulled;

  // The adapter's output is parsed fail-closed (implementors are untrusted).
  const parsedPage = parseSyncResult(pulled.value);
  if (!parsedPage.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `adapter sync result failed fail-closed parsing: ${parsedPage.error.code} at '${parsedPage.error.path === '' ? '<root>' : parsedPage.error.path}'`,
        [
          {
            code: `sync-result-${parsedPage.error.code}`,
            message: parsedPage.error.received,
            path: parsedPage.error.path === '' ? null : parsedPage.error.path,
          },
        ],
        { scope },
      ),
    );
  }
  const page = parsedPage.value;

  const applications: SyncApplication[] = [];
  const conflicts: Conflict[] = [];
  for (const snapshot of page.snapshots) {
    // Stream-consistency guards: a snapshot is applied only for THIS tenant
    // and THIS stream — a cross-tenant or cross-stream injection is typed.
    if (snapshot.tenantId !== tenantId) {
      return fail(
        domainError(
          'unauthorized',
          `adapter returned a snapshot stamped for tenant ${snapshot.tenantId} inside tenant ${tenantId}'s sync — cross-tenant injection is rejected`,
          [
            {
              code: 'tenant-scope-violation',
              message: `${snapshot.tenantId} vs ${tenantId}`,
              path: 'tenantId',
            },
          ],
          { scope },
        ),
      );
    }
    if (
      snapshot.source.adapterKind !== request.adapter.kind ||
      snapshot.source.systemId !== request.systemId ||
      snapshot.source.objectType !== request.objectKind
    ) {
      return fail(
        domainError(
          'invariant-violation',
          `adapter returned a snapshot of ${snapshot.source.adapterKind}/${snapshot.source.systemId}/${snapshot.source.objectType} inside the ${request.adapter.kind}/${request.systemId}/${request.objectKind} stream — cross-stream injection is rejected`,
          [
            {
              code: 'snapshot-stream-mismatch',
              message: `${snapshot.source.adapterKind}/${snapshot.source.systemId}/${snapshot.source.objectType}`,
              path: 'source',
            },
          ],
          { scope },
        ),
      );
    }

    const reconciled = await reconcile({
      deps,
      authorization: request.authorization,
      translator: request.translator,
      declarationCanonicalKind: declaration.canonicalKind,
      snapshot,
      tenantId,
      now,
    });
    if (!reconciled.ok) return reconciled;
    if (reconciled.value.conflict !== null) conflicts.push(reconciled.value.conflict);
    applications.push(reconciled.value.application);
  }

  let cursorAfter = request.cursor;
  if (page.nextCursorToken !== null) {
    const advanced = nextCursor({
      stream,
      previous: request.cursor,
      token: page.nextCursorToken,
      checkpoint: page.checkpoint,
      now,
    });
    if (!advanced.ok) return advanced;
    const saved = await deps.cursors.save(advanced.value);
    if (!saved.ok) return saved;
    cursorAfter = saved.value;
  }

  return ok({
    applications,
    conflicts,
    cursor: cursorAfter,
    hasMore: page.hasMore,
  } satisfies SyncOutcome);
}

/** Per-snapshot reconciliation result (local shape). */
interface ReconciledSnapshot {
  readonly application: SyncApplication;
  readonly conflict: Conflict | null;
}

/** The per-snapshot branch logic (see the module comment for the rules). */
const reconcile = async (parts: {
  readonly deps: SyncEngineDeps;
  readonly authorization: AdapterAuthorization;
  readonly translator: AdapterCommandTranslator;
  readonly declarationCanonicalKind: EntityKind;
  readonly snapshot: ProviderSnapshot;
  readonly tenantId: TenantId;
  readonly now: Timestamp;
}): Promise<Result<ReconciledSnapshot, DomainError>> => {
  const { deps, snapshot, tenantId, now } = parts;
  const actor = parts.authorization.context.actor;
  const mapping = await deps.mappings.findByCoordinate(tenantId, coordinateOf(snapshot.source));

  if (mapping === null) {
    if (snapshot.objectStatus === 'deleted') {
      return ok({
        application: {
          snapshot,
          mapping: null,
          command: null,
          outcome: 'orphan-deletion-skipped',
        },
        conflict: null,
      } satisfies ReconciledSnapshot);
    }
    const canonical = {
      entityKind: parts.declarationCanonicalKind,
      entityId: deps.nextCanonicalId(),
    };
    const current = await deps.canonicalVersionOf(tenantId, canonical);
    if (!current.ok) return current;
    const recorded = await recordSourceMapping({
      store: deps.mappings,
      tenantId,
      coordinate: coordinateOf(snapshot.source),
      canonical,
      providerVersion: snapshot.source.version,
      canonicalVersion: current.value ?? INITIAL_AGGREGATE_VERSION,
      actor,
      now,
    });
    if (!recorded.ok) return recorded;
    const command = proposeCommand(parts, recorded.value, 'created');
    if (!command.ok) return command;
    return ok({
      application: {
        snapshot,
        mapping: recorded.value,
        command: command.value,
        outcome: 'mapped-created',
      },
      conflict: null,
    } satisfies ReconciledSnapshot);
  }

  const tenant = assertMappingTenant(mapping, tenantId);
  if (!tenant.ok) return tenant;

  const current = await deps.canonicalVersionOf(tenantId, mapping.canonical);
  if (!current.ok) return current;

  // Canonical entity absent (pending create or canonical deletion): the
  // existing canonical id is re-used deterministically — never a second id.
  if (current.value === null) {
    const advanced = sourceMapping({
      ...mapping,
      providerVersion: snapshot.source.version,
      canonicalVersion: INITIAL_AGGREGATE_VERSION,
      lastSyncedAt: now,
    });
    const saved = await deps.mappings.save(advanced);
    if (!saved.ok) return saved;
    const command = proposeCommand(parts, saved.value, 'created');
    if (!command.ok) return command;
    return ok({
      application: {
        snapshot,
        mapping: saved.value,
        command: command.value,
        outcome: 'mapped-created',
      },
      conflict: null,
    } satisfies ReconciledSnapshot);
  }

  const providerMoved = snapshot.source.version !== mapping.providerVersion;
  const canonicalMoved = current.value !== mapping.canonicalVersion;

  if (!providerMoved && !canonicalMoved) {
    // Pure replay: same SourceRef + version already applied — idempotent no-op.
    return ok({
      application: { snapshot, mapping, command: null, outcome: 'replay-no-op' },
      conflict: null,
    } satisfies ReconciledSnapshot);
  }

  if (providerMoved && !canonicalMoved) {
    const changeKind = snapshot.objectStatus === 'deleted' ? 'deleted' : 'updated';
    const advanced = sourceMapping({
      ...mapping,
      providerVersion: snapshot.source.version,
      canonicalVersion: current.value,
      lastSyncedAt: now,
    });
    const saved = await deps.mappings.save(advanced);
    if (!saved.ok) return saved;
    const command = proposeCommand(parts, saved.value, changeKind);
    if (!command.ok) return command;
    return ok({
      application: {
        snapshot,
        mapping: saved.value,
        command: command.value,
        outcome: changeKind === 'deleted' ? 'applied-deletion' : 'applied-update',
      },
      conflict: null,
    } satisfies ReconciledSnapshot);
  }

  if (!providerMoved && canonicalMoved) {
    // Canonical moved independently, provider quiet: canonical owns the truth;
    // the outbound push of that change is the runtime's, not the sync's.
    const advanced = sourceMapping({
      ...mapping,
      canonicalVersion: current.value,
      lastSyncedAt: now,
    });
    const saved = await deps.mappings.save(advanced);
    if (!saved.ok) return saved;
    return ok({
      application: {
        snapshot,
        mapping: saved.value,
        command: null,
        outcome: 'canonical-ahead',
      },
      conflict: null,
    } satisfies ReconciledSnapshot);
  }

  // BOTH sides moved since the last synchronized point: explicit conflict,
  // recorded in the detected state with both sides — never auto-resolved,
  // never silently last-write-wins'd (frozen anti-pattern).
  const detected = detectedConflict({
    tenantId,
    source: snapshot.source,
    canonical: mapping.canonical,
    canonicalVersion: current.value,
    detectedAt: now,
    detectedBy: actor,
  });
  const appended = await deps.conflicts.append(detected);
  if (!appended.ok) return appended;
  return ok({
    application: { snapshot, mapping, command: null, outcome: 'conflict-detected' },
    conflict: appended.value,
  } satisfies ReconciledSnapshot);
};

/** Propose + compose + round-trip-check one command (local helper). */
const proposeCommand = (
  parts: {
    readonly authorization: AdapterAuthorization;
    readonly translator: AdapterCommandTranslator;
    readonly snapshot: ProviderSnapshot;
    readonly tenantId: TenantId;
    readonly now: Timestamp;
  },
  mapping: SourceMapping,
  changeKind: AdapterCommandInput['changeKind'],
): Result<CommandEnvelope<AdapterJsonObject>, DomainError> => {
  const proposal = parts.translator.proposeCommand({
    origin: 'sync',
    tenantId: parts.tenantId,
    source: parts.snapshot.source,
    canonical: mapping.canonical,
    canonicalVersion: mapping.canonicalVersion,
    changeKind,
    displayName: parts.snapshot.displayName,
    data: parts.snapshot.extension,
  });
  if (!proposal.ok) return proposal;
  const command = adapterCommandEnvelope({
    proposal: proposal.value,
    context: parts.authorization.context,
    source: parts.snapshot.source,
    causationId: null,
    now: parts.now,
  });
  const roundTrip = checkCommandEnvelopeRoundTrip(command, parts.tenantId);
  if (!roundTrip.ok) return roundTrip;
  return ok(command);
};
