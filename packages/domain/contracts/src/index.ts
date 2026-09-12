// Office contracts/change domain — public surface (OFF-012).
//
// src/index.ts is the package's WHOLE public surface: later Office modules
// (OFF-013 relationships, OFF-014 margin/impact, OFF-016 workflows,
// OFF-021/023 adapters) consume the package only through its root entry
// point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice.
//
// The package is PURE DOMAIN: aggregates, commands, and ports only — no SQL,
// no migrations, no repository layer. It imports exactly five workspace
// dependencies — @office/contracts (envelopes + canonical ids),
// @office/domain-kernel (Result/DomainError, aggregate versioning +
// concurrency, invariants), @office/authz (the deny-by-default authorize()
// evaluator), @office/persistence (the SqlExecutor TYPE of the EventSink port
// only), and @office/events (IN this item's dependency graph for the thin
// ledger-backed EventSink adapter) — plus node builtins. No external
// dependencies. It NEVER imports another domain package: cross-entity
// references are typed EntityId/EntityRef links (the dependency rule).
//
// Surface summary:
// - state:       ContractState, ContractExecutionStatus, ContractLifecycleStatus,
//                CONTRACT_EXECUTION/LIFECYCLE_STATUSES, CONTRACT_KIND,
//                CONTRACT_INVARIANTS, NewContract, ContractChanges,
//                ScopeObligationState, SCOPE_OBLIGATION_KIND, NewScopeObligation,
//                ChangeEventState, ChangeType, CHANGE_TYPES, ChangeEventStatus,
//                CHANGE_EVENT_STATUSES, CHANGE_EVENT_KIND,
//                CHANGE_EVENT_INVARIANTS, NewChangeEvent, ChangeEventLinks,
//                ChangeOrderState, ChangeOrderStatus, CHANGE_ORDER_STATUSES,
//                CHANGE_ORDER_KIND, CHANGE_ORDER_INVARIANTS, NewChangeOrder,
//                ClaimReferenceState, CLAIM_REFERENCE_KIND,
//                CLAIM_REFERENCE_INVARIANTS, NewClaimReference,
//                create/update/archiveContractState, recordObligationState,
//                createChangeEventState, linkChangeReferencesState,
//                replaceChangeLinksState, removeChangeLinksState (always-failing
//                immutability guards), supersedeChangeEventState,
//                create/approve/reject/executeChangeOrderState,
//                createClaimReferenceState
// - value objs:  Money, MinorUnits, CurrencyCode, QuantityValue, PartyLink,
//                PartyKind, EvidenceLink, CostImpactLink (+ grammars and
//                fail-closed parse/is helpers)
// - events:      EventSink, InMemoryEventSink, RecordedEventAppend,
//                createInMemoryEventSink, failingEventSink, eventSinkFailure,
//                CONTRACT_CREATED/UPDATED/ARCHIVED_EVENT,
//                OBLIGATION_RECORDED_EVENT, CHANGE_EVENT_RAISED/LINKED_EVENT,
//                CHANGE_ORDER_SUBMITTED/APPROVED/REJECTED/EXECUTED_EVENT,
//                CLAIM_REFERENCED_EVENT, contractsEventEnvelope, contractRef,
//                obligationRef, changeEventRef, changeOrderRef,
//                claimReferenceRef (+ payload types)
// - store:       ContractsStore, ContractsStoreTransaction,
//                InMemoryContractsStore, createInMemoryContractsStore
// - ledger-sink: createLedgerEventSink (the thin @office/events adapter)
// - commands:    ContractsCommands, createContractsCommands,
//                ContractsCommandDeps, ContractsCommandAuthorization,
//                CREATE/UPDATE/ARCHIVE_CONTRACT_COMMAND,
//                RECORD_SCOPE_OBLIGATION_COMMAND, RAISE_CHANGE_EVENT_COMMAND,
//                LINK_CHANGE_REFERENCES_COMMAND,
//                SUBMIT/APPROVE/REJECT/EXECUTE_CHANGE_ORDER_COMMAND,
//                REFERENCE_CLAIM_COMMAND (+ payload types and their
//                fail-closed parsers)

// Aggregate states, invariants, and pure lifecycle/change transitions.
export {
  CHANGE_EVENT_INVARIANTS,
  CHANGE_EVENT_KIND,
  CHANGE_EVENT_STATUSES,
  CHANGE_ORDER_INVARIANTS,
  CHANGE_ORDER_KIND,
  CHANGE_ORDER_STATUSES,
  CHANGE_TYPES,
  CLAIM_REFERENCE_INVARIANTS,
  CLAIM_REFERENCE_KIND,
  CONTRACT_EXECUTION_STATUSES,
  CONTRACT_INVARIANTS,
  CONTRACT_KIND,
  CONTRACT_LIFECYCLE_STATUSES,
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
  removeChangeLinksState,
  replaceChangeLinksState,
  supersedeChangeEventState,
  updateContractState,
} from './state';
export type {
  ChangeEventLinks,
  ChangeEventState,
  ChangeEventStatus,
  ChangeOrderState,
  ChangeOrderStatus,
  ChangeType,
  ClaimReferenceState,
  ContractChanges,
  ContractExecutionStatus,
  ContractLifecycleStatus,
  ContractState,
  NewChangeEvent,
  NewChangeOrder,
  NewClaimReference,
  NewContract,
  NewScopeObligation,
  ScopeObligationState,
} from './state';

// The typed value objects of the commercial model (money in minor units,
// canonical decimal quantities, and the typed cross-entity link shapes).
export {
  COST_IMPACT_LINK_GRAMMAR,
  CURRENCY_CODE_GRAMMAR,
  EVIDENCE_LINK_GRAMMAR,
  MINOR_UNITS_GRAMMAR,
  MONEY_GRAMMAR,
  PARTY_KINDS,
  PARTY_LINK_GRAMMAR,
  QUANTITY_VALUE_GRAMMAR,
  parseCostImpactLink,
  parseCurrencyCode,
  parseEvidenceLink,
  parseMinorUnits,
  parseMoney,
  parsePartyKind,
  parsePartyLink,
  parseQuantityValue,
} from './parse';
export type {
  CostImpactLink,
  CurrencyCode,
  EvidenceLink,
  Money,
  MinorUnits,
  PartyKind,
  PartyLink,
  QuantityValue,
} from './parse';

// Audit events + the EventSink port (mirrored byte-for-byte from the
// OFF-007 identity modules).
export {
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
  changeEventRef,
  changeOrderRef,
  claimReferenceRef,
  contractRef,
  contractsEventEnvelope,
  createInMemoryEventSink,
  eventSinkFailure,
  failingEventSink,
  obligationRef,
} from './events';
export type {
  ChangeEventLinkedPayload,
  ChangeEventRaisedPayload,
  ChangeOrderApprovedPayload,
  ChangeOrderExecutedPayload,
  ChangeOrderRejectedPayload,
  ChangeOrderSubmittedPayload,
  ClaimReferencedPayload,
  ContractArchivedPayload,
  ContractCreatedPayload,
  ContractUpdatedPayload,
  ContractsEventPayload,
  ContractsEventPayloads,
  EventSink,
  InMemoryEventSink,
  ObligationRecordedPayload,
  RecordedEventAppend,
} from './events';

// The transactional store port + the deterministic in-memory store.
export { createInMemoryContractsStore } from './store';
export type {
  ContractsStore,
  ContractsStoreTransaction,
  InMemoryContractsStore,
} from './store';

// The thin ledger-backed EventSink adapter over @office/events.
export { createLedgerEventSink } from './ledger-sink';

// The mutation command surface + fail-closed payload parsers.
export {
  APPROVE_CHANGE_ORDER_COMMAND,
  ARCHIVE_CONTRACT_COMMAND,
  CREATE_CONTRACT_COMMAND,
  EXECUTE_CHANGE_ORDER_COMMAND,
  LINK_CHANGE_REFERENCES_COMMAND,
  RAISE_CHANGE_EVENT_COMMAND,
  RECORD_SCOPE_OBLIGATION_COMMAND,
  REFERENCE_CLAIM_COMMAND,
  REJECT_CHANGE_ORDER_COMMAND,
  SUBMIT_CHANGE_ORDER_COMMAND,
  UPDATE_CONTRACT_COMMAND,
  createContractsCommands,
  parseApproveChangeOrderPayload,
  parseArchiveContractPayload,
  parseCreateContractPayload,
  parseExecuteChangeOrderPayload,
  parseLinkChangeReferencesPayload,
  parseRaiseChangeEventPayload,
  parseRecordScopeObligationPayload,
  parseReferenceClaimPayload,
  parseRejectChangeOrderPayload,
  parseSubmitChangeOrderPayload,
  parseUpdateContractPayload,
} from './commands';
export type {
  ApproveChangeOrderPayload,
  ArchiveContractPayload,
  ContractsCommandAuthorization,
  ContractsCommandDeps,
  ContractsCommands,
  CreateContractPayload,
  ExecuteChangeOrderPayload,
  LinkChangeReferencesPayload,
  RaiseChangeEventPayload,
  RecordScopeObligationPayload,
  ReferenceClaimPayload,
  RejectChangeOrderPayload,
  SubmitChangeOrderPayload,
  UpdateContractPayload,
} from './commands';
