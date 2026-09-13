import { describe, expect, it } from 'vitest';
import {
  formatEntityId,
  parseCausationId,
  parseDomainEventEnvelope,
  parseEntityRef,
  parseEventName,
  parseTenantId,
  parseTimestamp,
  CURRENT_SCHEMA_VERSION,
} from '@office/contracts';
import type { EntityRef, TenantId, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { AggregateVersion } from '@office/domain-kernel';
import {
  adapterAuthorizationContext,
  adapterCommandEnvelope,
  providerObjectKind,
  providerObjectId,
  providerVersion,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import type { AdapterCommandInput, AdapterCommandProposal } from '@office/adapters-sdk';
import {
  ELEMENT_CHANGED_EVENT,
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  ELEMENT_RETIRED_EVENT,
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_REGISTERED_EVENT,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
  RECORD_ELEMENT_CHANGE_COMMAND,
  REGISTER_CLASSIFICATION_COMMAND,
  REGISTER_MODEL_COMMAND,
  REGISTER_MODEL_VERSION_COMMAND,
  RETIRE_ELEMENT_COMMAND,
  UPDATE_CLASSIFICATION_COMMAND,
  UPDATE_MODEL_COMMAND,
  parseElementClassification,
  parseElementQuantity,
} from './vocabulary';
import type { ElementClassification, ElementQuantity } from './vocabulary';
import {
  LINKED_ACTIVITY_REF,
  LINKED_DOCUMENT_REF,
  TOWER_MODEL_ID,
  TOWER_MODEL_V2_ID,
  WALL_ELEMENT_ID,
} from './provider-fixture';
import { createModelTranslator } from './change-mapping';
import {
  elementChangedEnvelope,
  elementRetiredEnvelope,
  modelEventEnvelope,
  parseClassificationProviderData,
  parseElementChangedPayload,
  parseElementProviderData,
  parseElementRetiredPayload,
  parseModelEventPayload,
  parseModelProviderData,
  parseModelRegisteredPayload,
  parseModelVersionProviderData,
} from './change-mapping';
import type { ElementChangedEnvelopeParts } from './change-mapping';
import type { CommandEnvelope } from '@office/contracts';

// OFF-022 adapter-model — the change-event mapping: the command translator
// (provider mutations → canonical models-area command proposals), the strict
// fail-closed event payload parses, and the trusted envelope builders (the
// host-side execution seam). Deterministic: fixed ids and instants only.

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

const TENANT_A: TenantId = unwrap(parseTenantId('office-tnt-v1-0a1b2c3d4e5f60718293a4b5c6d7e8f9'));
const NOW_1: Timestamp = unwrap(parseTimestamp('2026-10-06T09:00:00.000Z'));
const NOW_2: Timestamp = unwrap(parseTimestamp('2026-10-07T12:30:00.000Z'));

const entity = (n: number) =>
  formatEntityId({ version: 'v1', opaque: `mdl${String(n).padStart(13, '0')}` });
const version = (n: number): AggregateVersion => unwrap(parseAggregateVersion(n));
const ref = (kind: string, id: ReturnType<typeof entity>): EntityRef =>
  unwrap(parseEntityRef({ entityKind: kind, entityId: id }));
const classification = (code: string): ElementClassification =>
  unwrap(parseElementClassification(code));
const quantityOf = (value: number, unit: string): ElementQuantity =>
  unwrap(parseElementQuantity({ value, unit }));

const CONTEXT = adapterAuthorizationContext({
  actorId: entity(90),
  scope: { kind: 'tenant', tenantId: TENANT_A },
  capabilities: ['models.write'],
});

const WALL_ELEMENT_REF = ref('element', entity(4));
const MODEL_REF = ref('model', entity(1));
const MODEL_VERSION_REF = ref('model-version', entity(3));

const WALL_DATA = {
  modelId: TOWER_MODEL_ID,
  modelVersionId: TOWER_MODEL_V2_ID,
  classification: 'wall',
  quantity: { value: 42.5, unit: 'm2' },
  linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
};

const elementSource = (objectVersion: string) =>
  sourceRef({
    adapterKind: MODEL_ADAPTER_KIND,
    systemId: MODEL_SYSTEM_ID,
    objectType: ELEMENT_OBJECT_KIND,
    objectId: providerObjectId(WALL_ELEMENT_ID),
    version: providerVersion(objectVersion),
  });

const input = (over: Partial<AdapterCommandInput>): AdapterCommandInput => ({
  origin: 'sync',
  tenantId: TENANT_A,
  source: elementSource('v2'),
  canonical: WALL_ELEMENT_REF,
  canonicalVersion: version(1),
  changeKind: 'updated',
  displayName: 'Wall 103 — grid B/4',
  data: WALL_DATA,
  ...over,
});

const translator = () => createModelTranslator();

const proposalOf = (cmd: AdapterCommandInput): AdapterCommandProposal =>
  unwrap(translator().proposeCommand(cmd));

const commandOf = (cmd: AdapterCommandInput): CommandEnvelope<unknown> =>
  adapterCommandEnvelope({
    proposal: proposalOf(cmd),
    context: CONTEXT,
    source: cmd.source,
    causationId: null,
    now: NOW_1,
  });

describe('the model command translator', () => {
  it('proposes models.recordElementChange for an element update', () => {
    const proposal = proposalOf(input({}));
    expect(proposal.commandName).toBe(RECORD_ELEMENT_CHANGE_COMMAND);
    expect(proposal.commandName).toBe('models.recordElementChange');
    expect(proposal.payload).toStrictEqual({
      elementId: entity(4),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      classification: 'wall',
      quantity: { value: 42.5, unit: 'm2' },
      modelProviderId: TOWER_MODEL_ID,
      modelVersionProviderId: TOWER_MODEL_V2_ID,
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      expectedVersion: 1,
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(elementSource('v2')),
        providerData: WALL_DATA,
      },
    });
  });

  it('proposes the element change with the created kind and a display-name fallback', () => {
    const proposal = proposalOf(
      input({ changeKind: 'created', displayName: null, canonicalVersion: null }),
    );
    expect(proposal.payload['change']).toBe('created');
    expect(proposal.payload['displayName']).toBe(`element-${WALL_ELEMENT_ID}`);
    expect(proposal.payload['expectedVersion']).toBe(1);
  });

  it('proposes models.retireElement for an element delete-of-version (history persists)', () => {
    const proposal = proposalOf(input({ changeKind: 'deleted' }));
    expect(proposal.commandName).toBe(RETIRE_ELEMENT_COMMAND);
    expect(proposal.commandName).toBe('models.retireElement');
    expect(proposal.payload).toStrictEqual({
      elementId: entity(4),
      classification: 'wall',
      modelProviderId: TOWER_MODEL_ID,
      modelVersionProviderId: TOWER_MODEL_V2_ID,
      expectedVersion: 1,
      extensionMetadata: { sourceKey: sourceRefKeyOf(elementSource('v2')) },
    });
  });

  it('rejects a provider deletion of a container (the history is append-only)', () => {
    for (const objectKind of [
      MODEL_OBJECT_KIND,
      MODEL_VERSION_OBJECT_KIND,
      ELEMENT_CLASSIFICATION_OBJECT_KIND,
    ]) {
      const result = translator().proposeCommand(
        input({
          source: sourceRef({
            adapterKind: MODEL_ADAPTER_KIND,
            systemId: MODEL_SYSTEM_ID,
            objectType: objectKind,
            objectId: providerObjectId('m-tower-a'),
            version: providerVersion('v2'),
          }),
          changeKind: 'deleted',
          data: { discipline: 'structure' },
        }),
      );
      expect(result.ok, objectKind).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invariant-violation');
        expect(result.error.details[0]?.code).toBe('model-history-immutable');
      }
    }
  });

  it('proposes models.registerModel / models.updateModel for model lifecycle', () => {
    const modelSource = sourceRef({
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: MODEL_OBJECT_KIND,
      objectId: providerObjectId(TOWER_MODEL_ID),
      version: providerVersion('v1'),
    });
    const created = proposalOf(
      input({
        source: modelSource,
        changeKind: 'created',
        canonical: null,
        canonicalVersion: null,
        displayName: 'Tower A — structural model',
        data: { discipline: 'structure' },
      }),
    );
    expect(created.commandName).toBe(REGISTER_MODEL_COMMAND);
    expect(created.payload).toStrictEqual({
      name: 'Tower A — structural model',
      discipline: 'structure',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(modelSource),
        providerData: { discipline: 'structure' },
      },
    });

    const updated = proposalOf(
      input({
        source: modelSource,
        changeKind: 'updated',
        canonical: MODEL_REF,
        canonicalVersion: version(2),
        displayName: 'Tower A — structural model (revised)',
        data: { discipline: 'structure' },
      }),
    );
    expect(updated.commandName).toBe(UPDATE_MODEL_COMMAND);
    expect(updated.payload).toStrictEqual({
      modelId: entity(1),
      expectedVersion: 2,
      changes: { name: 'Tower A — structural model (revised)', discipline: 'structure' },
    });
  });

  it('falls back to a provider-derived model name when the snapshot carries none', () => {
    const proposal = proposalOf(
      input({
        changeKind: 'created',
        canonical: null,
        canonicalVersion: null,
        displayName: null,
        data: { discipline: 'architecture' },
        source: sourceRef({
          adapterKind: MODEL_ADAPTER_KIND,
          systemId: MODEL_SYSTEM_ID,
          objectType: MODEL_OBJECT_KIND,
          objectId: providerObjectId(TOWER_MODEL_ID),
          version: providerVersion('v1'),
        }),
      }),
    );
    expect(proposal.payload['name']).toBe(`model-${TOWER_MODEL_ID}`);
  });

  it('proposes models.registerModelVersion for a NEW version and rejects in-place updates', () => {
    const versionSource = sourceRef({
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: MODEL_VERSION_OBJECT_KIND,
      objectId: providerObjectId('mv-tower-a-2'),
      version: providerVersion('v1'),
    });
    const registered = proposalOf(
      input({
        source: versionSource,
        changeKind: 'created',
        canonical: MODEL_VERSION_REF,
        data: { modelId: TOWER_MODEL_ID, label: 'coordination-2026-10-05' },
      }),
    );
    expect(registered.commandName).toBe(REGISTER_MODEL_VERSION_COMMAND);
    expect(registered.payload).toStrictEqual({
      modelVersionId: entity(3),
      parentModelProviderId: TOWER_MODEL_ID,
      label: 'coordination-2026-10-05',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(versionSource),
        providerData: { modelId: TOWER_MODEL_ID, label: 'coordination-2026-10-05' },
      },
    });

    const inPlace = translator().proposeCommand(
      input({
        source: versionSource,
        changeKind: 'updated',
        data: { modelId: TOWER_MODEL_ID, label: 'coordination-2026-10-06' },
      }),
    );
    expect(inPlace.ok).toBe(false);
    if (!inPlace.ok) {
      expect(inPlace.error.code).toBe('invariant-violation');
      expect(inPlace.error.details[0]?.code).toBe('model-version-immutable');
    }
  });

  it('proposes models.registerClassification / models.updateClassification', () => {
    const classificationSource = sourceRef({
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: ELEMENT_CLASSIFICATION_OBJECT_KIND,
      objectId: providerObjectId('cls-wall'),
      version: providerVersion('v1'),
    });
    const classificationCanonical = ref('element-classification', entity(6));
    const registered = proposalOf(
      input({
        source: classificationSource,
        changeKind: 'created',
        canonical: classificationCanonical,
        data: { code: 'wall', description: 'Vertical planar building element' },
      }),
    );
    expect(registered.commandName).toBe(REGISTER_CLASSIFICATION_COMMAND);
    expect(registered.payload).toStrictEqual({
      classificationId: entity(6),
      code: 'wall',
      description: 'Vertical planar building element',
      extensionMetadata: {
        sourceKey: sourceRefKeyOf(classificationSource),
        providerData: { code: 'wall', description: 'Vertical planar building element' },
      },
    });

    const updated = proposalOf(
      input({
        source: classificationSource,
        changeKind: 'updated',
        canonical: classificationCanonical,
        canonicalVersion: version(3),
        data: { code: 'wall', description: 'Vertical planar building element (revised)' },
      }),
    );
    expect(updated.commandName).toBe(UPDATE_CLASSIFICATION_COMMAND);
    expect(updated.payload).toStrictEqual({
      classificationId: entity(6),
      expectedVersion: 3,
      changes: { description: 'Vertical planar building element (revised)' },
    });
  });

  it('rejects object kinds outside the model family', () => {
    const result = translator().proposeCommand(
      input({
        source: sourceRef({
          adapterKind: MODEL_ADAPTER_KIND,
          systemId: MODEL_SYSTEM_ID,
          objectType: providerObjectKind('contact'),
          objectId: providerObjectId('c-1'),
          version: providerVersion('v1'),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details[0]?.code).toBe('model-object-kind-unknown');
    }
  });

  it('requires a resolved canonical target where the discipline demands one', () => {
    const result = translator().proposeCommand(input({ canonical: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(result.error.details[0]?.code).toBe('canonical-target-required');
    }
  });

  it('fails closed on malformed provider payloads (typed, never coerced)', () => {
    const missing = translator().proposeCommand(
      input({ data: { modelId: TOWER_MODEL_ID, modelVersionId: TOWER_MODEL_V2_ID, classification: 'wall' } }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('invariant-violation');
      expect(missing.error.details[0]?.code).toBe('provider-data-missing-field');
    }

    const badClassification = translator().proposeCommand(
      input({ data: { ...WALL_DATA, classification: 'roof' } }),
    );
    expect(badClassification.ok).toBe(false);
    if (!badClassification.ok) {
      expect(badClassification.error.details[0]?.code).toBe('provider-data-invalid-value');
    }

    const badQuantity = translator().proposeCommand(
      input({ data: { ...WALL_DATA, quantity: { value: -1, unit: 'm2' } } }),
    );
    expect(badQuantity.ok).toBe(false);
    if (!badQuantity.ok) {
      expect(badQuantity.error.details[0]?.code).toBe('provider-data-invalid-value');
    }
  });

  it('is deterministic: the same input proposes the identical payload twice', () => {
    expect(proposalOf(input({}))).toStrictEqual(proposalOf(input({})));
  });
});

describe('provider payload parses (the extension bag model-family fields)', () => {
  it('parses model payloads fail-closed', () => {
    expect(unwrap(parseModelProviderData({ discipline: 'structure' }))).toStrictEqual({
      discipline: 'structure',
    });
    expect(parseModelProviderData({ discipline: 'hvac' }).ok).toBe(false);
    expect(parseModelProviderData({}).ok).toBe(false);
  });

  it('parses model-version payloads fail-closed', () => {
    expect(
      unwrap(parseModelVersionProviderData({ modelId: 'm-tower-a', label: 'baseline-2026-09-01' })),
    ).toStrictEqual({ modelId: 'm-tower-a', label: 'baseline-2026-09-01' });
    expect(parseModelVersionProviderData({ modelId: 'm tower', label: 'x' }).ok).toBe(false);
    expect(parseModelVersionProviderData({ modelId: 'm-tower-a' }).ok).toBe(false);
    expect(
      parseModelVersionProviderData({ modelId: 'm-tower-a', label: '' }).ok,
    ).toBe(false);
  });

  it('parses classification payloads fail-closed', () => {
    expect(
      unwrap(parseClassificationProviderData({ code: 'wall', description: 'Vertical planar building element' })),
    ).toStrictEqual({ code: 'wall', description: 'Vertical planar building element' });
    expect(parseClassificationProviderData({ code: 'roof', description: 'x' }).ok).toBe(false);
    expect(parseClassificationProviderData({ code: 'wall' }).ok).toBe(false);
  });

  it('parses element payloads (quantities optional, links strict) fail-closed', () => {
    const parsed = unwrap(parseElementProviderData(WALL_DATA));
    expect(parsed).toStrictEqual({
      modelId: TOWER_MODEL_ID,
      modelVersionId: TOWER_MODEL_V2_ID,
      classification: 'wall',
      quantity: { value: 42.5, unit: 'm2' },
      linkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    });
    // quantity absent → null (an element may carry none).
    const withoutQuantity = unwrap(
      parseElementProviderData({
        modelId: TOWER_MODEL_ID,
        modelVersionId: TOWER_MODEL_V2_ID,
        classification: 'wall',
        linkedRefs: [],
      }),
    );
    expect(withoutQuantity.quantity).toBeNull();
    // A malformed link ref fails the whole parse.
    expect(
      parseElementProviderData({
        ...WALL_DATA,
        linkedRefs: [{ kind: 'provider-link-ref', adapterKind: 'x', systemId: 's', objectType: 'activity', objectId: 'a' }],
      }).ok,
    ).toBe(false);
  });
});

describe('canonical models-area event payload parses (strict keys)', () => {
  const provenance = {
    sourceKey: sourceRefKeyOf(elementSource('v2')),
    providerObjectId: WALL_ELEMENT_ID,
    providerVersion: 'v2',
  };

  it('parses models.modelRegistered fail-closed (strict keys)', () => {
    const payload = {
      modelId: entity(1),
      name: 'Tower A — structural model',
      discipline: 'structure',
      provenance,
    };
    expect(unwrap(parseModelRegisteredPayload(payload))).toStrictEqual(payload);
    expect(parseModelRegisteredPayload({ ...payload, extra: 1 }).ok).toBe(false);
    expect(parseModelRegisteredPayload({ ...payload, modelId: 'not-an-id' }).ok).toBe(false);
    expect(parseModelRegisteredPayload({ ...payload, name: '' }).ok).toBe(false);
    expect(parseModelRegisteredPayload(null).ok).toBe(false);
  });

  it('parses models.elementChanged fail-closed (strict keys, closed change kind)', () => {
    const payload = {
      elementId: entity(4),
      modelId: entity(1),
      modelVersionId: entity(3),
      classification: 'wall',
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: { value: 42.5, unit: 'm2' },
      affectedEntityRefs: [
        { entityKind: 'activity', entityId: entity(80) },
        { entityKind: 'document', entityId: entity(81) },
      ],
      provenance: { ...provenance, rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF] },
    };
    expect(unwrap(parseElementChangedPayload(payload))).toStrictEqual(payload);
    // quantity null is legal.
    expect(unwrap(parseElementChangedPayload({ ...payload, quantity: null })).quantity).toBeNull();
    // 'retired' is not an elementChanged change kind.
    expect(parseElementChangedPayload({ ...payload, change: 'retired' }).ok).toBe(false);
    expect(parseElementChangedPayload({ ...payload, unknown: true }).ok).toBe(false);
    expect(
      parseElementChangedPayload({ ...payload, affectedEntityRefs: [{ entityKind: 'activity' }] }).ok,
    ).toBe(false);
    expect(
      parseElementChangedPayload({ ...payload, provenance: { ...provenance } }).ok,
    ).toBe(false);
  });

  it('parses models.elementRetired fail-closed (strict keys)', () => {
    const payload = {
      elementId: entity(4),
      modelId: entity(1),
      modelVersionId: entity(3),
      classification: 'wall',
      displayName: 'Wall 103 — grid B/4',
      affectedEntityRefs: [{ entityKind: 'activity', entityId: entity(80) }],
      provenance: { ...provenance, rawLinkedRefs: [LINKED_ACTIVITY_REF] },
    };
    expect(unwrap(parseElementRetiredPayload(payload))).toStrictEqual(payload);
    expect(parseElementRetiredPayload({ ...payload, change: 'retired' }).ok).toBe(false);
    expect(parseElementRetiredPayload({ ...payload, quantity: null }).ok).toBe(false);
  });

  it('dispatches by event name: null for non-models names, failures for malformed payloads', () => {
    expect(parseModelEventPayload(unwrap(parseEventName('projects.projectCreated')), {})).toBeNull();
    expect(parseModelEventPayload(ELEMENT_CHANGED_EVENT, { elementId: 'x' })?.ok).toBe(false);
    const dispatched = parseModelEventPayload(MODEL_REGISTERED_EVENT, {
      modelId: entity(1),
      name: 'Tower A — structural model',
      discipline: 'structure',
      provenance,
    });
    if (dispatched === null) throw new Error('expected the model-registered dispatch');
    const payload = unwrap(dispatched);
    expect('modelId' in payload && payload.modelId).toBe(entity(1));
  });
});

describe('the trusted event-envelope builders (the host-side execution seam)', () => {
  const affected: readonly EntityRef[] = [
    ref('activity', entity(80)),
    ref('document', entity(81)),
  ];
  // Canonical order flips the document ahead of the activity in the input to
  // prove the builder sorts deterministically.
  const affectedUnsorted: readonly EntityRef[] = [
    ref('document', entity(81)),
    ref('activity', entity(80)),
  ];

  it('composes models.elementChanged with full provider traceability', () => {
    const command = commandOf(input({}));
    const envelope = elementChangedEnvelope({
      command,
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: quantityOf(42.5, 'm2'),
      affectedEntityRefs: affectedUnsorted,
      rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
    });
    expect(envelope.kind).toBe('event');
    expect(envelope.eventName).toBe(ELEMENT_CHANGED_EVENT);
    expect(envelope.eventName).toBe('models.elementChanged');
    expect(envelope.scope).toStrictEqual(command.scope);
    expect(envelope.actor).toStrictEqual(command.actor);
    expect(envelope.source).toBe('domain');
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(envelope.occurredAt).toBe(NOW_2);
    expect(envelope.entityRefs).toStrictEqual({ before: WALL_ELEMENT_REF, after: WALL_ELEMENT_REF });
    // The event's causal chain: the causation id IS the executed command's
    // idempotency key — the SourceRef-derived sync key of the exact provider
    // object version.
    expect(envelope.causality.causationId).toBe(command.idempotencyKey);
    expect(unwrap(parseCausationId(command.idempotencyKey))).toBe(command.idempotencyKey);
    expect(envelope.causality.correlationId).toBe(command.causality.correlationId);
    // The affected entities are ordered canonically and the provenance block
    // carries the raw provider link refs they were resolved from.
    expect(envelope.payload.affectedEntityRefs).toStrictEqual(affected);
    expect(envelope.payload.provenance.sourceKey).toBe(sourceRefKeyOf(elementSource('v2')));
    expect(envelope.payload.provenance.rawLinkedRefs).toStrictEqual([
      LINKED_ACTIVITY_REF,
      LINKED_DOCUMENT_REF,
    ]);
    // The composed envelope round-trips the contracts parser AND the strict
    // models-area payload parser by construction.
    expect(parseDomainEventEnvelope(envelope).ok).toBe(true);
    expect(unwrap(parseElementChangedPayload(envelope.payload))).toStrictEqual(envelope.payload);
  });

  it('composes models.elementChanged with a null before-ref on creation', () => {
    const envelope = elementChangedEnvelope({
      command: commandOf(input({ changeKind: 'created' })),
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'created',
      displayName: 'Wall 103 — grid B/4',
      quantity: null,
      affectedEntityRefs: affected,
      rawLinkedRefs: [],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v1',
    });
    expect(envelope.entityRefs).toStrictEqual({ before: null, after: WALL_ELEMENT_REF });
    expect(envelope.payload.change).toBe('created');
    expect(envelope.payload.quantity).toBeNull();
  });

  it('composes models.elementRetired (the element persists through retirement)', () => {
    const envelope = elementRetiredEnvelope({
      command: commandOf(input({ changeKind: 'deleted' })),
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      displayName: 'Wall 103 — grid B/4',
      affectedEntityRefs: affectedUnsorted,
      rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v3',
    });
    expect(envelope.eventName).toBe(ELEMENT_RETIRED_EVENT);
    expect(envelope.eventName).toBe('models.elementRetired');
    expect(envelope.entityRefs).toStrictEqual({ before: WALL_ELEMENT_REF, after: WALL_ELEMENT_REF });
    expect(envelope.payload.affectedEntityRefs).toStrictEqual(affected);
    expect(envelope.payload.provenance.providerVersion).toBe('v3');
    expect(parseDomainEventEnvelope(envelope).ok).toBe(true);
  });

  it('self-checks loudly: an invalid payload can never be emitted', () => {
    const parts: ElementChangedEnvelopeParts = {
      command: commandOf(input({})),
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: quantityOf(42.5, 'm2'),
      affectedEntityRefs: affected,
      rawLinkedRefs: [LINKED_ACTIVITY_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
    };
    // An empty display name violates the payload grammar.
    expect(() =>
      elementChangedEnvelope({ ...parts, displayName: '' }),
    ).toThrow(TypeError);
    // A garbage affected entity ref violates the EntityRef grammar.
    expect(() =>
      elementChangedEnvelope({
        ...parts,
        affectedEntityRefs: [
          ref('activity', entity(80)),
          { entityKind: 'nope', entityId: 'x' } as never,
        ],
      }),
    ).toThrow(TypeError);
    // A retired change kind is not an elementChanged payload.
    expect(() => elementChangedEnvelope({ ...parts, change: 'retired' as never })).toThrow(TypeError);
  });

  it('self-checks loudly: a non-models event name can never be emitted', () => {
    const command = commandOf(input({}));
    expect(() =>
      modelEventEnvelope({
        command,
        eventName: 'projects.projectCreated' as never,
        occurredAt: NOW_2,
        entityRefs: { before: null, after: WALL_ELEMENT_REF },
        payload: {} as never,
      }),
    ).toThrow(TypeError);
  });

  it('derives the sourceKey from the command provenance or the provider identity (identical)', () => {
    const command = commandOf(input({}));
    const viaCommand = elementChangedEnvelope({
      command,
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: quantityOf(42.5, 'm2'),
      affectedEntityRefs: affected,
      rawLinkedRefs: [LINKED_ACTIVITY_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
    });
    // A command assembled WITHOUT the extension metadata block still derives
    // the same sourceKey from the provider identity (the fail-safe path).
    const bareCommand = { ...command, payload: {} } as CommandEnvelope<unknown>;
    const viaIdentity = elementChangedEnvelope({
      command: bareCommand,
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: quantityOf(42.5, 'm2'),
      affectedEntityRefs: affected,
      rawLinkedRefs: [LINKED_ACTIVITY_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
    });
    expect(viaIdentity.payload.provenance.sourceKey).toBe(viaCommand.payload.provenance.sourceKey);
    expect(viaIdentity.payload.provenance.sourceKey).toBe(sourceRefKeyOf(elementSource('v2')));
  });

  it('is deterministic: the same command and parts compose the identical envelope', () => {
    const command = commandOf(input({}));
    const parts: ElementChangedEnvelopeParts = {
      command,
      occurredAt: NOW_2,
      element: WALL_ELEMENT_REF,
      modelVersion: MODEL_VERSION_REF,
      model: MODEL_REF,
      classification: classification('wall'),
      change: 'updated',
      displayName: 'Wall 103 — grid B/4',
      quantity: quantityOf(42.5, 'm2'),
      affectedEntityRefs: affected,
      rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
      providerObjectId: WALL_ELEMENT_ID,
      providerVersion: 'v2',
    };
    expect(elementChangedEnvelope(parts)).toStrictEqual(elementChangedEnvelope(parts));
  });
});
