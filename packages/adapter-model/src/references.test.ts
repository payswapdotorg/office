import { describe, expect, it } from 'vitest';
import { formatEntityId, parseEntityRef, parseTenantId, parseTimestamp } from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import {
  createInMemorySourceMappingStore,
  providerObjectId,
  providerObjectKind,
  providerVersion,
  recordSourceMapping,
  sourceCoordinate,
} from '@office/adapters-sdk';
import type { SourceMapping, SourceMappingStore } from '@office/adapters-sdk';
import {
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
} from './vocabulary';
import { LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF } from './provider-fixture';
import {
  assertModelObjectMapping,
  compareEntityRef,
  modelProviderCoordinateOf,
  recordModelObjectMapping,
  resolveElementParentChain,
  resolveModelObject,
  resolveProviderLink,
  resolveProviderLinks,
} from './references';
import type { ModelObjectCoordinate } from './references';

// OFF-022 adapter-model — THE model reference contracts: provider
// model/version/element/classification ids map to canonical office
// EntityIds through tenant-scoped, kind-disciplined, hierarchy-disciplined
// records (A10: provider ids are NEVER primary keys; A11: remapping is an
// explicit conflict, never an overwrite). Deterministic: fixed ids and
// instants, injected stores only.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const TENANT_B: TenantId = unwrap(parseTenantId('office-tnt-v1-f9e8d7c6b5a493827160f5e4d3c2b1a0'));
const NOW: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `mdl${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));

const ACTOR = { kind: 'adapter', actorId: entity(90) } as const;

const coordinate = (objectKind: string, objectId: string): ModelObjectCoordinate =>
  sourceCoordinate({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: providerObjectKind(objectKind),
    objectId: providerObjectId(objectId),
  });

const record = async (
  store: SourceMappingStore,
  objectKind: string,
  objectId: string,
  canonical: EntityRef,
  parentProviderObjectId: string | null = null,
): Promise<Result<SourceMapping, DomainError>> => {
  // Elements hang off the hierarchy: seed their owning model + version first
  // (re-saving an established binding is an idempotent bookkeeping advance).
  if (objectKind === 'element') {
    unwrap(await record(store, 'model', 'm-tower-a', ref('model', entity(1))));
    unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('model-version', 'mv-tower-a-2'),
        canonical: ref('model-version', entity(3)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'm-tower-a',
      }),
    );
    return recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate(objectKind, objectId),
      canonical,
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: 'mv-tower-a-2',
    });
  }
  return recordModelObjectMapping({
    store,
    tenantId: TENANT_A,
    coordinate: coordinate(objectKind, objectId),
    canonical,
    providerVersion: providerVersion('v1'),
    canonicalVersion: version(1),
    actor: ACTOR,
    now: NOW,
    parentProviderObjectId,
  });
};

const foreignFamilyMapping = (canonical: EntityRef): SourceMapping => ({
  kind: 'source-mapping',
  tenantId: TENANT_A,
  coordinate: coordinate('contact', 'c-1'),
  canonical,
  providerVersion: providerVersion('v1'),
  canonicalVersion: version(1),
  actor: ACTOR,
  mappedAt: NOW,
  lastSyncedAt: NOW,
});

describe('recordModelObjectMapping — the kind discipline (A10)', () => {
  it('records a model-family mapping binding an office-issued canonical id', async () => {
    const store = createInMemorySourceMappingStore();
    const model = ref('model', entity(1));
    const recorded = unwrap(await record(store, 'model', 'm-tower-a', model));
    expect(recorded).toMatchObject({
      kind: 'source-mapping',
      tenantId: TENANT_A,
      canonical: { entityKind: 'model', entityId: entity(1) },
      providerVersion: 'v1',
      canonicalVersion: 1,
    });
    // A10: the canonical id is office-issued (opaque office id format), never
    // the provider's own object id.
    expect(recorded.canonical.entityId).toMatch(/^office-ent-v1-[0-9a-z]{16,64}$/);
    expect(recorded.canonical.entityId).not.toContain('m-tower-a');
  });

  it('rejects a binding whose canonical kind contradicts the declared kind for the object kind', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await record(store, 'model', 'm-tower-a', ref('element', entity(1)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('model-mapping-kind-mismatch');
    }
  });

  it('rejects a provider object kind outside the model family', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await record(store, 'contact', 'c-1', ref('organization', entity(1)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('model-object-kind-unknown');
    }
  });
});

describe('recordModelObjectMapping — the hierarchy discipline', () => {
  it('requires the parent model for a model-version mapping', async () => {
    const store = createInMemorySourceMappingStore();
    // No parent id at all: typed invariant-violation.
    const missing = await recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('model-version', 'mv-tower-a-1'),
      canonical: ref('model-version', entity(2)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: null,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.details[0]?.code).toBe('model-parent-required');
    }
    // Parent id given but unmapped: typed not-found, never an invented parent.
    const unmapped = await recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('model-version', 'mv-tower-a-1'),
      canonical: ref('model-version', entity(2)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: 'm-tower-a',
    });
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) {
      expect(unmapped.error.code).toBe('not-found');
      expect(unmapped.error.details[0]?.code).toBe('model-parent-unmapped');
    }
    // Parent mapped first: the version records fine.
    unwrap(await record(store, 'model', 'm-tower-a', ref('model', entity(1))));
    const recorded = unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('model-version', 'mv-tower-a-1'),
        canonical: ref('model-version', entity(2)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'm-tower-a',
      }),
    );
    expect(recorded.canonical.entityKind).toBe('model-version');
  });

  it('requires the owning model-version for an element mapping', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'model', 'm-tower-a', ref('model', entity(1))));
    // The version stream has not run yet: the element fails fail-closed.
    const orphan = await recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('element', 'el-wall-103'),
      canonical: ref('element', entity(4)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: 'mv-tower-a-2',
    });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.error.code).toBe('not-found');
      expect(orphan.error.details[0]?.code).toBe('model-parent-unmapped');
    }
    // Version mapped, then the element records against it.
    unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('model-version', 'mv-tower-a-2'),
        canonical: ref('model-version', entity(3)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'm-tower-a',
      }),
    );
    const recorded = unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('element', 'el-wall-103'),
        canonical: ref('element', entity(4)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'mv-tower-a-2',
      }),
    );
    expect(recorded.canonical.entityKind).toBe('element');
  });

  it('treats element-classification entries as roots (no parent requirement)', async () => {
    const store = createInMemorySourceMappingStore();
    const recorded = unwrap(
      await record(store, 'element-classification', 'cls-wall', ref('element-classification', entity(6))),
    );
    expect(recorded.canonical.entityKind).toBe('element-classification');
  });
});

describe('recordModelObjectMapping — the remapping discipline (A11)', () => {
  it('makes re-pointing a coordinate at a different canonical id an explicit conflict', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'element', 'el-wall-103', ref('element', entity(4))));
    const remap = await recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('element', 'el-wall-103'),
      canonical: ref('element', entity(5)),
      providerVersion: providerVersion('v2'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: 'mv-tower-a-2',
    });
    expect(remap.ok).toBe(false);
    if (!remap.ok) {
      expect(remap.error.code).toBe('invariant-violation');
      expect(remap.error.details[0]?.code).toBe('source-mapping-collision');
    }
    // The original binding is untouched — never an overwrite.
    const current = await store.findByCoordinate(TENANT_A, coordinate('element', 'el-wall-103'));
    expect(current?.canonical.entityId).toBe(entity(4));
  });

  it('makes a second provider object claiming a bound canonical id an explicit conflict', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'element', 'el-wall-103', ref('element', entity(4))));
    const claim = await recordModelObjectMapping({
      store,
      tenantId: TENANT_A,
      coordinate: coordinate('element', 'el-wall-999'),
      canonical: ref('element', entity(4)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      now: NOW,
      parentProviderObjectId: 'mv-tower-a-2',
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) {
      expect(claim.error.details[0]?.code).toBe('canonical-binding-collision');
    }
  });

  it('advances bookkeeping on re-saving the SAME binding (idempotent, mappedAt preserved)', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'element', 'el-wall-103', ref('element', entity(4))));
    const again = unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate('element', 'el-wall-103'),
        canonical: ref('element', entity(4)),
        providerVersion: providerVersion('v2'),
        canonicalVersion: version(2),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'mv-tower-a-2',
      }),
    );
    expect(again.providerVersion).toBe('v2');
    expect(again.canonicalVersion).toBe(2);
    expect(again.mappedAt).toBe(NOW);
  });
});

describe('assertModelObjectMapping — the typed view', () => {
  it('accepts a well-formed model-family mapping', async () => {
    const store = createInMemorySourceMappingStore();
    const mapping = unwrap(await record(store, 'model', 'm-tower-a', ref('model', entity(1))));
    expect(unwrap(assertModelObjectMapping(mapping))).toBe(mapping);
  });

  it('rejects foreign-family mappings and kind mismatches (never silently used)', () => {
    const foreignResult = assertModelObjectMapping(foreignFamilyMapping(ref('organization', entity(1))));
    expect(foreignResult.ok).toBe(false);
    if (!foreignResult.ok) {
      expect(foreignResult.error.details[0]?.code).toBe('model-object-kind-unknown');
    }

    const mismatchResult = assertModelObjectMapping(foreignFamilyMapping(ref('element', entity(1))));
    expect(mismatchResult.ok).toBe(false);
    if (!mismatchResult.ok) {
      expect(mismatchResult.error.details[0]?.code).toBe('model-object-kind-unknown');
    }
  });

  it('rejects a model-family coordinate bound to a contradicting canonical kind', () => {
    const mismatch: SourceMapping = {
      kind: 'source-mapping',
      tenantId: TENANT_A,
      coordinate: coordinate('model', 'm-tower-a'),
      canonical: ref('element', entity(1)),
      providerVersion: providerVersion('v1'),
      canonicalVersion: version(1),
      actor: ACTOR,
      mappedAt: NOW,
      lastSyncedAt: NOW,
    };
    const result = assertModelObjectMapping(mismatch);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('model-mapping-kind-mismatch');
    }
  });
});

describe('resolveModelObject — tenant-scoped resolution (A12)', () => {
  it('resolves within the owning tenant and is blind to foreign tenants', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'element', 'el-wall-103', ref('element', entity(4))));
    expect(await resolveModelObject(store, TENANT_A, coordinate('element', 'el-wall-103'))).toStrictEqual(
      ref('element', entity(4)),
    );
    // A foreign tenant sees absence — indistinguishable from unmapped.
    expect(await resolveModelObject(store, TENANT_B, coordinate('element', 'el-wall-103'))).toBeNull();
    expect(await resolveModelObject(store, TENANT_A, coordinate('element', 'el-none'))).toBeNull();
  });
});

describe('resolveElementParentChain — the element read side', () => {
  it('resolves the owning version and model canonically', async () => {
    const store = createInMemorySourceMappingStore();
    unwrap(await record(store, 'model', 'm-tower-a', ref('model', entity(1))));
    unwrap(
      await recordModelObjectMapping({
        store,
        tenantId: TENANT_A,
        coordinate: coordinate(MODEL_VERSION_OBJECT_KIND, 'mv-tower-a-2'),
        canonical: ref('model-version', entity(3)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
        parentProviderObjectId: 'm-tower-a',
      }),
    );
    const chain = unwrap(
      await resolveElementParentChain(store, TENANT_A, {
        element: coordinate('element', 'el-wall-103'),
        modelVersionProviderObjectId: 'mv-tower-a-2',
        modelProviderObjectId: 'm-tower-a',
      }),
    );
    expect(chain.modelVersion).toStrictEqual(ref('model-version', entity(3)));
    expect(chain.model).toStrictEqual(ref('model', entity(1)));
  });

  it('fails closed when the owning version is unmapped (elements never dangle)', async () => {
    const store = createInMemorySourceMappingStore();
    const result = await resolveElementParentChain(store, TENANT_A, {
      element: coordinate('element', 'el-wall-103'),
      modelVersionProviderObjectId: 'mv-tower-a-2',
      modelProviderObjectId: 'm-tower-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('model-parent-unmapped');
    }
  });
});

describe('modelProviderCoordinateOf — the reverse lookup', () => {
  it('finds this adapter family coordinate and ignores foreign families', async () => {
    const store = createInMemorySourceMappingStore();
    const model = ref('model', entity(1));
    unwrap(await record(store, 'model', 'm-tower-a', model));
    // A different adapter family's mapping bound to the SAME canonical entity.
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: sourceCoordinate({
          adapterKind: LINKED_ACTIVITY_REF.adapterKind,
          systemId: LINKED_ACTIVITY_REF.systemId,
          objectType: providerObjectKind('activity'),
          objectId: providerObjectId(LINKED_ACTIVITY_REF.objectId),
        }),
        canonical: model,
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
      }),
    );
    const coordinateFound = await modelProviderCoordinateOf(store, TENANT_A, model);
    expect(coordinateFound).toStrictEqual(coordinate(MODEL_OBJECT_KIND, 'm-tower-a'));
    expect(await modelProviderCoordinateOf(store, TENANT_B, model)).toBeNull();
    expect(await modelProviderCoordinateOf(store, TENANT_A, ref('model', entity(9)))).toBeNull();
  });
});

describe('resolveProviderLink(s) — cross-system link resolution', () => {
  const linkCoordinateOf = (link: typeof LINKED_ACTIVITY_REF): ModelObjectCoordinate =>
    sourceCoordinate({
      adapterKind: link.adapterKind,
      systemId: link.systemId,
      objectType: providerObjectKind(link.objectType),
      objectId: providerObjectId(link.objectId),
    });

  it('resolves one link through the shared tenant-scoped store', async () => {
    const store = createInMemorySourceMappingStore();
    const activity = ref('activity', entity(80));
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: linkCoordinateOf(LINKED_ACTIVITY_REF),
        canonical: activity,
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
      }),
    );
    expect(await resolveProviderLink(store, TENANT_A, LINKED_ACTIVITY_REF)).toStrictEqual(activity);
    expect(await resolveProviderLink(store, TENANT_A, LINKED_DOCUMENT_REF)).toBeNull();
  });

  it('resolves a whole link list ALL-OR-NOTHING (fail-closed, canonical order)', async () => {
    const store = createInMemorySourceMappingStore();
    // Only the activity is mapped: the document link fails the whole set.
    unwrap(
      await recordSourceMapping({
        store,
        tenantId: TENANT_A,
        coordinate: linkCoordinateOf(LINKED_ACTIVITY_REF),
        canonical: ref('activity', entity(80)),
        providerVersion: providerVersion('v1'),
        canonicalVersion: version(1),
        actor: ACTOR,
        now: NOW,
      }),
    );
    const partial = await resolveProviderLinks(store, TENANT_A, [
      LINKED_ACTIVITY_REF,
      LINKED_DOCUMENT_REF,
    ]);
    expect(partial.ok).toBe(false);
    if (!partial.ok) {
      expect(partial.error.code).toBe('not-found');
      expect(partial.error.details[0]?.code).toBe('provider-link-unresolved');
    }
  });

  it('returns resolved links in canonical entity order', async () => {
    const store = createInMemorySourceMappingStore();
    for (const [link, canonical] of [
      [LINKED_DOCUMENT_REF, ref('document', entity(81))],
      [LINKED_ACTIVITY_REF, ref('activity', entity(80))],
    ] as const) {
      unwrap(
        await recordSourceMapping({
          store,
          tenantId: TENANT_A,
          coordinate: linkCoordinateOf(link),
          canonical,
          providerVersion: providerVersion('v1'),
          canonicalVersion: version(1),
          actor: ACTOR,
          now: NOW,
        }),
      );
    }
    const resolved = unwrap(
      await resolveProviderLinks(store, TENANT_A, [LINKED_DOCUMENT_REF, LINKED_ACTIVITY_REF]),
    );
    expect(resolved).toStrictEqual([ref('activity', entity(80)), ref('document', entity(81))]);
  });
});

describe('compareEntityRef — canonical ordering', () => {
  it('orders by kind then id', () => {
    expect(compareEntityRef(ref('activity', entity(1)), ref('document', entity(1)))).toBe(-1);
    expect(compareEntityRef(ref('element', entity(4)), ref('element', entity(5)))).toBe(-1);
    expect(compareEntityRef(ref('element', entity(5)), ref('element', entity(4)))).toBe(1);
    expect(compareEntityRef(ref('model', entity(1)), ref('model', entity(1)))).toBe(0);
  });
});
