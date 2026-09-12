// Office contracts/change domain — mutation command handlers (OFF-012).
//
// THE canonical mutation path of the contracts/change module (freeze
// "cross-view mutation" + the OFF-003 kernel contract), executed for every
// command — the exact flow of the sibling domain modules:
//
//   1. validate the command name + parse the payload fail-closed (a malformed
//      payload is a typed invariant-violation — never a silent default);
//   2. authorize the mutation with the CALLER-SUPPLIED policy through
//      @office/authz's deny-by-default authorize() (structural A12 isolation
//      first, then explicit deny, then allow, then default deny) — a denied
//      command never even opens a transaction;
//   3. load the aggregates through the scope-guarded store (a foreign
//      tenant's or foreign project's contract/change event/change order is
//      invisible — typed not-found, no existence oracle) and re-check scope
//      coverage (kernel A12 backstop);
//   4. check optimistic concurrency (stale version → typed
//      concurrency-conflict; commercial state is NEVER silently overwritten);
//   5. apply the invariant-checked pure transition — including the
//      cross-entity link gate: affected obligation links are validated
//      against the owning contract of THIS package, while evidence, cost and
//      schedule links are typed ids accepted as-is (referential wiring
//      against those packages is the app layer's job — no
//      domain-to-domain imports, no copied data);
//   6. write through the store AND append the audit event through the
//      injected EventSink inside ONE runInTransaction — a failure anywhere
//      rolls everything back (tx.rollback carries the typed DomainError out,
//      and pending writes are discarded);
//   7. return the committed aggregate state as a typed Result.
//
// Cross-entity link discipline (THE acceptance heart): a change event binds
// to scope obligations + evidence revisions + cost items + schedule
// activities via typed EntityId/EntityRef values ONLY — no referenced
// entity's data is ever copied into this package's aggregates, no
// referenced-entity store is consulted, and links are immutable once
// recorded (only APPENDS while the change event is proposed; the
// always-failing replace/remove guards live in state.ts).
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
  CHANGE_EVENT_LINKED_EVENT,
  CHANGE_EVENT_RAISED_EVENT,
  CHANGE_ORDER_APPROVED_EVENT,
  CHANGE_ORDER_EXECUTED_EVENT,
  CHANGE_ORDER_REJECTED_EVENT,
  CHANGE_ORDER_SUBMITTED_EVENT,
  CLAIM_REFERENCED_EVENT,
  CONTRACT_ARCHIVED_EVENT,
  CONTRACT_CREATED_EVENT,
  CONTRACT_UPDATED_EVENT,
  OBLIGATION_RECORDED_EVENT,
  contractsEventEnvelope,
} from './events';
import type { ContractsEventPayloads } from './events';
import type { ContractsStore, ContractsStoreTransaction } from './store';
import type {
  ChangeEventLinks,
  ChangeEventState,
  ChangeOrderState,
  ClaimReferenceState,
  ContractChanges,
  ContractState,
} from './state';
import {
  CHANGE_EVENT_KIND,
  CHANGE_ORDER_KIND,
  CLAIM_REFERENCE_KIND,
  CONTRACT_KIND,
  SCOPE_OBLIGATION_KIND,
  approveChangeOrderState,
  archiveContractState,
  createChangeEventState,
  createChangeOrderState,
  createClaimReferenceState,
  createContractState,
  executeChangeOrderState,
  linkChangeReferencesState,
  recordObligationState,
  rejectChangeOrderState,
  supersedeChangeEventState,
  updateContractState,
} from './state';
import {
  isPlainObject,
  optionalArrayOf,
  optionalFieldWith,
  optionalNullableFieldWith,
  parseCostImpactLink,
  parseEvidenceLink,
  parseMoney,
  parsePartyLink,
  parseQuantityValue,
  parseStringLike,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import type { CostImpactLink, EvidenceLink, Money, QuantityValue, StringRule } from './parse';

// ----- command names ------------------------------------------------------------

const commandNameOf = (name: string): CommandName => {
  const parsed = parseCommandName(name);
  if (!parsed.ok) {
    throw new TypeError(`invalid contracts-domain command name literal: ${name}`);
  }
  return parsed.value;
};

/** Command name executed by {@link ContractsCommands.createContract}. */
export const CREATE_CONTRACT_COMMAND: CommandName = commandNameOf('contracts.createContract');
/** Command name executed by {@link ContractsCommands.updateContract}. */
export const UPDATE_CONTRACT_COMMAND: CommandName = commandNameOf('contracts.updateContract');
/** Command name executed by {@link ContractsCommands.archiveContract}. */
export const ARCHIVE_CONTRACT_COMMAND: CommandName = commandNameOf('contracts.archiveContract');
/** Command name executed by {@link ContractsCommands.recordScopeObligation}. */
export const RECORD_SCOPE_OBLIGATION_COMMAND: CommandName = commandNameOf(
  'contracts.recordScopeObligation',
);
/** Command name executed by {@link ContractsCommands.raiseChangeEvent}. */
export const RAISE_CHANGE_EVENT_COMMAND: CommandName = commandNameOf('contracts.raiseChangeEvent');
/** Command name executed by {@link ContractsCommands.linkChangeReferences}. */
export const LINK_CHANGE_REFERENCES_COMMAND: CommandName = commandNameOf(
  'contracts.linkChangeReferences',
);
/** Command name executed by {@link ContractsCommands.submitChangeOrder}. */
export const SUBMIT_CHANGE_ORDER_COMMAND: CommandName = commandNameOf(
  'contracts.submitChangeOrder',
);
/** Command name executed by {@link ContractsCommands.approveChangeOrder}. */
export const APPROVE_CHANGE_ORDER_COMMAND: CommandName = commandNameOf(
  'contracts.approveChangeOrder',
);
/** Command name executed by {@link ContractsCommands.rejectChangeOrder}. */
export const REJECT_CHANGE_ORDER_COMMAND: CommandName = commandNameOf(
  'contracts.rejectChangeOrder',
);
/** Command name executed by {@link ContractsCommands.executeChangeOrder}. */
export const EXECUTE_CHANGE_ORDER_COMMAND: CommandName = commandNameOf(
  'contracts.executeChangeOrder',
);
/** Command name executed by {@link ContractsCommands.referenceClaim}. */
export const REFERENCE_CLAIM_COMMAND: CommandName = commandNameOf('contracts.referenceClaim');

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
      `contracts-domain command handler for '${expected}' received command '${command.commandName}'`,
    );
  }
};

// ----- payload shapes (fail-closed, strict keys) ---------------------------------

const TITLE_RULE: StringRule = { min: 1, max: 200, description: 'display title' };
const DESCRIPTION_RULE: StringRule = { min: 1, max: 2_000, description: 'description' };
const REASON_RULE: StringRule = { min: 1, max: 500, description: 'decision reason' };
const CODE_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/,
  description: 'obligation code (alphanumeric, dot, underscore, dash; no leading dot/dash)',
};
const UNIT_RULE: StringRule = {
  min: 1,
  max: 32,
  pattern: /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,31}$/,
  description: 'unit of measure (alphanumeric plus dot, underscore, slash, dash; e.g. m3, tonne, each)',
};

/** Validated payload of `contracts.createContract`. */
export interface CreateContractPayload {
  readonly title: string;
  readonly owner: { readonly entityKind: 'person' | 'company'; readonly entityId: EntityId };
  readonly contractor: { readonly entityKind: 'person' | 'company'; readonly entityId: EntityId };
  readonly contractValue: Money;
  readonly executionStatus?: 'draft' | 'executed' | 'closed';
  /** Required under tenant scope; under project scope it must equal the command's project. */
  readonly projectId?: ProjectId;
}

const CREATE_PAYLOAD_KEYS = [
  'title',
  'owner',
  'contractor',
  'contractValue',
  'executionStatus',
  'projectId',
] as const;
const CREATE_PAYLOAD_GRAMMAR =
  "CreateContractPayload: { title: string (1..200), owner: PartyLink, contractor: PartyLink, contractValue: Money, executionStatus?: 'draft' | 'executed' | 'closed', projectId?: ProjectId (required under tenant scope; must match under project scope) }";

/** Validated payload of `contracts.updateContract`. */
export interface UpdateContractPayload {
  readonly contractId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly changes: ContractChanges;
}

const UPDATE_PAYLOAD_KEYS = [
  'contractId',
  'expectedVersion',
  'title',
  'owner',
  'contractor',
  'contractValue',
  'executionStatus',
] as const;
const UPDATE_PAYLOAD_GRAMMAR =
  "UpdateContractPayload: { contractId: EntityId, expectedVersion: number (>= 1), title?: string (1..200), owner?: PartyLink, contractor?: PartyLink, contractValue?: Money, executionStatus?: 'draft' | 'executed' | 'closed' (forward-only) } — at least one change field";

/** Validated payload of `contracts.archiveContract`. */
export interface ArchiveContractPayload {
  readonly contractId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const ARCHIVE_PAYLOAD_KEYS = ['contractId', 'expectedVersion'] as const;
const ARCHIVE_PAYLOAD_GRAMMAR =
  'ArchiveContractPayload: { contractId: EntityId, expectedVersion: number (>= 1) }';

/** Validated payload of `contracts.recordScopeObligation`. */
export interface RecordScopeObligationPayload {
  readonly contractId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly code: string;
  readonly description: string;
  readonly quantity: QuantityValue;
  readonly unit: string;
}

const OBLIGATION_PAYLOAD_KEYS = [
  'contractId',
  'expectedVersion',
  'code',
  'description',
  'quantity',
  'unit',
] as const;
const OBLIGATION_PAYLOAD_GRAMMAR =
  "RecordScopeObligationPayload: { contractId: EntityId, expectedVersion: number (>= 1), code: string (1..64), description: string (1..2000), quantity: canonical decimal string (e.g. '12', '0.5', '133.750'), unit: string (1..32) }";

/** Validated payload of `contracts.raiseChangeEvent`. */
export interface RaiseChangeEventPayload {
  readonly contractId: EntityId;
  readonly title: string;
  readonly changeType: 'addition' | 'modification' | 'deletion';
  readonly affectedObligationIds?: readonly EntityId[];
  readonly evidenceLinks?: readonly EvidenceLink[];
  readonly costImpactLinks?: readonly CostImpactLink[];
  readonly scheduleImpactActivityIds?: readonly EntityId[];
}

const RAISE_PAYLOAD_KEYS = [
  'contractId',
  'title',
  'changeType',
  'affectedObligationIds',
  'evidenceLinks',
  'costImpactLinks',
  'scheduleImpactActivityIds',
] as const;
const RAISE_PAYLOAD_GRAMMAR =
  "RaiseChangeEventPayload: { contractId: EntityId, title: string (1..200), changeType: 'addition' | 'modification' | 'deletion', affectedObligationIds?: EntityId[], evidenceLinks?: EvidenceLink[], costImpactLinks?: CostImpactLink[], scheduleImpactActivityIds?: EntityId[] } — typed links only, ids/refs, never copied entity data";

/** Validated payload of `contracts.linkChangeReferences`. */
export interface LinkChangeReferencesPayload {
  readonly changeEventId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly affectedObligationIds?: readonly EntityId[];
  readonly evidenceLinks?: readonly EvidenceLink[];
  readonly costImpactLinks?: readonly CostImpactLink[];
  readonly scheduleImpactActivityIds?: readonly EntityId[];
}

const LINK_PAYLOAD_KEYS = [
  'changeEventId',
  'expectedVersion',
  'affectedObligationIds',
  'evidenceLinks',
  'costImpactLinks',
  'scheduleImpactActivityIds',
] as const;
const LINK_PAYLOAD_GRAMMAR =
  'LinkChangeReferencesPayload: { changeEventId: EntityId, expectedVersion: number (>= 1), affectedObligationIds?: EntityId[], evidenceLinks?: EvidenceLink[], costImpactLinks?: CostImpactLink[], scheduleImpactActivityIds?: EntityId[] } — append-only, at least one new link, duplicates rejected';

/** Validated payload of `contracts.submitChangeOrder`. */
export interface SubmitChangeOrderPayload {
  readonly changeEventId: EntityId;
  readonly title: string;
  readonly changeValue?: Money | null;
}

const SUBMIT_PAYLOAD_KEYS = ['changeEventId', 'title', 'changeValue'] as const;
const SUBMIT_PAYLOAD_GRAMMAR =
  'SubmitChangeOrderPayload: { changeEventId: EntityId, title: string (1..200), changeValue?: Money | null }';

/** Validated payload of `contracts.approveChangeOrder`. */
export interface ApproveChangeOrderPayload {
  readonly changeOrderId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly reason?: string;
}

const APPROVE_PAYLOAD_KEYS = ['changeOrderId', 'expectedVersion', 'reason'] as const;
const APPROVE_PAYLOAD_GRAMMAR =
  'ApproveChangeOrderPayload: { changeOrderId: EntityId, expectedVersion: number (>= 1), reason?: string (1..500) }';

/** Validated payload of `contracts.rejectChangeOrder`. */
export interface RejectChangeOrderPayload {
  readonly changeOrderId: EntityId;
  readonly expectedVersion: AggregateVersion;
  readonly reason?: string;
}

const REJECT_PAYLOAD_KEYS = ['changeOrderId', 'expectedVersion', 'reason'] as const;
const REJECT_PAYLOAD_GRAMMAR =
  'RejectChangeOrderPayload: { changeOrderId: EntityId, expectedVersion: number (>= 1), reason?: string (1..500) }';

/** Validated payload of `contracts.executeChangeOrder`. */
export interface ExecuteChangeOrderPayload {
  readonly changeOrderId: EntityId;
  readonly expectedVersion: AggregateVersion;
}

const EXECUTE_PAYLOAD_KEYS = ['changeOrderId', 'expectedVersion'] as const;
const EXECUTE_PAYLOAD_GRAMMAR =
  'ExecuteChangeOrderPayload: { changeOrderId: EntityId, expectedVersion: number (>= 1) }';

/** Validated payload of `contracts.referenceClaim`. */
export interface ReferenceClaimPayload {
  readonly claimEntityKind: EntityKind;
  readonly claimEntityId: EntityId;
  readonly changeOrderId: EntityId;
  readonly documentId: EntityId;
  readonly revisionId: EntityId;
}

const REFERENCE_CLAIM_PAYLOAD_KEYS = [
  'claimEntityKind',
  'claimEntityId',
  'changeOrderId',
  'documentId',
  'revisionId',
] as const;
const REFERENCE_CLAIM_PAYLOAD_GRAMMAR =
  'ReferenceClaimPayload: { claimEntityKind: EntityKind, claimEntityId: EntityId, changeOrderId: EntityId (must be executed), documentId: EntityId, revisionId: EntityId }';

const describePayload = (raw: unknown): string => {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (Array.isArray(raw)) return `array (length ${raw.length})`;
  return typeof raw;
};

/** Parse the create-contract payload (total, fail-closed, strict keys). */
export function parseCreateContractPayload(raw: unknown): ParseResult<CreateContractPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', CREATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, CREATE_PAYLOAD_KEYS, '', CREATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const owner = requireFieldWith(raw, 'owner', '', parsePartyLink);
  if (!owner.ok) return owner;
  const contractor = requireFieldWith(raw, 'contractor', '', parsePartyLink);
  if (!contractor.ok) return contractor;
  const contractValue = requireFieldWith(raw, 'contractValue', '', parseMoney);
  if (!contractValue.ok) return contractValue;
  const executionStatus = optionalFieldWith(
    raw,
    'executionStatus',
    '',
    parseExecutionStatusLiteral,
  );
  if (!executionStatus.ok) return executionStatus;
  const projectId = optionalFieldWith(raw, 'projectId', '', parseProjectId);
  if (!projectId.ok) return projectId;
  return parseOk({
    title: title.value,
    owner: owner.value,
    contractor: contractor.value,
    contractValue: contractValue.value,
    ...(executionStatus.value !== undefined
      ? { executionStatus: executionStatus.value }
      : {}),
    ...(projectId.value !== undefined ? { projectId: projectId.value } : {}),
  });
}

/** Parse the closed execution-status vocabulary (shared by create/update). */
function parseExecutionStatusLiteral(
  raw: unknown,
): ParseResult<'draft' | 'executed' | 'closed'> {
  const grammar = "execution status: one of 'draft', 'executed', 'closed'";
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  switch (raw) {
    case 'draft':
    case 'executed':
    case 'closed':
      return parseOk(raw);
    default:
      return parseFail('invalid-value', '', grammar, describePayload(raw));
  }
}

/** Parse the closed change-type vocabulary. */
function parseChangeTypeLiteral(
  raw: unknown,
): ParseResult<'addition' | 'modification' | 'deletion'> {
  const grammar = "change type: one of 'addition', 'modification', 'deletion'";
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', grammar, describePayload(raw));
  }
  switch (raw) {
    case 'addition':
    case 'modification':
    case 'deletion':
      return parseOk(raw);
    default:
      return parseFail('invalid-value', '', grammar, describePayload(raw));
  }
}

/** Parse the update-contract payload (total, fail-closed, strict keys). */
export function parseUpdateContractPayload(raw: unknown): ParseResult<UpdateContractPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UPDATE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, UPDATE_PAYLOAD_KEYS, '', UPDATE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const contractId = requireFieldWith(raw, 'contractId', '', parseEntityId);
  if (!contractId.ok) return contractId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const title = optionalFieldWith(raw, 'title', '', (value: unknown) =>
    parseStringLike(value, TITLE_RULE),
  );
  if (!title.ok) return title;
  const owner = optionalFieldWith(raw, 'owner', '', parsePartyLink);
  if (!owner.ok) return owner;
  const contractor = optionalFieldWith(raw, 'contractor', '', parsePartyLink);
  if (!contractor.ok) return contractor;
  const contractValue = optionalFieldWith(raw, 'contractValue', '', parseMoney);
  if (!contractValue.ok) return contractValue;
  const executionStatus = optionalFieldWith(
    raw,
    'executionStatus',
    '',
    parseExecutionStatusLiteral,
  );
  if (!executionStatus.ok) return executionStatus;
  if (
    title.value === undefined &&
    owner.value === undefined &&
    contractor.value === undefined &&
    contractValue.value === undefined &&
    executionStatus.value === undefined
  ) {
    return parseFail(
      'invalid-value',
      '',
      UPDATE_PAYLOAD_GRAMMAR,
      'no change field present — at least one of title, owner, contractor, contractValue, executionStatus is required',
    );
  }
  const changes: ContractChanges = {
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(owner.value !== undefined ? { owner: owner.value } : {}),
    ...(contractor.value !== undefined ? { contractor: contractor.value } : {}),
    ...(contractValue.value !== undefined ? { contractValue: contractValue.value } : {}),
    ...(executionStatus.value !== undefined
      ? { executionStatus: executionStatus.value }
      : {}),
  };
  return parseOk({
    contractId: contractId.value,
    expectedVersion: expectedVersion.value,
    changes,
  });
}

/** Parse the archive-contract payload (total, fail-closed, strict keys). */
export function parseArchiveContractPayload(raw: unknown): ParseResult<ArchiveContractPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', ARCHIVE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, ARCHIVE_PAYLOAD_KEYS, '', ARCHIVE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const contractId = requireFieldWith(raw, 'contractId', '', parseEntityId);
  if (!contractId.ok) return contractId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    contractId: contractId.value,
    expectedVersion: expectedVersion.value,
  });
}

/** Parse the record-scope-obligation payload (total, fail-closed, strict keys). */
export function parseRecordScopeObligationPayload(
  raw: unknown,
): ParseResult<RecordScopeObligationPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', OBLIGATION_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, OBLIGATION_PAYLOAD_KEYS, '', OBLIGATION_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const contractId = requireFieldWith(raw, 'contractId', '', parseEntityId);
  if (!contractId.ok) return contractId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const code = requireString(raw, 'code', '', CODE_RULE);
  if (!code.ok) return code;
  const description = requireString(raw, 'description', '', DESCRIPTION_RULE);
  if (!description.ok) return description;
  const quantity = requireFieldWith(raw, 'quantity', '', parseQuantityValue);
  if (!quantity.ok) return quantity;
  const unit = requireString(raw, 'unit', '', UNIT_RULE);
  if (!unit.ok) return unit;
  return parseOk({
    contractId: contractId.value,
    expectedVersion: expectedVersion.value,
    code: code.value,
    description: description.value,
    quantity: quantity.value,
    unit: unit.value,
  });
}

/** Parse the raise-change-event payload (total, fail-closed, strict keys). */
export function parseRaiseChangeEventPayload(
  raw: unknown,
): ParseResult<RaiseChangeEventPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', RAISE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, RAISE_PAYLOAD_KEYS, '', RAISE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const contractId = requireFieldWith(raw, 'contractId', '', parseEntityId);
  if (!contractId.ok) return contractId;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const changeType = requireFieldWith(raw, 'changeType', '', parseChangeTypeLiteral);
  if (!changeType.ok) return changeType;
  const affectedObligationIds = optionalArrayOf(raw, 'affectedObligationIds', '', parseEntityId);
  if (!affectedObligationIds.ok) return affectedObligationIds;
  const evidenceLinks = optionalArrayOf(raw, 'evidenceLinks', '', parseEvidenceLink);
  if (!evidenceLinks.ok) return evidenceLinks;
  const costImpactLinks = optionalArrayOf(raw, 'costImpactLinks', '', parseCostImpactLink);
  if (!costImpactLinks.ok) return costImpactLinks;
  const scheduleImpactActivityIds = optionalArrayOf(
    raw,
    'scheduleImpactActivityIds',
    '',
    parseEntityId,
  );
  if (!scheduleImpactActivityIds.ok) return scheduleImpactActivityIds;
  return parseOk({
    contractId: contractId.value,
    title: title.value,
    changeType: changeType.value,
    ...(affectedObligationIds.value !== undefined
      ? { affectedObligationIds: affectedObligationIds.value }
      : {}),
    ...(evidenceLinks.value !== undefined ? { evidenceLinks: evidenceLinks.value } : {}),
    ...(costImpactLinks.value !== undefined ? { costImpactLinks: costImpactLinks.value } : {}),
    ...(scheduleImpactActivityIds.value !== undefined
      ? { scheduleImpactActivityIds: scheduleImpactActivityIds.value }
      : {}),
  });
}

/** Parse the link-change-references payload (total, fail-closed, strict keys). */
export function parseLinkChangeReferencesPayload(
  raw: unknown,
): ParseResult<LinkChangeReferencesPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', LINK_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, LINK_PAYLOAD_KEYS, '', LINK_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const changeEventId = requireFieldWith(raw, 'changeEventId', '', parseEntityId);
  if (!changeEventId.ok) return changeEventId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const affectedObligationIds = optionalArrayOf(raw, 'affectedObligationIds', '', parseEntityId);
  if (!affectedObligationIds.ok) return affectedObligationIds;
  const evidenceLinks = optionalArrayOf(raw, 'evidenceLinks', '', parseEvidenceLink);
  if (!evidenceLinks.ok) return evidenceLinks;
  const costImpactLinks = optionalArrayOf(raw, 'costImpactLinks', '', parseCostImpactLink);
  if (!costImpactLinks.ok) return costImpactLinks;
  const scheduleImpactActivityIds = optionalArrayOf(
    raw,
    'scheduleImpactActivityIds',
    '',
    parseEntityId,
  );
  if (!scheduleImpactActivityIds.ok) return scheduleImpactActivityIds;
  if (
    (affectedObligationIds.value ?? []).length === 0 &&
    (evidenceLinks.value ?? []).length === 0 &&
    (costImpactLinks.value ?? []).length === 0 &&
    (scheduleImpactActivityIds.value ?? []).length === 0
  ) {
    return parseFail(
      'invalid-value',
      '',
      LINK_PAYLOAD_GRAMMAR,
      'no new link present — at least one appended link is required',
    );
  }
  return parseOk({
    changeEventId: changeEventId.value,
    expectedVersion: expectedVersion.value,
    ...(affectedObligationIds.value !== undefined
      ? { affectedObligationIds: affectedObligationIds.value }
      : {}),
    ...(evidenceLinks.value !== undefined ? { evidenceLinks: evidenceLinks.value } : {}),
    ...(costImpactLinks.value !== undefined ? { costImpactLinks: costImpactLinks.value } : {}),
    ...(scheduleImpactActivityIds.value !== undefined
      ? { scheduleImpactActivityIds: scheduleImpactActivityIds.value }
      : {}),
  });
}

/** Parse the submit-change-order payload (total, fail-closed, strict keys). */
export function parseSubmitChangeOrderPayload(
  raw: unknown,
): ParseResult<SubmitChangeOrderPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', SUBMIT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, SUBMIT_PAYLOAD_KEYS, '', SUBMIT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const changeEventId = requireFieldWith(raw, 'changeEventId', '', parseEntityId);
  if (!changeEventId.ok) return changeEventId;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const changeValue = optionalNullableFieldWith(raw, 'changeValue', '', parseMoney);
  if (!changeValue.ok) return changeValue;
  return parseOk({
    changeEventId: changeEventId.value,
    title: title.value,
    changeValue: changeValue.value,
  });
}

/** Parse the approve-change-order payload (total, fail-closed, strict keys). */
export function parseApproveChangeOrderPayload(
  raw: unknown,
): ParseResult<ApproveChangeOrderPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPROVE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, APPROVE_PAYLOAD_KEYS, '', APPROVE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const changeOrderId = requireFieldWith(raw, 'changeOrderId', '', parseEntityId);
  if (!changeOrderId.ok) return changeOrderId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const reason = optionalFieldWith(raw, 'reason', '', (value: unknown) =>
    parseStringLike(value, REASON_RULE),
  );
  if (!reason.ok) return reason;
  return parseOk({
    changeOrderId: changeOrderId.value,
    expectedVersion: expectedVersion.value,
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
  });
}

/** Parse the reject-change-order payload (total, fail-closed, strict keys). */
export function parseRejectChangeOrderPayload(
  raw: unknown,
): ParseResult<RejectChangeOrderPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REJECT_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, REJECT_PAYLOAD_KEYS, '', REJECT_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const changeOrderId = requireFieldWith(raw, 'changeOrderId', '', parseEntityId);
  if (!changeOrderId.ok) return changeOrderId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  const reason = optionalFieldWith(raw, 'reason', '', (value: unknown) =>
    parseStringLike(value, REASON_RULE),
  );
  if (!reason.ok) return reason;
  return parseOk({
    changeOrderId: changeOrderId.value,
    expectedVersion: expectedVersion.value,
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
  });
}

/** Parse the execute-change-order payload (total, fail-closed, strict keys). */
export function parseExecuteChangeOrderPayload(
  raw: unknown,
): ParseResult<ExecuteChangeOrderPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', EXECUTE_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(raw, EXECUTE_PAYLOAD_KEYS, '', EXECUTE_PAYLOAD_GRAMMAR);
  if (unknownKey) return unknownKey;
  const changeOrderId = requireFieldWith(raw, 'changeOrderId', '', parseEntityId);
  if (!changeOrderId.ok) return changeOrderId;
  const expectedVersion = requireFieldWith(raw, 'expectedVersion', '', parseAggregateVersion);
  if (!expectedVersion.ok) return expectedVersion;
  return parseOk({
    changeOrderId: changeOrderId.value,
    expectedVersion: expectedVersion.value,
  });
}

/** Parse the reference-claim payload (total, fail-closed, strict keys). */
export function parseReferenceClaimPayload(raw: unknown): ParseResult<ReferenceClaimPayload> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', REFERENCE_CLAIM_PAYLOAD_GRAMMAR, describePayload(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    REFERENCE_CLAIM_PAYLOAD_KEYS,
    '',
    REFERENCE_CLAIM_PAYLOAD_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const claimEntityKind = requireFieldWith(raw, 'claimEntityKind', '', parseEntityKind);
  if (!claimEntityKind.ok) return claimEntityKind;
  const claimEntityId = requireFieldWith(raw, 'claimEntityId', '', parseEntityId);
  if (!claimEntityId.ok) return claimEntityId;
  const changeOrderId = requireFieldWith(raw, 'changeOrderId', '', parseEntityId);
  if (!changeOrderId.ok) return changeOrderId;
  const documentId = requireFieldWith(raw, 'documentId', '', parseEntityId);
  if (!documentId.ok) return documentId;
  const revisionId = requireFieldWith(raw, 'revisionId', '', parseEntityId);
  if (!revisionId.ok) return revisionId;
  return parseOk({
    claimEntityKind: claimEntityKind.value,
    claimEntityId: claimEntityId.value,
    changeOrderId: changeOrderId.value,
    documentId: documentId.value,
    revisionId: revisionId.value,
  });
}

// ----- command service -------------------------------------------------------------

/**
 * Wiring dependencies of the contracts command service. `now` and
 * `newOpaqueId` are the injected suppliers (determinism rule): fixed values
 * in tests, wall clock / crypto randomness in production wiring. The store
 * is the pure-domain transactional seam (see store.ts); the event sink is
 * the mirrored OFF-007 port (see events.ts).
 */
export interface ContractsCommandDeps {
  readonly store: ContractsStore;
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
export interface ContractsCommandAuthorization {
  readonly policy: Policy;
  readonly capabilities: readonly string[];
}

/** The contracts/change mutation command surface. */
export interface ContractsCommands {
  /** Create a project's contract (the commercial baseline root). */
  createContract(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ContractState>>;
  /** Update the contract's metadata (execution status moves forward only). */
  updateContract(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ContractState>>;
  /** Archive the contract — the explicit one-way lifecycle event. */
  archiveContract(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ContractState>>;
  /** Record one immutable scope obligation into the contract's decomposition. */
  recordScopeObligation(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ContractState>>;
  /** Raise a change event against the contract with its typed link set. */
  raiseChangeEvent(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeEventState>>;
  /** Append additional typed links to a proposed change event (append-only). */
  linkChangeReferences(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeEventState>>;
  /** Submit a change order against a proposed change event. */
  submitChangeOrder(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeOrderState>>;
  /** Approve a submitted change order (one-way). */
  approveChangeOrder(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeOrderState>>;
  /** Reject a submitted change order (one-way, terminal; scope never mutates). */
  rejectChangeOrder(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeOrderState>>;
  /** Execute an approved change order — supersedes the originating change event. */
  executeChangeOrder(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ChangeOrderState>>;
  /** Pin one claim to evidence + an executed change order (immutable). */
  referenceClaim(
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
  ): Promise<CommandResult<ClaimReferenceState>>;
}

/** What one mutation step produces: the next state plus its audit event parts. */
interface MutationOutcome<S> {
  readonly next: S;
  readonly eventName: EventName;
  readonly entityRefs: EntityRefs;
  readonly payload: ContractsEventPayloads;
}

/** Create the contracts/change mutation command service. */
export function createContractsCommands(deps: ContractsCommandDeps): ContractsCommands {
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
    authorization: ContractsCommandAuthorization,
  ) =>
    authorizationContext({
      actor: command.actor,
      scope: command.scope,
      capabilities: authorization.capabilities,
    });

  /** The contracts-domain resource being accessed, addressed within the COMMAND's scope. */
  const resourceOf = (
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

  /**
   * The cross-entity link gate (acceptance heart): affected obligation links
   * are validated against the owning contract of THIS package; evidence,
   * cost and schedule links are typed canonical ids accepted AS-IS — no
   * referenced-entity store is consulted (referential wiring against those
   * packages is the app layer's job; no domain-to-domain imports).
   */
  const validateObligationLinks = (
    contract: ContractState,
    changeEventId: EntityId,
    obligationIds: readonly EntityId[],
    context: DomainErrorContext,
  ): Result<true, DomainError> => {
    for (const obligationId of obligationIds) {
      if (contract.obligations[obligationId] === undefined) {
        return fail(
          domainError(
            'invariant-violation',
            `change event ${changeEventId} links scope obligation ${obligationId}, which does not exist in contract ${contract.entityId}`,
            [
              {
                code: 'change-event-obligation-links-validated',
                message: `unknown obligation ${obligationId}`,
                path: 'affectedObligationIds',
              },
            ],
            context,
          ),
        );
      }
    }
    return ok(true);
  };

  /**
   * The shared mutation spine (steps 3–6 of the module contract) for
   * CONTRACT-root mutations: load scoped, A12 backstop, concurrency, pure
   * transition, store write + event append in ONE transaction — every
   * failure rolls the whole mutation back.
   */
  const mutateContract = async (
    command: CommandEnvelope<unknown>,
    authorization: ContractsCommandAuthorization,
    parts: {
      readonly contractId: EntityId;
      readonly expectedVersion: AggregateVersion;
      readonly resourceKind: EntityKind;
      readonly resourceId: EntityId | null;
      readonly step: (
        loaded: ContractState,
        now: Timestamp,
        context: DomainErrorContext,
      ) => Result<MutationOutcome<ContractState>, DomainError>;
    },
  ): Promise<CommandResult<ContractState>> => {
    const decision = authorize(
      authorization.policy,
      contextOf(command, authorization),
      resourceOf(command, parts.resourceKind, parts.resourceId),
      'write',
      errorContextOf(command),
    );
    if (!decision.ok) return decision;

    const expected: ConcurrencyToken = {
      kind: 'concurrency-token',
      entityKind: CONTRACT_KIND,
      entityId: parts.contractId,
      version: parts.expectedVersion,
    };

    return deps.store.runInTransaction(
      async (tx: ContractsStoreTransaction): Promise<CommandResult<ContractState>> => {
        const now = deps.now();
        const context = errorContextOf(command);

        const loaded = await tx.loadContract(command.scope, parts.contractId);
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

        const saved = await tx.saveContract(
          command.scope,
          outcome.value.next,
          parts.expectedVersion,
        );
        if (!saved.ok) return tx.rollback(saved);

        const event = contractsEventEnvelope({
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

  return {
    createContract: async (command, authorization) => {
      requireCommandName(command, CREATE_CONTRACT_COMMAND);
      const payload = parseCreateContractPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Resolve the project the new contract belongs to. Under project scope
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
            `invalid command payload for '${command.commandName}': a tenant-scoped create must name the project the contract belongs to (projectId)`,
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
          resourceKind: CONTRACT_KIND,
          resourceId: null,
          ownerId: null,
        }),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ContractState>> => {
          const now = deps.now();
          const contractId = newEntityId();
          const scope = {
            kind: 'project',
            tenantId: command.scope.tenantId,
            projectId,
          } as const;

          const initial = createContractState(
            {
              contractId,
              title: payload.value.title,
              owner: payload.value.owner,
              contractor: payload.value.contractor,
              contractValue: payload.value.contractValue,
              ...(payload.value.executionStatus !== undefined
                ? { executionStatus: payload.value.executionStatus }
                : {}),
              now,
            },
            scope,
            errorContextOf(command),
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertContract(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = contractsEventEnvelope({
            command,
            eventName: CONTRACT_CREATED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: {
              before: null,
              after: { entityKind: CONTRACT_KIND, entityId: inserted.value.entityId },
            },
            payload: {
              contractId: inserted.value.entityId,
              title: inserted.value.title,
              version: inserted.value.version,
              contractValue: inserted.value.contractValue,
              executionStatus: inserted.value.executionStatus,
              createdAt: inserted.value.createdAt,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    updateContract: async (command, authorization) => {
      requireCommandName(command, UPDATE_CONTRACT_COMMAND);
      const payload = parseUpdateContractPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateContract(command, authorization, {
        contractId: payload.value.contractId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: CONTRACT_KIND,
        resourceId: payload.value.contractId,
        step: (loaded, now, context) => {
          const next = updateContractState(loaded, payload.value.changes, now, context);
          if (!next.ok) return next;
          return ok({
            next: next.value,
            eventName: CONTRACT_UPDATED_EVENT,
            entityRefs: {
              before: { entityKind: CONTRACT_KIND, entityId: loaded.entityId },
              after: { entityKind: CONTRACT_KIND, entityId: next.value.entityId },
            },
            payload: {
              contractId: next.value.entityId,
              title: next.value.title,
              executionStatus: next.value.executionStatus,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
        },
      });
    },

    archiveContract: async (command, authorization) => {
      requireCommandName(command, ARCHIVE_CONTRACT_COMMAND);
      const payload = parseArchiveContractPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateContract(command, authorization, {
        contractId: payload.value.contractId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: CONTRACT_KIND,
        resourceId: payload.value.contractId,
        step: (loaded, now, context) => {
          const next = archiveContractState(loaded, now, context);
          if (!next.ok) return next;
          return ok({
            next: next.value,
            eventName: CONTRACT_ARCHIVED_EVENT,
            entityRefs: {
              before: { entityKind: CONTRACT_KIND, entityId: loaded.entityId },
              after: { entityKind: CONTRACT_KIND, entityId: next.value.entityId },
            },
            payload: {
              contractId: next.value.entityId,
              lifecycleStatus: next.value.lifecycleStatus,
              archivedAt: next.value.archivedAt ?? now,
              version: next.value.version,
              updatedAt: next.value.updatedAt,
            },
          });
        },
      });
    },

    recordScopeObligation: async (command, authorization) => {
      requireCommandName(command, RECORD_SCOPE_OBLIGATION_COMMAND);
      const payload = parseRecordScopeObligationPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      return mutateContract(command, authorization, {
        contractId: payload.value.contractId,
        expectedVersion: payload.value.expectedVersion,
        resourceKind: SCOPE_OBLIGATION_KIND,
        resourceId: null,
        step: (loaded, now, context) => {
          const obligationId = newEntityId();
          const next = recordObligationState(
            loaded,
            {
              obligationId,
              code: payload.value.code,
              description: payload.value.description,
              quantity: payload.value.quantity,
              unit: payload.value.unit,
              now,
            },
            context,
          );
          if (!next.ok) return next;
          const obligation = next.value.obligations[obligationId];
          if (obligation === undefined) {
            throw new TypeError(
              `recorded obligation ${obligationId} is missing from the next state`,
            );
          }
          return ok({
            next: next.value,
            eventName: OBLIGATION_RECORDED_EVENT,
            entityRefs: {
              before: null,
              after: { entityKind: SCOPE_OBLIGATION_KIND, entityId: obligationId },
            },
            payload: {
              contractId: next.value.entityId,
              obligationId,
              code: obligation.code,
              quantity: obligation.quantity,
              unit: obligation.unit,
              version: next.value.version,
            },
          });
        },
      });
    },

    raiseChangeEvent: async (command, authorization) => {
      requireCommandName(command, RAISE_CHANGE_EVENT_COMMAND);
      const payload = parseRaiseChangeEventPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      // Kind-level create authority (A12 structural isolation + the caller's
      // policy decide; a denied command never opens a transaction).
      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_EVENT_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeEventState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const contract = await tx.loadContract(command.scope, payload.value.contractId);
          if (!contract.ok) return tx.rollback(contract);

          const coverage = checkScopeCovers(command.scope, contract.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);
          if (contract.value.lifecycleStatus === 'archived') {
            return tx.rollback(
              fail(
                domainError(
                  'invariant-violation',
                  `contract ${contract.value.entityId} is archived: change events can no longer be raised against it`,
                  [
                    {
                      code: 'contract-archive-is-terminal',
                      message: 'the contract is archived',
                      path: 'contractId',
                    },
                  ],
                  context,
                ),
              ),
            );
          }

          // The cross-entity link gate: obligation links validated against
          // THIS package's contract; evidence/cost/schedule links are typed
          // ids accepted as-is (referential wiring is the app layer's job).
          const links: ChangeEventLinks = {
            affectedObligationIds: payload.value.affectedObligationIds,
            evidenceLinks: payload.value.evidenceLinks,
            costImpactLinks: payload.value.costImpactLinks,
            scheduleImpactActivityIds: payload.value.scheduleImpactActivityIds,
          };
          const changeEventId = newEntityId();
          const obligationGate = validateObligationLinks(
            contract.value,
            changeEventId,
            payload.value.affectedObligationIds ?? [],
            context,
          );
          if (!obligationGate.ok) return tx.rollback(obligationGate);

          const initial = createChangeEventState(
            {
              changeEventId,
              title: payload.value.title,
              changeType: payload.value.changeType,
              links,
              now,
            },
            contract.value.scope,
            contract.value.entityId,
            context,
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertChangeEvent(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_EVENT_RAISED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: {
              before: null,
              after: { entityKind: CHANGE_EVENT_KIND, entityId: inserted.value.entityId },
            },
            payload: {
              contractId: inserted.value.contractId,
              changeEventId: inserted.value.entityId,
              title: inserted.value.title,
              changeType: inserted.value.changeType,
              status: inserted.value.status,
              affectedObligationIds: inserted.value.affectedObligationIds,
              evidenceLinks: inserted.value.evidenceLinks,
              costImpactLinks: inserted.value.costImpactLinks,
              scheduleImpactActivityIds: inserted.value.scheduleImpactActivityIds,
              version: inserted.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    linkChangeReferences: async (command, authorization) => {
      requireCommandName(command, LINK_CHANGE_REFERENCES_COMMAND);
      const payload = parseLinkChangeReferencesPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_EVENT_KIND, payload.value.changeEventId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: CHANGE_EVENT_KIND,
        entityId: payload.value.changeEventId,
        version: payload.value.expectedVersion,
      };

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeEventState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadChangeEvent(command.scope, payload.value.changeEventId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          // The appended obligation links are validated against the owning
          // contract of THIS package (archived contracts freeze linking too).
          const contract = await tx.loadContract(command.scope, loaded.value.contractId);
          if (!contract.ok) return tx.rollback(contract);
          const contractCoverage = checkScopeCovers(
            command.scope,
            contract.value.scope,
            context,
          );
          if (!contractCoverage.ok) return tx.rollback(contractCoverage);
          if (contract.value.lifecycleStatus === 'archived') {
            return tx.rollback(
              fail(
                domainError(
                  'invariant-violation',
                  `contract ${contract.value.entityId} is archived: its change events' link sets are frozen`,
                  [
                    {
                      code: 'contract-archive-is-terminal',
                      message: 'the contract is archived',
                      path: 'contractId',
                    },
                  ],
                  context,
                ),
              ),
            );
          }
          const obligationGate = validateObligationLinks(
            contract.value,
            loaded.value.entityId,
            payload.value.affectedObligationIds ?? [],
            context,
          );
          if (!obligationGate.ok) return tx.rollback(obligationGate);

          const next = linkChangeReferencesState(
            loaded.value,
            {
              affectedObligationIds: payload.value.affectedObligationIds,
              evidenceLinks: payload.value.evidenceLinks,
              costImpactLinks: payload.value.costImpactLinks,
              scheduleImpactActivityIds: payload.value.scheduleImpactActivityIds,
            },
            now,
            context,
          );
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveChangeEvent(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!saved.ok) return tx.rollback(saved);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_EVENT_LINKED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: {
              before: { entityKind: CHANGE_EVENT_KIND, entityId: loaded.value.entityId },
              after: { entityKind: CHANGE_EVENT_KIND, entityId: saved.value.entityId },
            },
            payload: {
              contractId: saved.value.contractId,
              changeEventId: saved.value.entityId,
              addedObligationIds: payload.value.affectedObligationIds ?? [],
              addedEvidenceLinks: payload.value.evidenceLinks ?? [],
              addedCostImpactLinks: payload.value.costImpactLinks ?? [],
              addedActivityIds: payload.value.scheduleImpactActivityIds ?? [],
              version: saved.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    submitChangeOrder: async (command, authorization) => {
      requireCommandName(command, SUBMIT_CHANGE_ORDER_COMMAND);
      const payload = parseSubmitChangeOrderPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_ORDER_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeOrderState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const changeEvent = await tx.loadChangeEvent(
            command.scope,
            payload.value.changeEventId,
          );
          if (!changeEvent.ok) return tx.rollback(changeEvent);

          const coverage = checkScopeCovers(command.scope, changeEvent.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);
          if (changeEvent.value.status === 'superseded') {
            return tx.rollback(
              fail(
                domainError(
                  'invariant-violation',
                  `change event ${changeEvent.value.entityId} is already superseded: its proposed state is gone, and no change order can originate from it`,
                  [
                    {
                      code: 'change-event-superseded',
                      message: 'the originating change event is superseded',
                      path: 'changeEventId',
                    },
                  ],
                  context,
                ),
              ),
            );
          }

          const contract = await tx.loadContract(command.scope, changeEvent.value.contractId);
          if (!contract.ok) return tx.rollback(contract);
          const contractCoverage = checkScopeCovers(
            command.scope,
            contract.value.scope,
            context,
          );
          if (!contractCoverage.ok) return tx.rollback(contractCoverage);
          if (contract.value.lifecycleStatus === 'archived') {
            return tx.rollback(
              fail(
                domainError(
                  'invariant-violation',
                  `contract ${contract.value.entityId} is archived: change orders can no longer be submitted against it`,
                  [
                    {
                      code: 'contract-archive-is-terminal',
                      message: 'the contract is archived',
                      path: 'changeEventId',
                    },
                  ],
                  context,
                ),
              ),
            );
          }

          const changeOrderId = newEntityId();
          const initial = createChangeOrderState(
            {
              changeOrderId,
              title: payload.value.title,
              changeValue: payload.value.changeValue,
              now,
            },
            contract.value.scope,
            contract.value.entityId,
            changeEvent.value.entityId,
            context,
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertChangeOrder(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_ORDER_SUBMITTED_EVENT,
            scope: inserted.value.scope,
            occurredAt: now,
            entityRefs: {
              before: null,
              after: { entityKind: CHANGE_ORDER_KIND, entityId: inserted.value.entityId },
            },
            payload: {
              contractId: inserted.value.contractId,
              changeOrderId: inserted.value.entityId,
              changeEventId: inserted.value.changeEventId,
              title: inserted.value.title,
              changeValue: inserted.value.changeValue,
              status: inserted.value.status,
              version: inserted.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(inserted.value);
        },
      );
    },

    approveChangeOrder: async (command, authorization) => {
      requireCommandName(command, APPROVE_CHANGE_ORDER_COMMAND);
      const payload = parseApproveChangeOrderPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_ORDER_KIND, payload.value.changeOrderId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: CHANGE_ORDER_KIND,
        entityId: payload.value.changeOrderId,
        version: payload.value.expectedVersion,
      };

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeOrderState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadChangeOrder(command.scope, payload.value.changeOrderId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const next = approveChangeOrderState(loaded.value, payload.value.reason ?? null, now, context);
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveChangeOrder(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!saved.ok) return tx.rollback(saved);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_ORDER_APPROVED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: {
              before: { entityKind: CHANGE_ORDER_KIND, entityId: loaded.value.entityId },
              after: { entityKind: CHANGE_ORDER_KIND, entityId: saved.value.entityId },
            },
            payload: {
              contractId: saved.value.contractId,
              changeOrderId: saved.value.entityId,
              status: saved.value.status,
              decidedAt: saved.value.decidedAt ?? now,
              version: saved.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    rejectChangeOrder: async (command, authorization) => {
      requireCommandName(command, REJECT_CHANGE_ORDER_COMMAND);
      const payload = parseRejectChangeOrderPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_ORDER_KIND, payload.value.changeOrderId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: CHANGE_ORDER_KIND,
        entityId: payload.value.changeOrderId,
        version: payload.value.expectedVersion,
      };

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeOrderState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadChangeOrder(command.scope, payload.value.changeOrderId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const next = rejectChangeOrderState(loaded.value, payload.value.reason ?? null, now, context);
          if (!next.ok) return tx.rollback(next);

          const saved = await tx.saveChangeOrder(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!saved.ok) return tx.rollback(saved);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_ORDER_REJECTED_EVENT,
            scope: saved.value.scope,
            occurredAt: now,
            entityRefs: {
              before: { entityKind: CHANGE_ORDER_KIND, entityId: loaded.value.entityId },
              after: { entityKind: CHANGE_ORDER_KIND, entityId: saved.value.entityId },
            },
            payload: {
              contractId: saved.value.contractId,
              changeOrderId: saved.value.entityId,
              status: saved.value.status,
              decidedAt: saved.value.decidedAt ?? now,
              version: saved.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(saved.value);
        },
      );
    },

    executeChangeOrder: async (command, authorization) => {
      requireCommandName(command, EXECUTE_CHANGE_ORDER_COMMAND);
      const payload = parseExecuteChangeOrderPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CHANGE_ORDER_KIND, payload.value.changeOrderId),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      const expected: ConcurrencyToken = {
        kind: 'concurrency-token',
        entityKind: CHANGE_ORDER_KIND,
        entityId: payload.value.changeOrderId,
        version: payload.value.expectedVersion,
      };

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ChangeOrderState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          const loaded = await tx.loadChangeOrder(command.scope, payload.value.changeOrderId);
          if (!loaded.ok) return tx.rollback(loaded);

          const coverage = checkScopeCovers(command.scope, loaded.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);

          const concurrency = checkConcurrency(
            expected,
            concurrencyTokenOf(loaded.value),
            context,
          );
          if (!concurrency.ok) return tx.rollback(concurrency);

          const next = executeChangeOrderState(loaded.value, now, context);
          if (!next.ok) return tx.rollback(next);

          // THE supersession: executing the approved order supersedes the
          // originating change event's proposed state, inside the SAME unit
          // of work — both writes and the audit event commit atomically.
          const changeEvent = await tx.loadChangeEvent(command.scope, loaded.value.changeEventId);
          if (!changeEvent.ok) return tx.rollback(changeEvent);
          const superseded = supersedeChangeEventState(
            changeEvent.value,
            loaded.value.entityId,
            now,
            context,
          );
          if (!superseded.ok) return tx.rollback(superseded);

          const savedOrder = await tx.saveChangeOrder(
            command.scope,
            next.value,
            payload.value.expectedVersion,
          );
          if (!savedOrder.ok) return tx.rollback(savedOrder);
          const savedEvent = await tx.saveChangeEvent(
            command.scope,
            superseded.value,
            changeEvent.value.version,
          );
          if (!savedEvent.ok) return tx.rollback(savedEvent);

          const event = contractsEventEnvelope({
            command,
            eventName: CHANGE_ORDER_EXECUTED_EVENT,
            scope: savedOrder.value.scope,
            occurredAt: now,
            entityRefs: {
              before: { entityKind: CHANGE_ORDER_KIND, entityId: loaded.value.entityId },
              after: { entityKind: CHANGE_ORDER_KIND, entityId: savedOrder.value.entityId },
            },
            payload: {
              contractId: savedOrder.value.contractId,
              changeOrderId: savedOrder.value.entityId,
              changeEventId: savedEvent.value.entityId,
              status: savedOrder.value.status,
              changeEventStatus: savedEvent.value.status,
              changeEventVersion: savedEvent.value.version,
              executedAt: savedOrder.value.executedAt ?? now,
              version: savedOrder.value.version,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(savedOrder.value);
        },
      );
    },

    referenceClaim: async (command, authorization) => {
      requireCommandName(command, REFERENCE_CLAIM_COMMAND);
      const payload = parseReferenceClaimPayload(command.payload);
      if (!payload.ok) return { ok: false, error: invalidPayload(payload.error, command) };

      const decision = authorize(
        authorization.policy,
        contextOf(command, authorization),
        resourceOf(command, CLAIM_REFERENCE_KIND, null),
        'write',
        errorContextOf(command),
      );
      if (!decision.ok) return decision;

      return deps.store.runInTransaction(
        async (tx: ContractsStoreTransaction): Promise<CommandResult<ClaimReferenceState>> => {
          const now = deps.now();
          const context = errorContextOf(command);

          // The claim reference binds an EXECUTED change order of the owning
          // contract: entitlement evidence points at change that actually
          // took effect. A submitted/rejected order is a typed
          // invariant-violation.
          const changeOrder = await tx.loadChangeOrder(command.scope, payload.value.changeOrderId);
          if (!changeOrder.ok) return tx.rollback(changeOrder);

          const coverage = checkScopeCovers(command.scope, changeOrder.value.scope, context);
          if (!coverage.ok) return tx.rollback(coverage);
          if (changeOrder.value.status !== 'executed') {
            return tx.rollback(
              fail(
                domainError(
                  'invariant-violation',
                  `change order ${changeOrder.value.entityId} is '${changeOrder.value.status}', not executed: claim references bind claims to EXECUTED change orders only`,
                  [
                    {
                      code: 'claim-reference-requires-executed-change-order',
                      message: `change order status is '${changeOrder.value.status}'`,
                      path: 'changeOrderId',
                    },
                  ],
                  context,
                ),
              ),
            );
          }

          const claimReferenceId = newEntityId();
          const initial = createClaimReferenceState(
            {
              claimReferenceId,
              claimEntityKind: payload.value.claimEntityKind,
              claimEntityId: payload.value.claimEntityId,
              changeOrderId: payload.value.changeOrderId,
              documentId: payload.value.documentId,
              revisionId: payload.value.revisionId,
              now,
            },
            changeOrder.value.scope,
            changeOrder.value.contractId,
            context,
          );
          if (!initial.ok) return tx.rollback(initial);

          const inserted = await tx.insertClaimReference(command.scope, initial.value);
          if (!inserted.ok) return tx.rollback(inserted);

          const event = contractsEventEnvelope({
            command,
            eventName: CLAIM_REFERENCED_EVENT,
            scope: initial.value.scope,
            occurredAt: now,
            entityRefs: {
              before: null,
              after: { entityKind: CLAIM_REFERENCE_KIND, entityId: initial.value.entityId },
            },
            payload: {
              contractId: initial.value.contractId,
              claimReferenceId: initial.value.entityId,
              claimEntityKind: initial.value.claimEntityKind,
              claimEntityId: initial.value.claimEntityId,
              changeOrderId: initial.value.changeOrderId,
              documentId: initial.value.documentId,
              revisionId: initial.value.revisionId,
            },
          });
          const appended = await deps.eventSink.appendEvents(tx, [event]);
          if (!appended.ok) return tx.rollback(appended);

          return ok(initial.value);
        },
      );
    },
  };
}
