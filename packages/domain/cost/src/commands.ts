// Office cost domain — mutation command handlers (OFF-011).
//
// THE canonical mutation path of the cost module (freeze "cross-view
// mutation" + the OFF-003 kernel contract), executed for every command —
// the exact flow of the sibling pure-domain modules:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never even opens a transaction. Budget revisioning runs a
//      SECOND, distinct gate (see below);
//   3. load the aggregate through the scope-guarded store (a foreign
//      tenant's or foreign project's budget/commitment/invoice is invisible —
//      typed not-found, no existence oracle) and re-check scope coverage
//      (kernel A12 backstop);
//   4. check optimistic concurrency (stale version → typed
//      concurrency-conflict; the recorded commercial state is NEVER silently
//      overwritten — freeze: no last-write-wins for material state);
//   5. apply the invariant-checked pure transition — including the
//      cross-aggregate commercial validation gates (a commitment line must
//      reference a cost item of the addressed budget, the currency must
//      match, an invoice must reference an ACTIVE commitment, a payment
//      reference must not overpay its invoice) BEFORE any state lands;
//   6. write through the store AND append the audit event through the
//      injected EventSink inside ONE runInTransaction — a failure anywhere
//      rolls everything back (tx.rollback carries the typed DomainError out,
//      and pending writes are discarded);
//   7. return the committed aggregate state as a typed Result.
//
// BUDGET-REVISION AUTHORIZATION (acceptance: a distinct stronger capability):
// every cost mutation passes the cost-area write gate (the policy's
// `cost.write` capability); REVISING the budget ADDITIONALLY passes a
// project-area write gate (the policy's `projects.write` capability) —
// re-anchoring a project's whole budget of record is a high-impact commercial
// decision (the budget is the baseline every committed/invoiced balance is
// computed against), so it demands a capability distinct from and stronger
// than the one payment references require: an actor holding only `cost.write`
// can record items, commitments, invoices and payments but is denied
// revising the budget with a typed forbidden.
//
// Determinism (kernel rule): handlers read NO wall clock and NO randomness —
// `now` and the canonical-id opaque parts come from the injected suppliers
// (fixed sequences in tests; wall clock / crypto randomness in production
// wiring). Every canonical id is composed through the contracts format
// helper, so every issued id parses with parseEntityId by construction.
import {
  formatEntityId,
  parseCommandName,
  parseEntityId,
  parseEntityKind,
  parseProjectId,
  parseTimestamp,
} from '@office/contracts';
import type {
  CommandEnvelope,
  CommandName,
  ContractParseError,
  EntityId,
  EntityKind,
  EntityRefs,
  EventName,
  ParseResult,
  ProjectId,
  Timestamp,
} from '@office/contracts';
import { parseFail, parseOk } from '@office/contracts';
import { authorize, authorizationContext, resourceScope } from '@office/authz';
import type { Policy } from '@office/authz';
import {
  checkConcurrency,
  checkScopeCovers,
  concurrencyTokenOf,
  domainError,
  fail,
  invariantViolation,
  ok,
  parseAggregateVersion,
  projectScopeViolation,
} from '@office/domain-kernel';
import type {
  AggregateVersion,
  CommandResult,
  ConcurrencyToken,
  DomainError,
  DomainErrorContext,
  Result,
} from '@office/domain-kernel';
import type { EventSink } from './events';
import {
  BUDGET_CREATED_EVENT,
  BUDGET_REVISED_EVENT,
  COMMITMENT_AMENDED_EVENT,
  COMMITMENT_CLOSED_EVENT,
  COMMITMENT_CREATED_EVENT,
  COST_ITEM_RECORDED_EVENT,
  INVOICE_RECORDED_EVENT,
  PAYMENT_REFERENCED_EVENT,
  budgetRef,
  costEventEnvelope,
} from './events';
import type { CostEventPayloads } from './events';
import type { CostStore, CostStoreTransaction } from './store';
import type { BudgetState, CommitmentState, CurrencyCode, InvoiceState } from './state';
import {
  BUDGET_KIND,
  BUDGET_REVISION_KIND,
  COMMITMENT_AMENDMENT_KIND,
  COMMITMENT_KIND,
  COST_ITEM_KIND,
  INVOICE_KIND,
  PAYMENT_REFERENCE_KIND,
} from './state';
import {
  amendCommitmentState,
  closeCommitmentState,
  committedAmountMinorOf,
  createBudgetState,
  createCommitmentState,
  createInvoiceState,
  currentLineSetOf,
  invoicedAmountMinorOf,
  parseCommitmentKind,
  parseCurrencyCode,
  recordCostItemState,
  referencePaymentState,
  reviseBudgetState,
} from './state';
import type {
  NewCommitmentLine,
  NewInvoiceLine,
} from './state';
import {
  compareTimestamps,
  isPlainObject,
  optionalFieldWith,
  optionalNullableFieldWith,
  parseStringLike,
  requireFieldWith,
  requireInteger,
  requireObjectArray,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { IntegerRule, StringRule } from './parse';

// ----- command names ------------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid cost command name literal: ${name}`);
  }
  return parsed.value;
};

const entityKindOf = (literal: string): EntityKind => {
  const parsed = parseEntityKind(literal);
  if (!parsed.ok) {
    // Trusted-path literal: a violation means this module is malformed.
    throw new TypeError(
      `invalid cost-domain entity kind literal: ${JSON.stringify(parsed.error)}`,
    );
  }
  return parsed.value;
};

/** Command name executed by {@link CostCommands.createBudget}. */
export const CREATE_BUDGET_COMMAND: CommandName = commandNameOf('cost.createBudget');
/** Command name executed by {@link CostCommands.recordCostItem}. */
export const RECORD_COST_ITEM_COMMAND: CommandName = commandNameOf('cost.recordCostItem');
/** Command name executed by {@link CostCommands.reviseBudget}. */
export const REVISE_BUDGET_COMMAND: CommandName = commandNameOf('cost.reviseBudget');
/** Command name executed by {@link CostCommands.createCommitment}. */
export const CREATE_COMMITMENT_COMMAND: CommandName = commandNameOf('cost.createCommitment');
/** Command name executed by {@link CostCommands.amendCommitment}. */
export const AMEND_COMMITMENT_COMMAND: CommandName = commandNameOf('cost.amendCommitment');
/** Command name executed by {@link CostCommands.closeCommitment}. */
export const CLOSE_COMMITMENT_COMMAND: CommandName = commandNameOf('cost.closeCommitment');
/** Command name executed by {@link CostCommands.recordInvoice}. */
export const RECORD_INVOICE_COMMAND: CommandName = commandNameOf('cost.recordInvoice');
/** Command name executed by {@link CostCommands.referencePayment}. */
export const REFERENCE_PAYMENT_COMMAND: CommandName = commandNameOf('cost.referencePayment');

const PROJECT_KIND: EntityKind = entityKindOf('project');

/**
 * Guard: a handler executes exactly its own command kind. Handing another
 * command's envelope to a handler is a trusted-path wiring error — loud.
 */
const requireCommandName = (
  command: CommandEnvelope<unknown>,
  expected: CommandName,
): void => {
  if (command.commandName !== expected) {
    throw new TypeError(
      `cost command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) ---------------------------------

const NAME_RULE: StringRule = { min: 1, max: 200, description: 'display name' };
const DESCRIPTION_RULE: StringRule = { min: 1, max: 500, description: 'description' };
const CODE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/,
  description: 'cost item code (alphanumeric, dot, underscore, colon, dash; no leading symbol)',
};
const UNIT_RULE: StringRule = { min: 1, max: 32, description: 'unit of measure label' };
const NUMBER_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/,
  description: 'commercial number (alphanumeric, dot, underscore, colon, dash; no leading symbol)',
};
const LABEL_RULE: StringRule = { min: 1, max: 200, description: 'budget revision label' };
const REASON_RULE: StringRule = { min: 1, max: 500, description: 'close reason' };
const AMEND_REASON_RULE: StringRule = { min: 1, max: 500, description: 'amendment reason' };
const REFERENCE_RULE: StringRule = {
  min: 1,
  max: 128,
  pattern: /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,127}$/,
  description: 'external payment reference (alphanumeric, space, dot, underscore, colon, dash)',
};
const QUANTITY_MILLI_RULE: IntegerRule = {
  min: 1,
  max: 1_000_000_000,
  description: 'quantity in integer milli-units (quantity × 1000)',
};
const UNIT_RATE_MINOR_RULE: IntegerRule = {
  min: 0,
  max: 1_000_000_000_000,
  description: 'unit rate in integer minor units per whole unit',
};
const AMOUNT_MINOR_RULE: IntegerRule = {
  min: 0,
  max: 1_000_000_000_000,
  description: 'amount in integer minor units',
};
const PAYMENT_AMOUNT_MINOR_RULE: IntegerRule = {
  min: 1,
  max: 1_000_000_000_000,
  description: 'paid amount in integer minor units',
};

const LINES_GRAMMAR =
  'a non-empty array of line objects (1..10000 lines), each an object with its own line fields';
const LINE_COUNT_BOUNDS = { min: 1, max: 10_000 } as const;

/** One validated commitment line input (a typed cost-item link + amount). */
export interface CommitmentLineInput {
  readonly costItemId: EntityId;
  readonly description: string;
  readonly amountMinor: number;
}

/** One validated invoice line input. */
export interface InvoiceLineInput {
  readonly description: string;
  readonly amountMinor: number;
}

/** Validated payload of `cost.createBudget`. */
export interface CreateBudgetPayload {
  readonly name: string;
  readonly currency: CurrencyCode;
  /** Required under tenant scope; under project scope it must equal the command's project. */
  readonly projectId?: ProjectId;
}

const CREATE_BUDGET_PAYLOAD_KEYS = ['name', 'currency', 'projectId'] as const;
const CREATE_BUDGET_PAYLOAD_GRAMMAR =
  'CreateBudgetPayload: { name: string (1..200), currency: string (3 uppercase letters), projectId?: ProjectId (required under tenant scope; must match under project scope) }';

/** Validated payload of `cost.recordCostItem`. */
export interface RecordCostItemPayload {
  readonly budgetId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly code: string;
  readonly description: string;
  readonly unit: string;
  readonly quantityMilli: number;
  readonly unitRateMinor: number;
}

const RECORD_COST_ITEM_PAYLOAD_KEYS = [
  'budgetId',
  'expectedVersion',
  'code',
  'description',
  'unit',
  'quantityMilli',
  'unitRateMinor',
] as const;
const RECORD_COST_ITEM_PAYLOAD_GRAMMAR =
  'RecordCostItemPayload: { budgetId: EntityId, expectedVersion: number (>= 1), code: string (1..64), description: string (1..500), unit: string (1..32), quantityMilli: integer (1..1000000000), unitRateMinor: integer (0..1000000000000) }';

/** Validated payload of `cost.reviseBudget`. */
export interface ReviseBudgetPayload {
  readonly budgetId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly label: string | undefined;
}

const REVISE_BUDGET_PAYLOAD_KEYS = ['budgetId', 'expectedVersion', 'label'] as const;
const REVISE_BUDGET_PAYLOAD_GRAMMAR =
  'ReviseBudgetPayload: { budgetId: EntityId, expectedVersion: number (>= 1), label?: string (1..200; defaults deterministically to "Revision N") }';

/** Validated payload of `cost.createCommitment`. */
export interface CreateCommitmentPayload {
  readonly budgetId: EntityId;
  readonly number: string;
  readonly commitmentKind: 'purchase-order' | 'subcontract';
  readonly description: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly CommitmentLineInput[];
}

const CREATE_COMMITMENT_PAYLOAD_KEYS = [
  'budgetId',
  'number',
  'commitmentKind',
  'description',
  'currency',
  'lines',
] as const;
const CREATE_COMMITMENT_PAYLOAD_GRAMMAR =
  "CreateCommitmentPayload: { budgetId: EntityId, number: string (1..64), commitmentKind: 'purchase-order' | 'subcontract', description: string (1..500), currency: string (3 uppercase letters), lines: [{ costItemId: EntityId, description: string (1..500), amountMinor: integer (0..1000000000000) }] (1..10000 lines) }";

/** Validated payload of `cost.amendCommitment`. */
export interface AmendCommitmentPayload {
  readonly commitmentId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly budgetId: EntityId;
  readonly reason: string | null;
  readonly lines: readonly CommitmentLineInput[];
}

const AMEND_COMMITMENT_PAYLOAD_KEYS = [
  'commitmentId',
  'expectedVersion',
  'budgetId',
  'reason',
  'lines',
] as const;
const AMEND_COMMITMENT_PAYLOAD_GRAMMAR =
  'AmendCommitmentPayload: { commitmentId: EntityId, expectedVersion: number (>= 1), budgetId: EntityId, reason?: string (1..500), lines: [{ costItemId: EntityId, description: string (1..500), amountMinor: integer (0..1000000000000) }] (1..10000 lines) }';

/** Validated payload of `cost.closeCommitment`. */
export interface CloseCommitmentPayload {
  readonly commitmentId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly reason: string;
}

const CLOSE_COMMITMENT_PAYLOAD_KEYS = ['commitmentId', 'expectedVersion', 'reason'] as const;
const CLOSE_COMMITMENT_PAYLOAD_GRAMMAR =
  'CloseCommitmentPayload: { commitmentId: EntityId, expectedVersion: number (>= 1), reason: string (1..500) }';

/** Validated payload of `cost.recordInvoice`. */
export interface RecordInvoicePayload {
  readonly commitmentId: EntityId;
  readonly number: string;
  readonly description: string;
  readonly currency: CurrencyCode;
  readonly issuedOn: Timestamp | null;
  readonly dueOn: Timestamp | null;
  readonly lines: readonly InvoiceLineInput[];
}

const RECORD_INVOICE_PAYLOAD_KEYS = [
  'commitmentId',
  'number',
  'description',
  'currency',
  'issuedOn',
  'dueOn',
  'lines',
] as const;
const RECORD_INVOICE_PAYLOAD_GRAMMAR =
  'RecordInvoicePayload: { commitmentId: EntityId, number: string (1..64), description: string (1..500), currency: string (3 uppercase letters), issuedOn?: Timestamp | null, dueOn?: Timestamp | null (not before issuedOn), lines: [{ description: string (1..500), amountMinor: integer (0..1000000000000) }] (1..10000 lines) }';

/** Validated payload of `cost.referencePayment`. */
export interface ReferencePaymentPayload {
  readonly invoiceId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly reference: string;
  readonly amountMinor: number;
  readonly paidAt: Timestamp;
}

const REFERENCE_PAYMENT_PAYLOAD_KEYS = [
  'invoiceId',
  'expectedVersion',
  'reference',
  'amountMinor',
  'paidAt',
] as const;
const REFERENCE_PAYMENT_PAYLOAD_GRAMMAR =
  'ReferencePaymentPayload: { invoiceId: EntityId, expectedVersion: number (>= 1), reference: string (1..128), amountMinor: integer (1..1000000000000), paidAt: Timestamp (not after the recording instant) }';

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

/** Parse one commitment-line object (paths relative to the array element). */
const parseCommitmentLineInput = (
  raw: Record<string, unknown>,
  path: string,
): ParseResult<CommitmentLineInput> => {
  const grammar = 'commitment line: { costItemId: EntityId, description: string (1..500), amountMinor: integer (0..1000000000000) }';
  const unknownKey = unknownKeyFailure(raw, ['costItemId', 'description', 'amountMinor'], path, grammar);
  if (unknownKey) return unknownKey;
  const costItemId = requireFieldWith(raw, 'costItemId', path, parseEntityId);
  if (!costItemId.ok) return costItemId;
  const description = requireString(raw, 'description', path, DESCRIPTION_RULE);
  if (!description.ok) return description;
  const amountMinor = requireInteger(raw, 'amountMinor', path, AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  return parseOk({
    costItemId: costItemId.value,
    description: description.value,
    amountMinor: amountMinor.value,
  });
};

/** Parse one invoice-line object (paths relative to the array element). */
const parseInvoiceLineInput = (
  raw: Record<string, unknown>,
  path: string,
): ParseResult<InvoiceLineInput> => {
  const grammar = 'invoice line: { description: string (1..500), amountMinor: integer (0..1000000000000) }';
  const unknownKey = unknownKeyFailure(raw, ['description', 'amountMinor'], path, grammar);
  if (unknownKey) return unknownKey;
  const description = requireString(raw, 'description', path, DESCRIPTION_RULE);
  if (!description.ok) return description;
  const amountMinor = requireInteger(raw, 'amountMinor', path, AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  return parseOk({
    description: description.value,
    amountMinor: amountMinor.value,
  });
};

/** Parse the create-budget payload (total, fail-closed, strict keys). */
export function parseCreateBudgetPayload(
  raw: unknown,
): ParseResult<CreateBudgetPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_BUDGET_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CREATE_BUDGET_PAYLOAD_KEYS, '', CREATE_BUDGET_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const name = requireString(raw, 'name', '', NAME_RULE);
  if (!name.ok) return name;
  const currency = requireFieldWith(raw, 'currency', '', parseCurrencyCode);
  if (!currency.ok) return currency;
  const projectId = optionalFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  return parseOk({
    name: name.value,
    currency: currency.value,
    ...(projectId.value !== undefined ? { projectId: projectId.value } : {}),
  });
}

/** Parse the record-cost-item payload (total, fail-closed, strict keys). */
export function parseRecordCostItemPayload(
  raw: unknown,
): ParseResult<RecordCostItemPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RECORD_COST_ITEM_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RECORD_COST_ITEM_PAYLOAD_KEYS, '', RECORD_COST_ITEM_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const budgetId = requireFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const unit = requireString(raw, 'unit', '', UNIT_RULE);
  if (!unit.ok) return unit;
  const quantityMilli = requireInteger(raw, 'quantityMilli', '', QUANTITY_MILLI_RULE);
  if (!quantityMilli.ok) return quantityMilli;
  const unitRateMinor = requireInteger(raw, 'unitRateMinor', '', UNIT_RATE_MINOR_RULE);
  if (!unitRateMinor.ok) return unitRateMinor;
  return parseOk({
    budgetId: budgetId.value,
    expectedVersion: expectedVersion.value,
    code: code.value,
    description: description.value,
    unit: unit.value,
    quantityMilli: quantityMilli.value,
    unitRateMinor: unitRateMinor.value,
  });
}

/** Parse the revise-budget payload (total, fail-closed, strict keys). */
export function parseReviseBudgetPayload(
  raw: unknown,
): ParseResult<ReviseBudgetPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REVISE_BUDGET_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REVISE_BUDGET_PAYLOAD_KEYS, '', REVISE_BUDGET_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const budgetId = requireFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const label = optionalFieldWith(raw, 'label', '', (value: unknown) =>
    parseStringLike(value, LABEL_RULE),
  );
  if (!label.ok) return label;
  return parseOk({
    budgetId: budgetId.value,
    expectedVersion: expectedVersion.value,
    label: label.value,
  });
}

/** Parse the create-commitment payload (total, fail-closed, strict keys). */
export function parseCreateCommitmentPayload(
  raw: unknown,
): ParseResult<CreateCommitmentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_COMMITMENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CREATE_COMMITMENT_PAYLOAD_KEYS, '', CREATE_COMMITMENT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const budgetId = requireFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const number = requireString(raw, 'number', '', NUMBER_RULE);
  if (!number.ok) return number;
  const commitmentKind = requireFieldWith(raw, 'commitmentKind', '', parseCommitmentKind);
  if (!commitmentKind.ok) return commitmentKind;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const currency = requireFieldWith(raw, 'currency', '', parseCurrencyCode);
  if (!currency.ok) return currency;
  const lines = requireObjectArray(
    raw,
    'lines',
    '',
    LINES_GRAMMAR,
    LINE_COUNT_BOUNDS,
    parseCommitmentLineInput,
  );
  if (!lines.ok) return lines;
  return parseOk({
    budgetId: budgetId.value,
    number: number.value,
    commitmentKind: commitmentKind.value,
    description: description.value,
    currency: currency.value,
    lines: lines.value,
  });
}

/** Parse the amend-commitment payload (total, fail-closed, strict keys). */
export function parseAmendCommitmentPayload(
  raw: unknown,
): ParseResult<AmendCommitmentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', AMEND_COMMITMENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, AMEND_COMMITMENT_PAYLOAD_KEYS, '', AMEND_COMMITMENT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const commitmentId = requireFieldWith(raw, 'commitmentId', '', parseEntityId);
  if (!commitmentId.ok) return commitmentId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const budgetId = requireFieldWith(raw, 'budgetId', '', parseEntityId);
  if (!budgetId.ok) return budgetId;
  const reason = optionalNullableFieldWith(raw, 'reason', '', (value: unknown) =>
    parseStringLike(value, AMEND_REASON_RULE),
  );
  if (!reason.ok) return reason;
  const lines = requireObjectArray(
    raw,
    'lines',
    '',
    LINES_GRAMMAR,
    LINE_COUNT_BOUNDS,
    parseCommitmentLineInput,
  );
  if (!lines.ok) return lines;
  return parseOk({
    commitmentId: commitmentId.value,
    expectedVersion: expectedVersion.value,
    budgetId: budgetId.value,
    reason: reason.value,
    lines: lines.value,
  });
}

/** Parse the close-commitment payload (total, fail-closed, strict keys). */
export function parseCloseCommitmentPayload(
  raw: unknown,
): ParseResult<CloseCommitmentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CLOSE_COMMITMENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CLOSE_COMMITMENT_PAYLOAD_KEYS, '', CLOSE_COMMITMENT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const commitmentId = requireFieldWith(raw, 'commitmentId', '', parseEntityId);
  if (!commitmentId.ok) return commitmentId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const reason = requireString(raw, 'reason', '', REASON_RULE);
  if (!reason.ok) return reason;
  return parseOk({
    commitmentId: commitmentId.value,
    expectedVersion: expectedVersion.value,
    reason: reason.value,
  });
}

/** Parse the record-invoice payload (total, fail-closed, strict keys). */
export function parseRecordInvoicePayload(
  raw: unknown,
): ParseResult<RecordInvoicePayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RECORD_INVOICE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RECORD_INVOICE_PAYLOAD_KEYS, '', RECORD_INVOICE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const commitmentId = requireFieldWith(raw, 'commitmentId', '', parseEntityId);
  if (!commitmentId.ok) return commitmentId;
  const number = requireString(raw, 'number', '', NUMBER_RULE);
  if (!number.ok) return number;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const currency = requireFieldWith(raw, 'currency', '', parseCurrencyCode);
  if (!currency.ok) return currency;
  const issuedOn = optionalNullableFieldWith(raw, 'issuedOn', '', parseTimestamp);
  if (!issuedOn.ok) return issuedOn;
  const dueOn = optionalNullableFieldWith(raw, 'dueOn', '', parseTimestamp);
  if (!dueOn.ok) return dueOn;
  if (
    issuedOn.value !== null &&
    dueOn.value !== null &&
    compareTimestamps(dueOn.value, issuedOn.value) < 0
  ) {
    return parseFail(
      'invalid-value',
      'dueOn',
      'a due date not before the issue date',
      describePayload(raw['dueOn']),
    );
  }
  const lines = requireObjectArray(
    raw,
    'lines',
    '',
    LINES_GRAMMAR,
    LINE_COUNT_BOUNDS,
    parseInvoiceLineInput,
  );
  if (!lines.ok) return lines;
  return parseOk({
    commitmentId: commitmentId.value,
    number: number.value,
    description: description.value,
    currency: currency.value,
    issuedOn: issuedOn.value,
    dueOn: dueOn.value,
    lines: lines.value,
  });
}

/** Parse the reference-payment payload (total, fail-closed, strict keys). */
export function parseReferencePaymentPayload(
  raw: unknown,
): ParseResult<ReferencePaymentPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REFERENCE_PAYMENT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REFERENCE_PAYMENT_PAYLOAD_KEYS, '', REFERENCE_PAYMENT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const invoiceId = requireFieldWith(raw, 'invoiceId', '', parseEntityId);
  if (!invoiceId.ok) return invoiceId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const reference = requireString(raw, 'reference', '', REFERENCE_RULE);
  if (!reference.ok) return reference;
  const amountMinor = requireInteger(raw, 'amountMinor', '', PAYMENT_AMOUNT_MINOR_RULE);
  if (!amountMinor.ok) return amountMinor;
  const paidAt = requireFieldWith(raw, 'paidAt', '', parseTimestamp);
  if (!paidAt.ok) return paidAt;
  return parseOk({
    invoiceId: invoiceId.value,
    expectedVersion: expectedVersion.value,
    reference: reference.value,
    amountMinor: amountMinor.value,
    paidAt: paidAt.value,
  });
}

// ----- command service -------------------------------------------------------------

/**
 * Wiring dependencies of the cost command service. `now` and `newOpaqueId`
 * are the injected suppliers (determinism rule): fixed values in tests, wall
 * clock / crypto randomness in production wiring. The store is the
 * pure-domain transactional seam (see store.ts); the event sink is the
 * mirrored OFF-007 port (see events.ts).
 */
export interface CostCommandDeps {
  readonly store: CostStore;
  readonly eventSink: EventSink;
  /** Injected clock: the canonical 'now' of each execution. */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier (composed via formatEntityId). */
  readonly newOpaqueId: () => string;
}

/**
 * Caller-supplied authorization inputs for one command execution: the
 * deny-by-default policy (static, data-driven) and the capabilities granted
 * to the command's actor for THIS request (e.g. the expansion of a user's
 * roles, an app installation's manifest capabilities, an agent run's grant).
 */
export interface CostCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The cost mutation command surface. */
export interface CostCommands {
  /** Create a project's canonical budget (one budget per project). */
  createBudget(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<BudgetState>>;
  /** Record one cost item into the budget's current working set. */
  recordCostItem(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<BudgetState>>;
  /**
   * Revise the budget — anchor a new immutable revision of the budget lines
   * (the consequential, high-impact decision). Requires the distinct stronger
   * project-write capability IN ADDITION to the cost-write capability (two
   * authorization gates).
   */
  reviseBudget(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<BudgetState>>;
  /** Create one commitment referencing the addressed budget's cost items. */
  createCommitment(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<CommitmentState>>;
  /** Amend one commitment (append a new immutable line set; closed is terminal). */
  amendCommitment(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<CommitmentState>>;
  /** Close one commitment (terminal). */
  closeCommitment(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<CommitmentState>>;
  /** Record one invoice against an active commitment. */
  recordInvoice(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<InvoiceState>>;
  /** Reference one payment against an invoice (append-only, never overpaying). */
  referencePayment(
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ): Promise<CommandResult<InvoiceState>>;
}

/** Create the cost mutation command service. */
export function createCostCommands(deps: CostCommandDeps): CostCommands {
  const errorContextOf = (command: CommandEnvelope<unknown>): DomainErrorContext => ({
    scope: command.scope,
    correlationId: command.causality.correlationId,
  });

  /** Translate a payload parse failure into the typed domain failure. */
  const invalidPayload = (
    error: ContractParseError,
    command: CommandEnvelope<unknown>,
  ): DomainError =>
    domainError(
      'invariant-violation',
      `invalid command payload for '${command.commandName}': ${error.code} at '${
        error.path === '' ? '<root>' : error.path
      }' — expected ${error.expected}, received ${error.received}`,
      [
        {
          code: 'invalid-command-payload',
          message: `${error.code}: expected ${error.expected}, received ${error.received}`,
          path: error.path === '' ? null : error.path,
        },
      ],
      errorContextOf(command),
    );

  /** Build the request's AuthorizationContext from the command envelope. */
  const contextOf = (
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
  ) =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /** The cost-domain resource being accessed, addressed within the COMMAND's scope. */
  const costResource = (
    command: CommandEnvelope<unknown>,
    resourceKind: EntityKind,
    resourceId: EntityId | null,
  ) =>
    resourceScope({
      scope: command.scope,
      resourceKind,
      resourceId,
      ownerId: null,
    });

  /** Issue the next canonical EntityId from the injected supplier. */
  const newEntityId = (): EntityId =>
    formatEntityId({ version: 'v1', opaque: deps.newOpaqueId() });

  /** The acting actor's canonical id, or null for the system actor. */
  const actorIdOf = (command: CommandEnvelope<unknown>): EntityId | null =>
    command.actor.kind === 'system' ? null : command.actor.actorId;

  /** What one budget-family mutation step produces. */
  interface BudgetOutcome {
    readonly next: BudgetState;
    readonly eventName: EventName;
    readonly entityRefs: EntityRefs;
    readonly payload: CostEventPayloads;
  }

  /** What one commitment-family mutation step produces. */
  interface CommitmentOutcome {
    readonly next: CommitmentState;
    readonly eventName: EventName;
    readonly entityRefs: EntityRefs;
    readonly payload: CostEventPayloads;
  }

  /** What one invoice-family mutation step produces. */
  interface InvoiceOutcome {
    readonly next: InvoiceState;
    readonly eventName: EventName;
    readonly entityRefs: EntityRefs;
    readonly payload: CostEventPayloads;
  }

  /**
   * THE shared budget-family mutation flow (steps 3–7 of the module
   * contract): load scoped, A12 backstop, concurrency, pure transition,
   * store write + event append in ONE transaction — every failure rolls the
   * whole mutation back.
   */
  const mutateBudget = async (
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
    parts: {
      readonly budgetId: EntityId;
      readonly expectedVersion: AggregateVersion;
      readonly resourceKind: EntityKind;
      readonly resourceId: EntityId | null;
      readonly step: (
        loaded: BudgetState,
        now: Timestamp,
        context: DomainErrorContext,
      ) => Result<BudgetOutcome, DomainError>;
    },
  ): Promise<CommandResult<BudgetState>> => {
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization),
      costResource(command, parts.resourceKind, parts.resourceId),
      'write',
      errorContextOf(command),
    );
    if (!decision.ok) return decision;

    const expected: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind: BUDGET_KIND,
      entityId: parts.budgetId,
      version: parts.expectedVersion,
    };

    return deps.store.runInTransaction(
      async (tx: CostStoreTransaction): Promise<CommandResult<BudgetState>> => {
        const now = deps.now();
        const context = errorContextOf(command);

        const loaded = await tx.loadBudget(command.scope, parts.budgetId);
        if (!loaded.ok) return tx.rollback(loaded);

        // A12 backstop (kernel): the command scope must cover the loaded
        // aggregate's owning scope — with the scoped store this cannot fire,
        // and it is checked anyway (defense in depth).
        const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
        if (!coverage.ok) return tx.rollback(coverage);

        const concurrency = checkConcurrency(
          expected,
          concurrencyTokenOf(loaded.value),
          context,
        );
        if (!concurrency.ok) return tx.rollback(concurrency);

        const outcome = parts.step(loaded.value, now, context);
        if (!outcome.ok) return tx.rollback(outcome);

        const saved = await tx.saveBudget(
          command.scope,
          outcome.value.next,
          parts.expectedVersion,
        );
        if (!saved.ok) return tx.rollback(saved);

        const event = costEventEnvelope({
          command,
          eventName: outcome.value.eventName,
          scope: saved.value.scope,
          occurredAt: now,
          entityRefs: outcome.value.entityRefs,
          payload: outcome.value.payload,
        });
        const appended = await deps.eventSink.appendEvents(tx, [event]);
        if (!appended.ok) return tx.rollback(appended);

        return ok(saved.value);
      },
    );
  };

  /**
   * THE shared commitment-family mutation flow (steps 3–7): identical shape
   * to the budget flow, over the commitment aggregate.
   */
  const mutateCommitment = async (
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
    parts: {
      readonly commitmentId: EntityId;
      readonly expectedVersion: AggregateVersion;
      readonly resourceKind: EntityKind;
      readonly resourceId: EntityId | null;
      readonly step: (
        loaded: CommitmentState,
        now: Timestamp,
        context: DomainErrorContext,
      ) => Result<CommitmentOutcome, DomainError>;
    },
  ): Promise<CommandResult<CommitmentState>> => {
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization),
      costResource(command, parts.resourceKind, parts.resourceId),
      'write',
      errorContextOf(command),
    );
    if (!decision.ok) return decision;

    const expected: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind: COMMITMENT_KIND,
      entityId: parts.commitmentId,
      version: parts.expectedVersion,
    };

    return deps.store.runInTransaction(
      async (tx: CostStoreTransaction): Promise<CommandResult<CommitmentState>> => {
        const now = deps.now();
        const context = errorContextOf(command);

        const loaded = await tx.loadCommitment(command.scope, parts.commitmentId);
        if (!loaded.ok) return tx.rollback(loaded);

        const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
        if (!coverage.ok) return tx.rollback(coverage);

        const concurrency = checkConcurrency(
          expected,
          concurrencyTokenOf(loaded.value),
          context,
        );
        if (!concurrency.ok) return tx.rollback(concurrency);

        const outcome = parts.step(loaded.value, now, context);
        if (!outcome.ok) return tx.rollback(outcome);

        const saved = await tx.saveCommitment(
          command.scope,
          outcome.value.next,
          parts.expectedVersion,
        );
        if (!saved.ok) return tx.rollback(saved);

        const event = costEventEnvelope({
          command,
          eventName: outcome.value.eventName,
          scope: saved.value.scope,
          occurredAt: now,
          entityRefs: outcome.value.entityRefs,
          payload: outcome.value.payload,
        });
        const appended = await deps.eventSink.appendEvents(tx, [event]);
        if (!appended.ok) return tx.rollback(appended);

        return ok(saved.value);
      },
    );
  };

  /**
   * THE shared invoice-family mutation flow (steps 3–7): identical shape to
   * the budget flow, over the invoice aggregate.
   */
  const mutateInvoice = async (
    command: CommandEnvelope<unknown>,
    authorization: CostCommandAuthorization,
    parts: {
      readonly invoiceId: EntityId;
      readonly expectedVersion: AggregateVersion;
      readonly resourceKind: EntityKind;
      readonly resourceId: EntityId | null;
      readonly step: (
        loaded: InvoiceState,
        now: Timestamp,
        context: DomainErrorContext,
      ) => Result<InvoiceOutcome, DomainError>;
    },
  ): Promise<CommandResult<InvoiceState>> => {
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization),
      costResource(command, parts.resourceKind, parts.resourceId),
      'write',
      errorContextOf(command),
    );
    if (!decision.ok) return decision;

    const expected: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind: INVOICE_KIND,
      entityId: parts.invoiceId,
      version: parts.expectedVersion,
    };

    return deps.store.runInTransaction(
      async (tx: CostStoreTransaction): Promise<CommandResult<InvoiceState>> => {
        const now = deps.now();
        const context = errorContextOf(command);

        const loaded = await tx.loadInvoice(command.scope, parts.invoiceId);
        if (!loaded.ok) return tx.rollback(loaded);

        const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
        if (!coverage.ok) return tx.rollback(coverage);

        const concurrency = checkConcurrency(
          expected,
          concurrencyTokenOf(loaded.value),
          context,
        );
        if (!concurrency.ok) return tx.rollback(concurrency);

        const outcome = parts.step(loaded.value, now, context);
        if (!outcome.ok) return tx.rollback(outcome);

        const saved = await tx.saveInvoice(
          command.scope,
          outcome.value.next,
          parts.expectedVersion,
        );
        if (!saved.ok) return tx.rollback(saved);

        const event = costEventEnvelope({
          command,
          eventName: outcome.value.eventName,
          scope: saved.value.scope,
          occurredAt: now,
          entityRefs: outcome.value.entityRefs,
          payload: outcome.value.payload,
        });
        const appended = await deps.eventSink.appendEvents(tx, [event]);
        if (!appended.ok) return tx.rollback(appended);

        return ok(saved.value);
      },
    );
  };

  /**
   * Cross-aggregate commercial gate (shared by create/amend commitment):
   * every line must reference a cost item of the addressed budget's CURRENT
   * working set, and the commitment's currency must equal the budget's —
   * both checked BEFORE any state lands (typed invariant-violation).
   */
  const commitmentLinesGate = (
    budget: BudgetState,
    lines: readonly CommitmentLineInput[],
    currency: string,
    context: DomainErrorContext,
  ): Result<readonly NewCommitmentLine[], DomainError> => {
    if (currency !== budget.currency) {
      return fail(
        invariantViolation(
          {
            name: 'cost-currency-consistent',
            statement: `the commitment's currency ${currency} does not match budget ${budget.entityId}'s currency ${budget.currency}`,
          },
          context,
        ),
      );
    }
    const known = new Set(Object.keys(budget.costItems));
    const mapped: NewCommitmentLine[] = [];
    const linked = new Set<string>();
    for (const line of lines) {
      if (!known.has(line.costItemId)) {
        return fail(
          invariantViolation(
            {
              name: 'commitment-line-cost-item-exists',
              statement: `the commitment line references cost item ${line.costItemId}, which does not exist in the current working set of budget ${budget.entityId}`,
            },
            context,
          ),
        );
      }
      if (linked.has(line.costItemId)) {
        return fail(
          invariantViolation(
            {
              name: 'commitment-lines-unique-cost-items',
              statement: `the commitment references cost item ${line.costItemId} on more than one line`,
            },
            context,
          ),
        );
      }
      linked.add(line.costItemId);
      mapped.push({
        lineId: newEntityId(),
        costItemId: line.costItemId,
        description: line.description,
        amountMinor: line.amountMinor,
      });
    }
    return ok(mapped);
  };

  return {
    createBudget: async (command, authorization) => {
      requireCommandName(command, CREATE_BUDGET_COMMAND);
      const payload = parseCreateBudgetPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Resolve the project the new budget belongs to. Under project scope
      // the command initializes exactly its own project (a payload naming a
      // DIFFERENT project is a typed unauthorized second-boundary violation,
      // before any transaction opens); under tenant scope the payload must
      // name the project.
      let projectId: ProjectId;
      if (command.scope.kind === 'project') {
        if (
          payload.value.projectId !== undefined &&
          payload.value.projectId !== command.scope.projectId
        ) {
          return {
            ok: false,
            error: projectScopeViolation(
              {
                commandProjectId: command.scope.projectId,
                aggregateProjectId: payload.value.projectId,
              },
              errorContextOf(command),
            ),
          };
        }
        projectId = command.scope.projectId;
      } else if (payload.value.projectId !== undefined) {
        projectId = payload.value.projectId;
      } else {
        return {
          ok: false,
          error: domainError(
            'invariant-violation',
            `invalid command payload for '${command.commandName}': a tenant-scoped create must name the project the budget belongs to (projectId)`,
            [
              {
                code: 'invalid-command-payload',
                message: 'missing-field: projectId is required under tenant scope',
                path: 'projectId',
              },
            ],
            errorContextOf(command),
          ),
        };
      }

      // Kind-level create authority over the target project (A12 structural
      // isolation + the caller's policy decide; a denied command never opens
      // a transaction).
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceScope({
          scope: { kind: 'project', tenantId: command.scope.tenantId, projectId },
          resourceKind: BUDGET_KIND,
          resourceId: null,
          ownerId: null,
        }),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: CostStoreTransaction): Promise<CommandResult<BudgetState>> => {
          const now = deps.now();
          const budgetId = newEntityId();
          const scope = {
            kind: 'project',
            tenantId: command.scope.tenantId,
            projectId,
          } as const;

          const initial = createBudgetState(
            { budgetId, name: payload.value.name, currency: payload.value.currency, now },
            scope,
            errorContextOf(command),
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertBudget(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = costEventEnvelope({
            command,
            eventName: BUDGET_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: budgetRef(inserted.value) },
            payload: {
              budgetId: inserted.value.entityId,
              name: inserted.value.name,
              currency: inserted.value.currency,
              version: inserted.value.version,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    recordCostItem: async (command, authorization) => {
      requireCommandName(command, RECORD_COST_ITEM_COMMAND);
      const payload = parseRecordCostItemPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateBudget(command, authorization, {
        budgetId: payload.value.budgetId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: COST_ITEM_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          const costItemId = newEntityId();
          const next = recordCostItemState(
            loaded,
            {
              costItemId,
              code: payload.value.code,
              description: payload.value.description,
              unit: payload.value.unit,
              quantityMilli: payload.value.quantityMilli,
              unitRateMinor: payload.value.unitRateMinor,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const item = next.value.costItems[costItemId];
          if (item === undefined) {
            throw new TypeError(`recorded cost item ${costItemId} is missing from the next state`);
          }
          return ok({
            next: next.value,
            eventName: COST_ITEM_RECORDED_EVENT,
            entityRefs: { before: null, after: { entityKind: COST_ITEM_KIND, entityId: costItemId } },
            payload: {
              budgetId: next.value.entityId,
              costItemId,
              code: item.code,
              description: item.description,
              unit: item.unit,
              quantityMilli: item.quantityMilli,
              unitRateMinor: item.unitRateMinor,
              amountMinor: item.amountMinor,
              version: next.value.version,
            },
          });
        },
      });
    },

    reviseBudget: async (command, authorization) => {
      requireCommandName(command, REVISE_BUDGET_COMMAND);
      const payload = parseReviseBudgetPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // GATE 1 — the cost-area write gate (the same capability every cost
      // mutation requires).
      const costDecision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        costResource(command, BUDGET_REVISION_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!costDecision.ok) return costDecision;

      // GATE 2 — the DISTINCT STRONGER project-area write gate: re-anchoring
      // the project's whole budget of record additionally demands the project
      // write capability (an actor holding only the cost capability can
      // record items, commitments, invoices and payments but can never revise
      // the budget — typed forbidden here).
      const projectDecision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        costResource(command, PROJECT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!projectDecision.ok) return projectDecision;

      return deps.store.runInTransaction(
        async (tx: CostStoreTransaction): Promise<CommandResult<BudgetState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadBudget(command.scope, payload.value.budgetId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            {
              kind: 'concurrency-token',
              entityKind: BUDGET_KIND,
              entityId: payload.value.budgetId,
              version: payload.value.expectedVersion,
            },
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const revisionId = newEntityId();
          const next = reviseBudgetState(
            loaded.value,
            {
              revisionId,
              ...(payload.value.label !== undefined ? { label: payload.value.label } : {}),
              createdBy: actorIdOf(command),
              now,
            },
            context,
          );
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveBudget(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!saved.ok) return tx.rollback(saved);

          const revision = saved.value.revisions[revisionId];
          if (revision === undefined) {
            throw new TypeError(`revision ${revisionId} is missing from the saved state`);
          }

          const event = costEventEnvelope({
            command,
            eventName: BUDGET_REVISED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: { entityKind: BUDGET_REVISION_KIND, entityId: revisionId } },
            payload: {
              budgetId: saved.value.entityId,
              revisionId,
              sequence: revision.sequence,
              label: revision.label,
              supersedes: revision.supersedes,
              costItemCount: revision.costItems.length,
              version: saved.value.version,
              createdAt: revision.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    createCommitment: async (command, authorization) => {
      requireCommandName(command, CREATE_COMMITMENT_COMMAND);
      const payload = parseCreateCommitmentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        costResource(command, COMMITMENT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: CostStoreTransaction): Promise<CommandResult<CommitmentState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          // The addressed budget: scope-guarded load (cross-tenant/project is
          // a typed not-found — no existence oracle), and the source of the
          // new commitment's owning scope.
          const budget = await tx.loadBudget(command.scope, payload.value.budgetId);
          if (!budget.ok) return tx.rollback(budget);

          const lines = commitmentLinesGate(
            budget.value,
            payload.value.lines,
            payload.value.currency,
            context,
          );
          if (!lines.ok) return tx.rollback(lines);

          const commitmentId = newEntityId();
          const initial = createCommitmentState(
            {
              commitmentId,
              number: payload.value.number,
              commitmentKind: payload.value.commitmentKind,
              description: payload.value.description,
              currency: payload.value.currency,
              lines: lines.value,
              now,
              createdBy: actorIdOf(command),
            },
            budget.value.scope,
            context,
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertCommitment(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = costEventEnvelope({
            command,
            eventName: COMMITMENT_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: { entityKind: COMMITMENT_KIND, entityId: commitmentId } },
            payload: {
              commitmentId: inserted.value.entityId,
              budgetId: budget.value.entityId,
              number: inserted.value.number,
              commitmentKind: inserted.value.commitmentKind,
              description: inserted.value.description,
              lineCount: currentLineSetOf(inserted.value).lines.length,
              committedAmountMinor: committedAmountMinorOf(inserted.value),
              version: inserted.value.version,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    amendCommitment: async (command, authorization) => {
      requireCommandName(command, AMEND_COMMITMENT_COMMAND);
      const payload = parseAmendCommitmentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        costResource(command, COMMITMENT_AMENDMENT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: CostStoreTransaction): Promise<CommandResult<CommitmentState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadCommitment(command.scope, payload.value.commitmentId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            {
              kind: 'concurrency-token',
              entityKind: COMMITMENT_KIND,
              entityId: payload.value.commitmentId,
              version: payload.value.expectedVersion,
            },
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          // Cross-aggregate gate: the amendment's lines are validated against
          // the addressed budget's current working set + currency BEFORE any
          // state lands (the budget is loaded through the same scoped
          // transaction).
          const budget = await tx.loadBudget(command.scope, payload.value.budgetId);
          if (!budget.ok) return tx.rollback(budget);

          const lines = commitmentLinesGate(
            budget.value,
            payload.value.lines,
            loaded.value.currency,
            context,
          );
          if (!lines.ok) return tx.rollback(lines);

          const amendmentId = newEntityId();
          const next = amendCommitmentState(
            loaded.value,
            {
              amendmentId,
              reason: payload.value.reason,
              lines: lines.value,
              now,
              amendedBy: actorIdOf(command),
            },
            context,
          );
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveCommitment(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!saved.ok) return tx.rollback(saved);

          const amendment = saved.value.lineSets[saved.value.lineSets.length - 1];
          if (amendment === undefined) {
            throw new TypeError(`amendment ${amendmentId} is missing from the saved state`);
          }

          const event = costEventEnvelope({
            command,
            eventName: COMMITMENT_AMENDED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: { entityKind: COMMITMENT_AMENDMENT_KIND, entityId: amendmentId } },
            payload: {
              commitmentId: saved.value.entityId,
              amendmentId,
              sequence: amendment.sequence,
              reason: amendment.reason,
              lineCount: amendment.lines.length,
              committedAmountMinor: committedAmountMinorOf(saved.value),
              version: saved.value.version,
              amendedAt: amendment.recordedAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    closeCommitment: async (command, authorization) => {
      requireCommandName(command, CLOSE_COMMITMENT_COMMAND);
      const payload = parseCloseCommitmentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateCommitment(command, authorization, {
        commitmentId: payload.value.commitmentId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: COMMITMENT_KIND,
        resourceId: payload.value.commitmentId,
        step: (loaded, now, context) => {
          const next = closeCommitmentState(
            loaded,
            { reason: payload.value.reason, now },
            context,
          );
          if (!next.ok) return next;
          return ok({
            next: next.value,
            eventName: COMMITMENT_CLOSED_EVENT,
            entityRefs: {
              before: { entityKind: COMMITMENT_KIND, entityId: payload.value.commitmentId },
              after: { entityKind: COMMITMENT_KIND, entityId: payload.value.commitmentId },
            },
            payload: {
              commitmentId: next.value.entityId,
              status: next.value.status,
              closeReason: next.value.closeReason ?? '',
              closedAt: next.value.closedAt ?? now,
              version: next.value.version,
            },
          });
        },
      });
    },

    recordInvoice: async (command, authorization) => {
      requireCommandName(command, RECORD_INVOICE_COMMAND);
      const payload = parseRecordInvoicePayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        costResource(command, INVOICE_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: CostStoreTransaction): Promise<CommandResult<InvoiceState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          // The addressed commitment: scope-guarded load (cross-tenant/project
          // is a typed not-found — no existence oracle), and the source of the
          // new invoice's owning scope.
          const commitment = await tx.loadCommitment(
            command.scope,
            payload.value.commitmentId,
          );
          if (!commitment.ok) return tx.rollback(commitment);

          // Commercial gates BEFORE any state lands: the currency must match
          // and the obligation must still be active.
          if (payload.value.currency !== commitment.value.currency) {
            return tx.rollback(
              fail(
                invariantViolation(
                  {
                    name: 'cost-currency-consistent',
                    statement: `the invoice's currency ${payload.value.currency} does not match commitment ${commitment.value.entityId}'s currency ${commitment.value.currency}`,
                  },
                  context,
                ),
              ),
            );
          }
          if (commitment.value.status === 'closed') {
            return tx.rollback(
              fail(
                invariantViolation(
                  {
                    name: 'invoice-commitment-active',
                    statement: `commitment ${commitment.value.entityId} is closed; invoices cannot be recorded against a closed obligation`,
                  },
                  context,
                ),
              ),
            );
          }

          const invoiceId = newEntityId();
          const lines: NewInvoiceLine[] = payload.value.lines.map((line) => ({
            lineId: newEntityId(),
            description: line.description,
            amountMinor: line.amountMinor,
          }));
          const initial = createInvoiceState(
            {
              invoiceId,
              commitmentId: payload.value.commitmentId,
              number: payload.value.number,
              description: payload.value.description,
              currency: payload.value.currency,
              lines,
              issuedOn: payload.value.issuedOn,
              dueOn: payload.value.dueOn,
              now,
            },
            commitment.value.scope,
            context,
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertInvoice(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = costEventEnvelope({
            command,
            eventName: INVOICE_RECORDED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: { before: null, after: { entityKind: INVOICE_KIND, entityId: invoiceId } },
            payload: {
              invoiceId: inserted.value.entityId,
              commitmentId: inserted.value.commitmentId,
              number: inserted.value.number,
              lineCount: inserted.value.lines.length,
              invoicedAmountMinor: invoicedAmountMinorOf(inserted.value),
              version: inserted.value.version,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    referencePayment: async (command, authorization) => {
      requireCommandName(command, REFERENCE_PAYMENT_COMMAND);
      const payload = parseReferencePaymentPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateInvoice(command, authorization, {
        invoiceId: payload.value.invoiceId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: PAYMENT_REFERENCE_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          // The paid instant can never be after the recording instant (the
          // invariant list re-checks; reject before any state lands).
          if (compareTimestamps(payload.value.paidAt, now) > 0) {
            return fail(
              invariantViolation(
                {
                  name: 'payment-referenced-not-future',
                  statement: `the payment instant ${payload.value.paidAt} is after the recording instant ${now}`,
                },
                context,
              ),
            );
          }
          const paymentReferenceId = newEntityId();
          const next = referencePaymentState(
            loaded,
            {
              paymentReferenceId,
              reference: payload.value.reference,
              amountMinor: payload.value.amountMinor,
              paidAt: payload.value.paidAt,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const payment = next.value.paymentReferences[next.value.paymentReferences.length - 1];
          if (payment === undefined) {
            throw new TypeError(`payment reference ${paymentReferenceId} is missing from the next state`);
          }
          return ok({
            next: next.value,
            eventName: PAYMENT_REFERENCED_EVENT,
            entityRefs: { before: null, after: { entityKind: PAYMENT_REFERENCE_KIND, entityId: paymentReferenceId } },
            payload: {
              invoiceId: next.value.entityId,
              commitmentId: next.value.commitmentId,
              paymentReferenceId,
              reference: payment.reference,
              amountMinor: payment.amountMinor,
              paidAt: payment.paidAt,
              version: next.value.version,
              recordedAt: payment.recordedAt,
            },
          });
        },
      });
    },
  };
}
