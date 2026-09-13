// Office adapter-schedule — the schedule reference contracts (OFF-023).
//
// THE typed mapping from provider project-schedule/activity/
// activity-dependency/baseline ids to canonical office EntityIds (freeze
// A10: provider ids are NEVER primary keys — the binding is a first-class,
// tenant-scoped, queryable record; A12: every operation is keyed by tenant
// first). This module layers the SCHEDULE discipline on top of the OFF-020
// SDK's SourceMapping store:
//
//   - KIND DISCIPLINE — a mapping record for a schedule object family
//     coordinate must bind a canonical entity of the DECLARED canonical kind
//     for that object kind (an 'activity' coordinate bound to a 'baseline'
//     canonical id is a typed invariant-violation, never silently used);
//   - HIERARCHY DISCIPLINE — an activity mapping can only be recorded when
//     its owning PROJECT-SCHEDULE mapping already exists (same tenant, same
//     adapter family + provider system), an activity-dependency mapping only
//     when BOTH its predecessor AND successor ACTIVITY mappings exist, and a
//     baseline mapping only when its owning schedule mapping exists: links
//     and baselines can never dangle above an unmapped schedule network
//     (fail-closed typed 'not-found', never an invented parent);
//   - REMAPPING DISCIPLINE — re-pointing a coordinate at a different
//     canonical id, or a second provider object claiming a bound canonical
//     id, is the SDK store's typed collision (an explicit conflict, never an
//     overwrite — no last-write-wins anywhere).
//
// Deterministic everywhere: the canonical ids are ALWAYS office-issued by
// the caller's injected supplier, timestamps come from the injected clock,
// and every output collection is canonically ordered.
import type { Actor, EntityRef, TenantId, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import {
  assertMappingTenant,
  providerObjectId,
  providerObjectKind,
  recordSourceMapping,
  sourceCoordinate,
} from '@office/adapters-sdk';
import type {
  ProviderVersion,
  SourceCoordinate,
  SourceMapping,
  SourceMappingStore,
} from '@office/adapters-sdk';
import {
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  canonicalKindOfScheduleObjectKind,
  parseScheduleObjectKind,
} from './vocabulary';

/**
 * A SourceCoordinate whose object type belongs to the schedule object family
 * ('project-schedule' | 'activity' | 'activity-dependency' | 'baseline') —
 * the family membership is enforced fail-closed at runtime by
 * parseScheduleObjectKind (the repo's branded-type + total-parse idiom: the
 * SDK's ProviderObjectKind brand is open, the family is a closed vocabulary).
 */
export type ScheduleObjectCoordinate = SourceCoordinate;

/**
 * Typed view of one SourceMapping record as a schedule object-family
 * reference: verifies BOTH sides of the kind discipline — the coordinate's
 * object type is a schedule family kind AND the canonical entity kind is the
 * one declared for that object kind. A mismatch is a typed
 * invariant-violation carrying both sides (never silently used data).
 */
export function assertScheduleObjectMapping(
  mapping: SourceMapping,
): Result<SourceMapping, DomainError> {
  const objectKind = parseScheduleObjectKind(mapping.coordinate.objectType);
  if (!objectKind.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `mapping for provider object ${mapping.coordinate.adapterKind}/${mapping.coordinate.systemId}/${mapping.coordinate.objectType}/${mapping.coordinate.objectId} is not a schedule object-family mapping (object type '${mapping.coordinate.objectType}')`,
        [
          {
            code: 'schedule-object-kind-unknown',
            message: mapping.coordinate.objectType,
            path: 'coordinate.objectType',
          },
        ],
        { scope: { kind: 'tenant', tenantId: mapping.tenantId } },
      ),
    );
  }
  const declaredKind = canonicalKindOfScheduleObjectKind(objectKind.value);
  if (mapping.canonical.entityKind !== declaredKind) {
    return fail(
      domainError(
        'invariant-violation',
        `provider ${objectKind.value} object ${mapping.coordinate.objectId} is mapped to canonical kind '${mapping.canonical.entityKind}' but the schedule contract declares '${declaredKind}' for that object kind — the binding is an explicit conflict, never silently used`,
        [
          {
            code: 'schedule-mapping-kind-mismatch',
            message: `${mapping.canonical.entityKind} vs ${declaredKind}`,
            path: 'canonical.entityKind',
          },
        ],
        { scope: { kind: 'tenant', tenantId: mapping.tenantId } },
      ),
    );
  }
  return ok(mapping);
}

/** The schedule-family parents one mapping's object references, by role. */
export interface ScheduleObjectParents {
  /**
   * The owning project schedule's provider object id — required when
   * recording activity, activity-dependency, and baseline mappings; ignored
   * for the schedule root itself.
   */
  readonly schedule: string | null;
  /**
   * The predecessor activity's provider object id — required exactly when
   * recording an activity-dependency mapping (the link's tail).
   */
  readonly predecessorActivity: string | null;
  /**
   * The successor activity's provider object id — required exactly when
   * recording an activity-dependency mapping (the link's head).
   */
  readonly successorActivity: string | null;
}

/** Inputs of recordScheduleObjectMapping (the runtime's schedule write path). */
export interface RecordScheduleObjectMappingParts {
  /** The shared, tenant-scoped source-mapping store (the SDK port). */
  readonly store: SourceMappingStore;
  readonly tenantId: TenantId;
  /** The schedule object-family coordinate being bound (validated fail-closed). */
  readonly coordinate: ScheduleObjectCoordinate;
  /** The office-issued canonical entity this provider object maps into. */
  readonly canonical: EntityRef;
  readonly providerVersion: ProviderVersion;
  readonly canonicalVersion: AggregateVersion;
  readonly actor: Actor;
  readonly now: Timestamp;
  /** The schedule-family parents the object references (see ScheduleObjectParents). */
  readonly parents: ScheduleObjectParents;
}

const hierarchyError = (
  parts: RecordScheduleObjectMappingParts,
  parentKind: string,
  parentObjectId: string,
  role: string | null = null,
): DomainError =>
  domainError(
    'not-found',
    `cannot record ${parts.coordinate.objectType} mapping for provider object ${parts.coordinate.objectId}: the parent ${parentKind} mapping for provider object ${parentObjectId}${role === null ? '' : ` (${role})`} does not exist in tenant ${parts.tenantId} — sync the parent stream first (the schedule hierarchy discipline)`,
    [
      {
        code: 'schedule-parent-unmapped',
        message: parentObjectId,
        path: 'parents',
      },
    ],
    { scope: { kind: 'tenant', tenantId: parts.tenantId } },
  );

/**
 * Record one schedule object-family mapping with the full schedule
 * discipline: family + kind check (canonical kind must equal the declared one
 * for the object kind), hierarchy check (the owning schedule mapping must
 * already exist for activities, dependencies, and baselines; BOTH the
 * predecessor and successor activity mappings for dependencies), then the
 * SDK's recordSourceMapping write path (its store enforces the
 * forward/reverse bijection — typed collisions on any remapping, never
 * overwrites).
 */
export async function recordScheduleObjectMapping(
  parts: RecordScheduleObjectMappingParts,
): Promise<Result<SourceMapping, DomainError>> {
  const objectKind = parseScheduleObjectKind(parts.coordinate.objectType);
  if (!objectKind.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `provider object type '${String(parts.coordinate.objectType)}' is not part of the schedule object family — the schedule reference layer only records project-schedule, activity, activity-dependency, and baseline mappings`,
        [
          {
            code: 'schedule-object-kind-unknown',
            message: String(parts.coordinate.objectType),
            path: 'coordinate.objectType',
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.tenantId } },
      ),
    );
  }
  const declaredKind = canonicalKindOfScheduleObjectKind(objectKind.value);
  if (parts.canonical.entityKind !== declaredKind) {
    return fail(
      domainError(
        'invariant-violation',
        `provider ${objectKind.value} object ${parts.coordinate.objectId} cannot be bound to canonical kind '${parts.canonical.entityKind}': the schedule contract declares '${declaredKind}' for that object kind`,
        [
          {
            code: 'schedule-mapping-kind-mismatch',
            message: `${parts.canonical.entityKind} vs ${declaredKind}`,
            path: 'canonical.entityKind',
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.tenantId } },
      ),
    );
  }

  // Hierarchy discipline: activities, dependencies, and baselines require
  // their owning SCHEDULE mapping — within the SAME tenant, adapter family,
  // and provider system.
  if (objectKind.value !== PROJECT_SCHEDULE_OBJECT_KIND) {
    if (parts.parents.schedule === null) {
      return fail(
        domainError(
          'invariant-violation',
          `recording a ${objectKind.value} mapping requires the owning project schedule's provider object id (parents.schedule)`,
          [
            {
              code: 'schedule-parent-required',
              message: 'project-schedule',
              path: 'parents.schedule',
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    const scheduleParent = await parts.store.findByCoordinate(
      parts.tenantId,
      sameFamilyCoordinate(parts.coordinate, PROJECT_SCHEDULE_OBJECT_KIND, parts.parents.schedule),
    );
    if (scheduleParent === null) {
      return fail(hierarchyError(parts, 'project-schedule', parts.parents.schedule));
    }
    const tenant = assertMappingTenant(scheduleParent, parts.tenantId);
    if (!tenant.ok) return tenant;
  }

  // Dependencies additionally require BOTH endpoint ACTIVITY mappings: a
  // dependency can never dangle above an unmapped activity on either side.
  if (objectKind.value === ACTIVITY_DEPENDENCY_OBJECT_KIND) {
    for (const [role, parentObjectId] of [
      ['predecessorActivity', parts.parents.predecessorActivity] as const,
      ['successorActivity', parts.parents.successorActivity] as const,
    ]) {
      if (parentObjectId === null) {
        return fail(
          domainError(
            'invariant-violation',
            `recording an activity-dependency mapping requires both endpoint activity provider object ids (parents.predecessorActivity and parents.successorActivity) — '${role}' is missing`,
            [
              {
                code: 'schedule-parent-required',
                message: 'activity',
                path: `parents.${role}`,
              },
            ],
            { scope: { kind: 'tenant', tenantId: parts.tenantId } },
          ),
        );
      }
      const activityParent = await parts.store.findByCoordinate(
        parts.tenantId,
        sameFamilyCoordinate(parts.coordinate, ACTIVITY_OBJECT_KIND, parentObjectId),
      );
      if (activityParent === null) {
        return fail(hierarchyError(parts, 'activity', parentObjectId, role));
      }
      const tenant = assertMappingTenant(activityParent, parts.tenantId);
      if (!tenant.ok) return tenant;
    }
  }

  return recordSourceMapping({
    store: parts.store,
    tenantId: parts.tenantId,
    coordinate: parts.coordinate,
    canonical: parts.canonical,
    providerVersion: parts.providerVersion,
    canonicalVersion: parts.canonicalVersion,
    actor: parts.actor,
    now: parts.now,
  });
}

/** Compose the same-family coordinate of a parent/child object id (local). */
function sameFamilyCoordinate(
  coordinate: SourceCoordinate,
  objectKind: string,
  objectId: string,
): SourceCoordinate {
  return sourceCoordinate({
    adapterKind: coordinate.adapterKind,
    systemId: coordinate.systemId,
    objectType: providerObjectKind(objectKind),
    objectId: providerObjectId(objectId),
  });
}

/**
 * Resolve one schedule object-family coordinate to its canonical EntityRef
 * within a tenant — null when unmapped (a foreign tenant's mapping is
 * indistinguishable from absence: the store keys by tenant first, A12).
 */
export async function resolveScheduleObject(
  store: SourceMappingStore,
  tenantId: TenantId,
  coordinate: ScheduleObjectCoordinate,
): Promise<EntityRef | null> {
  const mapping = await store.findByCoordinate(tenantId, coordinate);
  return mapping?.canonical ?? null;
}

/**
 * Resolve the canonical OWNING SCHEDULE of one schedule-family object (an
 * activity, a dependency, or a baseline): the entity its provider payload
 * references by provider schedule id, resolved through the shared
 * tenant-scoped mapping store. Fail-closed typed not-found when the schedule
 * is unmapped — nothing in the schedule family can dangle above an unmapped
 * schedule (the hierarchy discipline's read side).
 */
export async function resolveOwningSchedule(
  store: SourceMappingStore,
  tenantId: TenantId,
  parts: {
    /** The referencing object's provider coordinate (for error provenance). */
    readonly referencing: ScheduleObjectCoordinate;
    /** The owning project schedule's provider object id. */
    readonly scheduleProviderObjectId: string;
  },
): Promise<Result<EntityRef, DomainError>> {
  const scheduleMapping = await store.findByCoordinate(
    tenantId,
    sameFamilyCoordinate(parts.referencing, PROJECT_SCHEDULE_OBJECT_KIND, parts.scheduleProviderObjectId),
  );
  if (scheduleMapping === null) {
    return fail(
      domainError(
        'not-found',
        `provider object ${parts.referencing.objectId} references project-schedule provider object ${parts.scheduleProviderObjectId}, which has no mapping in tenant ${tenantId} — sync the project-schedule stream first`,
        [
          {
            code: 'schedule-parent-unmapped',
            message: parts.scheduleProviderObjectId,
            path: 'scheduleProviderObjectId',
          },
        ],
        { scope: { kind: 'tenant', tenantId } },
      ),
    );
  }
  const tenant = assertMappingTenant(scheduleMapping, tenantId);
  if (!tenant.ok) return tenant;
  const typed = assertScheduleObjectMapping(scheduleMapping);
  if (!typed.ok) return typed;
  return ok(scheduleMapping.canonical);
}

/**
 * Resolve the canonical ENDPOINT ACTIVITIES of one activity dependency: the
 * predecessor's and successor's canonical entities, both through the shared
 * tenant-scoped mapping store (the dependency's provider payload names both
 * endpoints). Fail-closed typed not-found when either endpoint is unmapped —
 * a dependency can never dangle above an unmapped activity.
 */
export async function resolveDependencyEndpoints(
  store: SourceMappingStore,
  tenantId: TenantId,
  parts: {
    /** The dependency's provider coordinate (for error provenance). */
    readonly dependency: ScheduleObjectCoordinate;
    /** The predecessor activity's provider object id. */
    readonly predecessorProviderObjectId: string;
    /** The successor activity's provider object id. */
    readonly successorProviderObjectId: string;
  },
): Promise<Result<{ predecessor: EntityRef; successor: EntityRef }, DomainError>> {
  const endpoints: EntityRef[] = [];
  for (const [role, parentObjectId] of [
    ['predecessorId', parts.predecessorProviderObjectId] as const,
    ['successorId', parts.successorProviderObjectId] as const,
  ]) {
    const activityMapping = await store.findByCoordinate(
      tenantId,
      sameFamilyCoordinate(parts.dependency, ACTIVITY_OBJECT_KIND, parentObjectId),
    );
    if (activityMapping === null) {
      return fail(
        domainError(
          'not-found',
          `dependency ${parts.dependency.objectId} references activity provider object ${parentObjectId} (${role}), which has no mapping in tenant ${tenantId} — sync the activity stream first`,
          [
            {
              code: 'schedule-parent-unmapped',
              message: parentObjectId,
              path: role,
            },
          ],
          { scope: { kind: 'tenant', tenantId } },
        ),
      );
    }
    const tenant = assertMappingTenant(activityMapping, tenantId);
    if (!tenant.ok) return tenant;
    const typed = assertScheduleObjectMapping(activityMapping);
    if (!typed.ok) return typed;
    endpoints.push(activityMapping.canonical);
  }
  const predecessor = endpoints[0];
  const successor = endpoints[1];
  if (predecessor === undefined || successor === undefined) {
    // Unreachable over the loop above — kept loud for future edits.
    throw new TypeError('dependency endpoint resolution lost an endpoint');
  }
  return ok({ predecessor, successor } satisfies { predecessor: EntityRef; successor: EntityRef });
}

/**
 * Reverse lookup: the provider coordinate bound to one canonical entity by
 * the schedule adapter (this adapter family's four object kinds only), or
 * null when the entity has no schedule-area binding in the tenant. The
 * office-side identity of a schedule object — e.g. for the outbound push
 * path (OFF-037+).
 */
export async function scheduleProviderCoordinateOf(
  store: SourceMappingStore,
  tenantId: TenantId,
  canonical: EntityRef,
): Promise<ScheduleObjectCoordinate | null> {
  const bound = await store.listByCanonical(tenantId, canonical);
  let first: ScheduleObjectCoordinate | null = null;
  for (const mapping of bound) {
    if (mapping.coordinate.adapterKind !== SCHEDULE_ADAPTER_KIND) continue;
    if (!parseScheduleObjectKind(mapping.coordinate.objectType).ok) continue;
    if (first === null) first = mapping.coordinate;
  }
  return first;
}

/** Canonical entity-reference order (kind, then id) — deterministic output. */
export function compareEntityRef(left: EntityRef, right: EntityRef): number {
  if (left.entityKind !== right.entityKind) {
    return left.entityKind < right.entityKind ? -1 : 1;
  }
  if (left.entityId !== right.entityId) {
    return left.entityId < right.entityId ? -1 : 1;
  }
  return 0;
}
