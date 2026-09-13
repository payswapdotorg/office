// Office adapter-finance — financial reference mapping & command translation
// (OFF-024).
//
// TWO seams in one module — the financial reference mapping and the object
// mapping:
//
// 1. FINANCIAL REFERENCE MAPPING — the typed lookup/bind surface over the
//    SDK's tenant-scoped SourceMappingStore: provider account/cost-code/
//    commitment/invoice/payment ids resolve to canonical EntityIds (A10:
//    provider ids are NEVER primary keys; the mapping is the binding), an
//    unmapped reference is a typed not-found (fail closed — never a silent
//    null), and a REMAPPING attempt is the store's typed collision — an
//    explicit conflict, never an overwrite (the brief's remap discipline).
//
// 2. THE COMMAND TRANSLATOR — the adapter-implemented AdapterCommandTranslator
//    that turns one provider observation (an AdapterCommandInput from the
//    SDK's sync or webhook engine) into a TYPED canonical command proposal —
//    the ONLY way this package touches the canonical graph (freeze A8/A11:
//    adapters propose, the Action Gateway / application layer executes;
//    adapters never write canonical state).
//
// The translation is total and deterministic: for one (object kind, change
// kind) pair it is a pure function of the provider payload data, the resolved
// canonical target, and the observed canonical version. Provider payload data
// is parsed FAIL-CLOSED per object kind first — a malformed payload is a
// typed translation failure, never a partially-filled command.
//
// The A10 discipline inside payloads: identity references carried in provider
// data (project, budget, cost item, commitment, invoice) are the OFFICE-ISSUED
// ids the ERP learned when its finance workspace was provisioned from office
// — they are parsed fail-closed as canonical ids (parseProjectId/
// parseEntityId), and the adapter NEVER manufactures a canonical id out of a
// provider object id. The canonical aggregate id of the translated object
// itself always comes from the engine's mapping record (office-issued through
// the injected supplier), never from the provider.
//
// Documented translation decisions (the adapter OWNS these — freeze A6):
//   account     created → cost.createBudget (the ERP's per-project account IS
//                          the budget container; name + currency + project)
//               updated → cost.reviseBudget (the closest landed semantic for
//                          an account rename: budgets do not rename, they
//                          REVISE — the label records the ERP account state)
//               deleted → FAILS CLOSED: no landed canonical command retires a
//                          budget; its revision history stays.
//   cost-code   created → cost.recordCostItem (the ERP cost code is the
//                          budget line template: code/description/unit/
//                          quantity/rate)
//               updated → FAILS CLOSED: canonical cost items are append-only
//                          budget lines with unique codes; no landed command
//                          updates a line (re-recording would duplicate the
//                          code — the frozen anti-pattern).
//               deleted → FAILS CLOSED: no landed command removes a line.
//   commitment  created → cost.createCommitment (budget ref + kind + lines)
//               updated → cost.amendCommitment (the append-only line set: an
//                          update proposes amending with the lines the
//                          provider ADDED — the latest appended line; the
//                          canonical domain rejects duplicate lines)
//               deleted → cost.closeCommitment (a voided ERP commitment
//                          closes canonically, the reason citing the source)
//   invoice     created → cost.recordInvoice (the immutable commercial
//                          record: commitment ref + lines)
//               updated → FAILS CLOSED: canonical invoice amounts are
//                          immutable at record time; revisions flow through
//                          new invoices (the credit-note discipline). The
//                          adapter refuses to invent an amend semantic.
//               deleted → FAILS CLOSED: an invoice is an immutable
//                          commercial record — never deleted canonically.
//   payment     created → cost.referencePayment (the append-only payment
//                          reference against the invoice)
//               updated → FAILS CLOSED: payment references never change.
//               deleted → FAILS CLOSED: payment references never retract.
import {
  parseEntityId,
  parseFail,
  parseOk,
  parseProjectId,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  ContractParseError,
  EntityId,
  EntityRef,
  ParseResult,
  ProjectId,
  TenantId,
  Timestamp,
} from '@office/contracts';
import { domainError, fail, INITIAL_AGGREGATE_VERSION, ok } from '@office/domain-kernel';
import type { AggregateVersion, DomainError, Result } from '@office/domain-kernel';
import type {
  AdapterCommandInput,
  AdapterCommandProposal,
  AdapterCommandTranslator,
  AdapterJsonObject,
  ProviderVersion,
  SourceCoordinate,
  SourceMapping,
  SourceMappingStore,
} from '@office/adapters-sdk';
import { recordSourceMapping, requireCanonicalTarget, sourceRefKeyOf } from '@office/adapters-sdk';
import {
  ACCOUNT_OBJECT_KIND,
  COMMITMENT_OBJECT_KIND,
  COST_CODE_OBJECT_KIND,
  INVOICE_OBJECT_KIND,
  PAYMENT_OBJECT_KIND,
  financeObjectMappingOf,
} from './vocabulary';
import type { FinanceObjectMapping } from './vocabulary';
import {
  describeValue,
  isPlainObject,
  requireArrayField,
  requireFieldWith,
  requireLiteral,
  requireNullableFieldWith,
  requireNumberField,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';

// ---- per-kind string rules (mirroring the canonical payload bounds) --------
const CODE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[A-Z0-9][A-Z0-9._-]*$/,
  description: 'uppercase ERP code',
};
const NAME_RULE: StringRule = { min: 1, max: 200, description: 'account name' };
const NUMBER_RULE: StringRule = {
  min: 1,
  max: 64,
  description: 'commercial document number',
};
const DESCRIPTION_RULE: StringRule = { min: 1, max: 500, description: 'free-text description' };
const UNIT_RULE: StringRule = { min: 1, max: 32, description: 'measurement unit' };
const REFERENCE_RULE: StringRule = {
  min: 1,
  max: 128,
  description: 'external payment reference (a trace or check number)',
};
const CURRENCY_RULE: StringRule = {
  min: 3,
  max: 3,
  pattern: /^[A-Z]{3}$/,
  description: '3-uppercase-letter currency code',
};

const COMMITMENT_KINDS = ['purchase-order', 'subcontract'] as const;

const QUANTITY_MILLI_RULE = {
  min: 1,
  max: 1_000_000_000,
  description: 'quantity in integer milli-units (quantity × 1000)',
} as const;
const UNIT_RATE_MINOR_RULE = {
  min: 0,
  max: 1_000_000_000_000,
  description: 'unit rate in integer minor units per whole unit',
} as const;
const AMOUNT_MINOR_RULE = {
  min: 0,
  max: 1_000_000_000_000,
  description: 'amount in integer minor units',
} as const;
const PAYMENT_AMOUNT_MINOR_RULE = {
  min: 1,
  max: 1_000_000_000_000,
  description: 'paid amount in integer minor units',
} as const;

// ---- per-kind fail-closed provider-data parsers -----------------------------

/** The fail-closed-parsed provider data of one account. */
export interface AccountProviderData {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly projectRef: ProjectId;
}

const ACCOUNT_DATA_KEYS = ['code', 'name', 'currency', 'projectRef'] as const;

/** Parse untrusted provider payload data as one account's data (fail-closed). */
export function parseAccountProviderData(raw: unknown): ParseResult<AccountProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ACCOUNT_DATA_KEYS, '', 'account provider data');
  if (unknownKey) return unknownKey;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const currency = requireString(raw, 'currency', '', CURRENCY_RULE);
  if (!currency.ok) return currency;
  const projectRef = requireFieldWith(raw, 'projectRef', '', parseProjectId);
  if (!projectRef.ok) return projectRef;
  return parseOk({
    code: code.value,
    name: name.value,
    currency: currency.value,
    projectRef: projectRef.value,
  });
}

/** The fail-closed-parsed provider data of one cost code. */
export interface CostCodeProviderData {
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly budgetRef: EntityId;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
}

const COST_CODE_DATA_KEYS = [
  'code',
  'description',
  'unit',
  'budgetRef',
  'quantityMilli',
  'unitRateMinor',
] as const;

/** Parse untrusted provider payload data as one cost code's data (fail-closed). */
export function parseCostCodeProviderData(raw: unknown): ParseResult<CostCodeProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, COST_CODE_DATA_KEYS, '', 'cost-code provider data');
  if (unknownKey) return unknownKey;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const unit = requireString(raw, 'unit', '', UNIT_RULE);
  if (!unit.ok) return unit;
  const budgetRef = requireFieldWith(raw, 'budgetRef', '', parseEntityId);
  if (!budgetRef.ok) return budgetRef;
  const quantityMilli = requireNumberField(raw, 'quantityMilli', '', QUANTITY_MILLI_RULE);
  if (!quantityMilli.ok) return quantityMilli;
  const unitRateMinor = requireNumberField(raw, 'unitRateMinor', '', UNIT_RATE_MINOR_RULE);
  if (!unitRateMinor.ok) return unitRateMinor;
  return parseOk({
    code: code.value,
    description: description.value,
    unit: unit.value,
    budgetRef: budgetRef.value,
    quantityMilli: quantityMilli.value,
    unitRateMinor: unitRateMinor.value,
  });
}

/** One commitment line (an office-issued cost-item link + an amount). */
export interface CommitmentLineData {
  readonly costItemRef: EntityId;
  readonly description: string;
  readonly amountMinor: number;
}

/** The fail-closed-parsed provider data of one commitment. */
export interface CommitmentProviderData {
  readonly number: string;
  readonly commitmentKind: (typeof COMMITMENT_KINDS)[number];
  readonly description: string;
  readonly currency: string;
  readonly budgetRef: EntityId;
  readonly lines: readonly CommitmentLineData[];
}

const COMMITMENT_DATA_KEYS = [
  'number',
  'commitmentKind',
  'description',
  'currency',
  'budgetRef',
  'lines',
] as const;
const COMMITMENT_LINE_KEYS = ['costItemRef', 'description', 'amountMinor'] as const;

const parseCommitmentLine = (raw: unknown): ParseResult<CommitmentLineData> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'a commitment line object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    COMMITMENT_LINE_KEYS,
    '',
    'commitment line { costItemRef, description, amountMinor }',
  );
  if (unknownKey) return unknownKey;
  const costItemRef = requireFieldWith(raw, 'costItemRef', '', parseEntityId);
  if (!costItemRef.ok) return costItemRef;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const amountMinor = requireNumberField(raw, 'amountMinor', '', AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  return parseOk({
    costItemRef: costItemRef.value,
    description: description.value,
    amountMinor: amountMinor.value,
  });
};

/** Parse untrusted provider payload data as one commitment's data (fail-closed). */
export function parseCommitmentProviderData(raw: unknown): ParseResult<CommitmentProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    COMMITMENT_DATA_KEYS,
    '',
    'commitment provider data',
  );
  if (unknownKey) return unknownKey;
  const number = requireString(raw, 'number', '', NUMBER_RULE);
  if (!number.ok) return number;
  const commitmentKind = requireLiteral(raw, 'commitmentKind', '', COMMITMENT_KINDS);
  if (!commitmentKind.ok) return commitmentKind;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const currency = requireString(raw, 'currency', '', CURRENCY_RULE);
  if (!currency.ok) return currency;
  const budgetRef = requireFieldWith(raw, 'budgetRef', '', parseEntityId);
  if (!budgetRef.ok) return budgetRef;
  const lines = requireArrayField(
    raw,
    'lines',
    '',
    parseCommitmentLine,
    'an array of commitment line objects',
  );
  if (!lines.ok) return lines;
  return parseOk({
    number: number.value,
    commitmentKind: commitmentKind.value,
    description: description.value,
    currency: currency.value,
    budgetRef: budgetRef.value,
    lines: lines.value,
  });
}

/** One invoice line (a description + an amount in minor units). */
export interface InvoiceLineData {
  readonly description: string;
  readonly amountMinor: number;
}

/** The fail-closed-parsed provider data of one invoice. */
export interface InvoiceProviderData {
  readonly number: string;
  readonly description: string;
  readonly currency: string;
  readonly commitmentRef: EntityId;
  readonly issuedOn: Timestamp | null;
  readonly dueOn: Timestamp | null;
  readonly lines: readonly InvoiceLineData[];
}

const INVOICE_DATA_KEYS = [
  'number',
  'description',
  'currency',
  'commitmentRef',
  'issuedOn',
  'dueOn',
  'lines',
] as const;
const INVOICE_LINE_KEYS = ['description', 'amountMinor'] as const;

const parseInvoiceLine = (raw: unknown): ParseResult<InvoiceLineData> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an invoice line object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    INVOICE_LINE_KEYS,
    '',
    'invoice line { description, amountMinor }',
  );
  if (unknownKey) return unknownKey;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const amountMinor = requireNumberField(raw, 'amountMinor', '', AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  return parseOk({ description: description.value, amountMinor: amountMinor.value });
};

/** Parse untrusted provider payload data as one invoice's data (fail-closed). */
export function parseInvoiceProviderData(raw: unknown): ParseResult<InvoiceProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, INVOICE_DATA_KEYS, '', 'invoice provider data');
  if (unknownKey) return unknownKey;
  const number = requireString(raw, 'number', '', NUMBER_RULE);
  if (!number.ok) return number;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const currency = requireString(raw, 'currency', '', CURRENCY_RULE);
  if (!currency.ok) return currency;
  const commitmentRef = requireFieldWith(raw, 'commitmentRef', '', parseEntityId);
  if (!commitmentRef.ok) return commitmentRef;
  const issuedOn = requireNullableFieldWith(raw, 'issuedOn', '', parseTimestamp);
  if (!issuedOn.ok) return issuedOn;
  const dueOn = requireNullableFieldWith(raw, 'dueOn', '', parseTimestamp);
  if (!dueOn.ok) return dueOn;
  const lines = requireArrayField(
    raw,
    'lines',
    '',
    parseInvoiceLine,
    'an array of invoice line objects',
  );
  if (!lines.ok) return lines;
  return parseOk({
    number: number.value,
    description: description.value,
    currency: currency.value,
    commitmentRef: commitmentRef.value,
    issuedOn: issuedOn.value,
    dueOn: dueOn.value,
    lines: lines.value,
  });
}

/** The fail-closed-parsed provider data of one payment. */
export interface PaymentProviderData {
  readonly invoiceRef: EntityId;
  readonly reference: string;
  readonly amountMinor: number;
  readonly paidAt: Timestamp;
}

const PAYMENT_DATA_KEYS = ['invoiceRef', 'reference', 'amountMinor', 'paidAt'] as const;

/** Parse untrusted provider payload data as one payment's data (fail-closed). */
export function parsePaymentProviderData(raw: unknown): ParseResult<PaymentProviderData> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', 'an object', describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PAYMENT_DATA_KEYS, '', 'payment provider data');
  if (unknownKey) return unknownKey;
  const invoiceRef = requireFieldWith(raw, 'invoiceRef', '', parseEntityId);
  if (!invoiceRef.ok) return invoiceRef;
  const reference = requireString(raw, 'reference', '', REFERENCE_RULE);
  if (!reference.ok) return reference;
  const amountMinor = requireNumberField(raw, 'amountMinor', '', PAYMENT_AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  const paidAt = requireFieldWith(raw, 'paidAt', '', parseTimestamp);
  if (!paidAt.ok) return paidAt;
  return parseOk({
    invoiceRef: invoiceRef.value,
    reference: reference.value,
    amountMinor: amountMinor.value,
    paidAt: paidAt.value,
  });
}

// ---- the financial reference mapping (THE lookup/bind surface) --------------

/**
 * Resolve the canonical entity one provider financial reference maps to
 * (tenant-scoped through the SDK store — a foreign tenant's mapping is
 * indistinguishable from absence, A12). An unmapped reference is a typed
 * not-found: the caller never receives a silent null to improvise with.
 */
export async function resolveFinanceReference(parts: {
  readonly mappings: SourceMappingStore;
  readonly tenantId: TenantId;
  readonly coordinate: SourceCoordinate;
}): Promise<Result<EntityRef, DomainError>> {
  const mapping = await parts.mappings.findByCoordinate(parts.tenantId, parts.coordinate);
  if (mapping === null) {
    return fail(
      domainError(
        'not-found',
        `no financial reference mapping for provider object ${parts.coordinate.objectType} ${parts.coordinate.objectId} in ${parts.coordinate.systemId} — bind it first (provider ids are never canonical primary keys)`,
        [
          {
            code: 'finance-reference-unmapped',
            message: parts.coordinate.objectId,
            path: 'coordinate',
          },
        ],
        { scope: { kind: 'tenant', tenantId: parts.tenantId } },
      ),
    );
  }
  return ok(mapping.canonical);
}

/**
 * Bind one provider financial reference to its office-issued canonical id
 * (the engines' write path over the SDK's mapping store). The canonical id
 * MUST be office-issued (the caller's injected supplier) — provider ids
 * never reach the canonical field. A REMAPPING attempt (the same coordinate
 * re-pointed at a different canonical id, or a second provider object
 * claiming a bound canonical id) is the store's typed collision — an
 * explicit conflict, never an overwrite.
 */
export async function bindFinanceReference(parts: {
  readonly mappings: SourceMappingStore;
  readonly tenantId: TenantId;
  readonly coordinate: SourceCoordinate;
  readonly canonical: EntityRef;
  readonly providerVersion: ProviderVersion;
  readonly canonicalVersion: AggregateVersion;
  readonly actor: Actor;
  readonly now: Timestamp;
}): Promise<Result<SourceMapping, DomainError>> {
  return recordSourceMapping({
    store: parts.mappings,
    tenantId: parts.tenantId,
    coordinate: parts.coordinate,
    canonical: parts.canonical,
    providerVersion: parts.providerVersion,
    canonicalVersion: parts.canonicalVersion,
    actor: parts.actor,
    now: parts.now,
  });
}

// ---- the translation failures (typed values, never throws) ------------------
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
  mapping: FinanceObjectMapping,
): DomainError =>
  domainError(
    'invariant-violation',
    `provider ${input.source.objectType} ${input.source.objectId} was '${input.changeKind}' at version ${input.source.version}, but no landed canonical command expresses that transition for canonical kind '${mapping.canonicalKind}' — the adapter refuses to invent canonical financial semantics (fail closed)`,
    [
      {
        code: 'provider-transition-unmapped',
        message: `${input.source.objectType}.${input.changeKind}`,
        path: 'changeKind',
      },
    ],
    { scope: { kind: 'tenant', tenantId: input.tenantId } },
  );

/** The provenance-carrying extension metadata every create payload embeds. */
const extensionMetadataOf = (input: AdapterCommandInput): AdapterJsonObject => ({
  sourceKey: sourceRefKeyOf(input.source),
  providerData: input.data,
});

// ---- per-kind translations -------------------------------------------------
const proposeAccountCommand = (
  input: AdapterCommandInput,
  mapping: FinanceObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseAccountProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          name: input.displayName ?? `${data.value.code} ${data.value.name}`,
          currency: data.value.currency,
          projectId: data.value.projectRef,
          extensionMetadata: extensionMetadataOf(input),
        },
      });
    case 'updated': {
      if (mapping.updateCommand === null) {
        return fail(unmappedTransitionFailure(input, mapping));
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          budgetId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          label: `ERP account ${data.value.code} revision ${input.source.version}: ${data.value.name}`,
        },
      });
    }
    default:
      return fail(unmappedTransitionFailure(input, mapping));
  }
};

const proposeCostCodeCommand = (
  input: AdapterCommandInput,
  mapping: FinanceObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseCostCodeProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          budgetId: data.value.budgetRef,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          code: data.value.code,
          description: data.value.description,
          unit: data.value.unit,
          quantityMilli: data.value.quantityMilli,
          unitRateMinor: data.value.unitRateMinor,
        },
      });
    default:
      // Canonical cost items are append-only budget lines with unique codes:
      // no landed command updates or removes one, and re-recording would
      // duplicate the code — the adapter fails closed instead.
      return fail(unmappedTransitionFailure(input, mapping));
  }
};

const proposeCommitmentCommand = (
  input: AdapterCommandInput,
  mapping: FinanceObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseCommitmentProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          budgetId: data.value.budgetRef,
          number: input.displayName ?? data.value.number,
          commitmentKind: data.value.commitmentKind,
          description: data.value.description,
          currency: data.value.currency,
          ...(data.value.lines.length > 0
            ? {
                lines: data.value.lines.map((line) => ({
                  costItemId: line.costItemRef,
                  description: line.description,
                  amountMinor: line.amountMinor,
                })),
              }
            : {}),
        },
      });
    case 'updated': {
      if (mapping.updateCommand === null) {
        return fail(unmappedTransitionFailure(input, mapping));
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      // The append-only line set: an update proposes amending with the lines
      // the provider ADDED — the LATEST appended line (deterministic: the
      // last list entry is the new one; the canonical domain rejects
      // duplicate lines).
      const latestLine = data.value.lines.at(-1);
      if (latestLine === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `provider commitment ${input.source.objectId} was updated at version ${input.source.version} but carries no commitment lines — there is nothing to amend canonically (cost.amendCommitment requires at least one line)`,
            [
              {
                code: 'provider-update-without-lines',
                message: input.source.objectId,
                path: 'lines',
              },
            ],
            { scope: { kind: 'tenant', tenantId: input.tenantId } },
          ),
        );
      }
      return ok({
        commandName: mapping.updateCommand,
        payload: {
          commitmentId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          budgetId: data.value.budgetRef,
          reason: `ERP commitment ${data.value.number} revision ${input.source.version}`,
          lines: [
            {
              costItemId: latestLine.costItemRef,
              description: latestLine.description,
              amountMinor: latestLine.amountMinor,
            },
          ],
        },
      });
    }
    default: {
      if (mapping.deleteCommand === null) {
        return fail(unmappedTransitionFailure(input, mapping));
      }
      const canonical = requireCanonicalTarget(input);
      if (!canonical.ok) return canonical;
      return ok({
        commandName: mapping.deleteCommand,
        payload: {
          commitmentId: canonical.value.entityId,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          reason: `ERP commitment ${data.value.number} voided in the ERP at revision ${input.source.version}`,
        },
      });
    }
  }
};

const proposeInvoiceCommand = (
  input: AdapterCommandInput,
  mapping: FinanceObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parseInvoiceProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          commitmentId: data.value.commitmentRef,
          number: input.displayName ?? data.value.number,
          description: data.value.description,
          currency: data.value.currency,
          issuedOn: data.value.issuedOn,
          dueOn: data.value.dueOn,
          lines: data.value.lines.map((line) => ({
            description: line.description,
            amountMinor: line.amountMinor,
          })),
          extensionMetadata: extensionMetadataOf(input),
        },
      });
    default:
      // Canonical invoice amounts are immutable at record time (the
      // credit-note discipline) and an invoice is never deleted canonically:
      // both provider transitions fail closed rather than improvising an
      // amend/void semantic the canonical vocabulary does not carry.
      return fail(unmappedTransitionFailure(input, mapping));
  }
};

const proposePaymentCommand = (
  input: AdapterCommandInput,
  mapping: FinanceObjectMapping,
): Result<AdapterCommandProposal, DomainError> => {
  const data = parsePaymentProviderData(input.data);
  if (!data.ok) return fail(providerDataFailure(input, data.error));
  switch (input.changeKind) {
    case 'created':
      return ok({
        commandName: mapping.createCommand,
        payload: {
          invoiceId: data.value.invoiceRef,
          expectedVersion: input.canonicalVersion ?? INITIAL_AGGREGATE_VERSION,
          reference: data.value.reference,
          amountMinor: data.value.amountMinor,
          paidAt: data.value.paidAt,
        },
      });
    default:
      // Payment references are append-only: they never change and never
      // retract. Both transitions fail closed.
      return fail(unmappedTransitionFailure(input, mapping));
  }
};

/**
 * Create the finance adapter's command translator (pure and deterministic —
 * no clock, no ids, no I/O; the canonical target and version always arrive
 * through the input the engine composed).
 */
export function createFinanceTranslator(): AdapterCommandTranslator {
  return {
    proposeCommand(input: AdapterCommandInput): Result<AdapterCommandProposal, DomainError> {
      const mapping = financeObjectMappingOf(input.source.objectType);
      if (mapping === null) {
        return fail(
          domainError(
            'invariant-violation',
            `finance adapter does not translate provider object kind '${input.source.objectType}' — the mapping table declares ${mappingTableKinds()}`,
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
        case ACCOUNT_OBJECT_KIND:
          return proposeAccountCommand(input, mapping);
        case COST_CODE_OBJECT_KIND:
          return proposeCostCodeCommand(input, mapping);
        case COMMITMENT_OBJECT_KIND:
          return proposeCommitmentCommand(input, mapping);
        case INVOICE_OBJECT_KIND:
          return proposeInvoiceCommand(input, mapping);
        case PAYMENT_OBJECT_KIND:
          return proposePaymentCommand(input, mapping);
        default:
          return fail(
            domainError(
              'invariant-violation',
              `finance adapter does not translate provider object kind '${input.source.objectType}'`,
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
  [
    ACCOUNT_OBJECT_KIND,
    COST_CODE_OBJECT_KIND,
    COMMITMENT_OBJECT_KIND,
    INVOICE_OBJECT_KIND,
    PAYMENT_OBJECT_KIND,
  ].join(', ');
