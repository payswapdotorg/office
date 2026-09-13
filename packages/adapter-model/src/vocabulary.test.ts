import { describe, expect, it } from 'vitest';
import { adapterKind, providerObjectKind, providerSystemId } from '@office/adapters-sdk';
import {
  ELEMENT_CANONICAL_KIND,
  ELEMENT_CHANGED_EVENT,
  ELEMENT_CLASSIFICATION_CANONICAL_KIND,
  ELEMENT_CLASSIFICATIONS,
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  ELEMENT_QUANTITY_UNITS,
  ELEMENT_RETIRED_EVENT,
  MODEL_ADAPTER_CAPABILITIES,
  MODEL_ADAPTER_KIND,
  MODEL_CANONICAL_KIND,
  MODEL_DISCIPLINES,
  MODEL_EVENT_NAMES,
  MODEL_OBJECT_FAMILY,
  MODEL_OBJECT_KIND,
  MODEL_SYNC_CAPABILITY_NAME,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_CANONICAL_KIND,
  MODEL_VERSION_OBJECT_KIND,
  MODEL_VERSION_REGISTERED_EVENT,
  RECORD_ELEMENT_CHANGE_COMMAND,
  REGISTER_CLASSIFICATION_COMMAND,
  REGISTER_MODEL_COMMAND,
  REGISTER_MODEL_VERSION_COMMAND,
  RETIRE_ELEMENT_COMMAND,
  UPDATE_CLASSIFICATION_COMMAND,
  UPDATE_MODEL_COMMAND,
  canonicalKindOfModelObjectKind,
  isElementClassification,
  isElementQuantity,
  isElementQuantityUnit,
  isModelDiscipline,
  isModelElementChangeKind,
  isModelEventName,
  isModelObjectKind,
  isProviderLinkRef,
  parentObjectKindOf,
  parseElementClassification,
  parseElementQuantity,
  parseElementQuantityUnit,
  parseModelDiscipline,
  parseModelElementChangeKind,
  parseModelEventName,
  parseModelObjectKind,
  parseProviderLinkRef,
  providerLinkRefKeyOf,
} from './vocabulary';

// OFF-022 adapter-model — the model vocabulary: generic family identity,
// the four model object kinds and their canonical kinds, the capability
// block, the models-area command/event names, and every closed sub-vocabulary
// (classifications, quantity units, disciplines, change kinds, provider link
// refs) with fail-closed parses. Deterministic: fixed literals only.

const expectFail = (
  result: { ok: false; error: { code: string } } | { ok: true },
): { code: string } => {
  expect(result.ok).toBe(false);
  if (!result.ok) return result.error;
  throw new Error('unreachable');
};

describe('model adapter family identity (generic vocabulary only)', () => {
  it('declares the generic model adapter kind and provider system', () => {
    expect(MODEL_ADAPTER_KIND).toBe('model-cde');
    expect(MODEL_SYSTEM_ID).toBe('model-instance-01');
  });

  it('declares the four model object kinds in canonical (sync stream) order', () => {
    expect(MODEL_OBJECT_FAMILY).toStrictEqual([
      'model',
      'model-version',
      'element',
      'element-classification',
    ]);
    expect(MODEL_OBJECT_KIND).toBe('model');
    expect(MODEL_VERSION_OBJECT_KIND).toBe('model-version');
    expect(ELEMENT_OBJECT_KIND).toBe('element');
    expect(ELEMENT_CLASSIFICATION_OBJECT_KIND).toBe('element-classification');
  });

  it('parses model object kinds fail-closed (another adapter kind is a rejection)', () => {
    for (const kind of MODEL_OBJECT_FAMILY) {
      const parsed = parseModelObjectKind(kind);
      expect(parsed.ok, kind).toBe(true);
      expect(isModelObjectKind(kind)).toBe(true);
    }
    for (const foreign of ['contact', 'activity', 'document', 'organization', 'model-versions']) {
      expect(parseModelObjectKind(foreign).ok, foreign).toBe(false);
      expect(isModelObjectKind(foreign), foreign).toBe(false);
    }
    for (const wrongType of [null, 7, undefined, {}, ['model']]) {
      expect(parseModelObjectKind(wrongType).ok).toBe(false);
    }
    expect(expectFail(parseModelObjectKind('contact')).code).toBe('invalid-value');
  });

  it('maps every model object kind to its declared canonical kind (typed table)', () => {
    expect(canonicalKindOfModelObjectKind(MODEL_OBJECT_KIND)).toBe(MODEL_CANONICAL_KIND);
    expect(MODEL_CANONICAL_KIND).toBe('model');
    expect(canonicalKindOfModelObjectKind(MODEL_VERSION_OBJECT_KIND)).toBe(
      MODEL_VERSION_CANONICAL_KIND,
    );
    expect(MODEL_VERSION_CANONICAL_KIND).toBe('model-version');
    expect(canonicalKindOfModelObjectKind(ELEMENT_OBJECT_KIND)).toBe(ELEMENT_CANONICAL_KIND);
    expect(ELEMENT_CANONICAL_KIND).toBe('element');
    expect(canonicalKindOfModelObjectKind(ELEMENT_CLASSIFICATION_OBJECT_KIND)).toBe(
      ELEMENT_CLASSIFICATION_CANONICAL_KIND,
    );
    expect(ELEMENT_CLASSIFICATION_CANONICAL_KIND).toBe('element-classification');
    // A foreign object kind is a loud module defect, never a guessed kind.
    expect(() => canonicalKindOfModelObjectKind(providerObjectKind('contact'))).toThrow(TypeError);
  });

  it('declares the model hierarchy discipline (parent object kinds)', () => {
    expect(parentObjectKindOf(MODEL_OBJECT_KIND)).toBeNull();
    expect(parentObjectKindOf(MODEL_VERSION_OBJECT_KIND)).toBe('model');
    expect(parentObjectKindOf(ELEMENT_OBJECT_KIND)).toBe('model-version');
    expect(parentObjectKindOf(ELEMENT_CLASSIFICATION_OBJECT_KIND)).toBeNull();
  });

  it('declares the capability block: four object kinds, all models.write', () => {
    expect(MODEL_SYNC_CAPABILITY_NAME).toBe('models.write');
    expect(MODEL_ADAPTER_CAPABILITIES.objectKinds).toHaveLength(4);
    for (const declaration of MODEL_ADAPTER_CAPABILITIES.objectKinds) {
      expect(declaration.capability).toBe('models.write');
      expect(declaration.canonicalKind).toBe(
        canonicalKindOfModelObjectKind(declaration.objectKind),
      );
    }
  });
});

describe('models-area command and event names', () => {
  it('proposes the canonical models-area command vocabulary', () => {
    expect(REGISTER_MODEL_COMMAND).toBe('models.registerModel');
    expect(UPDATE_MODEL_COMMAND).toBe('models.updateModel');
    expect(REGISTER_MODEL_VERSION_COMMAND).toBe('models.registerModelVersion');
    expect(REGISTER_CLASSIFICATION_COMMAND).toBe('models.registerClassification');
    expect(UPDATE_CLASSIFICATION_COMMAND).toBe('models.updateClassification');
    expect(RECORD_ELEMENT_CHANGE_COMMAND).toBe('models.recordElementChange');
    expect(RETIRE_ELEMENT_COMMAND).toBe('models.retireElement');
  });

  it('recognizes exactly the seven models-area event names (fail-closed)', () => {
    expect(MODEL_EVENT_NAMES).toStrictEqual([
      'models.modelRegistered',
      'models.modelUpdated',
      'models.modelVersionRegistered',
      'models.classificationRegistered',
      'models.classificationUpdated',
      'models.elementChanged',
      'models.elementRetired',
    ]);
    for (const name of MODEL_EVENT_NAMES) {
      expect(parseModelEventName(name).ok, name).toBe(true);
      expect(isModelEventName(name), name).toBe(true);
    }
    for (const foreign of [
      'organization.organizationRegistered',
      'projects.projectCreated',
      'models.elementDeleted',
    ]) {
      expect(parseModelEventName(foreign).ok, foreign).toBe(false);
      expect(isModelEventName(foreign), foreign).toBe(false);
    }
    expect(parseModelEventName(42).ok).toBe(false);
    expect(ELEMENT_CHANGED_EVENT).toBe('models.elementChanged');
    expect(ELEMENT_RETIRED_EVENT).toBe('models.elementRetired');
    expect(MODEL_VERSION_REGISTERED_EVENT).toBe('models.modelVersionRegistered');
  });
});

describe('element classification vocabulary', () => {
  it('parses declared classification codes and fails closed otherwise', () => {
    expect(ELEMENT_CLASSIFICATIONS).toStrictEqual([
      'wall',
      'column',
      'beam',
      'slab',
      'door',
      'window',
      'duct',
      'pipe',
      'cable-tray',
      'equipment',
    ]);
    for (const code of ELEMENT_CLASSIFICATIONS) {
      expect(parseElementClassification(code).ok, code).toBe(true);
      expect(isElementClassification(code), code).toBe(true);
    }
    expect(parseElementClassification('roof').ok).toBe(false);
    expect(parseElementClassification('WALL').ok).toBe(false);
    expect(parseElementClassification(null).ok).toBe(false);
    expect(expectFail(parseElementClassification('roof')).code).toBe('invalid-value');
  });
});

describe('element quantity vocabulary', () => {
  it('parses declared units and fails closed otherwise', () => {
    expect(ELEMENT_QUANTITY_UNITS).toStrictEqual(['m2', 'm3', 'm', 'each']);
    for (const unit of ELEMENT_QUANTITY_UNITS) {
      expect(parseElementQuantityUnit(unit).ok, unit).toBe(true);
      expect(isElementQuantityUnit(unit), unit).toBe(true);
    }
    expect(parseElementQuantityUnit('m4').ok).toBe(false);
    expect(parseElementQuantityUnit('m2 ').ok).toBe(false);
  });

  it('parses typed quantities (positive finite value + declared unit) fail-closed', () => {
    const quantity = parseElementQuantity({ value: 42.5, unit: 'm2' });
    expect(quantity.ok).toBe(true);
    if (quantity.ok) {
      expect(quantity.value).toStrictEqual({ value: 42.5, unit: 'm2' });
    }
    expect(isElementQuantity({ value: 12, unit: 'm3' })).toBe(true);
    for (const bad of [
      { value: 0, unit: 'm2' },
      { value: -1, unit: 'm2' },
      { value: Number.NaN, unit: 'm2' },
      { value: '42', unit: 'm2' },
      { value: 42.5, unit: 'm4' },
      { value: 42.5 },
      { unit: 'm2' },
      null,
      'wall',
      [1, 2],
    ]) {
      expect(parseElementQuantity(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('model discipline vocabulary', () => {
  it('parses declared disciplines and fails closed otherwise', () => {
    expect(MODEL_DISCIPLINES).toStrictEqual(['structure', 'architecture', 'earthworks', 'mep']);
    for (const discipline of MODEL_DISCIPLINES) {
      expect(parseModelDiscipline(discipline).ok, discipline).toBe(true);
      expect(isModelDiscipline(discipline), discipline).toBe(true);
    }
    expect(parseModelDiscipline('hvac').ok).toBe(false);
    expect(parseModelDiscipline('Structure').ok).toBe(false);
    expect(expectFail(parseModelDiscipline('hvac')).code).toBe('invalid-value');
  });
});

describe('element change kinds (the delete-of-version discipline)', () => {
  it('accepts created/updated/retired and rejects the destructive delete', () => {
    for (const kind of ['created', 'updated', 'retired'] as const) {
      expect(parseModelElementChangeKind(kind).ok, kind).toBe(true);
      expect(isModelElementChangeKind(kind), kind).toBe(true);
    }
    // 'deleted' is deliberately NOT in the vocabulary: a provider element
    // deletion is a retirement, never a destructive history delete.
    expect(parseModelElementChangeKind('deleted').ok).toBe(false);
    expect(parseModelElementChangeKind('retired!').ok).toBe(false);
    expect(parseModelElementChangeKind(null).ok).toBe(false);
    expect(expectFail(parseModelElementChangeKind('deleted')).code).toBe('invalid-value');
  });
});

describe('provider link references', () => {
  it('parses a full provider link ref fail-closed', () => {
    const link = {
      kind: 'provider-link-ref',
      adapterKind: 'schedule-planning',
      systemId: 'schedule-instance-01',
      objectType: 'activity',
      objectId: 'act-401',
    };
    const parsed = parseProviderLinkRef(link);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toStrictEqual(link);
    }
    expect(isProviderLinkRef(link)).toBe(true);
  });

  it('rejects malformed link refs (kind literal, whitespace ids, wrong types)', () => {
    for (const bad of [
      null,
      'provider-link-ref',
      { ...({ kind: 'provider-link' }) },
      { kind: 'provider-link-ref' },
      { kind: 'provider-link-ref', adapterKind: 'x', systemId: 's', objectType: 'activity', objectId: 'act-401' },
      { kind: 'provider-link-ref', adapterKind: 'schedule-planning', systemId: '', objectType: 'activity', objectId: 'act-401' },
      { kind: 'provider-link-ref', adapterKind: 'schedule-planning', systemId: 's', objectType: '', objectId: 'act-401' },
      { kind: 'provider-link-ref', adapterKind: 'schedule-planning', systemId: 's', objectType: 'activity', objectId: 'act 401' },
      { kind: 'provider-link-ref', adapterKind: 'schedule-planning', systemId: 's', objectType: 'activity', objectId: 401 },
    ]) {
      expect(parseProviderLinkRef(bad).ok, JSON.stringify(bad)).toBe(false);
      expect(isProviderLinkRef(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('serializes a link ref canonically (deterministic digest material)', () => {
    expect(
      providerLinkRefKeyOf({
        kind: 'provider-link-ref',
        adapterKind: adapterKind('schedule-planning'),
        systemId: providerSystemId('schedule-instance-01'),
        objectType: providerObjectKind('activity'),
        objectId: 'act-401',
      }),
    ).toBe('["schedule-planning","schedule-instance-01","activity","act-401"]');
  });
});
