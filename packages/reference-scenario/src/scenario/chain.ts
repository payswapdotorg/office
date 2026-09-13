// Office reference-scenario — THE golden chain driver (OFF-037).
//
// runReferenceScenario(world parts, rig parts) composes THE deterministic
// end-to-end construction chain over the seeded world (world.ts) and the
// four-adapter fixture rig (adapters.ts):
//
//   1. MODEL INGRESS   the model adapter delivers the wall-element mutation
//                      (second sync pass → exactly ONE models.recordElementChange
//                      proposal) → the host executes it through the adapter
//                      package's OWN host-side execution seam (elementChangedEnvelope
//                      over the mapping-resolved canonical identities) → the
//                      `models.elementChanged` ledger event.
//   2. COST IMPACT     the quantity change → a cost item recorded through
//                      domain-cost's TYPED command path (the world's cost
//                      service), caused by the model event.
//   3. SCHEDULE        the schedule adapter delivers the activity update
//                      (second sync pass → exactly ONE schedule.updateActivity
//                      proposal) → translated through the host-side execution
//                      seam (provider refs resolved into canonical ids over the
//                      re-bound mapping graph) → executed through the world's
//                      schedule service → the schedule impact recorded.
//   4. EVIDENCE        the change-evidence packet assembled under @office/agents'
//                      EvidenceSet discipline, citing the causal command + event
//                      ids of steps 1-3 (+ the construction adapter's canonical
//                      change-event/document identities).
//   5. APPROVAL        a definition/instance/approval routed through
//                      @office/workflows' in-memory store + instance machine —
//                      submitted and DECIDED (approved), the decision note citing
//                      the evidence packet's reference tokens.
//   6. EXECUTION       the approved change applied through the canonical command
//                      services (cost.amendCommitment) → the ledger + every
//                      projection reflects it.
//   7. OBSERVERS       the revenue + procurement detection surfaces run over
//                      typed input records built FROM the post-execution world
//                      state (the real budget/commitment states + one margin
//                      ImpactAssessment citing the chain's own ledger events);
//                      their evidence chains resolve into the scenario's records.
//
// replayNotifications(run) re-delivers the SAME adapter notifications (every
// rig driver re-run) and proves ZERO new canonical records. causalWalk(run)
// walks event → command → aggregate → projection → evidence collecting the
// causal ids at every hop. Same parts → byte-identical world + ledger.
import { authorizationContext, capability, definePolicy } from '@office/authz';
import type { Capability, Policy } from '@office/authz';
import { formatEntityId, parseEntityId, parseEntityRef } from '@office/contracts';
import type { Actor, CommandEnvelope, EntityId, EntityRef, Scope, Timestamp } from '@office/contracts';
import { parseAggregateVersion } from '@office/domain-kernel';
import type { Result } from '@office/domain-kernel';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import { evidenceSet, qualifyEvidenceSet } from '@office/agents';
import type { EvidenceItem, EvidenceSet } from '@office/agents';
import {
  ELEMENT_OBJECT_KIND,
  LINKED_ACTIVITY_REF,
  LINKED_DOCUMENT_REF,
  MODEL_ADAPTER_KIND,
  MODEL_OBJECT_KIND,
  MODEL_SYSTEM_ID,
  MODEL_VERSION_OBJECT_KIND,
  TOWER_MODEL_ID,
  TOWER_MODEL_V2_ID,
  WALL_ELEMENT_ID,
  elementChangedEnvelope,
  parseElementClassification,
  parseElementQuantity,
} from '@office/adapter-model';
import {
  ACTIVITY_DEPENDENCY_OBJECT_KIND,
  ACTIVITY_OBJECT_KIND,
  BASELINE_OBJECT_KIND,
  PROJECT_SCHEDULE_OBJECT_KIND,
  SCHEDULE_ADAPTER_KIND,
  SCHEDULE_SYSTEM_ID,
  STRUCTURE_ACTIVITY_ID,
  TOWER_SCHEDULE_ID,
  parseActivityProviderData,
} from '@office/adapter-schedule';
import {
  CHANGE_EVENT_OBJECT_KIND,
  CONSTRUCTION_ADAPTER_KIND,
  CONSTRUCTION_SYSTEM_ID,
  DOCUMENT_OBJECT_KIND,
} from '@office/adapter-construction';
import { AMEND_COMMITMENT_COMMAND, RECORD_COST_ITEM_COMMAND } from '@office/domain-cost';
import type { BudgetState, CommitmentState } from '@office/domain-cost';
import {
  ADD_ACTIVITY_COMMAND,
  ADD_DEPENDENCY_COMMAND,
  CREATE_SCHEDULE_COMMAND,
  SET_BASELINE_COMMAND,
  UPDATE_ACTIVITY_COMMAND,
} from '@office/domain-schedule';
import type { ScheduleState } from '@office/domain-schedule';
import {
  APPROVE_APPROVAL_COMMAND,
  CREATE_DEFINITION_COMMAND,
  EXECUTE_TRANSITION_COMMAND,
  PUBLISH_DEFINITION_COMMAND,
  START_INSTANCE_COMMAND,
  SUBMIT_APPROVAL_COMMAND,
} from '@office/workflows';
import { detectProcurementRecommendations } from '@office/intelligence-procurement';
import type {
  ProcurementAlternative,
  ProcurementAuthorization,
  ProcurementRecommendation,
  ProcurementScanInputs,
} from '@office/intelligence-procurement';
import { detectRecoveryCandidates } from '@office/intelligence-revenue';
import type {
  CandidateRecovery,
  RecoveryAuthorization,
  RecoveryScanInputs,
} from '@office/intelligence-revenue';
import type { AdapterProposal, AdapterRig, CoordinateKey } from './adapters';
import { createAdapterRig } from './adapters';
import type { SeededWorld } from './world';
import { seedWorld } from './world';

// ---------------------------------------------------------------------------
// The scenario parts + the typed run record.
// ---------------------------------------------------------------------------

/** The injected deterministic parts of one reference-scenario run. */
export interface ReferenceScenarioParts {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly adapterActorId: string;
  /** Injected clock — the canonical 'now' of every command (never wall time). */
  readonly now: () => Timestamp;
  /** Injected canonical-id opaque part supplier. */
  readonly newOpaqueId: () => string;
}

/** One provider application observed by a sync pass (the notification). */
export interface ObservedApplication {
  /** The stream's object kind (the provider family's own token). */
  readonly objectKind: string;
  /** The provider object id the snapshot observed. */
  readonly objectId: string;
  /** The provider object version the snapshot observed. */
  readonly providerVersion: string;
  /** The canonical command the translator proposed for it (or null). */
  readonly command: CommandEnvelope<unknown> | null;
}

/** The executed command + ledger event of one chain step. */
export interface ChainCommandRecord {
  readonly commandName: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly eventId: LedgerEventId;
  readonly eventName: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The model-ingress step of the chain. */
export interface ModelIngressStep {
  readonly firstPassProposals: readonly AdapterProposal[];
  readonly mutation: {
    readonly elementId: string;
    readonly quantityBefore: number;
    readonly quantityAfter: number;
    readonly unit: string;
  };
  readonly secondPassProposals: readonly AdapterProposal[];
  readonly proposal: CommandEnvelope<unknown>;
  readonly element: EntityRef;
  readonly model: EntityRef;
  readonly modelVersion: EntityRef;
  readonly affectedEntityRefs: readonly EntityRef[];
  readonly event: LedgerEvent;
}

/** The cost-impact step of the chain. */
export interface CostImpactStep {
  readonly budgetId: EntityId;
  readonly costItemId: EntityId;
  readonly quantityMilliDelta: number;
  readonly amountMinorDelta: number;
  readonly command: ChainCommandRecord;
}

/** The schedule-ingress step of the chain. */
export interface ScheduleIngressStep {
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly activityCode: string;
  readonly durationBefore: number;
  readonly durationAfter: number;
  readonly command: ChainCommandRecord;
}

/** The change-evidence step of the chain (the agents EvidenceSet packet). */
export interface EvidenceStep {
  readonly packet: EvidenceSet;
  readonly references: readonly string[];
  readonly citedEventIds: readonly LedgerEventId[];
  readonly citedEntityIds: readonly EntityId[];
  readonly qualified: boolean;
}

/** The approval step of the chain (the workflows instance machine). */
export interface ApprovalStep {
  readonly definitionId: EntityId;
  readonly instanceId: EntityId;
  readonly approvalKey: string;
  readonly subject: EntityRef;
  readonly submitted: ChainCommandRecord;
  readonly decided: ChainCommandRecord;
  readonly note: string;
}

/** The execution step of the chain (the approved change applied). */
export interface ExecutionStep {
  readonly commitmentId: EntityId;
  readonly committedBeforeMinor: number;
  readonly committedAfterMinor: number;
  readonly command: ChainCommandRecord;
}

/** The observer step of the chain (the two detection surfaces). */
export interface ObserverStep {
  readonly procurement: {
    readonly inputBudgetIds: readonly EntityId[];
    readonly inputCommitmentIds: readonly EntityId[];
    readonly recommendations: readonly ProcurementRecommendation[];
  };
  readonly revenue: {
    readonly inputChangeEventId: EntityId;
    readonly inputChangeOrderId: EntityId;
    readonly candidates: readonly CandidateRecovery[];
  };
}

/** THE deterministic end-to-end reference-scenario run record. */
export interface ScenarioRun {
  readonly kind: 'reference-scenario-run';
  readonly world: SeededWorld;
  readonly rig: AdapterRig;
  readonly parts: ReferenceScenarioParts;
  readonly financeIngress: {
    readonly proposals: readonly AdapterProposal[];
    readonly commands: readonly ChainCommandRecord[];
  };
  readonly scheduleBaseline: {
    readonly proposals: readonly AdapterProposal[];
    readonly commands: readonly ChainCommandRecord[];
    readonly schedule: ScheduleState;
  };
  readonly constructionIngress: {
    readonly proposals: readonly AdapterProposal[];
    readonly changeEvent: EntityRef;
    readonly document: EntityRef;
  };
  readonly modelIngress: ModelIngressStep;
  readonly costImpact: CostImpactStep;
  readonly scheduleIngress: ScheduleIngressStep;
  readonly evidence: EvidenceStep;
  readonly approval: ApprovalStep;
  readonly execution: ExecutionStep;
  readonly observers: ObserverStep;
}

// ---------------------------------------------------------------------------
// Trusted-path helpers (seed wiring errors are loud, never silent).
// ---------------------------------------------------------------------------

const unwrap = <T, E>(result: Result<T, E>, what: string): T => {
  if (result.ok) return result.value;
  throw new TypeError(`reference-scenario wiring error (${what}): ${JSON.stringify(result)}`);
};

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new TypeError(`reference-scenario wiring error: missing ${what}`);
  }
  return value;
};

const refOf = (canonical: { readonly entityKind: string; readonly entityId: string }): EntityRef =>
  unwrap(parseEntityRef({ entityKind: canonical.entityKind, entityId: canonical.entityId }), 'entity ref');

const commandRecordOf = (
  command: CommandEnvelope<unknown>,
  event: LedgerEvent,
): ChainCommandRecord => {
  const after = must(event.envelope.entityRefs.after, 'event after-ref');
  return {
    commandName: command.commandName,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.causality.correlationId,
    causationId: command.causality.causationId,
    eventId: event.eventId,
    eventName: event.envelope.eventName,
    aggregateKind: after.entityKind,
    aggregateId: after.entityId,
  };
};

/** Walk one sync outcome's streams into (objectKind, objectId, command) observations. */
const applicationsOf = (
  outcome: {
    readonly streams?: readonly {
      readonly objectKind?: unknown;
      readonly applications?: readonly {
        readonly snapshot?: {
          readonly source?: { readonly objectId?: unknown; readonly version?: unknown };
        };
        readonly command?: unknown;
      }[];
    }[];
  },
): readonly ObservedApplication[] => {
  const observed: ObservedApplication[] = [];
  for (const stream of outcome.streams ?? []) {
    for (const application of stream.applications ?? []) {
      const objectId = application.snapshot?.source?.objectId;
      const providerVersion = application.snapshot?.source?.version;
      if (typeof objectId !== 'string' || typeof providerVersion !== 'string') continue;
      const command = application.command;
      observed.push({
        objectKind: typeof stream.objectKind === 'string' ? stream.objectKind : '',
        objectId,
        providerVersion,
        command:
          command !== null && typeof command === 'object'
            ? (command as CommandEnvelope<unknown>)
            : null,
      });
    }
  }
  return observed;
};

/** The proposals of one sync outcome (stream order, full envelopes). */
const commandsOf = (
  outcome: { readonly commands?: readonly unknown[] },
): readonly CommandEnvelope<unknown>[] => {
  const commands: CommandEnvelope<unknown>[] = [];
  for (const command of outcome.commands ?? []) {
    if (command !== null && typeof command === 'object') {
      commands.push(command as CommandEnvelope<unknown>);
    }
  }
  return commands;
};

/** Drop the host-side provenance key the domain's strict payload parsers reject. */
const canonicalPayloadOf = (payload: unknown): Record<string, unknown> => {
  if (payload === null || typeof payload !== 'object') return {};
  const source = payload as Record<string, unknown>;
  const { extensionMetadata: _dropped, ...rest } = source;
  return rest;
};

/**
 * The host-seam calendar-date -> canonical-instant conversion. The schedule
 * adapter's proposals carry provider wire-format ScheduleDate values
 * (plain 'YYYY-MM-DD' calendar dates — the adapter family's own grammar);
 * the canonical domain commands require UTC RFC 3339 instants. The HOST
 * owns the conversion (the adapter never fabricates time-of-day): each
 * provider calendar date maps to its UTC midnight instant, deterministically.
 */
const scheduleInstantOf = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  return raw.length === 10 ? `${raw}T00:00:00.000Z` : raw;
};

// ---------------------------------------------------------------------------
// The observers' typed input records (built FROM the post-execution world).
// ---------------------------------------------------------------------------

type ScanAssessment = ProcurementScanInputs['assessments'][number];
type ScanOutcomeRecord = ProcurementScanInputs['outcomes'][number];
type ScanBenchmark = ProcurementScanInputs['benchmarks'][number];
type ScanContracts = RecoveryScanInputs['contracts'][number];
type ScanChangeEvent = RecoveryScanInputs['changeEvents'][number];
type ScanChangeOrder = RecoveryScanInputs['changeOrders'][number];
type ScanClaimReference = RecoveryScanInputs['claimReferences'][number];
type MinorUnits = ScanContracts['contractValue']['amount'];
type AssessmentIdToken = ScanAssessment['assessmentId'];
type AlternativeIdToken = ProcurementAlternative['alternativeId'];
type VendorKeyToken = ProcurementAlternative['vendorKey'];

const observerCapabilities: readonly Capability[] = [
  capability('contracts.read'),
  capability('cost.read'),
  capability('schedule.read'),
];

const observerPolicy: Policy = definePolicy([
  {
    effect: 'allow',
    capabilities: ['contracts.read', 'cost.read', 'schedule.read'],
    actions: ['read'],
  },
]);

const observerAuthorizationOf = (
  actor: Actor,
  scope: Scope,
): ProcurementAuthorization & RecoveryAuthorization => ({
  context: authorizationContext({
    actor,
    scope,
    capabilities: [...observerCapabilities],
  }),
  policy: observerPolicy,
});

const sourceOf = (event: LedgerEvent): ProcurementScanInputs['assessments'][number]['costImpact']['itemDeltas'][number]['source'] => ({
  eventId: event.eventId,
  eventName: event.envelope.eventName,
  occurredAt: event.envelope.occurredAt,
});

/** The wall element's provider payload (validated field-by-field, fail-closed). */
interface WallElementData {
  readonly modelId: string;
  readonly modelVersionId: string;
  readonly classification: string;
  readonly quantity: { readonly value: number; readonly unit: string } | null;
  /** The ORIGINAL provider link-ref records (kind discriminator preserved). */
  readonly linkedRefs: readonly Record<string, unknown>[];
}

const wallElementDataOf = (raw: unknown, what: string): WallElementData => {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`reference-scenario wiring error: ${what} carries no payload object`);
  }
  const source = raw as Record<string, unknown>;
  const modelId = source['modelId'];
  const modelVersionId = source['modelVersionId'];
  const classification = source['classification'];
  if (
    typeof modelId !== 'string' ||
    typeof modelVersionId !== 'string' ||
    typeof classification !== 'string'
  ) {
    throw new TypeError(`reference-scenario wiring error: ${what} carries an invalid identity`);
  }
  const quantityRaw = source['quantity'];
  let quantity: WallElementData['quantity'] = null;
  if (
    quantityRaw !== null &&
    quantityRaw !== undefined &&
    typeof quantityRaw === 'object'
  ) {
    const quantityObject = quantityRaw as Record<string, unknown>;
    if (
      typeof quantityObject['value'] === 'number' &&
      typeof quantityObject['unit'] === 'string'
    ) {
      quantity = { value: quantityObject['value'], unit: quantityObject['unit'] };
    }
  }
  const linkedRefsRaw = source['linkedRefs'];
  const linkedRefs: Record<string, unknown>[] = [];
  if (Array.isArray(linkedRefsRaw)) {
    for (const link of linkedRefsRaw) {
      if (link === null || typeof link !== 'object') continue;
      const linkObject = link as Record<string, unknown>;
      // Validate the four structural fields, then keep the ORIGINAL record:
      // the provider link-ref carries a `kind: 'provider-link-ref'`
      // discriminator the updateElement provider-data parser requires —
      // a lossy reconstruction (fields copied into a fresh object) would
      // drop it and fail the fail-closed parse.
      if (
        typeof linkObject['adapterKind'] === 'string' &&
        typeof linkObject['systemId'] === 'string' &&
        typeof linkObject['objectType'] === 'string' &&
        typeof linkObject['objectId'] === 'string'
      ) {
        linkedRefs.push(linkObject);
      }
    }
  }
  return { modelId, modelVersionId, classification, quantity, linkedRefs };
};

/** Collect a construction sync report's proposed commands (stream order). */
const constructionCommandsOf = (
  report: { readonly streams?: readonly { readonly commands?: readonly unknown[] }[] },
): readonly CommandEnvelope<unknown>[] => {
  const commands: CommandEnvelope<unknown>[] = [];
  for (const stream of report.streams ?? []) {
    for (const command of stream.commands ?? []) {
      if (command !== null && typeof command === 'object') {
        commands.push(command as CommandEnvelope<unknown>);
      }
    }
  }
  return commands;
};

// ---------------------------------------------------------------------------
// THE golden chain driver.
// ---------------------------------------------------------------------------

/** The wall-quantity change of THE chain (milli-units; the unit-rate basis). */
const WALL_QUANTITY_DELTA = 5.5;
/** The calendar-free working-day extension of the impacted structure activity. */
const STRUCTURE_DURATION_DELTA = 5;

/**
 * Run THE deterministic end-to-end construction reference scenario: the
 * seeded world + the four-adapter rig wired through the eight chain steps.
 * The same parts always produce the byte-identical world + ledger.
 */
export async function runReferenceScenario(
  parts: ReferenceScenarioParts,
): Promise<ScenarioRun> {
  const world = await seedWorld({
    tenantId: parts.tenantId,
    projectId: parts.projectId,
    actorId: parts.actorId,
    correlationId: parts.correlationId,
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const rig = createAdapterRig(world, {
    adapterActorId: unwrap(parseEntityId(parts.adapterActorId), 'adapter actor id'),
    now: parts.now,
    newOpaqueId: parts.newOpaqueId,
  });
  const session = world.session;
  const tenantId = world.scope.tenantId;

  let chainTick = 0;
  const nextChainKey = (): string => `ref-chain-${String((chainTick += 1)).padStart(4, '0')}`;

  /** Submit ONE canonical command as the world's session (loud on failure). */
  const submit = async <S>(
    commandName: Parameters<SeededWorld['submit']>[1]['commandName'],
    payload: unknown,
    options: { readonly causationId?: string | null } = {},
  ): Promise<{ readonly state: S; readonly event: LedgerEvent; readonly command: CommandEnvelope<unknown> }> => {
    const idempotencyKey = nextChainKey();
    const submitted = await world.submit<S>(session, {
      commandName,
      payload,
      scope: world.scope,
      idempotencyKey,
      correlationId: session.correlationId,
      causationId: options.causationId ?? null,
    });
    if (!submitted.ok) {
      throw new TypeError(
        `reference-scenario chain error (${commandName}): ${submitted.error.code} — ${submitted.error.message}`,
      );
    }
    const composed = unwrap(
      world.composeCommand({
        commandName,
        payload,
        scope: world.scope,
        actor: session.actor,
        idempotencyKey,
        correlationId: session.correlationId,
        causationId: options.causationId ?? null,
        issuedAt: parts.now(),
      }),
      `compose ${commandName}`,
    );
    return { state: submitted.value.state, event: submitted.value.event, command: composed };
  };

  /** Re-bind one provider mapping to the EXECUTED canonical aggregate. */
  const rebind = async (
    coordinate: CoordinateKey,
    canonical: { readonly entityKind: string; readonly entityId: string },
    canonicalVersion: number,
  ): Promise<void> => {
    const mapping = await rig.mappings.findByCoordinate(tenantId, coordinate);
    if (mapping === null) return; // never mapped: nothing to re-bind.
    await rig.mappings.save({
      ...mapping,
      canonical,
      canonicalVersion,
      lastSyncedAt: parts.now(),
    });
  };

  // ---- 0a. THE FINANCE INGRESS: the commercial baseline through the cost
  // commands the finance adapter proposes (the host-side execution seam:
  // the adapter's provenance key is dropped; every landed parser is strict).
  const financeReport = unwrap(await rig.finance.run(), 'finance sync');
  const financeCommands = commandsOf(financeReport);
  const financeRecords: ChainCommandRecord[] = [];
  for (const command of financeCommands) {
    const executed = await submit<unknown>(
      command.commandName,
      canonicalPayloadOf(command.payload),
    );
    financeRecords.push(commandRecordOf(command, executed.event));
  }
  const budgets: readonly BudgetState[] = world.stores.cost.budgets;
  const commitments: readonly CommitmentState[] = world.stores.cost.commitments;
  const budget = must(budgets[0], 'the seeded budget');
  const baselineItem = must(
    Object.values(budget.costItems)[0],
    'the seeded cost item',
  );
  const baselineCommitment = must(commitments[0], 'the seeded commitment');

  // ---- 0b. THE SCHEDULE INGRESS (first pass): the whole network through
  // the schedule commands the adapter proposes, translated over the mapping
  // graph (provider refs → canonical ids; the runtime owns the graph).
  const scheduleFirst = unwrap(await rig.schedule.run(), 'schedule sync (first pass)');
  const scheduleCommands = commandsOf(scheduleFirst);
  const scheduleApplications = applicationsOf(scheduleFirst);
  const scheduleRecords: ChainCommandRecord[] = [];
  let scheduleId: EntityId | null = null;
  let scheduleVersion = 0;
  const activityIdsByCode = new Map<string, EntityId>();
  const resolveScheduleId = (): EntityId => {
    if (scheduleId === null) throw new TypeError('schedule-ingress wiring error: no schedule yet');
    return scheduleId;
  };
  for (const command of scheduleCommands) {
    const payload = canonicalPayloadOf(command.payload);
    const name = command.commandName;
    if (name === CREATE_SCHEDULE_COMMAND) {
      const executed = await submit<ScheduleState>(CREATE_SCHEDULE_COMMAND, payload);
      scheduleId = executed.state.entityId;
      scheduleVersion = executed.state.version;
      scheduleRecords.push(commandRecordOf(command, executed.event));
      await rebind(
        {
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: PROJECT_SCHEDULE_OBJECT_KIND,
          objectId: TOWER_SCHEDULE_ID,
        },
        { entityKind: 'schedule', entityId: executed.state.entityId },
        executed.state.version,
      );
      continue;
    }
    if (name === ADD_ACTIVITY_COMMAND) {
      const parentProviderId =
        typeof payload['parentActivityProviderId'] === 'string'
          ? (payload['parentActivityProviderId'] as string)
          : null;
      const parentCode =
        parentProviderId === null
          ? null
          : scheduleApplications
              .filter(
                (application) =>
                  application.objectKind === ACTIVITY_OBJECT_KIND && application.command !== null,
              )
              .find((application) => application.objectId === parentProviderId);
      const parentActivityId =
        parentCode && parentCode.command
          ? activityIdsByCode.get(
              String((parentCode.command.payload as Record<string, unknown>)['code']),
            ) ?? null
          : null;
      const executed = await submit<ScheduleState>(ADD_ACTIVITY_COMMAND, {
        scheduleId: resolveScheduleId(),
        expectedVersion: scheduleVersion,
        code: payload['code'],
        name: payload['name'],
        plannedDuration: payload['plannedDuration'],
        plannedStart: scheduleInstantOf(payload['plannedStart'] ?? null),
        plannedFinish: scheduleInstantOf(payload['plannedFinish'] ?? null),
        parentActivityId,
      });
      scheduleVersion = executed.state.version;
      const code = String(payload['code']);
      const activityId = must(
        Object.values(executed.state.activities).find((activity) => activity.code === code),
        `executed activity ${code}`,
      ).entityId;
      activityIdsByCode.set(code, activityId);
      scheduleRecords.push(commandRecordOf(command, executed.event));
      await rebind(
        {
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: ACTIVITY_OBJECT_KIND,
          objectId: must(
            scheduleApplications.find(
              (application) =>
                application.objectKind === ACTIVITY_OBJECT_KIND &&
                application.command !== null &&
                (application.command.payload as Record<string, unknown>)['code'] === code,
            ),
            `provider activity ${code}`,
          ).objectId,
        },
        { entityKind: 'activity', entityId: activityId },
        executed.state.version,
      );
      continue;
    }
    if (name === ADD_DEPENDENCY_COMMAND) {
      // The proposal carries the dependency's provider ENDPOINT OBJECT IDS
      // ('act-401'-style — the provider activity ids), not activity codes:
      // resolve each endpoint through its APPLICATION (by objectId), then to
      // the executed canonical activity through that application's own code.
      const predecessorProviderId = String(payload['predecessorProviderId']);
      const successorProviderId = String(payload['successorProviderId']);
      const applicationByObjectId = (objectId: string) =>
        must(
          scheduleApplications.find(
            (application) =>
              application.objectKind === ACTIVITY_OBJECT_KIND &&
              application.objectId === objectId &&
              application.command !== null,
          ),
          `activity application ${objectId}`,
        );
      const predecessorCode = String(
        (must(
          applicationByObjectId(predecessorProviderId).command,
          'predecessor command',
        ).payload as Record<string, unknown>)['code'],
      );
      const successorCode = String(
        (must(
          applicationByObjectId(successorProviderId).command,
          'successor command',
        ).payload as Record<string, unknown>)['code'],
      );
      const predecessorId = activityIdsByCode.get(predecessorCode) ?? null;
      const successorId = activityIdsByCode.get(successorCode) ?? null;
      // The provider wire format carries lowercase link types ('fs'); the
      // canonical CPM vocabulary is uppercase ('FS'/'SS'/'FF'/'SF'). The
      // host seam owns the casing normalization (deterministic total map).
      const linkTypeOf = (raw: unknown): string => {
        const link = typeof raw === 'string' ? raw.toUpperCase() : '';
        return link === 'FS' || link === 'SS' || link === 'FF' || link === 'SF'
          ? link
          : String(raw);
      };
      const executed = await submit<ScheduleState>(ADD_DEPENDENCY_COMMAND, {
        scheduleId: resolveScheduleId(),
        expectedVersion: scheduleVersion,
        predecessorId,
        successorId,
        linkType: linkTypeOf(payload['linkType']),
        lagDays: payload['lagDays'] ?? 0,
      });
      scheduleVersion = executed.state.version;
      scheduleRecords.push(commandRecordOf(command, executed.event));
      // Re-bind the dependency's provider mapping to the EXECUTED canonical
      // dependency (the engine minted a placeholder id at mapping time; the
      // world's addDependency issued the real one). The specific application
      // is matched by THIS command's provider endpoint pair.
      const executedDependency = must(
        Object.values(executed.state.dependencies).find(
          (dependency) =>
            dependency.predecessorId === predecessorId &&
            dependency.successorId === successorId,
        ),
        'the executed dependency',
      );
      await rebind(
        {
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: ACTIVITY_DEPENDENCY_OBJECT_KIND,
          objectId: must(
            scheduleApplications.find(
              (application) =>
                application.objectKind === ACTIVITY_DEPENDENCY_OBJECT_KIND &&
                application.command !== null &&
                (application.command.payload as Record<string, unknown>)[
                  'predecessorProviderId'
                ] === payload['predecessorProviderId'] &&
                (application.command.payload as Record<string, unknown>)[
                  'successorProviderId'
                ] === payload['successorProviderId'],
            ),
            'the dependency application',
          ).objectId,
        },
        { entityKind: 'dependency', entityId: executedDependency.entityId },
        executed.state.version,
      );
      continue;
    }
    if (name === SET_BASELINE_COMMAND) {
      const executed = await submit<ScheduleState>(SET_BASELINE_COMMAND, {
        scheduleId: resolveScheduleId(),
        expectedVersion: scheduleVersion,
        label: payload['label'],
      });
      scheduleVersion = executed.state.version;
      scheduleRecords.push(commandRecordOf(command, executed.event));
      // Re-bind the baseline's provider mapping to the EXECUTED canonical
      // baseline (same placeholder-to-real rebind discipline as dependencies;
      // the specific application matched by THIS command's label).
      const executedBaseline = must(
        Object.values(executed.state.baselines).find(
          (baseline) => baseline.label === payload['label'],
        ),
        'the executed baseline',
      );
      await rebind(
        {
          adapterKind: SCHEDULE_ADAPTER_KIND,
          systemId: SCHEDULE_SYSTEM_ID,
          objectType: BASELINE_OBJECT_KIND,
          objectId: must(
            scheduleApplications.find(
              (application) =>
                application.objectKind === BASELINE_OBJECT_KIND &&
                application.command !== null &&
                (application.command.payload as Record<string, unknown>)['label'] ===
                  payload['label'],
            ),
            'the baseline application',
          ).objectId,
        },
        { entityKind: 'baseline', entityId: executedBaseline.entityId },
        executed.state.version,
      );
      continue;
    }
    // Any other proposal of the first pass has no landing surface in this
    // world — the baseline records only what the chain executes.
  }

  // ---- 0c. THE CONSTRUCTION INGRESS: the change-event/document surface.
  // The proposals address the documents/field/contracts command surfaces
  // this world does not wire; the pass records the provider→canonical
  // mappings the evidence packet + the approval subject resolve through.
  const constructionReport = unwrap(await rig.construction.run(), 'construction sync');
  const constructionCommands = constructionCommandsOf(constructionReport);
  const changeEventMapping = must(
    await rig.mappings.findByCoordinate(tenantId, {
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: CONSTRUCTION_SYSTEM_ID,
      objectType: CHANGE_EVENT_OBJECT_KIND,
      objectId: 'ce-1',
    }),
    'the change-event mapping',
  );
  const documentMapping = must(
    await rig.mappings.findByCoordinate(tenantId, {
      adapterKind: CONSTRUCTION_ADAPTER_KIND,
      systemId: CONSTRUCTION_SYSTEM_ID,
      objectType: DOCUMENT_OBJECT_KIND,
      objectId: 'doc-9',
    }),
    'the document mapping',
  );
  const changeEventRef = refOf(changeEventMapping.canonical);
  const documentRef = refOf(documentMapping.canonical);

  // The host-side LINK BINDING for the model fixture's linked ACTIVITY: the
  // fixture names the Foundations activity through its OWN provider
  // coordinate family ('schedule-planning'/'schedule-instance-01'/'act-401')
  // — a different adapterKind than the schedule family's own
  // 'schedule-pm' coordinate of the same provider object. The mapping
  // graph is the HOST's binding surface: the host binds the link coordinate
  // to the SAME canonical Foundations aggregate the schedule ingress
  // executed (one canonical entity, two provider coordinates — the
  // documented linked-ref resolution discipline).
  const linkedActivityCanonical = must(
    activityIdsByCode.get('A4010') ?? null,
    'the executed foundations activity (the model fixture link target)',
  );
  unwrap(
    await rig.mappings.save({
      kind: 'source-mapping',
      tenantId,
      coordinate: {
        adapterKind: LINKED_ACTIVITY_REF.adapterKind,
        systemId: LINKED_ACTIVITY_REF.systemId,
        objectType: LINKED_ACTIVITY_REF.objectType,
        objectId: LINKED_ACTIVITY_REF.objectId,
      },
      canonical: { entityKind: 'activity', entityId: linkedActivityCanonical },
      providerVersion: 'v1',
      canonicalVersion: 1,
      actor: null,
      mappedAt: parts.now(),
      lastSyncedAt: parts.now(),
    } as never),
    'the linked-activity binding',
  );

  // ---- 1. THE MODEL INGRESS: the wall-element mutation ---------------------
  const modelFirst = unwrap(await rig.model.run(), 'model sync (first pass)');
  const wallObject = must(
    rig.model.provider.objects.find((object) => object.objectId === WALL_ELEMENT_ID),
    'the seeded wall element',
  );
  const wallData = wallElementDataOf(wallObject.data, 'the wall element payload');
  const quantityBefore = wallData.quantity === null ? 0 : wallData.quantity.value;
  const quantityAfter = quantityBefore + WALL_QUANTITY_DELTA;
  const wallUnit = wallData.quantity === null ? 'm2' : wallData.quantity.unit;
  rig.model.provider.updateElement(WALL_ELEMENT_ID, {
    displayName: `${wallObject.displayName} — quantity change`,
    data: {
      modelId: wallData.modelId,
      modelVersionId: wallData.modelVersionId,
      classification: wallData.classification,
      quantity: { value: quantityAfter, unit: wallUnit },
      // The ORIGINAL provider link-ref records (kind discriminators intact)
      // — the updateElement provider-data parser is fail-closed over the
      // wire shape, so the records pass through untyped-here and validated
      // there.
      linkedRefs: [...wallData.linkedRefs] as never,
    },
  });
  const modelSecond = unwrap(await rig.model.run(), 'model sync (second pass)');
  const modelProposal = must(
    commandsOf(modelSecond).find((command) => command.commandName === 'models.recordElementChange'),
    'the element-change proposal',
  );
  const wallApplication = must(
    applicationsOf(modelSecond).find(
      (application) =>
        application.objectId === WALL_ELEMENT_ID && application.command !== null,
    ),
    'the wall application',
  );
  const elementMapping = must(
    await rig.mappings.findByCoordinate(tenantId, {
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: ELEMENT_OBJECT_KIND,
      objectId: WALL_ELEMENT_ID,
    }),
    'the wall element mapping',
  );
  const modelVersionMapping = must(
    await rig.mappings.findByCoordinate(tenantId, {
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: MODEL_VERSION_OBJECT_KIND,
      objectId: TOWER_MODEL_V2_ID,
    }),
    'the model-version mapping',
  );
  const modelMapping = must(
    await rig.mappings.findByCoordinate(tenantId, {
      adapterKind: MODEL_ADAPTER_KIND,
      systemId: MODEL_SYSTEM_ID,
      objectType: MODEL_OBJECT_KIND,
      objectId: TOWER_MODEL_ID,
    }),
    'the model mapping',
  );
  // The host-side execution seam: the linked activity/document resolve
  // through the SHARED mapping graph (the schedule activity re-bound to its
  // executed canonical aggregate; the construction document as mapped).
  const linkMappingOf = async (link: {
    readonly adapterKind: string;
    readonly systemId: string;
    readonly objectType: string;
    readonly objectId: string;
  }): Promise<EntityRef> => {
    const mapping = must(
      await rig.mappings.findByCoordinate(tenantId, {
        adapterKind: link.adapterKind,
        systemId: link.systemId,
        objectType: link.objectType,
        objectId: link.objectId,
      }),
      `the linked ${link.objectType} mapping`,
    );
    return refOf(mapping.canonical);
  };
  const linkedActivity = await linkMappingOf(LINKED_ACTIVITY_REF);
  const linkedDocument = await linkMappingOf(LINKED_DOCUMENT_REF);
  const affectedEntityRefs = [linkedActivity, linkedDocument].sort((left, right) =>
    left.entityKind !== right.entityKind
      ? left.entityKind < right.entityKind
        ? -1
        : 1
      : left.entityId < right.entityId
        ? -1
        : 1,
  );
  const elementChanged = elementChangedEnvelope({
    command: modelProposal,
    occurredAt: parts.now(),
    element: refOf(elementMapping.canonical),
    modelVersion: refOf(modelVersionMapping.canonical),
    model: refOf(modelMapping.canonical),
    classification: unwrap(parseElementClassification(wallData.classification), 'classification'),
    change: 'updated',
    displayName: `${wallObject.displayName} — quantity change`,
    quantity: unwrap(parseElementQuantity({ value: quantityAfter, unit: wallUnit }), 'quantity'),
    affectedEntityRefs,
    rawLinkedRefs: [LINKED_ACTIVITY_REF, LINKED_DOCUMENT_REF],
    providerObjectId: WALL_ELEMENT_ID,
    providerVersion: wallApplication.providerVersion,
  });
  const modelEvent = unwrap(world.ledger.append(elementChanged), 'the element-changed ledger event');

  // ---- 2. THE COST IMPACT: the quantity change through domain-cost -------
  const quantityMilliDelta = Math.round(WALL_QUANTITY_DELTA * 1000);
  const amountMinorDelta =
    (quantityMilliDelta * baselineItem.unitRateMinor) / 1000;
  const costExecuted = await submit<BudgetState>(
    RECORD_COST_ITEM_COMMAND,
    {
      budgetId: budget.entityId,
      expectedVersion: budget.version,
      code: `${baselineItem.code}-C01`,
      description: 'Wall element quantity increase — change order 01',
      unit: baselineItem.unit,
      quantityMilli: quantityMilliDelta,
      unitRateMinor: baselineItem.unitRateMinor,
    },
    { causationId: modelEvent.eventId },
  );
  const costImpactItem = must(
    Object.values(costExecuted.state.costItems).find(
      (item) => item.code === `${baselineItem.code}-C01`,
    ),
    'the change cost item',
  );

  // ---- 3. THE SCHEDULE INGRESS: the activity update ------------------------
  // Re-advance every schedule-family element mapping to the CURRENT schedule
  // version first: the first pass's per-command rebinds recorded each
  // element's canonicalVersion at ITS OWN command time, but every subsequent
  // schedule command (dependencies, baseline) advanced the OWNING schedule
  // aggregate. Without this re-advance, the provider-side mutation below
  // would reconcile as BOTH-sides-moved (an explicit conflict, by frozen
  // design — never auto-resolved) instead of the provider-moved UPDATE the
  // chain intends.
  for (const mapping of rig.mappings.mappings) {
    if (mapping.coordinate.adapterKind !== SCHEDULE_ADAPTER_KIND) continue;
    const currentVersion = world.canonicalVersionOf(
      mapping.canonical.entityId as EntityId,
    );
    if (currentVersion === null || currentVersion === mapping.canonicalVersion) {
      continue;
    }
    unwrap(
      await rig.mappings.save({
        ...mapping,
        canonicalVersion: currentVersion,
        lastSyncedAt: parts.now(),
      } as never),
      'the schedule mapping re-advance',
    );
  }
  const structureObject = must(
    rig.schedule.provider.objects.find((object) => object.objectId === STRUCTURE_ACTIVITY_ID),
    'the seeded structure activity',
  );
  const structureData = unwrap(
    parseActivityProviderData(structureObject.data),
    'structure activity data',
  );
  const durationBefore = structureData.plannedDuration;
  const durationAfter = durationBefore + STRUCTURE_DURATION_DELTA;
  rig.schedule.provider.updateActivity(STRUCTURE_ACTIVITY_ID, {
    data: {
      scheduleId: structureData.scheduleId,
      code: structureData.code,
      name: structureData.name,
      plannedDuration: durationAfter,
      plannedStart: structureData.plannedStart,
      plannedFinish: structureData.plannedFinish,
      parentActivityId: structureData.parentActivityId,
    },
  });
  const scheduleSecond = unwrap(await rig.schedule.run(), 'schedule sync (second pass)');
  const activityUpdateProposal = must(
    commandsOf(scheduleSecond).find(
      (command) => command.commandName === UPDATE_ACTIVITY_COMMAND,
    ),
    'the activity-update proposal',
  );
  const updatePayload = canonicalPayloadOf(activityUpdateProposal.payload);
  const scheduleState = must(
    world.stores.schedule.schedules.find((row) => row.entityId === resolveScheduleId()),
    'the world schedule',
  );
  const activityEntry = must(
    Object.values(scheduleState.activities).find(
      (activity) => activity.code === structureData.code,
    ),
    'the structure activity aggregate',
  );
  const scheduleExecuted = await submit<ScheduleState>(
    UPDATE_ACTIVITY_COMMAND,
    {
      scheduleId: resolveScheduleId(),
      activityId: activityEntry.entityId,
      expectedVersion: world.canonicalVersionOf(resolveScheduleId()) ?? scheduleVersion,
      plannedDuration: updatePayload['plannedDuration'],
    },
    { causationId: modelEvent.eventId },
  );

  // ---- 4. THE CHANGE EVIDENCE: the agents EvidenceSet packet ---------------
  const evidenceItems: readonly EvidenceItem[] = [
    {
      kind: 'ledger-event',
      ref: modelEvent.eventId,
      entity: refOf(elementMapping.canonical),
      scope: world.scope,
      confidence: 'certain',
      retrieval: {
        tool: 'reference-scenario-ledger',
        query: { kind: 'memory-outcomes', projectId: world.scope.projectId },
        retrievedAt: parts.now(),
      },
    },
    {
      kind: 'ledger-event',
      ref: costExecuted.event.eventId,
      entity: refOf({ entityKind: 'budget', entityId: budget.entityId }),
      scope: world.scope,
      confidence: 'certain',
      retrieval: {
        tool: 'reference-scenario-ledger',
        query: { kind: 'memory-outcomes', projectId: world.scope.projectId },
        retrievedAt: parts.now(),
      },
    },
    {
      kind: 'ledger-event',
      ref: scheduleExecuted.event.eventId,
      entity: refOf({ entityKind: 'activity', entityId: activityEntry.entityId }),
      scope: world.scope,
      confidence: 'certain',
      retrieval: {
        tool: 'reference-scenario-ledger',
        query: { kind: 'memory-outcomes', projectId: world.scope.projectId },
        retrievedAt: parts.now(),
      },
    },
    {
      kind: 'entity',
      ref: `change-event:${changeEventRef.entityId}`,
      entity: changeEventRef,
      scope: world.scope,
      confidence: 'high',
      retrieval: {
        tool: 'reference-scenario-ledger',
        query: { kind: 'memory-outcomes', projectId: world.scope.projectId },
        retrievedAt: parts.now(),
      },
    },
    {
      kind: 'entity',
      ref: `document:${documentRef.entityId}`,
      entity: documentRef,
      scope: world.scope,
      confidence: 'high',
      retrieval: {
        tool: 'reference-scenario-ledger',
        query: { kind: 'memory-outcomes', projectId: world.scope.projectId },
        retrievedAt: parts.now(),
      },
    },
  ];
  const packet = evidenceSet(evidenceItems);
  const qualification = qualifyEvidenceSet(packet, world.scope);
  if (!qualification.ok) {
    throw new TypeError(
      `reference-scenario evidence error: ${qualification.error.code} — ${qualification.error.message}`,
    );
  }
  const packetReferences = packet.items.map((item) => item.ref);

  // ---- 5. THE APPROVAL: the workflows instance machine ---------------------
  const definitionExecuted = await submit<{ entityId: EntityId; version: number }>(
    CREATE_DEFINITION_COMMAND,
    {
      key: 'wall-quantity-change',
      title: 'Wall quantity change approval',
      description: 'The reference scenario change-order approval route',
      model: {
        states: [
          { name: 'change-proposed', kind: 'initial' },
          { name: 'change-review', kind: 'normal' },
          { name: 'change-executed', kind: 'success' },
        ],
        transitions: [
          {
            key: 'submit-for-review',
            from: 'change-proposed',
            to: 'change-review',
            conditions: [{ kind: 'always' }],
            requiredCapabilities: [],
          },
          {
            key: 'approve-change',
            from: 'change-review',
            to: 'change-executed',
            conditions: [
              {
                kind: 'approval-decision',
                approval: 'quantity-change-approval',
                decision: 'approved',
              },
            ],
            requiredCapabilities: [],
          },
        ],
        tasks: [],
        approvals: [
          {
            key: 'quantity-change-approval',
            title: 'Approve the wall quantity change',
            state: 'change-review',
            requiredCapability: 'workflows.write',
            policyRef: 'reference-scenario-approval-policy',
          },
        ],
        retryPolicy: { maxAttempts: 3, backoffBaseSeconds: 60, backoffMaxSeconds: 3600 },
        escalationRules: [],
      },
    },
  );
  const definitionId = definitionExecuted.state.entityId;
  await submit<unknown>(PUBLISH_DEFINITION_COMMAND, {
    definitionId,
    expectedVersion: definitionExecuted.state.version,
  });
  const instanceExecuted = await submit<{ entityId: EntityId; version: number }>(
    START_INSTANCE_COMMAND,
    { definitionId, subject: changeEventRef },
    { causationId: modelEvent.eventId },
  );
  const instanceId = instanceExecuted.state.entityId;
  // The instance machine starts in the model's INITIAL state
  // ('change-proposed'); the review gate transition runs FIRST (proposed ->
  // review), THEN the approval is submitted and decided, THEN the
  // approve-change transition lands (review -> executed). The machine
  // enforces from-state discipline at every hop.
  const reviewTransitionExecuted = await submit<{ entityId: EntityId; version: number }>(
    EXECUTE_TRANSITION_COMMAND,
    {
      instanceId,
      expectedVersion: instanceExecuted.state.version,
      transitionKey: 'submit-for-review',
    },
    { causationId: modelEvent.eventId },
  );
  const submitExecuted = await submit<{ entityId: EntityId; version: number }>(
    SUBMIT_APPROVAL_COMMAND,
    { instanceId, expectedVersion: reviewTransitionExecuted.state.version, approvalKey: 'quantity-change-approval' },
    { causationId: modelEvent.eventId },
  );
  const approvalNote = `change-evidence:${packetReferences.join(',')}`;
  const approveExecuted = await submit<{ entityId: EntityId; version: number }>(
    APPROVE_APPROVAL_COMMAND,
    {
      instanceId,
      expectedVersion: submitExecuted.state.version,
      approvalKey: 'quantity-change-approval',
      note: approvalNote,
    },
    { causationId: submitExecuted.event.eventId },
  );
  const transitionExecuted = await submit<{ entityId: EntityId; version: number }>(
    EXECUTE_TRANSITION_COMMAND,
    {
      instanceId,
      expectedVersion: approveExecuted.state.version,
      transitionKey: 'approve-change',
    },
    { causationId: approveExecuted.event.eventId },
  );
  void transitionExecuted;

  // ---- 6. THE EXECUTION: the approved change applied canonically -----------
  const committedBefore = baselineCommitment.lineSets.reduce(
    (sum, lineSet) => sum + lineSet.lines.reduce((inner, line) => inner + line.amountMinor, 0),
    0,
  );
  const tipLineSet = baselineCommitment.lineSets[baselineCommitment.lineSets.length - 1];
  const amendmentLines = [
    ...must(tipLineSet, 'the baseline line set').lines.map((line) => ({
      costItemId: line.costItemId,
      description: line.description,
      amountMinor: line.amountMinor,
    })),
    {
      costItemId: costImpactItem.entityId,
      description: 'Wall element quantity increase — change order 01',
      amountMinor: amountMinorDelta,
    },
  ];
  const amendExecuted = await submit<CommitmentState>(
    AMEND_COMMITMENT_COMMAND,
    {
      commitmentId: baselineCommitment.entityId,
      expectedVersion: baselineCommitment.version,
      budgetId: budget.entityId,
      reason: 'Wall quantity increase — change order 01 (approved)',
      lines: amendmentLines,
    },
    { causationId: approveExecuted.event.eventId },
  );
  const committedAfter = amendExecuted.state.lineSets.reduce(
    (sum, lineSet) => sum + lineSet.lines.reduce((inner, line) => inner + line.amountMinor, 0),
    0,
  );

  // ---- 7. THE OBSERVERS: the two detection surfaces over the executed world.
  const authorization = observerAuthorizationOf(session.actor, world.scope);
  const scanNow = parts.now();
  const postBudget = must(
    world.stores.cost.budgets.find((row) => row.entityId === budget.entityId),
    'the post-execution budget',
  );
  const postCommitment = must(
    world.stores.cost.commitments.find((row) => row.entityId === baselineCommitment.entityId),
    'the post-execution commitment',
  );
  const contractId = formatEntityId({ version: 'v1', opaque: parts.newOpaqueId() });
  const ownerPartyId = formatEntityId({ version: 'v1', opaque: parts.newOpaqueId() });
  const contractorPartyId = formatEntityId({ version: 'v1', opaque: parts.newOpaqueId() });
  const changeOrderId = formatEntityId({ version: 'v1', opaque: parts.newOpaqueId() });
  const assessmentId = 'reference-scenario-assessment-01' as AssessmentIdToken;
  const currencyCode = String(postBudget.currency);
  const marginCurrency = currencyCode as ScanAssessment['marginPosition']['currency'];
  const contractsCurrency = currencyCode as ScanContracts['contractValue']['currency'];
  const alternativeCurrency = currencyCode as ProcurementAlternative['currency'];
  const contractValueMinor = 100_000 as MinorUnits;
  const assessment: ScanAssessment = {
    assessmentId,
    assessmentVersion: 1,
    engine: 'intelligence-margin',
    assessedAt: scanNow,
    actor: session.actor,
    scope: world.scope,
    query: { sourceEventId: modelEvent.eventId },
    source: {
      eventId: modelEvent.eventId,
      changeEventId: changeEventRef.entityId,
      contractId,
      title: 'Wall element quantity increase',
      changeType: 'modification',
      evidenceLinks: [],
      scope: world.scope,
      actor: session.actor,
      occurredAt: modelEvent.envelope.occurredAt,
      correlationId: session.correlationId,
    },
    consumed: { projectedEventCount: 3, subgraphNodeCount: 0, subgraphEdgeCount: 0 },
    costImpact: {
      budgetRevisionDeltaMinor: amountMinorDelta,
      itemDeltas: [
        {
          budgetId: postBudget.entityId,
          costItemId: costImpactItem.entityId,
          amountMinor: amountMinorDelta,
          source: sourceOf(costExecuted.event),
        },
      ],
      revisionAnchors: [],
      evidence: [sourceOf(costExecuted.event)],
    },
    scheduleImpact: {
      activityDeltas: [
        {
          activityId: activityEntry.entityId,
          code: structureData.code,
          earlyStartDelta: 0,
          earlyFinishDelta: STRUCTURE_DURATION_DELTA,
          drivers: [sourceOf(scheduleExecuted.event)],
        },
      ],
      projectDurationDelta: STRUCTURE_DURATION_DELTA,
      preProjectDuration: durationBefore,
      currentProjectDuration: durationAfter,
      drivers: [sourceOf(scheduleExecuted.event)],
      basisAnchors: [],
      evidence: [sourceOf(scheduleExecuted.event)],
    },
    entitlementImpact: {
      status: 'entitled',
      orders: [
        {
          changeOrderId,
          valueMinor: amountMinorDelta,
          currency: marginCurrency,
          status: 'executed',
          submissionSource: sourceOf(submitExecuted.event),
          decisionSource: sourceOf(approveExecuted.event),
          claims: [],
        },
      ],
      approvedValueMinor: amountMinorDelta,
      rejectedValueMinor: 0,
      pendingValueMinor: 0,
      evidence: [sourceOf(submitExecuted.event), sourceOf(approveExecuted.event)],
    },
    marginPosition: {
      contractedValue: {
        amountMinor: Number(contractValueMinor) + amountMinorDelta,
        evidence: [sourceOf(modelEvent)],
      },
      committedCost: {
        amountMinor: committedAfter,
        evidence: [sourceOf(amendExecuted.event)],
      },
      budgetedCost: {
        amountMinor: Object.values(postBudget.costItems).reduce((sum, item) => sum + item.amountMinor, 0),
        evidence: [sourceOf(costExecuted.event)],
      },
      projectedCost: {
        amountMinor: committedAfter,
        evidence: [sourceOf(amendExecuted.event)],
      },
      marginMinor: Number(contractValueMinor),
      marginOverCommittedMinor: Number(contractValueMinor) - committedAfter,
      currency: marginCurrency,
    },
    confidence: { level: 'high', reasons: ['complete-inputs'] },
    policyContext: {
      capabilities: [...observerCapabilities],
      requiredCapabilities: ['contracts.read', 'cost.read', 'schedule.read'],
      policyRuleCount: 1,
      decision: 'allow',
    },
    evidence: [sourceOf(modelEvent), sourceOf(costExecuted.event), sourceOf(scheduleExecuted.event)],
  };
  const incumbentQuote: ProcurementAlternative = {
    alternativeId: 'alt-incumbent-01' as AlternativeIdToken,
    vendorKey: 'vendor-01' as VendorKeyToken,
    scope: world.scope,
    incumbentCommitmentId: postCommitment.entityId,
    incumbentVendor: true,
    quotedQuantityMilli: 1_205_500,
    quotedUnitRateMinor: 2_500,
    currency: alternativeCurrency,
    leadTimeDays: 30,
    outcomeIds: [],
  };
  const challengerQuote: ProcurementAlternative = {
    alternativeId: 'alt-challenger-01' as AlternativeIdToken,
    vendorKey: 'vendor-02' as VendorKeyToken,
    scope: world.scope,
    incumbentCommitmentId: postCommitment.entityId,
    incumbentVendor: false,
    quotedQuantityMilli: 1_205_500,
    quotedUnitRateMinor: 2_400,
    currency: alternativeCurrency,
    leadTimeDays: 30,
    outcomeIds: [],
  };
  const procurementScan = detectProcurementRecommendations(
    {
      budgets: [postBudget],
      commitments: [postCommitment],
      alternatives: [incumbentQuote, challengerQuote],
      assessments: [assessment],
      outcomes: [] as readonly ScanOutcomeRecord[],
      benchmarks: [] as readonly ScanBenchmark[],
    },
    authorization as ProcurementAuthorization,
    { scanId: 'reference-scenario-procurement-01' as Parameters<typeof detectProcurementRecommendations>[2]['scanId'], detectedAt: scanNow },
  );
  const procurementRecommendations = unwrap(procurementScan, 'the procurement scan');
  const contractRecord: ScanContracts = {
    entityId: contractId,
    entityKind: 'contract' as ScanContracts['entityKind'],
    scope: world.scope,
    version: unwrap(parseAggregateVersion(1), 'contract version'),
    title: 'Reference Tower Works main contract',
    owner: { entityKind: 'company', entityId: ownerPartyId },
    contractor: { entityKind: 'company', entityId: contractorPartyId },
    contractValue: { amount: contractValueMinor, currency: contractsCurrency },
    executionStatus: 'executed',
    lifecycleStatus: 'active',
    archivedAt: null,
    obligations: {},
    createdAt: scanNow,
    updatedAt: scanNow,
  };
  const changeEventRecord: ScanChangeEvent = {
    entityId: changeEventRef.entityId,
    entityKind: 'change-event' as ScanChangeEvent['entityKind'],
    scope: world.scope,
    version: unwrap(parseAggregateVersion(1), 'change-event version'),
    contractId,
    title: 'Wall element quantity increase',
    changeType: 'modification',
    status: 'proposed',
    supersededAt: null,
    supersededByChangeOrderId: null,
    affectedObligationIds: [],
    evidenceLinks: [],
    costImpactLinks: [{ budgetId: postBudget.entityId, costItemId: costImpactItem.entityId }],
    scheduleImpactActivityIds: [activityEntry.entityId],
    createdAt: scanNow,
    updatedAt: scanNow,
  };
  const changeOrderRecord: ScanChangeOrder = {
    entityId: changeOrderId,
    entityKind: 'change-order' as ScanChangeOrder['entityKind'],
    scope: world.scope,
    version: unwrap(parseAggregateVersion(3), 'change-order version'),
    contractId,
    changeEventId: changeEventRef.entityId,
    title: 'Wall quantity increase — change order 01',
    changeValue: { amount: amountMinorDelta as MinorUnits, currency: contractsCurrency },
    status: 'executed',
    decidedAt: scanNow,
    decisionReason: 'Approved on the reference scenario evidence packet',
    executedAt: scanNow,
    createdAt: scanNow,
    updatedAt: scanNow,
  };
  const revenueScan = detectRecoveryCandidates(
    {
      contracts: [contractRecord],
      changeEvents: [changeEventRecord],
      changeOrders: [changeOrderRecord],
      claimReferences: [] as readonly ScanClaimReference[],
      assessments: [assessment],
      outcomes: [] as readonly ScanOutcomeRecord[],
      benchmarks: [] as readonly ScanBenchmark[],
    },
    authorization as RecoveryAuthorization,
    {
      scanId: 'reference-scenario-recovery-01' as Parameters<typeof detectRecoveryCandidates>[2]['scanId'],
      detectedAt: scanNow,
    },
  );
  const recoveryCandidates = unwrap(revenueScan, 'the recovery scan');

  // ---- THE run record -------------------------------------------------------
  return {
    kind: 'reference-scenario-run',
    world,
    rig,
    parts,
    financeIngress: {
      proposals: financeCommands.map((command) => ({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      })),
      commands: financeRecords,
    },
    scheduleBaseline: {
      proposals: scheduleCommands.map((command) => ({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      })),
      commands: scheduleRecords,
      schedule: must(
        world.stores.schedule.schedules.find((row) => row.entityId === resolveScheduleId()),
        'the world schedule',
      ),
    },
    constructionIngress: {
      proposals: constructionCommands.map((command) => ({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      })),
      changeEvent: changeEventRef,
      document: documentRef,
    },
    modelIngress: {
      firstPassProposals: commandsOf(modelFirst).map((command) => ({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      })),
      mutation: {
        elementId: WALL_ELEMENT_ID,
        quantityBefore,
        quantityAfter,
        unit: wallUnit,
      },
      secondPassProposals: commandsOf(modelSecond).map((command) => ({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      })),
      proposal: modelProposal,
      element: refOf(elementMapping.canonical),
      model: refOf(modelMapping.canonical),
      modelVersion: refOf(modelVersionMapping.canonical),
      affectedEntityRefs,
      event: modelEvent,
    },
    costImpact: {
      budgetId: budget.entityId,
      costItemId: costImpactItem.entityId,
      quantityMilliDelta,
      amountMinorDelta,
      command: commandRecordOf(costExecuted.command, costExecuted.event),
    },
    scheduleIngress: {
      scheduleId: resolveScheduleId(),
      activityId: activityEntry.entityId,
      activityCode: structureData.code,
      durationBefore,
      durationAfter,
      command: commandRecordOf(scheduleExecuted.command, scheduleExecuted.event),
    },
    evidence: {
      packet,
      references: packetReferences,
      citedEventIds: [
        modelEvent.eventId,
        costExecuted.event.eventId,
        scheduleExecuted.event.eventId,
      ],
      citedEntityIds: [
        refOf(elementMapping.canonical).entityId,
        budget.entityId,
        activityEntry.entityId,
      ],
      qualified: true,
    },
    approval: {
      definitionId,
      instanceId,
      approvalKey: 'quantity-change-approval',
      subject: changeEventRef,
      submitted: commandRecordOf(submitExecuted.command, submitExecuted.event),
      decided: commandRecordOf(approveExecuted.command, approveExecuted.event),
      note: approvalNote,
    },
    execution: {
      commitmentId: baselineCommitment.entityId,
      committedBeforeMinor: committedBefore,
      committedAfterMinor: committedAfter,
      command: commandRecordOf(amendExecuted.command, amendExecuted.event),
    },
    observers: {
      procurement: {
        inputBudgetIds: [postBudget.entityId],
        inputCommitmentIds: [postCommitment.entityId],
        recommendations: procurementRecommendations,
      },
      revenue: {
        inputChangeEventId: changeEventRef.entityId,
        inputChangeOrderId: changeOrderId,
        candidates: recoveryCandidates,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// THE replay proof: re-deliver the SAME adapter notifications.
// ---------------------------------------------------------------------------

/** The outcome of re-delivering every adapter notification of a run. */
export interface ReplayOutcome {
  /** Every proposal the re-delivered notifications produced. */
  readonly proposals: readonly AdapterProposal[];
  /** The number of NEW canonical records the replay produced (must be 0). */
  readonly newCanonicalRecords: number;
  /** The ledger length before / after the replay. */
  readonly ledgerCountBefore: number;
  readonly ledgerCountAfter: number;
  /** The command-journal length before / after the replay. */
  readonly journalCountBefore: number;
  readonly journalCountAfter: number;
}

/**
 * Re-deliver the SAME adapter notifications (re-run every rig sync driver):
 * the adapters' source-version discipline means every provider object is
 * observed at its already-mapped version — ZERO new canonical records.
 */
export async function replayNotifications(run: ScenarioRun): Promise<ReplayOutcome> {
  const ledgerCountBefore = run.world.ledger.count;
  const journalCountBefore = run.world.commandJournal.length;
  const proposals: AdapterProposal[] = [];
  const collect = (commands: readonly CommandEnvelope<unknown>[]): void => {
    for (const command of commands) {
      proposals.push({
        commandName: command.commandName,
        payload: canonicalPayloadOf(command.payload),
        idempotencyKey: command.idempotencyKey,
        scope: command.scope,
      });
    }
  };
  collect(commandsOf(unwrap(await run.rig.model.run(), 'replay: model sync')));
  collect(commandsOf(unwrap(await run.rig.schedule.run(), 'replay: schedule sync')));
  collect(commandsOf(unwrap(await run.rig.finance.run(), 'replay: finance sync')));
  collect(constructionCommandsOf(unwrap(await run.rig.construction.run(), 'replay: construction sync')));
  const ledgerCountAfter = run.world.ledger.count;
  const journalCountAfter = run.world.commandJournal.length;
  return {
    proposals,
    newCanonicalRecords: ledgerCountAfter - ledgerCountBefore,
    ledgerCountBefore,
    ledgerCountAfter,
    journalCountBefore,
    journalCountAfter,
  };
}

// ---------------------------------------------------------------------------
// THE causal walk: event → command → aggregate → projection → evidence.
// ---------------------------------------------------------------------------

/** One hop of the causal walk (the causal ids collected at that hop). */
export interface CausalHop {
  readonly step: string;
  readonly commandId: string;
  readonly eventId: LedgerEventId | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly aggregateKind: string | null;
  readonly aggregateId: string | null;
  /** The causal ids this hop's PROJECTION cites (the linked-projection ids). */
  readonly citedIds: readonly string[];
}

/** The typed causal walk over a completed run. */
export interface CausalWalk {
  readonly hops: readonly CausalHop[];
  /** The originating causal command id (the model adapter's proposal). */
  readonly originatingCommandId: string;
  /** The originating causal event id (the models.elementChanged event). */
  readonly originatingEventId: LedgerEventId;
  /** The one correlation id every command of the chain shares. */
  readonly correlationId: string;
}

/**
 * Walk the causality chain END TO END: every hop collects the command id,
 * ledger event id, correlation id, causation id, aggregate id, and the
 * causal ids its linked projection cites — the named acceptance's walk.
 */
export const causalWalk = (run: ScenarioRun): CausalWalk => {
  const hops: CausalHop[] = [];
  const commandHops = (
    step: string,
    record: ChainCommandRecord,
    citedIds: readonly string[],
  ): void => {
    hops.push({
      step,
      commandId: record.idempotencyKey,
      eventId: record.eventId,
      correlationId: record.correlationId,
      causationId: record.causationId,
      aggregateKind: record.aggregateKind,
      aggregateId: record.aggregateId,
      citedIds,
    });
  };
  commandHops('model-ingress', {
    commandName: run.modelIngress.proposal.commandName,
    idempotencyKey: run.modelIngress.proposal.idempotencyKey,
    correlationId: run.modelIngress.proposal.causality.correlationId,
    causationId: run.modelIngress.proposal.causality.causationId,
    eventId: run.modelIngress.event.eventId,
    eventName: run.modelIngress.event.envelope.eventName,
    aggregateKind: run.modelIngress.event.envelope.entityRefs.after?.entityKind ?? null,
    aggregateId: run.modelIngress.event.envelope.entityRefs.after?.entityId ?? null,
  } as ChainCommandRecord, [
    run.modelIngress.event.eventId,
    run.modelIngress.element.entityId,
    run.modelIngress.modelVersion.entityId,
    run.modelIngress.model.entityId,
  ]);
  commandHops('cost-impact', run.costImpact.command, [
    run.modelIngress.event.eventId,
    run.costImpact.command.eventId,
    run.costImpact.budgetId,
    run.costImpact.costItemId,
  ]);
  commandHops('schedule-ingress', run.scheduleIngress.command, [
    run.modelIngress.event.eventId,
    run.scheduleIngress.command.eventId,
    run.scheduleIngress.scheduleId,
    run.scheduleIngress.activityId,
  ]);
  hops.push({
    step: 'change-evidence',
    commandId: run.modelIngress.proposal.idempotencyKey,
    eventId: null,
    correlationId: run.approval.submitted.correlationId,
    causationId: run.modelIngress.event.eventId,
    aggregateKind: run.constructionIngress.changeEvent.entityKind,
    aggregateId: run.constructionIngress.changeEvent.entityId,
    citedIds: [...run.evidence.citedEventIds, ...run.evidence.citedEntityIds],
  });
  commandHops('approval-submitted', run.approval.submitted, [
    run.modelIngress.event.eventId,
    run.approval.submitted.eventId,
    run.approval.instanceId,
    run.constructionIngress.changeEvent.entityId,
  ]);
  commandHops('approval-decided', run.approval.decided, [
    run.approval.submitted.eventId,
    run.approval.decided.eventId,
    run.approval.instanceId,
  ]);
  commandHops('execution', run.execution.command, [
    run.approval.decided.eventId,
    run.execution.command.eventId,
    run.execution.commitmentId,
    run.costImpact.costItemId,
  ]);
  const procurementIds = run.observers.procurement.recommendations.map(
    (recommendation) => recommendation.recommendationId,
  );
  const recoveryIds = run.observers.revenue.candidates.map(
    (candidate) => candidate.candidateId,
  );
  hops.push({
    step: 'observers',
    commandId: run.modelIngress.proposal.idempotencyKey,
    eventId: null,
    correlationId: run.approval.submitted.correlationId,
    causationId: run.modelIngress.event.eventId,
    aggregateKind: null,
    aggregateId: null,
    citedIds: [
      run.modelIngress.event.eventId,
      run.costImpact.command.eventId,
      run.scheduleIngress.command.eventId,
      run.execution.command.eventId,
      ...run.observers.procurement.inputBudgetIds,
      ...run.observers.procurement.inputCommitmentIds,
      ...procurementIds,
      ...recoveryIds,
    ],
  });
  return {
    hops,
    originatingCommandId: run.modelIngress.proposal.idempotencyKey,
    originatingEventId: run.modelIngress.event.eventId,
    correlationId: run.approval.submitted.correlationId,
  };
};
