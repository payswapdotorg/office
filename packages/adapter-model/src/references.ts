// Office adapter-model — the model reference contracts (OFF-022).
//
// THE typed mapping from provider model/version/element/classification ids
// to canonical office EntityIds (freeze A10: provider ids are NEVER primary
// keys — the binding is a first-class, tenant-scoped, queryable record; A12:
// every operation is keyed by tenant first). This module layers the MODEL
// discipline on top of the OFF-020 SDK's SourceMapping store:
//
//   - KIND DISCIPLINE — a mapping record for a model object family
//     coordinate must bind a canonical entity of the DECLARED canonical kind
//     for that object kind (a 'model' coordinate bound to a 'model-version'
//     canonical id is a typed invariant-violation, never silently used);
//   - HIERARCHY DISCIPLINE — a model-version mapping can only be recorded
//     when its parent MODEL mapping already exists (same tenant, same
//     adapter family + provider system), and an element mapping only when
//     its owning model-VERSION mapping exists: elements can never dangle
//     above an unmapped version, and versions never above an unmapped model
//     (fail-closed typed 'not-found', never an invented parent);
//   - REMAPPING DISCIPLINE — re-pointing a coordinate at a different
//     canonical id, or a second provider object claiming a bound canonical
//     id, is the SDK store's typed collision (explicit conflict, never an
//     overwrite — no last-write-wins anywhere);
//   - LINK RESOLUTION — provider-side link references (an element's linked
//     activity/document in ANOTHER provider system) resolve to canonical
//     EntityRefs through the SAME shared, tenant-scoped mapping store the
//     other adapters' syncs populate; an unresolved link is a typed
//     not-found (all-or-nothing resolution — the canonical element-change
//     event never carries a half-resolved link set).
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
  sourceCoordinateKeyOf,
} from '@office/adapters-sdk';
import type {
  ProviderVersion,
  SourceCoordinate,
  SourceMapping,
  SourceMappingStore,
} from '@office/adapters-sdk';
import {
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_VERSION_OBJECT_KIND,
  canonicalKindOfModelObjectKind,
  parseModelObjectKind,
  providerLinkRefKeyOf,
} from './vocabulary';
import type { ProviderLinkRef } from './vocabulary';

/**
 * A SourceCoordinate whose object type belongs to the model object family
 * ('model' | 'model-version' | 'element' | 'element-classification') — the
 * family membership is enforced fail-closed at runtime by
 * parseModelObjectKind (the repo's branded-type + total-parse idiom: the
// SDK's ProviderObjectKind brand is open, the family is a closed vocabulary).
 */
export type ModelObjectCoordinate = SourceCoordinate;

/**
 * Typed view of one SourceMapping record as a model object-family
 * reference: verifies BOTH sides of the kind discipline — the coordinate's
 * object type is a model family kind AND the canonical entity kind is the
 * one declared for that object kind. A mismatch is a typed
 * invariant-violation carrying both sides (never silently used data).
 */
export function assertModelObjectMapping(
  mapping: SourceMapping,
): Result<SourceMapping, DomainError> {
  const objectKind = parseModelObjectKind(mapping.coordinate.objectType);
  if (!objectKind.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `mapping for provider object ${sourceCoordinateKeyOf(mapping.coordinate)} is not a model object-family mapping (object type '${mapping.coordinate.objectType}')`,
        [
          {
            code: 'model-object-kind-unknown',
            message: mapping.coordinate.objectType,
            path: 'coordinate.objectType',
          },
        ],
        { scope: { kind: 'tenant', tenantId: mapping.tenantId } },
      ),
    );
  }
  const declaredKind = canonicalKindOfModelObjectKind(objectKind.value);
  if (mapping.canonical.entityKind !== declaredKind) {
    return fail(
      domainError(
        'invariant-violation',
        `provider ${objectKind.value} object ${mapping.coordinate.objectId} is mapped to canonical kind '${mapping.canonical.entityKind}' but the model contract declares '${declaredKind}' for that object kind — the binding is an explicit conflict, never silently used`,
        [
          {
            code: 'model-mapping-kind-mismatch',
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

/** Inputs of recordModelObjectMapping (the runtime's model write path). */
export interface RecordModelObjectMappingParts {
  /** The shared, tenant-scoped source-mapping store (the SDK port). */
  readonly store: SourceMappingStore;
  readonly tenantId: TenantId;
  /** The model object-family coordinate being bound (validated fail-closed). */
  readonly coordinate: ModelObjectCoordinate;
  /** The office-issued canonical entity this provider object maps into. */
  readonly canonical: EntityRef;
  readonly providerVersion: ProviderVersion;
  readonly canonicalVersion: AggregateVersion;
  readonly actor: Actor;
  readonly now: Timestamp;
  /**
   * The provider object id of the PARENT object whose mapping must already
   * exist: the owning model for a model-version, the owning model-version
   * for an element. Required exactly when the object kind has a parent
   * (the model hierarchy discipline); ignored for roots.
   */
  readonly parentProviderObjectId: string | null;
}

const hierarchyError = (
  parts: RecordModelObjectMappingParts,
  parentKind: string,
  parentObjectId: string,
): DomainError =>
  domainError(
    'not-found',
    `cannot record ${parts.coordinate.objectType} mapping for provider object ${parts.coordinate.objectId}: the parent ${parentKind} mapping for provider object ${parentObjectId} does not exist in tenant ${parts.tenantId} — sync the parent stream first (the model hierarchy discipline)`,
    [
      {
        code: 'model-parent-unmapped',
        message: parentObjectId,
        path: 'parentProviderObjectId',
      },
    ],
    { scope: { kind: 'tenant', tenantId: parts.tenantId } },
  );

/**
 * Record one model object-family mapping with the full model discipline:
 * family + kind check (canonical kind must equal the declared one for the
 * object kind), hierarchy check (the parent mapping must already exist when
 * the object kind has one), then the SDK's recordSourceMapping write path
 * (its store enforces the forward/reverse bijection — typed collisions on
 * any remapping, never overwrites).
 */
export async function recordModelObjectMapping(
  parts: RecordModelObjectMappingParts,
): Promise<Result<SourceMapping, DomainError>> {
  const objectKind = parseModelObjectKind(parts.coordinate.objectType);
  if (!objectKind.ok) {
    return fail(
      domainError(
        'invariant-violation',
        `provider object type '${String(parts.coordinate.objectType)}' is not part of the model object family — the model reference layer only records model, model-version, element, and element-classification mappings`,
        [
          {
            code: 'model-object-kind-unknown',
            message: String(parts.coordinate.objectType),
            path: 'coordinate.objectType',
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.tenantId } },
      ),
    );
  }
  const declaredKind = canonicalKindOfModelObjectKind(objectKind.value);
  if (parts.canonical.entityKind !== declaredKind) {
    return fail(
      domainError(
        'invariant-violation',
        `provider ${objectKind.value} object ${parts.coordinate.objectId} cannot be bound to canonical kind '${parts.canonical.entityKind}': the model contract declares '${declaredKind}' for that object kind`,
        [
          {
            code: 'model-mapping-kind-mismatch',
            message: `${parts.canonical.entityKind} vs ${declaredKind}`,
            path: 'canonical.entityKind',
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.tenantId } },
      ),
    );
  }

  // Hierarchy discipline: versions require their model, elements their
  // version — within the SAME tenant, adapter family, and provider system.
  if (objectKind.value === MODEL_VERSION_OBJECT_KIND) {
    const parentObjectId = parts.parentProviderObjectId;
    if (parentObjectId === null) {
      return fail(
        domainError(
          'invariant-violation',
          'recording a model-version mapping requires the parent model provider object id (parentProviderObjectId)',
          [
            { code: 'model-parent-required', message: 'model', path: 'parentProviderObjectId' },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    const parent = await parts.store.findByCoordinate(
      parts.tenantId,
      sameFamilyCoordinate(parts.coordinate, MODEL_OBJECT_KIND, parentObjectId),
    );
    if (parent === null) {
      return fail(hierarchyError(parts, 'model', parentObjectId));
    }
    const tenant = assertMappingTenant(parent, parts.tenantId);
    if (!tenant.ok) return tenant;
  }
  if (objectKind.value === 'element') {
    const parentObjectId = parts.parentProviderObjectId;
    if (parentObjectId === null) {
      return fail(
        domainError(
          'invariant-violation',
          'recording an element mapping requires the owning model-version provider object id (parentProviderObjectId)',
          [
            {
              code: 'model-parent-required',
              message: 'model-version',
              path: 'parentProviderObjectId',
            },
          ],
          { scope: { kind: 'tenant', tenantId: parts.tenantId } },
        ),
      );
    }
    const parent = await parts.store.findByCoordinate(
      parts.tenantId,
      sameFamilyCoordinate(parts.coordinate, MODEL_VERSION_OBJECT_KIND, parentObjectId),
    );
    if (parent === null) {
      return fail(hierarchyError(parts, 'model-version', parentObjectId));
    }
    const tenant = assertMappingTenant(parent, parts.tenantId);
    if (!tenant.ok) return tenant;
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
 * Resolve one model object-family coordinate to its canonical EntityRef
 * within a tenant — null when unmapped (a foreign tenant's mapping is
 * indistinguishable from absence: the store keys by tenant first, A12).
 */
export async function resolveModelObject(
  store: SourceMappingStore,
  tenantId: TenantId,
  coordinate: ModelObjectCoordinate,
): Promise<EntityRef | null> {
  const mapping = await store.findByCoordinate(tenantId, coordinate);
  return mapping?.canonical ?? null;
}

/** The typed parent chain of one element (its version and model). */
export interface ElementParentChain {
  /** The owning model-version's canonical entity. */
  readonly modelVersion: EntityRef;
  /** The owning model's canonical entity. */
  readonly model: EntityRef;
}

/**
 * Resolve the canonical parent chain of one ELEMENT: the owning
 * model-version's canonical entity and the owning model's, both through the
 * shared tenant-scoped mapping store (the element's provider payload names
 * both parents). Fail-closed typed not-found when either parent is unmapped
 * — an element can never dangle above an unmapped version (the hierarchy
 * discipline's read side).
 */
export async function resolveElementParentChain(
  store: SourceMappingStore,
  tenantId: TenantId,
  parents: {
    /** The element's provider coordinate (for error provenance). */
    readonly element: ModelObjectCoordinate;
    /** The owning model-version's provider object id. */
    readonly modelVersionProviderObjectId: string;
    /** The owning model's provider object id. */
    readonly modelProviderObjectId: string;
  },
): Promise<Result<ElementParentChain, DomainError>> {
  const versionMapping = await store.findByCoordinate(
    tenantId,
    sameFamilyCoordinate(
      parents.element,
      MODEL_VERSION_OBJECT_KIND,
      parents.modelVersionProviderObjectId,
    ),
  );
  if (versionMapping === null) {
    return fail(
      domainError(
        'not-found',
        `element ${parents.element.objectId} references model-version provider object ${parents.modelVersionProviderObjectId}, which has no mapping in tenant ${tenantId} — sync the model-version stream first`,
        [
          {
            code: 'model-parent-unmapped',
            message: parents.modelVersionProviderObjectId,
            path: 'modelVersionProviderObjectId',
          },
        ],
        { scope: { kind: 'tenant', tenantId } },
      ),
    );
  }
  const versionTenant = assertMappingTenant(versionMapping, tenantId);
  if (!versionTenant.ok) return versionTenant;
  const versionTyped = assertModelObjectMapping(versionMapping);
  if (!versionTyped.ok) return versionTyped;

  const modelMapping = await store.findByCoordinate(
    tenantId,
    sameFamilyCoordinate(parents.element, MODEL_OBJECT_KIND, parents.modelProviderObjectId),
  );
  if (modelMapping === null) {
    return fail(
      domainError(
        'not-found',
        `element ${parents.element.objectId} references model provider object ${parents.modelProviderObjectId}, which has no mapping in tenant ${tenantId}`,
        [
          {
            code: 'model-parent-unmapped',
            message: parents.modelProviderObjectId,
            path: 'modelProviderObjectId',
          },
        ],
        { scope: { kind: 'tenant', tenantId } },
      ),
    );
  }
  const modelTenant = assertMappingTenant(modelMapping, tenantId);
  if (!modelTenant.ok) return modelTenant;
  const modelTyped = assertModelObjectMapping(modelMapping);
  if (!modelTyped.ok) return modelTyped;

  return ok({
    modelVersion: versionMapping.canonical,
    model: modelMapping.canonical,
  } satisfies ElementParentChain);
}

/**
 * Reverse lookup: the provider coordinate bound to one canonical entity by
 * the model adapter (this adapter family's four object kinds only), or null
 * when the entity has no model-area binding in the tenant. The office-side
 * identity of a model object — e.g. for the outbound push path (OFF-037+).
 */
export async function modelProviderCoordinateOf(
  store: SourceMappingStore,
  tenantId: TenantId,
  canonical: EntityRef,
): Promise<ModelObjectCoordinate | null> {
  const bound = await store.listByCanonical(tenantId, canonical);
  let first: ModelObjectCoordinate | null = null;
  for (const mapping of bound) {
    if (mapping.coordinate.adapterKind !== MODEL_ADAPTER_KIND) continue;
    if (!parseModelObjectKind(mapping.coordinate.objectType).ok) continue;
    if (first === null) first = mapping.coordinate;
  }
  return first;
}

/**
 * Resolve ONE provider-side link reference to its canonical EntityRef
 * through the shared tenant-scoped mapping store — or null when the linked
 * provider object has no mapping yet (the linked entity's own adapter has
 * not synced it, or it belongs to a foreign tenant — indistinguishable).
 */
export async function resolveProviderLink(
  store: SourceMappingStore,
  tenantId: TenantId,
  link: ProviderLinkRef,
): Promise<EntityRef | null> {
  const mapping = await store.findByCoordinate(tenantId, {
    adapterKind: link.adapterKind,
    systemId: link.systemId,
    objectType: providerObjectKind(link.objectType),
    objectId: providerObjectId(link.objectId),
  });
  return mapping?.canonical ?? null;
}

/**
 * Resolve a whole provider link-reference list to canonical EntityRefs,
 * ALL-OR-NOTHING: every link must resolve within the tenant, or the result
 * is a typed not-found naming the first unresolved link (the canonical
 * element-change event never carries a half-resolved link set — fail
 * closed, never silently dropped). Output is in canonical entity order.
 */
export async function resolveProviderLinks(
  store: SourceMappingStore,
  tenantId: TenantId,
  links: readonly ProviderLinkRef[],
): Promise<Result<readonly EntityRef[], DomainError>> {
  const resolved: EntityRef[] = [];
  for (const link of links) {
    const canonical = await resolveProviderLink(store, tenantId, link);
    if (canonical === null) {
      return fail(
        domainError(
          'not-found',
          `provider link ${providerLinkRefKeyOf(link)} has no canonical mapping in tenant ${tenantId} — the linked entity's adapter has not synced it yet; resolve the link (or sync its stream) before executing the element change`,
          [
            {
              code: 'provider-link-unresolved',
              message: link.objectId,
              path: null,
            },
          ],
          { scope: { kind: 'tenant', tenantId } },
        ),
      );
    }
    resolved.push(canonical);
  }
  resolved.sort(compareEntityRef);
  return ok(resolved);
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
