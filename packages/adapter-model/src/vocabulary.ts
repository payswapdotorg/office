// Office adapter-model — the BIM/model vocabulary (OFF-022).
//
// The typed vocabularies of the Autodesk-CLASS model adapter, in strictly
// GENERIC terms (freeze A5 + the OFF-022 vocabulary rule): the adapter
// family kind and the fixture's provider system are generic names
// ('model-cde' / 'model-instance-01'), the provider's object kinds are the
// model object family (model, model-version, element, element-classification),
// and the canonical kinds they map into are the models-area entity kinds.
// No real vendor name appears anywhere in this package: all
// provider-specific shapes live INSIDE it (that IS the acceptance
// discipline), and no vendor SDK is imported.
//
// Local closed vocabularies (each fail-closed parsed):
//   - the four model object kinds (provider-side) and their canonical kinds;
//   - the element classification vocabulary (wall/column/… — what a
//     classification entry or element classification code may be);
//   - the quantity unit vocabulary (m2/m3/m/each);
//   - the model discipline vocabulary (structure/architecture/…);
//   - the element change kinds (created/updated/retired) — the
//     delete-of-version retirement discipline (never a destructive delete).
import { parseCommandName, parseEntityKind, parseEventName } from '@office/contracts';
import type { CommandName, EntityKind, EventName, ParseResult } from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import {
  adapterKind,
  parseAdapterCapabilities,
  providerObjectKind,
  providerSystemId,
} from '@office/adapters-sdk';
import type { AdapterCapabilities, AdapterKind, ProviderObjectKind, ProviderSystemId } from '@office/adapters-sdk';
import { describeValue } from './parse';

// ---------------------------------------------------------------------------
// Adapter family identity (generic vocabulary — no real provider names).
// ---------------------------------------------------------------------------

/** The model adapter family kind (the Autodesk-class family, generically named). */
export const MODEL_ADAPTER_KIND: AdapterKind = adapterKind('model-cde');

/** The fixture provider system the model adapter syncs against. */
export const MODEL_SYSTEM_ID: ProviderSystemId = providerSystemId('model-instance-01');

// ---------------------------------------------------------------------------
// The model object family: provider object kinds and their canonical kinds.
// ---------------------------------------------------------------------------

/** The provider object kind of a model (the BIM model container). */
export const MODEL_OBJECT_KIND: ProviderObjectKind = providerObjectKind('model');
/** The provider object kind of an immutable model version. */
export const MODEL_VERSION_OBJECT_KIND: ProviderObjectKind = providerObjectKind('model-version');
/** The provider object kind of a model element. */
export const ELEMENT_OBJECT_KIND: ProviderObjectKind = providerObjectKind('element');
/** The provider object kind of an element-classification entry. */
export const ELEMENT_CLASSIFICATION_OBJECT_KIND: ProviderObjectKind = providerObjectKind(
  'element-classification',
);

const trustedEntityKind = (raw: string): EntityKind => {
  const parsed = parseEntityKind(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical kind literal: ${raw}`);
  }
  return parsed.value;
};

/** The canonical entity kind a provider model maps into (freeze A1 area 5). */
export const MODEL_CANONICAL_KIND: EntityKind = trustedEntityKind('model');
/**
 * The canonical entity kind a provider model version maps into — the
 * document-revision-style IMMUTABLE version discipline (a version is
 * registered once, superseded by later versions, never rewritten).
 */
export const MODEL_VERSION_CANONICAL_KIND: EntityKind = trustedEntityKind('model-version');
/** The canonical entity kind a provider element maps into. */
export const ELEMENT_CANONICAL_KIND: EntityKind = trustedEntityKind('element');
/** The canonical entity kind an element-classification entry maps into. */
export const ELEMENT_CLASSIFICATION_CANONICAL_KIND: EntityKind = trustedEntityKind(
  'element-classification',
);

/** The model object-family kinds in canonical order (the sync stream order). */
export const MODEL_OBJECT_FAMILY: readonly ProviderObjectKind[] = [
  MODEL_OBJECT_KIND,
  MODEL_VERSION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
];

/** Grammar description used in parse failures. */
export const MODEL_OBJECT_KIND_GRAMMAR =
  "model object family kind: 'model' | 'model-version' | 'element' | 'element-classification'";

const MODEL_OBJECT_KINDS: readonly string[] = [
  MODEL_OBJECT_KIND,
  MODEL_VERSION_OBJECT_KIND,
  ELEMENT_OBJECT_KIND,
  ELEMENT_CLASSIFICATION_OBJECT_KIND,
];

/**
 * Parse an untrusted value as one of the four model object-family kinds
 * (total, fail-closed — anything else, including another adapter's object
 * kind, is a typed rejection).
 */
export function parseModelObjectKind(raw: unknown): ParseResult<ProviderObjectKind> {
  if (typeof raw !== 'string' || !MODEL_OBJECT_KINDS.includes(raw)) {
    return parseFail('invalid-value', '', MODEL_OBJECT_KIND_GRAMMAR, describeValue(raw));
  }
  return parseOk(providerObjectKind(raw));
}

/** Type guard for the four model object-family kinds. */
export function isModelObjectKind(raw: unknown): raw is ProviderObjectKind {
  return parseModelObjectKind(raw).ok;
}

/** The canonical entity kind one model object kind maps into (trusted table). */
export function canonicalKindOfModelObjectKind(objectKind: ProviderObjectKind): EntityKind {
  if (objectKind === MODEL_OBJECT_KIND) return MODEL_CANONICAL_KIND;
  if (objectKind === MODEL_VERSION_OBJECT_KIND) return MODEL_VERSION_CANONICAL_KIND;
  if (objectKind === ELEMENT_OBJECT_KIND) return ELEMENT_CANONICAL_KIND;
  if (objectKind === ELEMENT_CLASSIFICATION_OBJECT_KIND) {
    return ELEMENT_CLASSIFICATION_CANONICAL_KIND;
  }
  throw new TypeError(`not a model object family kind: ${String(objectKind)}`);
}

/**
 * The parent object kind whose mapping must exist before one of this kind
 * can be recorded (the model hierarchy discipline), or null for roots.
 */
export function parentObjectKindOf(objectKind: ProviderObjectKind): ProviderObjectKind | null {
  if (objectKind === MODEL_VERSION_OBJECT_KIND) return MODEL_OBJECT_KIND;
  if (objectKind === ELEMENT_OBJECT_KIND) return MODEL_VERSION_OBJECT_KIND;
  return null;
}

// ---------------------------------------------------------------------------
// Capability (authz's declared BIM/model area, deny-by-default at sync time).
//
// The typed Capability values are obtained through the SDK's own fail-closed
// capability parse (parseAdapterCapabilities) — the SDK is THE contract and
// this package never imports @office/authz directly: the declared capability
// name must pass the SDK's closed-vocabulary check, so an undeclared area
// can never enter this adapter's capabilities through this path.
// ---------------------------------------------------------------------------

/** The capability every model object kind requires to sync (BIM/model area write). */
export const MODEL_SYNC_CAPABILITY_NAME = 'models.write' as const;

const trustedCapabilities = (raw: unknown): AdapterCapabilities => {
  const parsed = parseAdapterCapabilities(raw);
  if (!parsed.ok) {
    // Pure literals over the declared vocabulary — a violation is a module defect.
    throw new TypeError(`invalid model adapter capabilities: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value;
};

/** The declared object-kind surfaces of the model adapter (THE contract's capability block). */
export const MODEL_ADAPTER_CAPABILITIES: AdapterCapabilities = trustedCapabilities({
  objectKinds: [
    {
      objectKind: MODEL_OBJECT_KIND,
      canonicalKind: MODEL_CANONICAL_KIND,
      capability: MODEL_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: MODEL_VERSION_OBJECT_KIND,
      canonicalKind: MODEL_VERSION_CANONICAL_KIND,
      capability: MODEL_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: ELEMENT_OBJECT_KIND,
      canonicalKind: ELEMENT_CANONICAL_KIND,
      capability: MODEL_SYNC_CAPABILITY_NAME,
    },
    {
      objectKind: ELEMENT_CLASSIFICATION_OBJECT_KIND,
      canonicalKind: ELEMENT_CLASSIFICATION_CANONICAL_KIND,
      capability: MODEL_SYNC_CAPABILITY_NAME,
    },
  ],
});

// ---------------------------------------------------------------------------
// Canonical models-area command names (what the adapter proposes).
// ---------------------------------------------------------------------------

const trustedCommandName = (raw: string): CommandName => {
  const parsed = parseCommandName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical command name literal: ${raw}`);
  }
  return parsed.value;
};

/** Canonical command proposed for a provider model creation. */
export const REGISTER_MODEL_COMMAND: CommandName = trustedCommandName('models.registerModel');
/** Canonical command proposed for a provider model update. */
export const UPDATE_MODEL_COMMAND: CommandName = trustedCommandName('models.updateModel');
/** Canonical command proposed for a provider model-version registration. */
export const REGISTER_MODEL_VERSION_COMMAND: CommandName = trustedCommandName(
  'models.registerModelVersion',
);
/** Canonical command proposed for a classification entry creation. */
export const REGISTER_CLASSIFICATION_COMMAND: CommandName = trustedCommandName(
  'models.registerClassification',
);
/** Canonical command proposed for a classification entry update. */
export const UPDATE_CLASSIFICATION_COMMAND: CommandName = trustedCommandName(
  'models.updateClassification',
);
/** Canonical command proposed for an element creation or update. */
export const RECORD_ELEMENT_CHANGE_COMMAND: CommandName = trustedCommandName(
  'models.recordElementChange',
);
/**
 * Canonical command proposed for an element delete-of-version — the RETIRE
 * discipline: the element is retired from the version going forward and its
 * history is never destructively deleted (frozen anti-pattern).
 */
export const RETIRE_ELEMENT_COMMAND: CommandName = trustedCommandName('models.retireElement');

// ---------------------------------------------------------------------------
// Canonical models-area event names (what executing a proposed command emits).
// ---------------------------------------------------------------------------

const trustedEventName = (raw: string): EventName => {
  const parsed = parseEventName(raw);
  if (!parsed.ok) {
    throw new TypeError(`invalid canonical event name literal: ${raw}`);
  }
  return parsed.value;
};

/** Event name of the model-registered lifecycle event. */
export const MODEL_REGISTERED_EVENT: EventName = trustedEventName('models.modelRegistered');
/** Event name of the model-updated lifecycle event. */
export const MODEL_UPDATED_EVENT: EventName = trustedEventName('models.modelUpdated');
/** Event name of the immutable model-version registration event. */
export const MODEL_VERSION_REGISTERED_EVENT: EventName = trustedEventName(
  'models.modelVersionRegistered',
);
/** Event name of the classification-registered lifecycle event. */
export const CLASSIFICATION_REGISTERED_EVENT: EventName = trustedEventName(
  'models.classificationRegistered',
);
/** Event name of the classification-updated lifecycle event. */
export const CLASSIFICATION_UPDATED_EVENT: EventName = trustedEventName(
  'models.classificationUpdated',
);
/** Event name of THE element-mutation event (element created or updated). */
export const ELEMENT_CHANGED_EVENT: EventName = trustedEventName('models.elementChanged');
/** Event name of the element delete-of-version retirement event. */
export const ELEMENT_RETIRED_EVENT: EventName = trustedEventName('models.elementRetired');

/** Every models-area event name this package recognizes (canonical order). */
export const MODEL_EVENT_NAMES: readonly EventName[] = [
  MODEL_REGISTERED_EVENT,
  MODEL_UPDATED_EVENT,
  MODEL_VERSION_REGISTERED_EVENT,
  CLASSIFICATION_REGISTERED_EVENT,
  CLASSIFICATION_UPDATED_EVENT,
  ELEMENT_CHANGED_EVENT,
  ELEMENT_RETIRED_EVENT,
];

/** Grammar description used in parse failures. */
export const MODEL_EVENT_NAME_GRAMMAR =
  'a models-area event name (models.modelRegistered, models.modelUpdated, models.modelVersionRegistered, models.classificationRegistered, models.classificationUpdated, models.elementChanged, models.elementRetired)';

/**
 * Parse an untrusted value as a models-area event name (total, fail-closed).
 */
export function parseModelEventName(raw: unknown): ParseResult<EventName> {
  if (
    typeof raw !== 'string' ||
    !(MODEL_EVENT_NAMES as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', MODEL_EVENT_NAME_GRAMMAR, describeValue(raw));
  }
  return parseOk(trustedEventName(raw));
}

/** Type guard for models-area event names. */
export function isModelEventName(raw: unknown): raw is EventName {
  return parseModelEventName(raw).ok;
}

// ---------------------------------------------------------------------------
// The element classification vocabulary (typed element classification).
// ---------------------------------------------------------------------------

declare const elementClassificationBrand: unique symbol;

/** One element classification code from the closed typed vocabulary. */
export type ElementClassification = string & {
  readonly [elementClassificationBrand]: 'ElementClassification';
};

/** The element classification vocabulary, in canonical order. */
export const ELEMENT_CLASSIFICATIONS: readonly ElementClassification[] = [
  'wall' as ElementClassification,
  'column' as ElementClassification,
  'beam' as ElementClassification,
  'slab' as ElementClassification,
  'door' as ElementClassification,
  'window' as ElementClassification,
  'duct' as ElementClassification,
  'pipe' as ElementClassification,
  'cable-tray' as ElementClassification,
  'equipment' as ElementClassification,
];

/** Grammar description used in parse failures. */
export const ELEMENT_CLASSIFICATION_GRAMMAR =
  "element classification code: 'wall' | 'column' | 'beam' | 'slab' | 'door' | 'window' | 'duct' | 'pipe' | 'cable-tray' | 'equipment'";

/** Parse an untrusted value as an ElementClassification (total, fail-closed). */
export function parseElementClassification(raw: unknown): ParseResult<ElementClassification> {
  if (
    typeof raw !== 'string' ||
    !(ELEMENT_CLASSIFICATIONS as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', ELEMENT_CLASSIFICATION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ElementClassification);
}

/** Type guard for structurally valid ElementClassification values. */
export function isElementClassification(raw: unknown): raw is ElementClassification {
  return parseElementClassification(raw).ok;
}

// ---------------------------------------------------------------------------
// The element quantity unit vocabulary.
// ---------------------------------------------------------------------------

declare const elementQuantityUnitBrand: unique symbol;

/** One quantity unit from the closed typed vocabulary. */
export type ElementQuantityUnit = string & {
  readonly [elementQuantityUnitBrand]: 'ElementQuantityUnit';
};

/** The quantity unit vocabulary, in canonical order. */
export const ELEMENT_QUANTITY_UNITS: readonly ElementQuantityUnit[] = [
  'm2' as ElementQuantityUnit,
  'm3' as ElementQuantityUnit,
  'm' as ElementQuantityUnit,
  'each' as ElementQuantityUnit,
];

/** Grammar description used in parse failures. */
export const ELEMENT_QUANTITY_UNIT_GRAMMAR =
  "element quantity unit: 'm2' | 'm3' | 'm' | 'each'";

/** Parse an untrusted value as an ElementQuantityUnit (total, fail-closed). */
export function parseElementQuantityUnit(raw: unknown): ParseResult<ElementQuantityUnit> {
  if (
    typeof raw !== 'string' ||
    !(ELEMENT_QUANTITY_UNITS as readonly string[]).includes(raw)
  ) {
    return parseFail('invalid-value', '', ELEMENT_QUANTITY_UNIT_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ElementQuantityUnit);
}

/** Type guard for structurally valid ElementQuantityUnit values. */
export function isElementQuantityUnit(raw: unknown): raw is ElementQuantityUnit {
  return parseElementQuantityUnit(raw).ok;
}

/**
 * One typed element quantity: a positive finite value in a declared unit.
 * (A type alias of an object literal shape so payload composition stays
 * assignable to the SDK's JSON-exact extension-bag model.)
 */
export type ElementQuantity = {
  readonly value: number;
  readonly unit: ElementQuantityUnit;
};

/** Shape description used in parse failures. */
export const ELEMENT_QUANTITY_GRAMMAR =
  "ElementQuantity: { value: positive finite number, unit: 'm2' | 'm3' | 'm' | 'each' }";

/** Parse an untrusted value as an ElementQuantity (total, fail-closed, strict keys). */
export function parseElementQuantity(raw: unknown): ParseResult<ElementQuantity> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', ELEMENT_QUANTITY_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  const value = record['value'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return parseFail(
      'invalid-value',
      'value',
      'a positive finite number',
      describeValue(value),
    );
  }
  const unit = parseElementQuantityUnit(record['unit']);
  if (!unit.ok) {
    return parseFail(unit.error.code, 'unit', unit.error.expected, unit.error.received);
  }
  return parseOk({ value, unit: unit.value } satisfies ElementQuantity);
}

/** Type guard for structurally valid ElementQuantity values. */
export function isElementQuantity(raw: unknown): raw is ElementQuantity {
  return parseElementQuantity(raw).ok;
}

// ---------------------------------------------------------------------------
// The model discipline vocabulary.
// ---------------------------------------------------------------------------

declare const modelDisciplineBrand: unique symbol;

/** One model discipline from the closed typed vocabulary. */
export type ModelDiscipline = string & {
  readonly [modelDisciplineBrand]: 'ModelDiscipline';
};

/** The model discipline vocabulary, in canonical order. */
export const MODEL_DISCIPLINES: readonly ModelDiscipline[] = [
  'structure' as ModelDiscipline,
  'architecture' as ModelDiscipline,
  'earthworks' as ModelDiscipline,
  'mep' as ModelDiscipline,
];

/** Grammar description used in parse failures. */
export const MODEL_DISCIPLINE_GRAMMAR =
  "model discipline: 'structure' | 'architecture' | 'earthworks' | 'mep'";

/** Parse an untrusted value as a ModelDiscipline (total, fail-closed). */
export function parseModelDiscipline(raw: unknown): ParseResult<ModelDiscipline> {
  if (typeof raw !== 'string' || !(MODEL_DISCIPLINES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', MODEL_DISCIPLINE_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ModelDiscipline);
}

/** Type guard for structurally valid ModelDiscipline values. */
export function isModelDiscipline(raw: unknown): raw is ModelDiscipline {
  return parseModelDiscipline(raw).ok;
}

// ---------------------------------------------------------------------------
// The element change vocabulary (the delete-of-version discipline).
// ---------------------------------------------------------------------------

/**
 * What happened to a model element: created, updated, or RETIRED — the
 * delete-of-version vocabulary. There is no destructive delete: a provider
 * element deletion retires the element from the version going forward while
 * its history (and every prior version's record of it) is preserved.
 */
export type ModelElementChangeKind = 'created' | 'updated' | 'retired';

/** Grammar description used in parse failures. */
export const MODEL_ELEMENT_CHANGE_KIND_GRAMMAR =
  "'created' | 'updated' | 'retired' (an element deletion is a retirement, never a destructive history delete)";

const MODEL_ELEMENT_CHANGE_KINDS: readonly ModelElementChangeKind[] = [
  'created',
  'updated',
  'retired',
];

/** Parse an untrusted value as a ModelElementChangeKind (total, fail-closed). */
export function parseModelElementChangeKind(
  raw: unknown,
): ParseResult<ModelElementChangeKind> {
  if (typeof raw !== 'string' || !MODEL_ELEMENT_CHANGE_KINDS.includes(raw as ModelElementChangeKind)) {
    return parseFail(
      'invalid-value',
      '',
      MODEL_ELEMENT_CHANGE_KIND_GRAMMAR,
      describeValue(raw),
    );
  }
  return parseOk(raw as ModelElementChangeKind);
}

/** Type guard for structurally valid ModelElementChangeKind values. */
export function isModelElementChangeKind(raw: unknown): raw is ModelElementChangeKind {
  return parseModelElementChangeKind(raw).ok;
}

// ---------------------------------------------------------------------------
// Provider-side link references (typed, fail-closed parsed).
// ---------------------------------------------------------------------------

/**
 * A provider-side reference from one model element to a linked entity in
 * ANOTHER provider system (e.g. the activity whose quantities the element
 * drives, or the document that evidences it). The reference is a full
 * provider coordinate — the office-side resolution goes through the shared
 * source-mapping records (the same tenant-scoped store every adapter's sync
 * populates), never a provider id as a canonical key (freeze A10).
 */
export type ProviderLinkRef = {
  readonly kind: 'provider-link-ref';
  readonly adapterKind: AdapterKind;
  readonly systemId: ProviderSystemId;
  readonly objectType: ProviderObjectKind;
  readonly objectId: string;
};

/** Shape description used in parse failures. */
export const PROVIDER_LINK_REF_GRAMMAR =
  "ProviderLinkRef: { kind: 'provider-link-ref', adapterKind, systemId, objectType, objectId }";

const LINK_OBJECT_ID_RULE = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]+$/,
  description: 'opaque printable-ASCII provider object id (no whitespace)',
} as const;

/**
 * Parse an untrusted value as a ProviderLinkRef (total, fail-closed, strict
 * keys) — the parse the command translator runs over provider element
 * payloads and the canonical event payload parsers run over provenance.
 */
export function parseProviderLinkRef(raw: unknown): ParseResult<ProviderLinkRef> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFail('invalid-type', '', PROVIDER_LINK_REF_GRAMMAR, describeValue(raw));
  }
  const record = raw as Record<string, unknown>;
  if (record['kind'] !== 'provider-link-ref') {
    return parseFail(
      'invalid-value',
      'kind',
      "'provider-link-ref'",
      describeValue(record['kind']),
    );
  }
  const adapterKindRaw = record['adapterKind'];
  if (typeof adapterKindRaw !== 'string' || adapterKindRaw.length < 2 || adapterKindRaw.length > 64) {
    return parseFail(
      'invalid-value',
      'adapterKind',
      'a provider adapter kind (lowercase kebab-case)',
      describeValue(adapterKindRaw),
    );
  }
  const systemIdRaw = record['systemId'];
  if (typeof systemIdRaw !== 'string' || systemIdRaw.length < 1 || systemIdRaw.length > 128) {
    return parseFail(
      'invalid-value',
      'systemId',
      'a provider system id (opaque printable-ASCII token)',
      describeValue(systemIdRaw),
    );
  }
  const objectTypeRaw = record['objectType'];
  if (typeof objectTypeRaw !== 'string' || objectTypeRaw.length < 1 || objectTypeRaw.length > 64) {
    return parseFail(
      'invalid-value',
      'objectType',
      'a provider object kind (lowercase kebab-case)',
      describeValue(objectTypeRaw),
    );
  }
  const objectIdRaw = record['objectId'];
  if (
    typeof objectIdRaw !== 'string' ||
    !LINK_OBJECT_ID_RULE.pattern.test(objectIdRaw) ||
    objectIdRaw.length < LINK_OBJECT_ID_RULE.min ||
    objectIdRaw.length > LINK_OBJECT_ID_RULE.max
  ) {
    return parseFail(
      'invalid-value',
      'objectId',
      LINK_OBJECT_ID_RULE.description,
      describeValue(objectIdRaw),
    );
  }
  return parseOk(
    {
      kind: 'provider-link-ref',
      adapterKind: adapterKindRaw as AdapterKind,
      systemId: systemIdRaw as ProviderSystemId,
      objectType: objectTypeRaw as ProviderObjectKind,
      objectId: objectIdRaw,
    } satisfies ProviderLinkRef,
  );
}

/** Type guard for structurally valid ProviderLinkRef values. */
export function isProviderLinkRef(raw: unknown): raw is ProviderLinkRef {
  return parseProviderLinkRef(raw).ok;
}

/** Canonical, unambiguous serialization of one link ref (digest material). */
export function providerLinkRefKeyOf(link: ProviderLinkRef): string {
  return JSON.stringify([
    link.adapterKind,
    link.systemId,
    link.objectType,
    link.objectId,
  ]);
}
