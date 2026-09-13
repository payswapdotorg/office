// Office adapter-model — the change-event mapping (OFF-022).
//
// The translation seam of THE canonical flow:
//
//   provider element mutation (create / update / delete-of-version)
//     → ProviderSnapshot (the SDK's normalized observation)
//     → canonical command proposal (models.recordElementChange /
//       models.retireElement — the AdapterCommandTranslator below)
//     → (executed by the HOST through the Action Gateway)
//     → canonical DomainEventEnvelope (models.elementChanged /
//       models.elementRetired — the event vocabulary + trusted envelope
//       builders below)
//     → affected-relationship notifications (notification.ts).
//
// Adapters NEVER write canonical state (freeze A8/A11): the translator only
// PROPOSES typed commands; the host executes them and emits the events.
// The delete-of-version discipline: a provider element deletion proposes a
// RETIREMENT (the element is retired from the version going forward), never
// a destructive delete of history — and a provider-side deletion of a
// MODEL, MODEL-VERSION, or CLASSIFICATION entry is a typed rejection (the
// canonical models-area history is append-only; container deletions are a
// divergence the runtime must reconcile explicitly, not auto-propose).
//
// Provider payloads are parsed fail-closed before any proposal is composed;
// canonical event payloads are strict-keyed and round-trip the contracts
// parser by construction. Deterministic everywhere: no clock, no
// randomness, canonical orderings only.
import { CURRENT_SCHEMA_VERSION, parseCausationId, parseDomainEventEnvelope, parseEntityId, parseEntityRef, parseFail, parseOk } from '@office/contracts';
import type {
  CommandEnvelope,
  Causality,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  EntityRefs,
  EventName,
  ParseResult,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import {
  providerObjectId,
  providerVersion,
  requireCanonicalTarget,
  sourceRef,
  sourceRefKeyOf,
} from '@office/adapters-sdk';
import type {
  AdapterCommandInput,
  AdapterCommandProposal,
  AdapterCommandTranslator,
  AdapterJsonObject,
} from '@office/adapters-sdk';
import {
  CLASSIFICATION_REGISTERED_EVENT,
  CLASSIFICATION_UPDATED_EVENT,
  ELEMENT_CHANGED_EVENT,
  ELEMENT_OBJECT_KIND,
  ELEMENT_RETIRED_EVENT,
  MODEL_ADAPTER_KIND,
  MODEL_REGISTERED_EVENT,
  MODEL_SYSTEM_ID,
  MODEL_UPDATED_EVENT,
  MODEL_VERSION_REGISTERED_EVENT,
  RECORD_ELEMENT_CHANGE_COMMAND,
  REGISTER_CLASSIFICATION_COMMAND,
  REGISTER_MODEL_COMMAND,
  REGISTER_MODEL_VERSION_COMMAND,
  RETIRE_ELEMENT_COMMAND,
  UPDATE_CLASSIFICATION_COMMAND,
  UPDATE_MODEL_COMMAND,
  isModelEventName,
  parseElementClassification,
  parseElementQuantity,
  parseModelDiscipline,
  parseModelEventName,
  parseModelObjectKind,
  parseProviderLinkRef,
} from './vocabulary';
import type {
  ElementClassification,
  ElementQuantity,
  ModelDiscipline,
  ProviderLinkRef,
} from './vocabulary';
import { compareEntityRef } from './references';
import {
  describeValue,
  isPlainObject,
  optionalField,
  parseValueArray,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requirePositiveNumber,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { StringRule } from './parse';

// ---------------------------------------------------------------------------
// Provider payload parses (the extension bag's model-family fields).
// ---------------------------------------------------------------------------

const PROVIDER_ID_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[\x21-\x7e]+$/,
  description: 'opaque printable-ASCII provider object id (no whitespace)',
};

const LABEL_RULE: StringRule = {
  min: 1,
  max: 200,
  description: 'provider version label (1..200 characters)',
};

const DESCRIPTION_RULE: StringRule = {
  min: 1,
  max: 512,
  description: 'classification description (1..512 characters)',
};

/** The model-family fields a provider MODEL payload carries. */
export interface ModelProviderData {
  readonly discipline: ModelDiscipline;
}

/** The model-family fields a provider MODEL-VERSION payload carries. */
export interface ModelVersionProviderData {
  readonly modelId: string;
  readonly label: string;
}

/** The model-family fields a provider ELEMENT-CLASSIFICATION payload carries. */
export interface ClassificationProviderData {
  readonly code: ElementClassification;
  readonly description: string;
}

/** The model-family fields a provider ELEMENT payload carries. */
export interface ElementProviderData {
  readonly modelId: string;
  readonly modelVersionId: string;
  readonly classification: ElementClassification;
  readonly quantity: ElementQuantity | null;
  readonly linkedRefs: readonly ProviderLinkRef[];
}

/** Parse a provider model payload (open extension bag; named fields strict). */
export function parseModelProviderData(data: AdapterJsonObject): ParseResult<ModelProviderData> {
  const discipline = requireFieldWith(data, 'discipline', '', parseModelDiscipline);
  if (!discipline.ok) return discipline;
  return parseOk({ discipline: discipline.value } satisfies ModelProviderData);
}

/** Parse a provider model-version payload (open bag; named fields strict). */
export function parseModelVersionProviderData(
  data: AdapterJsonObject,
): ParseResult<ModelVersionProviderData> {
  const modelId = requireString(data, 'modelId', '', PROVIDER_ID_RULE);
  if (!modelId.ok) return modelId;
  const label = requireString(data, 'label', '', LABEL_RULE);
  if (!label.ok) return label;
  return parseOk({ modelId: modelId.value, label: label.value } satisfies ModelVersionProviderData);
}

/** Parse a provider element-classification payload (open bag; strict fields). */
export function parseClassificationProviderData(
  data: AdapterJsonObject,
): ParseResult<ClassificationProviderData> {
  const code = requireFieldWith(data, 'code', '', parseElementClassification);
  if (!code.ok) return code;
  const description = requireString(data, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  return parseOk(
    { code: code.value, description: description.value } satisfies ClassificationProviderData,
  );
}

/** Parse a provider element payload (open bag; named fields strict). */
export function parseElementProviderData(data: AdapterJsonObject): ParseResult<ElementProviderData> {
  const modelId = requireString(data, 'modelId', '', PROVIDER_ID_RULE);
  if (!modelId.ok) return modelId;
  const modelVersionId = requireString(data, 'modelVersionId', '', PROVIDER_ID_RULE);
  if (!modelVersionId.ok) return modelVersionId;
  const classification = requireFieldWith(data, 'classification', '', parseElementClassification);
  if (!classification.ok) return classification;
  const quantity = optionalField(data, 'quantity', parseElementQuantity);
  if (!quantity.ok) return quantity;
  const linkedRefs = requireFieldWith(
    data,
    'linkedRefs',
    '',
    (value: unknown): ParseResult<readonly ProviderLinkRef[]> =>
      parseValueArray(value, 'linkedRefs', parseProviderLinkRef, 'array of provider link refs'),
  );
  if (!linkedRefs.ok) return linkedRefs;
  return parseOk(
    {
      modelId: modelId.value,
      modelVersionId: modelVersionId.value,
      classification: classification.value,
      quantity: quantity.value ?? null,
      linkedRefs: linkedRefs.value,
    } satisfies ElementProviderData,
  );
}

// ---------------------------------------------------------------------------
// The command translator (provider mutations → canonical command proposals).
// ---------------------------------------------------------------------------

/** Wrap a provider-payload parse failure as a typed DomainError (local). */
const providerDataError = (
  tenantId: AdapterCommandInput['tenantId'],
  failure: { readonly code: string; readonly path: string; readonly expected: string; readonly received: string },
): DomainError =>
  domainError(
    'invariant-violation',
    `provider payload failed fail-closed parsing: ${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`,
    [
      {
        code: `provider-data-${failure.code}`,
        message: failure.received,
        path: failure.path === '' ? null : failure.path,
      },
    ],
    { scope: { kind: 'tenant', tenantId } },
  );

/** The proposed canonical command payload's provenance block (local type). */
type ExtensionMetadata = {
  readonly sourceKey: string;
  readonly providerData?: AdapterJsonObject;
};

const extensionMetadataOf = (
  input: AdapterCommandInput,
  withData: boolean,
): ExtensionMetadata =>
  withData ? { sourceKey: sourceRefKeyOf(input.source), providerData: input.data } : { sourceKey: sourceRefKeyOf(input.source) };

/**
 * The Autodesk-class model adapter's command translator: proposes the
 * canonical models-area command for one provider observation. Pure and
 * deterministic — same input, same proposal; a translation failure is a
 * typed value, and a failed proposal never produces a command envelope.
 */
export function createModelTranslator(): AdapterCommandTranslator {
  return {
    proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError> {
      const objectKind = parseModelObjectKind(input.source.objectType);
      if (!objectKind.ok) {
        return fail(
          domainError(
            'invariant-violation',
            `the model adapter does not translate provider object kind '${String(input.source.objectType)}' — only the model object family (model, model-version, element, element-classification)`,
            [
              {
                code: 'model-object-kind-unknown',
                message: String(input.source.objectType),
                path: 'source.objectType',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }

      // Deletion discipline: elements retire (delete-of-version); the
      // containers' histories are append-only and never destructively deleted.
      if (input.changeKind === 'deleted') {
        if (objectKind.value === 'element') {
          const data = parseElementProviderData(input.data);
          if (!data.ok) {
            return fail(providerDataError(input.tenantId, data.error));
          }
          const canonical = requireCanonicalTarget(input);
          if (!canonical.ok) return canonical;
          return ok({
            commandName: RETIRE_ELEMENT_COMMAND,
            payload: {
              elementId: canonical.value.entityId,
              classification: data.value.classification,
              modelProviderId: data.value.modelId,
              modelVersionProviderId: data.value.modelVersionId,
              expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
              extensionMetadata: extensionMetadataOf(input, false),
            } satisfies AdapterJsonObject,
          });
        }
        return fail(
          domainError(
            'invariant-violation',
            `provider deletion of a ${objectKind.value} object is not a supported mutation: the canonical models-area history is append-only (model versions are immutable; container deletions are a divergence the runtime must reconcile explicitly) — only element deletion maps, as a retirement`,
            [
              {
                code: 'model-history-immutable',
                message: objectKind.value,
                path: 'changeKind',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }

      if (objectKind.value === 'model') {
        const data = parseModelProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        const name = input.displayName ?? `model-${input.source.objectId}`;
        if (input.changeKind === 'created') {
          return ok({
            commandName: REGISTER_MODEL_COMMAND,
            payload: {
              name,
              discipline: data.value.discipline,
              extensionMetadata: extensionMetadataOf(input, true),
            } satisfies AdapterJsonObject,
          });
        }
        const canonical = requireCanonicalTarget(input);
        if (!canonical.ok) return canonical;
        return ok({
          commandName: UPDATE_MODEL_COMMAND,
          payload: {
            modelId: canonical.value.entityId,
            expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
            changes: { name, discipline: data.value.discipline },
          } satisfies AdapterJsonObject,
        });
      }

      if (objectKind.value === 'model-version') {
        const data = parseModelVersionProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        if (input.changeKind === 'updated') {
          return fail(
            domainError(
              'invariant-violation',
              `provider model-version ${input.source.objectId} was updated in place — model versions are immutable (the document-revision discipline): a changed version is a NEW provider object, never a mutation of a registered one`,
              [
                {
                  code: 'model-version-immutable',
                  message: input.source.objectId,
                  path: 'changeKind',
                },
              ],
              { scope: { kind: 'tenant', tenantId: input.tenantId } },
            ),
          );
        }
        const canonical = requireCanonicalTarget(input);
        if (!canonical.ok) return canonical;
        return ok({
          commandName: REGISTER_MODEL_VERSION_COMMAND,
          payload: {
            modelVersionId: canonical.value.entityId,
            parentModelProviderId: data.value.modelId,
            label: data.value.label,
            extensionMetadata: extensionMetadataOf(input, true),
          } satisfies AdapterJsonObject,
        });
      }

      if (objectKind.value === 'element-classification') {
        const data = parseClassificationProviderData(input.data);
        if (!data.ok) {
          return fail(providerDataError(input.tenantId, data.error));
        }
        if (input.changeKind === 'created') {
          const canonical = requireCanonicalTarget(input);
          if (!canonical.ok) return canonical;
          return ok({
            commandName: REGISTER_CLASSIFICATION_COMMAND,
            payload: {
              classificationId: canonical.value.entityId,
              code: data.value.code,
              description: data.value.description,
              extensionMetadata: extensionMetadataOf(input, true),
            } satisfies AdapterJsonObject,
          });
        }
        const canonical = requireCanonicalTarget(input);
        if (!canonical.ok) return canonical;
        return ok({
          commandName: UPDATE_CLASSIFICATION_COMMAND,
          payload: {
            classificationId: canonical.value.entityId,
            expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
            changes: { description: data.value.description },
          } satisfies AdapterJsonObject,
        });
      }

      // objectKind.value === 'element'
      const data = parseElementProviderData(input.data);
      if (!data.ok) {
        return fail(providerDataError(input.tenantId, data.error));
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: RECORD_ELEMENT_CHANGE_COMMAND,
        payload: {
          elementId: canonical.value.entityId,
          change: input.changeKind,
          displayName: input.displayName ?? `element-${input.source.objectId}`,
          classification: data.value.classification,
          quantity: data.value.quantity,
          modelProviderId: data.value.modelId,
          modelVersionProviderId: data.value.modelVersionId,
          linkedRefs: data.value.linkedRefs,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          extensionMetadata: extensionMetadataOf(input, true),
        } satisfies AdapterJsonObject,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The canonical models-area event payloads (strict-keyed, fail-closed).
// ---------------------------------------------------------------------------

/** Full provider provenance carried by every models-area event payload. */
export interface ModelEventProvenance {
  /** The canonical serialization of the provider SourceRef (full identity). */
  readonly sourceKey: string;
  /** The provider object id the observation came from. */
  readonly providerObjectId: string;
  /** The provider version/etag of the observation. */
  readonly providerVersion: string;
}

/** Payload of `models.modelRegistered`. */
export interface ModelRegisteredPayload {
  readonly modelId: EntityId;
  readonly name: string;
  readonly discipline: ModelDiscipline;
  readonly provenance: ModelEventProvenance;
}

/** Payload of `models.modelUpdated`. */
export interface ModelUpdatedPayload {
  readonly modelId: EntityId;
  readonly name: string;
  readonly discipline: ModelDiscipline;
  readonly version: number;
  readonly provenance: ModelEventProvenance;
}

/** Payload of `models.modelVersionRegistered`. */
export interface ModelVersionRegisteredPayload {
  readonly modelId: EntityId;
  readonly modelVersionId: EntityId;
  readonly label: string;
  readonly provenance: ModelEventProvenance;
}

/** Payload of `models.classificationRegistered`. */
export interface ClassificationRegisteredPayload {
  readonly classificationId: EntityId;
  readonly code: ElementClassification;
  readonly description: string;
  readonly provenance: ModelEventProvenance;
}

/** Payload of `models.classificationUpdated`. */
export interface ClassificationUpdatedPayload {
  readonly classificationId: EntityId;
  readonly code: ElementClassification;
  readonly description: string;
  readonly version: number;
  readonly provenance: ModelEventProvenance;
}

/** Payload of THE `models.elementChanged` event (element created or updated). */
export interface ElementChangedPayload {
  readonly elementId: EntityId;
  readonly modelId: EntityId;
  readonly modelVersionId: EntityId;
  readonly classification: ElementClassification;
  readonly change: 'created' | 'updated';
  readonly displayName: string;
  readonly quantity: ElementQuantity | null;
  /**
   * The canonical entities linked to the element in OTHER systems (the
   * resolved provider link refs — e.g. the activities whose quantities the
   * element drives and the documents that evidence it), in canonical order.
   * THE input of the affected-relationship notification flow.
   */
  readonly affectedEntityRefs: readonly EntityRef[];
  readonly provenance: ModelEventProvenance & {
    /** The raw provider link refs the affected entities were resolved from. */
    readonly rawLinkedRefs: readonly ProviderLinkRef[];
  };
}

/** Payload of the `models.elementRetired` event (delete-of-version). */
export interface ElementRetiredPayload {
  readonly elementId: EntityId;
  readonly modelId: EntityId;
  readonly modelVersionId: EntityId;
  readonly classification: ElementClassification;
  readonly displayName: string;
  readonly affectedEntityRefs: readonly EntityRef[];
  readonly provenance: ModelEventProvenance & {
    readonly rawLinkedRefs: readonly ProviderLinkRef[];
  };
}

/** Every models-area event payload, discriminated by its event name. */
export type ModelEventPayloads =
  | ModelRegisteredPayload
  | ModelUpdatedPayload
  | ModelVersionRegisteredPayload
  | ClassificationRegisteredPayload
  | ClassificationUpdatedPayload
  | ElementChangedPayload
  | ElementRetiredPayload;

const NAME_RULE: StringRule = { min: 1, max: 512, description: 'display name (1..512 characters)' };
const AGGREGATE_VERSION_DESCRIPTION = 'a positive aggregate version (integer >= 1)';
const SOURCE_KEY_RULE: StringRule = {
  min: 2,
  max: 1024,
  pattern: /^\[.*\]$/,
  description: 'the canonical JSON serialization of a SourceRef (a JSON array)',
};

const parseProvenance = (raw: unknown): ParseResult<ModelEventProvenance> => {
  if (!isPlainObject(raw)) {
    return parseFail(
      'invalid-type',
      '',
      'ModelEventProvenance: { sourceKey, providerObjectId, providerVersion }',
      describeValue(raw),
    );
  }
  const sourceKey = requireString(raw, 'sourceKey', '', SOURCE_KEY_RULE);
  if (!sourceKey.ok) return sourceKey;
  const providerObjectId = requireString(raw, 'providerObjectId', '', PROVIDER_ID_RULE);
  if (!providerObjectId.ok) return providerObjectId;
  const providerVersion = requireString(raw, 'providerVersion', '', PROVIDER_ID_RULE);
  if (!providerVersion.ok) return providerVersion;
  return parseOk(
    {
      sourceKey: sourceKey.value,
      providerObjectId: providerObjectId.value,
      providerVersion: providerVersion.value,
    } satisfies ModelEventProvenance,
  );
};

const parseEntityIdField = (raw: Record<string, unknown>, field: string): ParseResult<EntityId> =>
  requireFieldWith(raw, field, '', parseEntityId);

const parseEntityRefArray = (raw: unknown, field: string): ParseResult<readonly EntityRef[]> =>
  parseValueArray(raw, field, parseEntityRef, 'array of canonical EntityRefs');

const parseRawLinkedRefs = (raw: unknown): ParseResult<readonly ProviderLinkRef[]> =>
  parseValueArray(raw, 'rawLinkedRefs', parseProviderLinkRef, 'array of provider link refs');

/** Parse an untrusted value as a ModelRegisteredPayload (strict keys). */
export function parseModelRegisteredPayload(raw: unknown): ParseResult<ModelRegisteredPayload> {
  if (!isPlainObject(raw)) return rootFailure<ModelRegisteredPayload>('models.modelRegistered');
  const grammar = "ModelRegisteredPayload: { modelId, name, discipline, provenance }";
  const unknownKey = unknownKeyFailure(raw, ['modelId', 'name', 'discipline', 'provenance'], '', grammar);
  if (unknownKey) return unknownKey;
  const modelId = parseEntityIdField(raw, 'modelId');
  if (!modelId.ok) return modelId;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const discipline = requireFieldWith(raw, 'discipline', '', parseModelDiscipline);
  if (!discipline.ok) return discipline;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      modelId: modelId.value,
      name: name.value,
      discipline: discipline.value,
      provenance: provenance.value,
    } satisfies ModelRegisteredPayload,
  );
}

/** Parse an untrusted value as a ModelUpdatedPayload (strict keys). */
export function parseModelUpdatedPayload(raw: unknown): ParseResult<ModelUpdatedPayload> {
  if (!isPlainObject(raw)) return rootFailure<ModelUpdatedPayload>('models.modelUpdated');
  const grammar = "ModelUpdatedPayload: { modelId, name, discipline, version, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['modelId', 'name', 'discipline', 'version', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const modelId = parseEntityIdField(raw, 'modelId');
  if (!modelId.ok) return modelId;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const discipline = requireFieldWith(raw, 'discipline', '', parseModelDiscipline);
  if (!discipline.ok) return discipline;
  const version = requirePositiveNumber(raw, 'version', '', AGGREGATE_VERSION_DESCRIPTION);
  if (!version.ok) return version;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      modelId: modelId.value,
      name: name.value,
      discipline: discipline.value,
      version: version.value,
      provenance: provenance.value,
    } satisfies ModelUpdatedPayload,
  );
}

/** Parse an untrusted value as a ModelVersionRegisteredPayload (strict keys). */
export function parseModelVersionRegisteredPayload(
  raw: unknown,
): ParseResult<ModelVersionRegisteredPayload> {
  if (!isPlainObject(raw)) {
    return rootFailure<ModelVersionRegisteredPayload>('models.modelVersionRegistered');
  }
  const grammar = "ModelVersionRegisteredPayload: { modelId, modelVersionId, label, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['modelId', 'modelVersionId', 'label', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const modelId = parseEntityIdField(raw, 'modelId');
  if (!modelId.ok) return modelId;
  const modelVersionId = parseEntityIdField(raw, 'modelVersionId');
  if (!modelVersionId.ok) return modelVersionId;
  const label = requireString(raw, 'label', '', LABEL_RULE);
  if (!label.ok) return label;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      modelId: modelId.value,
      modelVersionId: modelVersionId.value,
      label: label.value,
      provenance: provenance.value,
    } satisfies ModelVersionRegisteredPayload,
  );
}

/** Parse an untrusted value as a ClassificationRegisteredPayload (strict keys). */
export function parseClassificationRegisteredPayload(
  raw: unknown,
): ParseResult<ClassificationRegisteredPayload> {
  if (!isPlainObject(raw)) {
    return rootFailure<ClassificationRegisteredPayload>('models.classificationRegistered');
  }
  const grammar = "ClassificationRegisteredPayload: { classificationId, code, description, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['classificationId', 'code', 'description', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const classificationId = parseEntityIdField(raw, 'classificationId');
  if (!classificationId.ok) return classificationId;
  const code = requireFieldWith(raw, 'code', '', parseElementClassification);
  if (!code.ok) return code;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      classificationId: classificationId.value,
      code: code.value,
      description: description.value,
      provenance: provenance.value,
    } satisfies ClassificationRegisteredPayload,
  );
}

/** Parse an untrusted value as a ClassificationUpdatedPayload (strict keys). */
export function parseClassificationUpdatedPayload(
  raw: unknown,
): ParseResult<ClassificationUpdatedPayload> {
  if (!isPlainObject(raw)) {
    return rootFailure<ClassificationUpdatedPayload>('models.classificationUpdated');
  }
  const grammar = "ClassificationUpdatedPayload: { classificationId, code, description, version, provenance }";
  const unknownKey = unknownKeyFailure(
    raw,
    ['classificationId', 'code', 'description', 'version', 'provenance'],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const classificationId = parseEntityIdField(raw, 'classificationId');
  if (!classificationId.ok) return classificationId;
  const code = requireFieldWith(raw, 'code', '', parseElementClassification);
  if (!code.ok) return code;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const version = requirePositiveNumber(raw, 'version', '', AGGREGATE_VERSION_DESCRIPTION);
  if (!version.ok) return version;
  const provenance = requireFieldWith(raw, 'provenance', '', parseProvenance);
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      classificationId: classificationId.value,
      code: code.value,
      description: description.value,
      version: version.value,
      provenance: provenance.value,
    } satisfies ClassificationUpdatedPayload,
  );
}

/** Parse an untrusted value as an ElementChangedPayload (strict keys). */
export function parseElementChangedPayload(raw: unknown): ParseResult<ElementChangedPayload> {
  if (!isPlainObject(raw)) return rootFailure<ElementChangedPayload>('models.elementChanged');
  const grammar =
    "ElementChangedPayload: { elementId, modelId, modelVersionId, classification, change: 'created' | 'updated', displayName, quantity: ElementQuantity | null, affectedEntityRefs: EntityRef[], provenance: { sourceKey, providerObjectId, providerVersion, rawLinkedRefs } }";
  const unknownKey = unknownKeyFailure(
    raw,
    [
      'elementId',
      'modelId',
      'modelVersionId',
      'classification',
      'change',
      'displayName',
      'quantity',
      'affectedEntityRefs',
      'provenance',
    ],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const elementId = parseEntityIdField(raw, 'elementId');
  if (!elementId.ok) return elementId;
  const modelId = parseEntityIdField(raw, 'modelId');
  if (!modelId.ok) return modelId;
  const modelVersionId = parseEntityIdField(raw, 'modelVersionId');
  if (!modelVersionId.ok) return modelVersionId;
  const classification = requireFieldWith(raw, 'classification', '', parseElementClassification);
  if (!classification.ok) return classification;
  const change = requireLiteral(raw, 'change', '', ['created', 'updated']);
  if (!change.ok) return change;
  const displayName = requireString(raw, 'displayName', '', NAME_RULE);
  if (!displayName.ok) return displayName;
  const quantity = requireNullableFieldWith(raw, 'quantity', '', parseElementQuantity);
  if (!quantity.ok) return quantity;
  const affectedEntityRefs = parseEntityRefArray(raw['affectedEntityRefs'], 'affectedEntityRefs');
  if (!affectedEntityRefs.ok) return affectedEntityRefs;
  const provenance = requireFieldWith(
    raw,
    'provenance',
    '',
    (value: unknown): ParseResult<ElementChangedPayload['provenance']> => {
      if (!isPlainObject(value)) {
        return rootFailure<ElementChangedPayload['provenance']>('provenance');
      }
      const base = parseProvenance(value);
      if (!base.ok) return base;
      const rawLinkedRefs = parseRawLinkedRefs(value['rawLinkedRefs']);
      if (!rawLinkedRefs.ok) return rawLinkedRefs;
      return parseOk({ ...base.value, rawLinkedRefs: rawLinkedRefs.value });
    },
  );
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      elementId: elementId.value,
      modelId: modelId.value,
      modelVersionId: modelVersionId.value,
      classification: classification.value,
      change: change.value as 'created' | 'updated',
      displayName: displayName.value,
      quantity: quantity.value,
      affectedEntityRefs: affectedEntityRefs.value,
      provenance: provenance.value,
    } satisfies ElementChangedPayload,
  );
}

/** Parse an untrusted value as an ElementRetiredPayload (strict keys). */
export function parseElementRetiredPayload(raw: unknown): ParseResult<ElementRetiredPayload> {
  if (!isPlainObject(raw)) return rootFailure<ElementRetiredPayload>('models.elementRetired');
  const grammar =
    "ElementRetiredPayload: { elementId, modelId, modelVersionId, classification, displayName, affectedEntityRefs: EntityRef[], provenance: { sourceKey, providerObjectId, providerVersion, rawLinkedRefs } }";
  const unknownKey = unknownKeyFailure(
    raw,
    [
      'elementId',
      'modelId',
      'modelVersionId',
      'classification',
      'displayName',
      'affectedEntityRefs',
      'provenance',
    ],
    '',
    grammar,
  );
  if (unknownKey) return unknownKey;
  const elementId = parseEntityIdField(raw, 'elementId');
  if (!elementId.ok) return elementId;
  const modelId = parseEntityIdField(raw, 'modelId');
  if (!modelId.ok) return modelId;
  const modelVersionId = parseEntityIdField(raw, 'modelVersionId');
  if (!modelVersionId.ok) return modelVersionId;
  const classification = requireFieldWith(raw, 'classification', '', parseElementClassification);
  if (!classification.ok) return classification;
  const displayName = requireString(raw, 'displayName', '', NAME_RULE);
  if (!displayName.ok) return displayName;
  const affectedEntityRefs = parseEntityRefArray(raw['affectedEntityRefs'], 'affectedEntityRefs');
  if (!affectedEntityRefs.ok) return affectedEntityRefs;
  const provenance = requireFieldWith(
    raw,
    'provenance',
    '',
    (value: unknown): ParseResult<ElementRetiredPayload['provenance']> => {
      if (!isPlainObject(value)) {
        return rootFailure<ElementRetiredPayload['provenance']>('provenance');
      }
      const base = parseProvenance(value);
      if (!base.ok) return base;
      const rawLinkedRefs = parseRawLinkedRefs(value['rawLinkedRefs']);
      if (!rawLinkedRefs.ok) return rawLinkedRefs;
      return parseOk({ ...base.value, rawLinkedRefs: rawLinkedRefs.value });
    },
  );
  if (!provenance.ok) return provenance;
  return parseOk(
    {
      elementId: elementId.value,
      modelId: modelId.value,
      modelVersionId: modelVersionId.value,
      classification: classification.value,
      displayName: displayName.value,
      affectedEntityRefs: affectedEntityRefs.value,
      provenance: provenance.value,
    } satisfies ElementRetiredPayload,
  );
}

/** Local fail-closed root-type failure helper. */
function rootFailure<T>(grammarName: string): ParseResult<T> {
  return parseFail(
    'invalid-type',
    '',
    `a JSON object (${grammarName} payload)`,
    describeValue(null),
  ) as ParseResult<T>;
}

/**
 * Parse an untrusted payload for one models-area event name (strict keys,
 * fail-closed). Returns null when the name is not a models-area event name
 * (the projection skips unknown names deterministically); a RECOGNIZED name
 * with a malformed payload is a typed parse failure instead.
 */
export function parseModelEventPayload(
  eventName: EventName,
  raw: unknown,
): ParseResult<ModelEventPayloads> | null {
  if (!isModelEventName(eventName)) return null;
  switch (eventName) {
    case MODEL_REGISTERED_EVENT:
      return parseModelRegisteredPayload(raw);
    case MODEL_UPDATED_EVENT:
      return parseModelUpdatedPayload(raw);
    case MODEL_VERSION_REGISTERED_EVENT:
      return parseModelVersionRegisteredPayload(raw);
    case CLASSIFICATION_REGISTERED_EVENT:
      return parseClassificationRegisteredPayload(raw);
    case CLASSIFICATION_UPDATED_EVENT:
      return parseClassificationUpdatedPayload(raw);
    case ELEMENT_CHANGED_EVENT:
      return parseElementChangedPayload(raw);
    case ELEMENT_RETIRED_EVENT:
      return parseElementRetiredPayload(raw);
    default:
      // Unreachable: every MODEL_EVENT_NAMES member is handled above (the
      // isModelEventName guard ran first); the default keeps the switch
      // total over future vocabulary extensions.
      return null;
  }
}

// ---------------------------------------------------------------------------
// The trusted event-envelope builders (the host-side execution seam).
// ---------------------------------------------------------------------------

/**
 * Derive the event causality from the command envelope (the OFF-005 ledger
 * convention): the correlation id of the causal chain is carried over; the
 * causation id of the resulting event is the COMMAND's idempotency key —
 * the id of the message that caused this mutation. For an adapter-proposed
 * command that key is the SourceRef-derived sync idempotency key, so the
 * canonical event is traceable to the exact provider object version.
 * Trusted path: the envelope was already validated (the idempotency-key
 * grammar is exactly the causation-id grammar), so a parse failure here is
 * a loud TypeError, never a silent drop.
 */
const causalityOf = (command: CommandEnvelope<unknown>): Causality => {
  const causationId = parseCausationId(command.idempotencyKey);
  if (!causationId.ok) {
    throw new TypeError(
      `command idempotency key is not a valid causation id: ${command.idempotencyKey}`,
    );
  }
  return {
    correlationId: command.causality.correlationId,
    causationId: causationId.value,
  };
};

/** Inputs of modelEventEnvelope (the generic trusted builder). */
export interface ModelEventEnvelopeParts<P extends ModelEventPayloads> {
  /** The executed command (actor, scope, and causal chain come from it). */
  readonly command: CommandEnvelope<unknown>;
  readonly eventName: EventName;
  /** The injected clock's instant recorded as occurredAt. */
  readonly occurredAt: Timestamp;
  /** Before/after entity references per the transition kind (freeze A3). */
  readonly entityRefs: EntityRefs;
  readonly payload: P;
}

/**
 * Build one canonical models-area event envelope (trusted path;
 * self-checked through the contracts parser AND the strict payload parser
 * for the event name, so an emitted event can never be invalid): source is
 * 'domain' (the canonical command path emits; the adapter ORIGIN is carried
 * by the adapter actor, the SourceRef-derived causation id, and the
 * payload's provenance block), scope and actor come from the command, and
 * the causal chain ties the event back to the exact provider object version.
 */
export function modelEventEnvelope<P extends ModelEventPayloads>(
  parts: ModelEventEnvelopeParts<P>,
): DomainEventEnvelope<P> {
  const eventName = parseModelEventName(parts.eventName);
  if (!eventName.ok) {
    throw new TypeError(`not a models-area event name: ${String(parts.eventName)}`);
  }
  const payloadCheck = parseModelEventPayload(eventName.value, parts.payload);
  if (payloadCheck === null || !payloadCheck.ok) {
    const failure = payloadCheck === null ? null : payloadCheck.error;
    throw new TypeError(
      `invalid ${eventName.value} payload: ${failure === null ? 'event name not recognized' : `${failure.code} at '${failure.path === '' ? '<root>' : failure.path}'`}`,
    );
  }
  const envelope: DomainEventEnvelope<P> = {
    kind: 'event',
    eventName: eventName.value,
    scope: parts.command.scope,
    actor: parts.command.actor,
    source: 'domain',
    causality: causalityOf(parts.command),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: parts.occurredAt,
    entityRefs: parts.entityRefs,
    payload: parts.payload,
  };
  const roundTrip = parseDomainEventEnvelope(envelope);
  if (!roundTrip.ok) {
    throw new TypeError(
      `models-area event envelope did not round-trip the contracts parser: ${roundTrip.error.code} at '${roundTrip.error.path}'`,
    );
  }
  return envelope;
}

/** Inputs of elementChangedEnvelope (THE flow's element-mutation builder). */
export interface ElementChangedEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  /** The canonical element (before = null on creation). */
  readonly element: EntityRef;
  /** The owning model-version's canonical entity (resolved through mappings). */
  readonly modelVersion: EntityRef;
  /** The owning model's canonical entity (resolved through mappings). */
  readonly model: EntityRef;
  readonly classification: ElementClassification;
  readonly change: 'created' | 'updated';
  readonly displayName: string;
  readonly quantity: ElementQuantity | null;
  /** The resolved canonical linked entities (sorted canonically here). */
  readonly affectedEntityRefs: readonly EntityRef[];
  /** The raw provider link refs the affected entities were resolved from. */
  readonly rawLinkedRefs: readonly ProviderLinkRef[];
  /** The provider object id and version the observation came from. */
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/**
 * Compose THE `models.elementChanged` canonical event envelope: the
 * element-mutation event of the canonical flow (created or updated — before
 * is null on creation, otherwise both refs carry the persisting element).
 */
export function elementChangedEnvelope(
  parts: ElementChangedEnvelopeParts,
): DomainEventEnvelope<ElementChangedPayload> {
  return modelEventEnvelope({
    command: parts.command,
    eventName: ELEMENT_CHANGED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: {
      before: parts.change === 'created' ? null : parts.element,
      after: parts.element,
    },
    payload: {
      elementId: parts.element.entityId,
      modelId: parts.model.entityId,
      modelVersionId: parts.modelVersion.entityId,
      classification: parts.classification,
      change: parts.change,
      displayName: parts.displayName,
      quantity: parts.quantity,
      affectedEntityRefs: [...parts.affectedEntityRefs].sort(compareEntityRef),
      provenance: {
        sourceKey: sourceKeyOf(parts),
        providerObjectId: parts.providerObjectId,
        providerVersion: parts.providerVersion,
        rawLinkedRefs: parts.rawLinkedRefs,
      },
    },
  });
}

/** Inputs of elementRetiredEnvelope (the delete-of-version builder). */
export interface ElementRetiredEnvelopeParts {
  readonly command: CommandEnvelope<unknown>;
  readonly occurredAt: Timestamp;
  /** The canonical element (persists — retirement is a state transition). */
  readonly element: EntityRef;
  readonly modelVersion: EntityRef;
  readonly model: EntityRef;
  readonly classification: ElementClassification;
  readonly displayName: string;
  readonly affectedEntityRefs: readonly EntityRef[];
  readonly rawLinkedRefs: readonly ProviderLinkRef[];
  readonly providerObjectId: string;
  readonly providerVersion: string;
}

/**
 * Compose the `models.elementRetired` canonical event envelope: the
 * delete-of-version discipline — the element entity PERSISTS with its whole
 * history (entityRefs carry before AND after), and the retirement is what
 * the linked entities are affected by.
 */
export function elementRetiredEnvelope(
  parts: ElementRetiredEnvelopeParts,
): DomainEventEnvelope<ElementRetiredPayload> {
  return modelEventEnvelope({
    command: parts.command,
    eventName: ELEMENT_RETIRED_EVENT,
    occurredAt: parts.occurredAt,
    entityRefs: { before: parts.element, after: parts.element },
    payload: {
      elementId: parts.element.entityId,
      modelId: parts.model.entityId,
      modelVersionId: parts.modelVersion.entityId,
      classification: parts.classification,
      displayName: parts.displayName,
      affectedEntityRefs: [...parts.affectedEntityRefs].sort(compareEntityRef),
      provenance: {
        sourceKey: sourceKeyOf(parts),
        providerObjectId: parts.providerObjectId,
        providerVersion: parts.providerVersion,
        rawLinkedRefs: parts.rawLinkedRefs,
      },
    },
  });
}

/** The sourceKey derivation shared by the element envelope builders (local). */
const sourceKeyOf = (parts: {
  readonly command: CommandEnvelope<unknown>;
  readonly providerObjectId: string;
  readonly providerVersion: string;
}): string => {
  // The command payload's extensionMetadata carries the canonical sourceKey
  // the translator composed from the observed SourceRef (sourceRefKeyOf);
  // the recomposition below is the fail-safe for commands assembled without
  // it — both agree by construction over the fixture's provider identity.
  const payload = parts.command.payload as {
    readonly extensionMetadata?: { readonly sourceKey?: unknown };
  };
  const sourceKey = payload?.extensionMetadata?.sourceKey;
  if (typeof sourceKey === 'string' && sourceKey.startsWith('[')) {
    return sourceKey;
  }
  return sourceRefKeyOf(
    sourceRef({
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: ELEMENT_OBJECT_KIND,
      objectId: providerObjectId(parts.providerObjectId),
      version: providerVersion(parts.providerVersion),
    }),
  );
};

