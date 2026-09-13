// Office adapter-schedule — THE typed conflict rules (OFF-023, the named focus).
//
// Schedule conflicts are MATERIAL: the provider's schedule state and the
// canonical schedules-area state can diverge in ways that must never be
// silently reconciled (the frozen anti-patterns: no last-write-wins, no
// destructive auto-resolution over material schedule state). This module is
// the adapter's DIVERGENCE DETECTION: every rule composes an explicit
// Conflict record — the OFF-020 SDK's typed shape carrying BOTH sides (the
// provider SourceRef INCLUDING its version, and the canonical EntityRef +
// its aggregate version at detection) — and NOTHING else: detection never
// resolves; resolution is an explicit command (the SDK's resolveConflict
// with ledger-evidence refs), which the runtime issues after reconciling.
//
// The three named rules:
//   1. CONCURRENT ACTIVITY-DATE CHANGES — the provider changed an activity's
//      dates while the canonical aggregate moved independently. Detected by
//      the SDK's sync engine itself (both sides moved since the last
//      synchronized point); THIS module classifies the engine's record with
//      its typed rule kind (classifyScheduleConflict).
//   2. DEPENDENCY-CYCLE INTRODUCTIONS — a NEW provider dependency link whose
//      edge would close a cycle in the schedule network. Detected here
//      (detectDependencyCycle + detectScheduleDivergences): the cycle-
//      introducing dependency is QUARANTINED from the sync stream (the
//      canonical network stays acyclic — no command is ever proposed for
//      it) and the divergence is recorded as a Conflict against the owning
//      schedule aggregate.
//   3. BASELINE RE-BASELINING ATTEMPTS AGAINST PROTECTED BASELINES — a
//      provider baseline object changed IN PLACE (a re-baselining attempt)
//      where the mapped baseline record is immutable: the attempt is
//      quarantined from the sync stream and recorded as a Conflict carrying
//      the protected flag, while a re-baseline done properly (a NEW provider
//      baseline object superseding the old one) flows through as a NEW
//      canonical baseline record (never a mutation).
//
// Deterministic everywhere: pure graph arithmetic over provider-declared
// edges, ids derived from both sides (the SDK's discipline — re-detecting
// the same divergence yields the same conflict id, and appending it again
// is an idempotent no-op), timestamps from the injected clock, canonical
// orderings only.
import type { Actor, EntityRef, TenantId, Timestamp } from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import type {
  AdapterKind,
  CanonicalVersionLookup,
  Conflict,
  ProviderSystemId,
  SourceMappingStore,
} from '@office/adapters-sdk';
import { detectedConflict, providerObjectId, providerVersion, sourceRef } from '@office/adapters-sdk';
import {
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  parseScheduleObjectKind,
} from './vocabulary';

// ---------------------------------------------------------------------------
// The typed rule vocabulary.
// ---------------------------------------------------------------------------

/**
 * The typed schedule conflict kinds — which named rule fired. The three
 * focus rules plus the degenerate root case (a both-sides-moved divergence
 * over the project-schedule root itself), so classification is total over
 * the schedule object family.
 */
export type ScheduleConflictKind =
  | 'concurrent-activity-change'
  | 'dependency-cycle-introduction'
  | 'baseline-rebaselining'
  | 'concurrent-schedule-change';

/** Grammar description used in parse failures. */
export const SCHEDULE_CONFLICT_KIND_GRAMMAR =
  "schedule conflict rule: 'concurrent-activity-change' | 'dependency-cycle-introduction' | 'baseline-rebaselining' | 'concurrent-schedule-change'";

const KINDS: readonly ScheduleConflictKind[] = [
  'concurrent-activity-change',
  'dependency-cycle-introduction',
  'baseline-rebaselining',
  'concurrent-schedule-change',
];

/** Parse an untrusted value as a ScheduleConflictKind (total, fail-closed). */
export function parseScheduleConflictKind(raw: unknown): Result<ScheduleConflictKind, DomainError> {
  if (typeof raw !== 'string' || !KINDS.includes(raw as ScheduleConflictKind)) {
    return fail(
      domainError(
        'invariant-violation',
        `not a schedule conflict rule kind: ${String(raw)}`,
        [
          {
            code: 'schedule-conflict-kind-invalid',
            message: String(raw),
            path: null,
          },
        ],
      ),
    );
  }
  return ok(raw as ScheduleConflictKind);
}

/**
 * Classify one Conflict record with its typed schedule rule kind, by the
 * provider object family of its source side (total over the family; a
 * conflict recorded for a foreign object kind is a typed
 * invariant-violation — it cannot be classified by these rules).
 */
export function classifyScheduleConflict(
  conflict: Conflict,
): Result<ScheduleConflictKind, DomainError> {
  const objectKind = parseScheduleObjectKind(conflict.source.objectType);
  if (!objectKind.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `conflict ${conflict.conflictId} was recorded for provider object kind '${conflict.source.objectType}', which is not part of the schedule object family — the schedule conflict rules classify schedule divergences only`,
        [
          {
            code: 'schedule-conflict-kind-unknown',
            message: conflict.source.objectType,
            path: 'source.objectType',
          },
        ],
        { scope: { kind: 'tenant', tenantId: conflict.tenantId } },
      ),
    );
  }
  switch (objectKind.value) {
    case ACTIVITY_OBJECT_KIND:
      return ok('concurrent-activity-change');
    case ACTIVITY_DEPENDENCY_OBJECT_KIND:
      return ok('dependency-cycle-introduction');
    case BASELINE_OBJECT_KIND:
      return ok('baseline-rebaselining');
    default:
      return ok('concurrent-schedule-change');
  }
}

// ---------------------------------------------------------------------------
// Rule 2's pure core: dependency-cycle detection over provider edges.
// ---------------------------------------------------------------------------

/** One directed edge of the schedule network, in provider activity ids. */
export interface ScheduleDependencyEdge {
  readonly predecessorId: string;
  readonly successorId: string;
}

/** One detected dependency cycle: the introducing edge and its path. */
export interface DependencyCycle {
  readonly kind: 'dependency-cycle';
  /** The edge that would close the cycle (provider activity ids). */
  readonly introducedBy: ScheduleDependencyEdge;
  /**
   * The cycle path as provider activity ids: starts at the introducing
   * edge's predecessor, crosses the successor, and follows the existing
   * network back to the predecessor.
   */
  readonly path: readonly string[];
}

/** Grammar description used in parse failures. */
export const DEPENDENCY_CYCLE_GRAMMAR =
  "DependencyCycle: { kind: 'dependency-cycle', introducedBy: { predecessorId, successorId }, path: string[] (>= 2) }";

/** Parse an untrusted value as a DependencyCycle (total, fail-closed, strict keys). */
export function parseDependencyCycle(raw: unknown): Result<DependencyCycle, DomainError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(
      domainError(
        'invariant-violation',
        `not a dependency cycle: ${String(raw)}`,
        [{ code: 'dependency-cycle-invalid', message: String(raw), path: null }],
      ),
    );
  }
  const record = raw as Record<string, unknown>;
  if (record['kind'] !== 'dependency-cycle') {
    return fail(
      domainError(
        'invariant-violation',
        `not a dependency cycle: kind '${String(record['kind'])}'`,
        [{ code: 'dependency-cycle-invalid', message: String(record['kind']), path: 'kind' }],
      ),
    );
  }
  const introducedBy = record['introducedBy'];
  if (
    typeof introducedBy !== 'object' ||
    introducedBy === null ||
    Array.isArray(introducedBy)
  ) {
    return fail(
      domainError(
        'invariant-violation',
        'dependency cycle introducedBy is not an edge object',
        [{ code: 'dependency-cycle-invalid', message: String(introducedBy), path: 'introducedBy' }],
      ),
    );
  }
  const edge = introducedBy as Record<string, unknown>;
  const predecessorId = edge['predecessorId'];
  const successorId = edge['successorId'];
  if (typeof predecessorId !== 'string' || typeof successorId !== 'string') {
    return fail(
      domainError(
        'invariant-violation',
        'dependency cycle introducedBy edge is malformed',
        [
          {
            code: 'dependency-cycle-invalid',
            message: JSON.stringify(introducedBy),
            path: 'introducedBy',
          },
        ],
      ),
    );
  }
  const path = record['path'];
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    !path.every((entry) => typeof entry === 'string')
  ) {
    return fail(
      domainError(
        'invariant-violation',
        'dependency cycle path is not a list of provider activity ids',
        [{ code: 'dependency-cycle-invalid', message: String(path), path: 'path' }],
      ),
    );
  }
  return ok({
    kind: 'dependency-cycle',
    introducedBy: { predecessorId, successorId },
    path: path as readonly string[],
  } satisfies DependencyCycle);
}

/**
 * Would adding `candidate` to the existing dependency network close a
 * cycle? Pure deterministic DFS over the existing edges: a cycle closes
 * exactly when a path already leads from the candidate's successor back to
 * its predecessor. Returns the cycle (introducing edge + path) or null.
 */
export function detectDependencyCycle(
  edges: readonly ScheduleDependencyEdge[],
  candidate: ScheduleDependencyEdge,
): DependencyCycle | null {
  // Deterministic adjacency: provider insertion order preserved.
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.predecessorId) ?? [];
    list.push(edge.successorId);
    adjacency.set(edge.predecessorId, list);
  }
  // DFS from the candidate's successor toward its predecessor, in edge order.
  const visited = new Set<string>();
  const stack: string[] = [candidate.successorId];
  const parentOf = new Map<string, string>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node === candidate.predecessorId) {
      // Reconstruct the cycle: predecessor → successor → (the discovered
      // path) → predecessor, following the discovery parents backward.
      const intermediate: string[] = [];
      let cursor: string | undefined = node;
      while (cursor !== undefined && cursor !== candidate.successorId) {
        intermediate.push(cursor);
        cursor = parentOf.get(cursor);
      }
      if (cursor === candidate.successorId) {
        return {
          kind: 'dependency-cycle',
          introducedBy: candidate,
          path: [
            candidate.predecessorId,
            candidate.successorId,
            ...[...intermediate].reverse(),
          ],
        } satisfies DependencyCycle;
      }
      // Unreachable: every discovered node's parent chain roots at the DFS
      // start (the candidate's successor). Kept loud rather than guessing.
      return null;
    }
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) {
        parentOf.set(next, node);
        stack.push(next);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The divergence view + the pre-flight detection pass.
// ---------------------------------------------------------------------------

/** One provider activity-dependency object, as the divergence view sees it. */
export interface ProviderDependencyEdge {
  /** The dependency's provider object id. */
  readonly objectId: string;
  /** The dependency's provider version. */
  readonly version: string;
  /** The owning project schedule's provider object id. */
  readonly scheduleId: string;
  readonly predecessorId: string;
  readonly successorId: string;
}

/** One provider baseline object, as the divergence view sees it. */
export interface ProviderBaselineState {
  /** The baseline's provider object id. */
  readonly objectId: string;
  /** The baseline's provider version. */
  readonly version: string;
  /** The owning project schedule's provider object id. */
  readonly scheduleId: string;
  /**
   * The provider's protection flag: a PROTECTED baseline may not be
   * re-baselined in place (the named conflict rule); an in-place change of
   * an unprotected mapped baseline is still a divergence (baselines are
   * immutable records) recorded with protected=false.
   */
  readonly protected: boolean;
}

/**
 * The injected provider-data view the divergence detection runs over (a
 * PORT: in production the runtime wires the real provider client's data
 * into it; in tests the deterministic in-memory fixture derives it). It is
 * the ADAPTER's own view of the provider state — never canonical state.
 */
export interface ScheduleDivergenceView {
  /** Every provider activity-dependency object, in provider order. */
  readonly dependencies: readonly ProviderDependencyEdge[];
  /** Every provider baseline object, in provider order. */
  readonly baselines: readonly ProviderBaselineState[];
}

/** One detected divergence: its typed rule, its Conflict record, its quarantine. */
export interface DetectedScheduleDivergence {
  /** Which named rule fired. */
  readonly rule: Exclude<ScheduleConflictKind, 'concurrent-activity-change' | 'concurrent-schedule-change'>;
  /** The explicit Conflict record with BOTH sides (the SDK's typed shape). */
  readonly conflict: Conflict;
  /**
   * The quarantined provider object: its stream is filtered from THIS sync
   * run (no mapping is created or advanced, no command is proposed — the
   * canonical side is untouched until the conflict is resolved explicitly).
   */
  readonly quarantinedObjectKind: 'activity-dependency' | 'baseline';
  readonly quarantinedObjectId: string;
  /** The cycle path for dependency-cycle introductions, else null. */
  readonly cycle: DependencyCycle | null;
}

/** Inputs of detectScheduleDivergences (the pre-flight detection pass). */
export interface DetectScheduleDivergencesParts {
  readonly tenantId: TenantId;
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  /** The provider-data view (the adapter's own state, never canonical). */
  readonly view: ScheduleDivergenceView;
  /** The shared, tenant-scoped source-mapping store (the SDK port). */
  readonly mappings: SourceMappingStore;
  /** The canonical-state lookup port (the runtime owns the graph). */
  readonly canonicalVersionOf: CanonicalVersionLookup;
  readonly actor: Actor;
  readonly now: Timestamp;
}

/** The provider coordinate of one dependency object (local helper). */
const dependencySourceOf = (
  parts: Pick<DetectScheduleDivergencesParts, 'adapterKind' | 'systemId'>,
  edge: ProviderDependencyEdge,
): ReturnType<typeof sourceRef> =>
  sourceRef({
    adapterKind: parts.adapterKind,
    systemId: parts.systemId,
    objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
    objectId: providerObjectId(edge.objectId),
    version: providerVersion(edge.version),
  });

/** The provider coordinate of one baseline object (local helper). */
const baselineSourceOf = (
  parts: Pick<DetectScheduleDivergencesParts, 'adapterKind' | 'systemId'>,
  baseline: ProviderBaselineState,
): ReturnType<typeof sourceRef> =>
  sourceRef({
    adapterKind: parts.adapterKind,
    systemId: parts.systemId,
    objectType: BASELINE_OBJECT_KIND,
    objectId: providerObjectId(baseline.objectId),
    version: providerVersion(baseline.version),
  });

/** Look up the current canonical version of one canonical entity (local). */
const currentCanonicalVersion = async (
  parts: DetectScheduleDivergencesParts,
  canonical: EntityRef,
): Promise<Result<AggregateVersion, DomainError>> => {
  const current = await parts.canonicalVersionOf(parts.tenantId, canonical);
  if (!current.ok) return current;
  return ok(current.value ?? INITIAL_AGGREGATE_VERSION);
};

/**
 * Run the pre-flight divergence detection over the provider view:
 *
 *   - for every provider dependency object with NO mapping yet (a NEW link),
 *     detectDependencyCycle runs over the OTHER provider edges: a link that
 *     would close a cycle is an introducer — a typed Conflict is composed
 *     against the OWNING SCHEDULE aggregate (the unmapped link has no
 *     canonical entity of its own; the schedule root whose network the
 *     introduction would corrupt is the canonical side, with its current
 *     aggregate version) and the link is quarantined;
 *   - for every provider baseline object WITH a mapping whose provider
 *     version moved past the mapping's (an IN-PLACE re-baselining attempt
 *     against an immutable baseline record), a typed Conflict is composed
 *     against the baseline's own canonical entity (with its current version)
 *     and the object is quarantined — the protection flag rides the typed
 *     rule's documentation and the fixture's payloads.
 *
 * Pure over the injected state: same view + same mappings + same canonical
 * versions → the same divergence records (conflict ids are derived from
 * both sides, so re-detection is idempotent in the SDK's conflict store).
 */
export async function detectScheduleDivergences(
  parts: DetectScheduleDivergencesParts,
): Promise<Result<readonly DetectedScheduleDivergence[], DomainError>> {
  const divergences: DetectedScheduleDivergence[] = [];

  // Rule 2: dependency-cycle introductions (new links that close a cycle).
  for (const edge of parts.view.dependencies) {
    const mapping = await parts.mappings.findByCoordinate(parts.tenantId, {
      adapterKind: parts.adapterKind,
      systemId: parts.systemId,
      objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
      objectId: providerObjectId(edge.objectId),
    });
    if (mapping !== null) continue; // already known: not an introduction
    const others = parts.view.dependencies
      .filter((candidate) => candidate.objectId !== edge.objectId)
      .map((candidate) => ({
        predecessorId: candidate.predecessorId,
        successorId: candidate.successorId,
      }));
    const cycle = detectDependencyCycle(others, {
      predecessorId: edge.predecessorId,
      successorId: edge.successorId,
    });
    if (cycle === null) continue;
    // The canonical side is the owning schedule aggregate: resolve its
    // mapping (the schedule stream always syncs first).
    const scheduleMapping = await parts.mappings.findByCoordinate(parts.tenantId, {
      adapterKind: parts.adapterKind,
      systemId: parts.systemId,
      objectType: PROJECT_SCHEDULE_OBJECT_KIND,
      objectId: providerObjectId(edge.scheduleId),
    });
    if (scheduleMapping === null) {
      return fail(
        domainError(
          'not-found',
          `provider dependency ${edge.objectId} references project-schedule provider object ${edge.scheduleId}, which has no mapping in tenant ${parts.tenantId} — sync the project-schedule stream before the dependency stream (the schedule hierarchy discipline)`,
          [
            {
              code: 'schedule-parent-unmapped',
              message: edge.scheduleId,
              path: 'scheduleId',
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    const version = await currentCanonicalVersion(parts, scheduleMapping.canonical);
    if (!version.ok) return version;
    divergences.push({
      rule: 'dependency-cycle-introduction',
      conflict: detectedConflict({
        tenantId: parts.tenantId,
        source: dependencySourceOf(parts, edge),
        canonical: scheduleMapping.canonical,
        canonicalVersion: version.value,
        detectedAt: parts.now,
        detectedBy: parts.actor,
      }),
      quarantinedObjectKind: 'activity-dependency',
      quarantinedObjectId: edge.objectId,
      cycle,
    });
  }

  // Rule 3: re-baselining attempts against (protected) baselines.
  for (const baseline of parts.view.baselines) {
    const mapping = await parts.mappings.findByCoordinate(parts.tenantId, {
      adapterKind: parts.adapterKind,
      systemId: parts.systemId,
      objectType: BASELINE_OBJECT_KIND,
      objectId: providerObjectId(baseline.objectId),
    });
    if (mapping === null) continue; // a NEW baseline object: a new record, not a divergence
    if (mapping.providerVersion === baseline.version) continue; // quiet: no attempt
    const version = await currentCanonicalVersion(parts, mapping.canonical);
    if (!version.ok) return version;
    divergences.push({
      rule: 'baseline-rebaselining',
      conflict: detectedConflict({
        tenantId: parts.tenantId,
        source: baselineSourceOf(parts, baseline),
        canonical: mapping.canonical,
        canonicalVersion: version.value,
        detectedAt: parts.now,
        detectedBy: parts.actor,
      }),
      quarantinedObjectKind: 'baseline',
      quarantinedObjectId: baseline.objectId,
      cycle: null,
    });
  }

  return ok(divergences);
}
