// Office adapter-construction — object mapping & command translation (OFF-021).
//
// THE document/RFI/change-event/observation mapping: the adapter-implemented
// AdapterCommandTranslator that turns one provider observation (an
// AdapterCommandInput from the SDK's sync or webhook engine) into a TYPED
// canonical command proposal — the ONLY way this package touches the
// canonical graph (freeze A8/A11: adapters propose, the Action Gateway /
// application layer executes; adapters never write canonical state).
//
// The translation is total and deterministic: for one (object kind, change
// kind) pair it is a pure function of the provider payload data, the
// resolved canonical target, and the observed canonical version. Provider
// payload data is parsed FAIL-CLOSED per object kind first — a malformed
// payload is a typed translation failure, never a partially-filled command.
//
// The A10 discipline inside payloads: identity references carried in
// provider data (project, contract, users, evidence document/revision ids)
// are the OFFICE-ISSUED ids the provider learned when its workspace was
// provisioned from office — they are parsed fail-closed as canonical ids
// (parseProjectId/parseEntityId), and the adapter NEVER manufactures a
// canonical id out of a provider object id. The canonical aggregate id of
// the translated object itself always comes from the engine's mapping
// record (office-issued through the injected supplier), never from the
// provider.
//
// Documented translation decisions (the adapter OWNS these — freeze A6):
//   document    created → documents.registerDocument (title + extension
//                         metadata carrying full SourceRef provenance)
//               updated → documents.attachRevision (the provider's current
//                         revision content)
//               deleted → documents.archiveDocument (the tombstone)
//   rfi         created → field.raiseIssue (question as description)
//               updated → field.commentOnIssue (a comment carrying the
//                         provider's current question at this version)
//               deleted → field.resolveIssue (a closed RFI resolves canonically)
//   change-event created → contracts.raiseChangeEvent (contract ref + type)
//               updated → contracts.linkChangeReferences (the append-only
//                         impact links added since the last synchronized
//                         version — the LAST cost impact and/or schedule
//                         activity reference)
//               deleted → FAILS CLOSED: the canonical contracts domain models
//                         change events as append-only and has no landed
//                         command that withdraws one; the adapter refuses to
//                         invent a semantic that does not exist.
//   observation created → field.captureFieldEvent (the observation capture)
//               updated → field.attachFieldEventEvidence (the latest
//                         append-only evidence reference)
//               deleted → field.resolveFieldEvent (a voided observation
//                         resolves canonically, note citing the source)
import {
  parseEntityId,
  parseFail,
  parseProjectId,
  parseTimestamp,
} from '@office/contracts';
import type {
  ContractParseError,
  EntityId,
  ParseResult,
  ProjectId,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import type {
  AdapterCommandInput,
  AdapterCommandProposal,
  AdapterCommandTranslator,
  AdapterJsonObject,
} from '@office/adapters-sdk';
import { requireCanonicalTarget, sourceRefKeyOf } from '@office/adapters-sdk';
import {
  CHANGE_EVENT_OBJECT_KIND,
  DOCUMENT_OBJECT_KIND,
  OBSERVATION_OBJECT_KIND,
  RFI_OBJECT_KIND,
  constructionObjectMappingOf,
} from './vocabulary';
import type { ConstructionObjectMapping } from './vocabulary';
import {
  checkString,
  describeValue,
  isPlainObject,
  optionalField,
  requireArrayField,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireNumberField,
  requireRecordField,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';

// ---- per-kind string rules (mirroring the canonical payload bounds) --------
const TITLE_RULE: StringRule = { min: 1, max: 200, description: 'object title' };
const QUESTION_RULE: StringRule = {
  min: 1,
  max: 1500,
  description: 'the RFI question body (bounded so the canonical comment stays under 2000)',
};
const CATEGORY_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case category',
};
const DISCIPLINE_RULE: StringRule = { min: 1, max: 64, description: 'document discipline' };
const SUMMARY_RULE: StringRule = { min: 1, max: 200, description: 'observation summary' };
const DETAIL_RULE: StringRule = { min: 1, max: 4000, description: 'free-text detail' };
const LOCATION_RULE: StringRule = { min: 1, max: 200, description: 'observation location' };
const REVISION_ID_RULE: StringRule = {
  min: 1,
  max: 128,
  description: 'provider revision reference',
};
const CONTENT_RULE: StringRule = {
  min: 1,
  max: 65_536,
  description: 'revision content as canonical base64',
};
const UNIT_RULE: StringRule = { min: 1, max: 32, description: 'measurement unit' };

const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const CHANGE_TYPES = ['addition', 'modification', 'deletion'] as const;

/** The fail-closed-parsed provider data of one controlled document. */
export interface DocumentProviderData {
  readonly title: string;
  readonly projectId: ProjectId;
  readonly discipline: string;
  readonly revision: { readonly revisionId: string; readonly contentBase64: string };
}

const DOCUMENT_DATA_KEYS = [
  'title',
  'projectId',
  'discipline',
  'revision',
] as const;
const DOCUMENT_REVISION_KEYS = ['revisionId', 'contentBase64'] as const;

/** Parse untrusted provider payload data as one document's data (fail-closed). */
export function parseDocumentProviderData(
  raw: unknown,
): ParseResult<DocumentProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, DOCUMENT_DATA_KEYS, '', 'document provider data');
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const discipline = requireString(raw, 'discipline', '', DISCIPLINE_RULE);
  if (!discipline.ok) return discipline;
  const revisionRecord = requireRecordField(raw, 'revision', '');
  if (!revisionRecord.ok) return revisionRecord;
  const revisionUnknownKey = unknownKeyFailure(
    revisionRecord.value,
    DOCUMENT_REVISION_KEYS,
    'revision',
    'document revision { revisionId, contentBase64 }',
  );
  if (revisionUnknownKey) return revisionUnknownKey;
  const revisionId = requireString(revisionRecord.value, 'revisionId', 'revision', REVISION_ID_RULE);
  if (!revisionId.ok) return revisionId;
  const contentBase64 = requireString(
    revisionRecord.value,
    'contentBase64',
    'revision',
    CONTENT_RULE,
  );
  if (!contentBase64.ok) return contentBase64;
  return ok({
    title: title.value,
    projectId: projectId.value,
    discipline: discipline.value,
    revision: { revisionId: revisionId.value, contentBase64: contentBase64.value },
  });
}

/** The fail-closed-parsed provider data of one RFI. */
export interface RfiProviderData {
  readonly title: string;
  readonly projectId: ProjectId;
  readonly question: string;
  readonly category: string;
  readonly severity: (typeof ISSUE_SEVERITIES)[number];
  readonly raisedBy: EntityId;
  readonly raisedAt: Timestamp;
}

const RFI_DATA_KEYS = [
  'title',
  'projectId',
  'question',
  'category',
  'severity',
  'raisedBy',
  'raisedAt',
] as const;

/** Parse untrusted provider payload data as one RFI's data (fail-closed). */
export function parseRfiProviderData(raw: unknown): ParseResult<RfiProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RFI_DATA_KEYS, '', 'rfi provider data');
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const projectId = requireFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  const question = requireString(raw, 'question', '', QUESTION_RULE);
  if (!question.ok) return question;
  const category = requireString(raw, 'category', '', CATEGORY_RULE);
  if (!category.ok) return category;
  const severity = requireLiteral(raw, 'severity', '', ISSUE_SEVERITIES);
  if (!severity.ok) return severity;
  const raisedBy = requireFieldWith(raw, 'raisedBy', '', parseEntityId);
  if (!raisedBy.ok) return raisedBy;
  const raisedAt = requireFieldWith(raw, 'raisedAt', '', parseTimestamp);
  if (!raisedAt.ok) return raisedAt;
  return ok({
    title: title.value,
    projectId: projectId.value,
    question: question.value,
    category: category.value,
    severity: severity.value,
    raisedBy: raisedBy.value,
    raisedAt: raisedAt.value,
  });
}

/** One cost impact reference of a change event (office-issued ids or null). */
export interface ChangeEventCostImpact {
  readonly budgetId: EntityId | null;
  readonly costItemId: EntityId | null;
}

/** The fail-closed-parsed provider data of one change event. */
export interface ChangeEventProviderData {
  readonly title: string;
  readonly contractRef: EntityId;
  readonly changeType: (typeof CHANGE_TYPES)[number];
  readonly costImpacts: readonly ChangeEventCostImpact[];
  readonly scheduleImpactActivityIds: readonly EntityId[];
}

const CHANGE_EVENT_DATA_KEYS = [
  'title',
  'contractRef',
  'changeType',
  'costImpacts',
  'scheduleImpactActivityIds',
] as const;
const COST_IMPACT_KEYS = ['budgetId', 'costItemId'] as const;

const parseCostImpact = (raw: unknown): ParseResult<ChangeEventCostImpact> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'a cost impact object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COST_IMPACT_KEYS, '', 'cost impact { budgetId, costItemId }');
  if (unknownKey) return unknownKey;
  const budgetId = requireNullableFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const costItemId = requireNullableFieldWith(raw, 'costItemId', '', parseEntityId);
  if (!costItemId.ok) return costItemId;
  return ok({ budgetId: budgetId.value, costItemId: costItemId.value });
};

/** Parse untrusted provider payload data as one change event's data (fail-closed). */
export function parseChangeEventProviderData(
  raw: unknown,
): ParseResult<ChangeEventProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CHANGE_EVENT_DATA_KEYS, '', 'change-event provider data');
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const contractRef = requireFieldWith(raw, 'contractRef', '', parseEntityId);
  if (!contractRef.ok) return contractRef;
  const changeType = requireLiteral(raw, 'changeType', '', CHANGE_TYPES);
  if (!changeType.ok) return changeType;
  const costImpacts = requireArrayField(
    raw,
    'costImpacts',
    '',
    parseCostImpact,
    'an array of cost impact objects',
  );
  if (!costImpacts.ok) return costImpacts;
  const scheduleImpactActivityIds = requireArrayField(
    raw,
    'scheduleImpactActivityIds',
    '',
    parseEntityId,
    'an array of office-issued activity ids',
  );
  if (!scheduleImpactActivityIds.ok) return scheduleImpactActivityIds;
  return ok({
    title: title.value,
    contractRef: contractRef.value,
    changeType: changeType.value,
    costImpacts: costImpacts.value,
    scheduleImpactActivityIds: scheduleImpactActivityIds.value,
  });
}

/** One evidence reference of an observation (office-issued ids). */
export interface ObservationEvidenceReference {
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

/** The fail-closed-parsed provider data of one observation. */
export interface ObservationProviderData {
  readonly summary: string;
  readonly category: string;
  readonly detail?: string;
  readonly location: string;
  readonly observedAt: Timestamp;
  readonly observedBy: EntityId;
  readonly quantity?: { readonly value: number; readonly unit: string };
  readonly evidence?: readonly ObservationEvidenceReference[];
}

const OBSERVATION_DATA_KEYS = [
  'summary',
  'category',
  'detail',
  'location',
  'observedAt',
  'observedBy',
  'quantity',
  'evidence',
] as const;
const QUANTITY_KEYS = ['value', 'unit'] as const;
const EVIDENCE_KEYS = ['documentId', 'revisionId'] as const;

const parseEvidenceReference = (
  raw: unknown,
): ParseResult<ObservationEvidenceReference> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an evidence reference object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    EVIDENCE_KEYS,
    '',
    'evidence reference { documentId, revisionId }',
  );
  if (unknownKey) return unknownKey;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const revisionId = requireFieldWith(raw, 'revisionId', '', parseEntityId);
  if (!revisionId.ok) return revisionId;
  return ok({ documentId: documentId.value, revisionId: revisionId.value });
};

/** Parse untrusted provider payload data as one observation's data (fail-closed). */
export function parseObservationProviderData(
  raw: unknown,
): ParseResult<ObservationProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    OBSERVATION_DATA_KEYS,
    '',
    'observation provider data',
  );
  if (unknownKey) return unknownKey;
  const summary = requireString(raw, 'summary', '', SUMMARY_RULE);
  if (!summary.ok) return summary;
  const category = requireString(raw, 'category', '', CATEGORY_RULE);
  if (!category.ok) return category;
  const detail = optionalField(raw, 'detail', '', (value) =>
    checkString(value, DETAIL_RULE, ''),
  );
  if (!detail.ok) return detail;
  const location = requireString(raw, 'location', '', LOCATION_RULE);
  if (!location.ok) return location;
  const observedAt = requireFieldWith(raw, 'observedAt', '', parseTimestamp);
  if (!observedAt.ok) return observedAt;
  const observedBy = requireFieldWith(raw, 'observedBy', '', parseEntityId);
  if (!observedBy.ok) return observedBy;
  const quantityRecord = optionalField(raw, 'quantity', '', (value) => {
    if (!isPlainObject(value)) {
      return parseFail('invalid-type', '', 'an object', describeValue(value));
    }
    const quantityUnknownKey = unknownKeyFailure(
      value,
      QUANTITY_KEYS,
      '',
      'quantity { value, unit }',
    );
    if (quantityUnknownKey) return quantityUnknownKey;
    const quantityValue = requireNumberField(value, 'value', '', {
      min: 0,
      max: 1_000_000_000,
      description: 'a non-negative finite quantity value',
    });
    if (!quantityValue.ok) return quantityValue;
    const unit = requireString(value, 'unit', '', UNIT_RULE);
    if (!unit.ok) return unit;
    return ok({ value: quantityValue.value, unit: unit.value });
  });
  if (!quantityRecord.ok) return quantityRecord;
  const evidenceValue = raw['evidence'];
  let evidence: readonly ObservationEvidenceReference[] | undefined;
  if (evidenceValue !== undefined) {
    if (!Array.isArray(evidenceValue)) {
      return parseFail('invalid-type', 'evidence', 'an array', describeValue(evidenceValue));
    }
    const evidenceParsed = parseEvidenceArray(evidenceValue, 'evidence');
    if (!evidenceParsed.ok) return evidenceParsed;
    evidence = evidenceParsed.value;
  }
  return ok({
    summary: summary.value,
    category: category.value,
    ...(detail.value !== undefined ? { detail: detail.value } : {}),
    location: location.value,
    observedAt: observedAt.value,
    observedBy: observedBy.value,
    ...(quantityRecord.value !== undefined ? { quantity: quantityRecord.value } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  });
}

const parseEvidenceArray = (
  raw: readonly unknown[],
  field: string,
): ParseResult<readonly ObservationEvidenceReference[]> => {
  const references: ObservationEvidenceReference[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = parseEvidenceReference(item);
    if (!parsed.ok) {
      return parseFail(
        parsed.error.code,
        parsed.error.path === ''
          ? `${field}[${index}]`
          : `${field}[${index}].${parsed.error.path}`,
        parsed.error.expected,
        parsed.error.received,
      );
    }
    references.push(parsed.value);
  }
  return ok(references);
};

// ---- the translation failures (typed values, never throws) ----------------
const providerDataFailure = (
  input: AdapterCommandInput,
  error: ContractParseError,
): DomainError =>
  domainError(
    'invariant-violation',
    `provider payload data for ${input.source.objectType} ${input.source.objectId} failed fail-closed parsing: ${error.code} at '${error.path === '' ? '<root>' : error.path}'`,
    [
      {
        code: `provider-data-${error.code}`,
        message: error.received,
        path: error.path === '' ? null : error.path,
      },
    ],
    { scope: { kind: 'tenant', tenantId: input.tenantId } },
  );

const unmappedTransitionFailure = (
  input: AdapterCommandInput,
  mapping: ConstructionObjectMapping,
): DomainError =>
  domainError(
    'invariant-violation',
    `provider ${input.source.objectType} ${input.source.objectId} was '${input.changeKind}' at version ${input.source.version}, but no landed canonical command expresses that transition for canonical kind '${mapping.canonicalKind}' (the canonical domain models it as append-only) — the adapter refuses to invent canonical semantics (fail closed)`,
    [
      {
        code: 'provider-transition-unmapped',
        message: `${input.source.objectType}.${input.changeKind}`,
        path: 'changeKind',
      },
    ],
    { scope: { kind: 'tenant', tenantId: input.tenantId } },
  );

/** The provenance-carrying extension metadata every create/update payload embeds. */
const extensionMetadataOf = (input: AdapterCommandInput): AdapterJsonObject => ({
  sourceKey: sourceRefKeyOf(input.source),
  providerData: input.data,
});

// ---- per-kind translations -------------------------------------------------
const proposeDocumentCommand = (
  input: AdapterCommandInput,
  mapping: ConstructionObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseDocumentProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  const displayName = input.displayName ?? data.value.title;
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          projectId: data.value.projectId,
          title: displayName,
          extensionMetadata: extensionMetadataOf(input),
        },
      });
    case 'updated': {
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          projectId: data.value.projectId,
          documentId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          contentBase64: data.value.revision.contentBase64,
          extensionMetadata: extensionMetadataOf(input),
        },
      });
    }
    default: {
      if (mapping.deleteCommand === null) return fail(unmappedTransitionFailure(input, mapping));
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.deleteCommand,
        payload: {
          projectId: data.value.projectId,
          documentId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
        },
      });
    }
  }
};

const proposeRfiCommand = (
  input: AdapterCommandInput,
  mapping: ConstructionObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseRfiProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          title: input.displayName ?? data.value.title,
          description: data.value.question,
          category: data.value.category,
          severity: data.value.severity,
          reportedAt: data.value.raisedAt,
          reportedBy: data.value.raisedBy,
        },
      });
    case 'updated': {
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          issueId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          body: `CDE RFI ${input.source.objectId} updated to revision ${input.source.version}: ${data.value.question}`,
        },
      });
    }
    default: {
      if (mapping.deleteCommand === null) return fail(unmappedTransitionFailure(input, mapping));
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.deleteCommand,
        payload: {
          issueId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          resolutionNote: `RFI ${input.source.objectId} closed in the CDE at revision ${input.source.version}`,
        },
      });
    }
  }
};

const proposeChangeEventCommand = (
  input: AdapterCommandInput,
  mapping: ConstructionObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseChangeEventProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          contractId: data.value.contractRef,
          title: input.displayName ?? data.value.title,
          changeType: data.value.changeType,
          ...(data.value.costImpacts.length > 0
            ? {
                costImpactLinks: data.value.costImpacts.map((impact) => ({
                  budgetId: impact.budgetId,
                  costItemId: impact.costItemId,
                })),
              }
            : {}),
          ...(data.value.scheduleImpactActivityIds.length > 0
            ? { scheduleImpactActivityIds: [...data.value.scheduleImpactActivityIds] }
            : {}),
        },
      });
    case 'updated': {
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      // The append-only link lists: an update proposes linking what the
      // provider ADDED — the latest cost impact and/or the latest schedule
      // activity reference (deterministic: the last list entries are the new
      // ones; the canonical domain rejects duplicate links).
      const latestCostImpact = data.value.costImpacts.at(-1);
      const latestActivityId = data.value.scheduleImpactActivityIds.at(-1);
      if (latestCostImpact === undefined && latestActivityId === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `provider change event ${input.source.objectId} was updated at version ${input.source.version} but carries no new impact references — there is nothing to link canonically (contracts.linkChangeReferences requires at least one new link)`,
            [
              {
                code: 'provider-update-without-links',
                message: input.source.objectId,
                path: 'costImpacts',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          changeEventId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          ...(latestCostImpact !== undefined
            ? {
                costImpactLinks: [
                  { budgetId: latestCostImpact.budgetId, costItemId: latestCostImpact.costItemId },
                ],
              }
            : {}),
          ...(latestActivityId !== undefined
            ? { scheduleImpactActivityIds: [latestActivityId] }
            : {}),
        },
      });
    }
    default:
      // The withdrawn-change-event gap: the contracts domain models change
      // events as append-only; no landed command withdraws one. Fail closed.
      return fail(unmappedTransitionFailure(input, mapping));
  }
};

const proposeObservationCommand = (
  input: AdapterCommandInput,
  mapping: ConstructionObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseObservationProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          category: data.value.category,
          summary: input.displayName ?? data.value.summary,
          ...(data.value.detail !== undefined ? { detail: data.value.detail } : {}),
          location: data.value.location,
          observedAt: data.value.observedAt,
          observedBy: data.value.observedBy,
          ...(data.value.quantity !== undefined
            ? { quantity: data.value.quantity }
            : {}),
        },
      });
    case 'updated': {
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      // The append-only evidence list: an update proposes attaching the
      // LATEST evidence reference (the new one); the canonical domain
      // rejects duplicate evidence.
      const latestEvidence = data.value.evidence?.at(-1);
      if (latestEvidence === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `provider observation ${input.source.objectId} was updated at version ${input.source.version} but carries no evidence references — there is nothing to attach canonically (field.attachFieldEventEvidence requires at least one evidence reference)`,
            [
              {
                code: 'provider-update-without-evidence',
                message: input.source.objectId,
                path: 'evidence',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          fieldEventId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          evidence: [
            {
              entityKind: 'document',
              entityId: latestEvidence.documentId,
              revisionId: latestEvidence.revisionId,
            },
          ],
        },
      });
    }
    default: {
      if (mapping.deleteCommand === null) return fail(unmappedTransitionFailure(input, mapping));
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.deleteCommand,
        payload: {
          fieldEventId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          resolutionNote: `Observation ${input.source.objectId} voided in the CDE at revision ${input.source.version}`,
        },
      });
    }
  }
};

/**
 * Create the construction adapter's command translator (pure and
 * deterministic — no clock, no ids, no I/O; the canonical target and version
 * always arrive through the input the engine composed).
 */
export function createConstructionTranslator(): AdapterCommandTranslator {
  return {
    proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError> {
      const mapping = constructionObjectMappingOf(input.source.objectType);
      if (mapping === null) {
        return fail(
          domainError(
            'invariant-violation',
            `construction adapter does not translate provider object kind '${input.source.objectType}' — the mapping table declares ${mappingTableKinds()}`,
            [
              {
                code: 'object-kind-not-declared',
                message: input.source.objectType,
                path: 'source.objectType',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }
      switch (input.source.objectType) {
        case DOCUMENT_OBJECT_KIND:
          return proposeDocumentCommand(input, mapping);
        case RFI_OBJECT_KIND:
          return proposeRfiCommand(input, mapping);
        case CHANGE_EVENT_OBJECT_KIND:
          return proposeChangeEventCommand(input, mapping);
        case OBSERVATION_OBJECT_KIND:
          return proposeObservationCommand(input, mapping);
        default:
          return fail(
            domainError(
              'invariant-violation',
              `construction adapter does not translate provider object kind '${input.source.objectType}'`,
              [
                {
                  code: 'object-kind-not-declared',
                  message: input.source.objectType,
                  path: 'source.objectType',
                },
              ],
              { scope: { kind: 'tenant', tenantId: input.tenantId } },
            ),
          );
      }
    },
  };
}

const mappingTableKinds = (): string =>
  [DOCUMENT_OBJECT_KIND, RFI_OBJECT_KIND, CHANGE_EVENT_OBJECT_KIND, OBSERVATION_OBJECT_KIND].join(
    ', ',
  );
