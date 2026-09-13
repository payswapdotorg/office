// Office intelligence — package-internal test support (OFF-015).
//
// NOT part of the public surface: deterministic factories for the golden
// completed-project scenarios the memory suite derives its outcomes from.
// The scenarios consume the REAL landed engines exactly the way the runtime
// will: ledger-shaped streams through the @office/events conventions
// (commands cause events), the relationship engine's authorization-filtered
// traversal subgraphs, the margin engine's commercial facts fold + impact
// calculation (the typed outcome inputs), and the memory module's own
// derivation. Fixed clock, fixed ids, fixed correlation/causation tokens:
// no Date.now, no Math.random, no environment.
import {
  CURRENT_SCHEMA_VERSION,
  formatEntityId,
  formatProjectId,
  formatTenantId,
  parseCommandEnvelope,
  parseDomainEventEnvelope,
  parseIdempotencyKey,
  parseTimestamp,
} from '@office/contracts';
import type {
  Actor,
  Causality,
  CommandEnvelope,
  DomainEventEnvelope,
  EntityId,
  EntityRef,
  IdempotencyKey,
  Scope,
  Timestamp,
} from '@office/contracts';
import { causedByCommand } from '@office/events';
import type { LedgerEvent } from '@office/events';
import {
  createInMemoryEventSource,
  projectRelationships,
  traverseRelationships,
} from '@office/intelligence-relationships';
import type { InMemoryEventSource, TraversalSubgraph } from '@office/intelligence-relationships';
import {
  ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
  CHANGE_EVENT_KIND,
  calculateImpact,
  parseAssessmentId,
  projectCommercialFacts,
} from '@office/intelligence-margin';
import type {
  AssessmentAuthorization,
  CommercialFacts,
  ImpactAssessment,
} from '@office/intelligence-margin';
import { authorizationContext, definePolicy } from '@office/authz';
import type { Policy } from '@office/authz';
import { deriveOutcome } from './outcome';
import { parseBenchmarkId, parseLessonId, parseOutcomeId } from './vocabulary';
import type { BenchmarkId, LessonId, OutcomeId } from './vocabulary';
import { benchmarkComputedEnvelope, lessonCapturedEnvelope, outcomeRecordedEnvelope } from './memory-events';
import type { MemoryCausality } from './memory-events';
import { captureLesson } from './lesson';
import type { Lesson } from './model';
import type { MemoryAuthorization } from './authorization';

/** Unwrap a typed Result (failures are test bugs — loud, never silent). */
export const unwrap = <T, E = unknown>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E },
): T => {
  if (result.ok) return result.value;
  throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
};

// ---------------------------------------------------------------------------
// The fixed deterministic clock + identities (no wall time anywhere).
// ---------------------------------------------------------------------------

/** The fixed test clock (deterministic — replayed streams replay exactly). */
export const T0: Timestamp = unwrap(parseTimestamp('2026-09-12T08:00:00.000Z'));
export const T1: Timestamp = unwrap(parseTimestamp('2026-09-13T09:30:00.000Z'));
export const T2: Timestamp = unwrap(parseTimestamp('2026-09-14T11:45:00.000Z'));
export const T3: Timestamp = unwrap(parseTimestamp('2026-09-15T14:15:00.000Z'));
export const T4: Timestamp = unwrap(parseTimestamp('2026-09-16T16:45:00.000Z'));
export const T5: Timestamp = unwrap(parseTimestamp('2026-09-17T10:00:00.000Z'));

/** Two tenants (A12 isolation tests run in BOTH directions). */
export const TENANT_A = formatTenantId({
  version: 'v1',
  opaque: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
});
export const TENANT_B = formatTenantId({
  version: 'v1',
  opaque: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
});

/** Three completed projects of tenant A (the benchmark outcome set). */
export const PROJECT_1 = formatProjectId({
  version: 'v1',
  opaque: '1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
});
export const PROJECT_2 = formatProjectId({
  version: 'v1',
  opaque: 'a9f8e7d6c5b4a39281706f5e4d3c2b10',
});
export const PROJECT_3 = formatProjectId({
  version: 'v1',
  opaque: '3c4d5e6f708192a3b4c5d6e7f8a9a1b2',
});

/** One completed project of tenant B (the cross-tenant probe outcome). */
export const PROJECT_B1 = formatProjectId({
  version: 'v1',
  opaque: 'b1a0f9e8d7c6b5a4938271605f4e3d2c',
});

/** The fixed acting user (a canonical actor, not a provider identity). */
export const ACTOR_ID = formatEntityId({
  version: 'v1',
  opaque: 'b2c3d4e5f60718293a4b5c6d7e8f9a1',
});
export const USER_ACTOR: Actor = { kind: 'user', actorId: ACTOR_ID };

export const projectOneScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_1,
});
export const projectTwoScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_2,
});
export const projectThreeScope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_A,
  projectId: PROJECT_3,
});
export const projectB1Scope = (): Scope => ({
  kind: 'project',
  tenantId: TENANT_B,
  projectId: PROJECT_B1,
});
/** Tenant-A-wide scope (covers every tenant-A project resource). */
export const tenantAWideScope = (): Scope => ({ kind: 'tenant', tenantId: TENANT_A });
/** Tenant-B-wide scope (the foreign reader of the A12 both-direction probes). */
export const tenantBWideScope = (): Scope => ({ kind: 'tenant', tenantId: TENANT_B });

/** Deterministic entity ids: <prefix><n> padded to the 16-char opaque minimum. */
export const testId = (prefix: string, n: number): EntityId =>
  formatEntityId({ version: 'v1', opaque: `${prefix}${String(n).padStart(13, '0')}` });

/** Deterministic idempotency keys (the causation tokens of command roots). */
export const testKey = (n: number): IdempotencyKey =>
  unwrap(parseIdempotencyKey(`test-key-${String(n).padStart(4, '0')}`));

/** Deterministic correlation ids (one per causal chain). */
export const testCorrelationId = (n: number): string => `corr-${String(n).padStart(8, '0')}`;

/** Deterministic record identities of the three memory kinds. */
export const testOutcomeId = (n: number): OutcomeId =>
  unwrap(parseOutcomeId(`outcome-${String(n).padStart(6, '0')}`));
export const testBenchmarkId = (n: number): BenchmarkId =>
  unwrap(parseBenchmarkId(`benchmark-${String(n).padStart(6, '0')}`));
export const testLessonId = (n: number): LessonId =>
  unwrap(parseLessonId(`lesson-${String(n).padStart(6, '0')}`));

/** Deterministic assessment identities (the margin engine's tokens). */
export const testAssessmentId = (n: number) => unwrap(parseAssessmentId(`assessment-${String(n).padStart(4, '0')}`));

// ---------------------------------------------------------------------------
// Ledger-shaped stream factories (the @office/events conventions).
// ---------------------------------------------------------------------------

/** Build one canonical CommandEnvelope (trusted path, self-checked). */
export const testCommand = (parts: {
  readonly commandName: string;
  readonly scope: Scope;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly issuedAt: Timestamp;
}): CommandEnvelope =>
  unwrap(
    parseCommandEnvelope({
      kind: 'command',
      commandName: parts.commandName,
      scope: parts.scope,
      actor: USER_ACTOR,
      idempotencyKey: parts.idempotencyKey,
      causality: {
        correlationId: parts.correlationId,
        causationId: null,
      },
      issuedAt: parts.issuedAt,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      payload: {},
    }),
  );

/** Build one canonical DomainEventEnvelope (trusted path, self-checked). */
export const testEventEnvelope = (parts: {
  readonly eventName: string;
  readonly scope: Scope;
  readonly causality: Causality;
  readonly occurredAt: Timestamp;
  readonly aggregate: EntityRef;
  readonly payload: Record<string, unknown>;
}): DomainEventEnvelope =>
  unwrap(
    parseDomainEventEnvelope({
      kind: 'event',
      eventName: parts.eventName,
      scope: parts.scope,
      actor: USER_ACTOR,
      source: 'domain',
      causality: parts.causality,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      occurredAt: parts.occurredAt,
      entityRefs: { before: null, after: parts.aggregate },
      payload: parts.payload,
    }),
  );

/** Create the shared in-memory ledger-shaped event source (tests). */
export const newEventSource = (): InMemoryEventSource => createInMemoryEventSource();

/** Append one ledger-shaped event caused by its command (the OFF-005 convention). */
export const appendCommandEvent = async (
  source: InMemoryEventSource,
  parts: {
    readonly command: CommandEnvelope;
    readonly eventName: string;
    readonly scope: Scope;
    readonly occurredAt: Timestamp;
    readonly aggregate: EntityRef;
    readonly payload: Record<string, unknown>;
  },
): Promise<LedgerEvent> =>
  unwrap(
    await source.append(
      testEventEnvelope({
        eventName: parts.eventName,
        scope: parts.scope,
        causality: causedByCommand(parts.command),
        occurredAt: parts.occurredAt,
        aggregate: parts.aggregate,
        payload: parts.payload,
      }),
      parts.aggregate,
    ),
  );

// ---------------------------------------------------------------------------
// Authorization factories (deterministic, deny-by-default probes).
// ---------------------------------------------------------------------------

/** Every area read capability a margin assessment (the outcome input) requires. */
export const ALL_ASSESSMENT_CAPABILITIES: readonly string[] = [
  ...ASSESSMENT_REQUIRED_CAPABILITY_NAMES,
];

/** Every area read capability a memory read requires. */
export const ALL_MEMORY_CAPABILITIES: readonly string[] = [
  'contracts.read',
  'cost.read',
  'schedule.read',
];

/** The allow-all-reads policy: every read within the caller's covered scope. */
export const ALLOW_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'allow', actions: ['read'] },
]);

/** The explicit-deny-every-read policy (explicit deny wins over any allow). */
export const DENY_ALL_READS_POLICY: Policy = definePolicy([
  { effect: 'deny', actions: ['read'] },
]);

/** The empty policy — no rules at all (deny-by-default, 'no-allow-rule'). */
export const EMPTY_POLICY: Policy = definePolicy([]);

/**
 * A margin-assessment authorization for the fixed test user (the reader the
 * golden completed-project scenarios are assessed under).
 */
export const assessmentReaderOf = (scope: Scope): AssessmentAuthorization => ({
  policy: ALLOW_ALL_READS_POLICY,
  context: authorizationContext({
    actor: USER_ACTOR,
    scope,
    capabilities: ALL_ASSESSMENT_CAPABILITIES,
  }),
});

/**
 * A memory authorization for the fixed test user: the given scope, the given
 * capabilities (default: every required memory read), and the given policy
 * (default: allow-all-reads). Capability/policy combos are the A12 and
 * capability-missing probes of the memory tests.
 */
export const memoryReaderOf = (
  scope: Scope,
  parts: {
    readonly capabilities?: readonly string[];
    readonly policy?: Policy;
  } = {},
): MemoryAuthorization => ({
  policy: parts.policy ?? ALLOW_ALL_READS_POLICY,
  context: authorizationContext({
    actor: USER_ACTOR,
    scope,
    capabilities: parts.capabilities ?? ALL_MEMORY_CAPABILITIES,
  }),
});

// ---------------------------------------------------------------------------
// THE golden completed-project scenarios — deterministic specs whose streams
// the REAL engines fold: relationships traversal → margin facts + impact
// assessments → deriveOutcome. Every number below is chosen so the derived
// outcome metrics are distinct, exact, and hand-checkable.
// ---------------------------------------------------------------------------

/** One change order of a completed project, linked to its first change event. */
export interface OrderSpec {
  readonly valueMinor: number;
  readonly decision: 'approved' | 'rejected' | 'executed' | 'pending';
}

/** The typed spec of one golden completed-project stream. */
export interface CompletedProjectSpec {
  /** The id seed (every entity id of the stream derives from it). */
  readonly seed: number;
  /** The project scope the whole stream is recorded under. */
  readonly scope: Scope;
  /** The contract's original value (integer minor units, USD). */
  readonly contractValueMinor: number;
  /** The pre-change budget cost item amount (CI1). */
  readonly budgetItemMinor: number;
  /** The commitment amount (CM1). */
  readonly commitmentMinor: number;
  /** The post-change budget revision + cost item amount (CI2), or none. */
  readonly postChangeItemMinor: number | null;
  /** The change orders linked to the first change event. */
  readonly orders: readonly OrderSpec[];
  /** The single activity's planned duration (the pre-change basis). */
  readonly plannedDurationDays: number;
  /** The post-change duration assertion, or null (no schedule change). */
  readonly updatedDurationDays: number | null;
  /** How many change events the project raised (change pressure). */
  readonly changeEventCount: number;
  /** How many assessments were recorded before close-out. */
  readonly assessmentCount: number;
}

/** The entity ids one completed-project stream derives from its seed. */
export interface ProjectIds {
  readonly contractId: EntityId;
  readonly budgetId: EntityId;
  readonly costItem1Id: EntityId;
  readonly costItem2Id: EntityId;
  readonly commitmentId: EntityId;
  readonly budgetRevisionId: EntityId;
  readonly scheduleId: EntityId;
  readonly activityId: EntityId;
  readonly changeEventIds: readonly EntityId[];
  readonly changeOrderIds: readonly EntityId[];
}

export const projectIdsOf = (spec: CompletedProjectSpec): ProjectIds => ({
  contractId: testId('con', spec.seed),
  budgetId: testId('bud', spec.seed),
  costItem1Id: testId('cst', spec.seed * 10 + 1),
  costItem2Id: testId('cst', spec.seed * 10 + 2),
  commitmentId: testId('cmt', spec.seed),
  budgetRevisionId: testId('brv', spec.seed),
  scheduleId: testId('sch', spec.seed),
  activityId: testId('act', spec.seed),
  changeEventIds: Array.from({ length: spec.changeEventCount }, (_value, index) =>
    testId('chg', spec.seed * 10 + index),
  ),
  changeOrderIds: spec.orders.map((_order, index) => testId('ord', spec.seed * 10 + index)),
});

/**
 * Build ONE golden completed-project ledger stream: schedule + activity +
 * baseline, the contract, the budget with its pre-change item + commitment,
 * the change event(s), the post-change duration/cost assertions, and the
 * change orders with their decisions.
 */
export const buildCompletedProject = async (
  source: InMemoryEventSource,
  spec: CompletedProjectSpec,
): Promise<readonly LedgerEvent[]> => {
  const ids = projectIdsOf(spec);
  const scope = spec.scope;
  let commandKey = 0;
  const append = (parts: {
    readonly commandName: string;
    readonly eventName: string;
    readonly occurredAt: Timestamp;
    readonly aggregate: EntityRef;
    readonly payload: Record<string, unknown>;
  }): Promise<LedgerEvent> => {
    commandKey += 1;
    return appendCommandEvent(source, {
      command: testCommand({
        commandName: parts.commandName,
        scope,
        idempotencyKey: testKey(commandKey),
        correlationId: testCorrelationId(commandKey),
        issuedAt: T0,
      }),
      eventName: parts.eventName,
      scope,
      occurredAt: parts.occurredAt,
      aggregate: parts.aggregate,
      payload: parts.payload,
    });
  };

  const scheduleAggregate: EntityRef = {
    entityKind: 'schedule' as EntityRef['entityKind'],
    entityId: ids.scheduleId,
  };
  const contractAggregate: EntityRef = {
    entityKind: 'contract' as EntityRef['entityKind'],
    entityId: ids.contractId,
  };
  const budgetAggregate: EntityRef = {
    entityKind: 'budget' as EntityRef['entityKind'],
    entityId: ids.budgetId,
  };
  const commitmentAggregate: EntityRef = {
    entityKind: 'commitment' as EntityRef['entityKind'],
    entityId: ids.commitmentId,
  };

  // The pre-change history (positions before the change-event boundary).
  await append({
    commandName: 'schedule.createSchedule',
    eventName: 'schedule.scheduleCreated',
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: { scheduleId: ids.scheduleId, name: 'Fit-out schedule', version: 1, createdAt: T0 },
  });
  await append({
    commandName: 'schedule.addActivity',
    eventName: 'schedule.activityAdded',
    occurredAt: T0,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: ids.scheduleId,
      activityId: ids.activityId,
      code: 'A0',
      name: 'Fit-out works',
      plannedDuration: spec.plannedDurationDays,
      parentActivityId: null,
      version: 2,
    },
  });
  await append({
    commandName: 'schedule.setBaseline',
    eventName: 'schedule.baselineSet',
    occurredAt: T1,
    aggregate: scheduleAggregate,
    payload: {
      scheduleId: ids.scheduleId,
      baselineId: testId('bas', spec.seed),
      sequence: 1,
      label: 'Baseline B1',
      supersedes: null,
      activityCount: 1,
      dependencyCount: 0,
      milestoneCount: 0,
      version: 3,
      createdAt: T1,
    },
  });
  await append({
    commandName: 'contracts.createContract',
    eventName: 'contracts.contractCreated',
    occurredAt: T1,
    aggregate: contractAggregate,
    payload: {
      contractId: ids.contractId,
      title: 'Fit-out works contract',
      version: 1,
      contractValue: { amount: spec.contractValueMinor, currency: 'USD' },
      executionStatus: 'draft',
      createdAt: T1,
    },
  });
  await append({
    commandName: 'cost.createBudget',
    eventName: 'cost.budgetCreated',
    occurredAt: T1,
    aggregate: budgetAggregate,
    payload: {
      budgetId: ids.budgetId,
      name: 'Fit-out budget',
      currency: 'USD',
      version: 1,
      createdAt: T1,
    },
  });
  await append({
    commandName: 'cost.recordCostItem',
    eventName: 'cost.costItemRecorded',
    occurredAt: T1,
    aggregate: budgetAggregate,
    payload: {
      budgetId: ids.budgetId,
      costItemId: ids.costItem1Id,
      code: '02-41-00',
      description: 'Fit-out works package',
      unit: 'lot',
      quantityMilli: 1000,
      unitRateMinor: 1000,
      amountMinor: spec.budgetItemMinor,
      version: 2,
    },
  });
  await append({
    commandName: 'cost.createCommitment',
    eventName: 'cost.commitmentCreated',
    occurredAt: T1,
    aggregate: commitmentAggregate,
    payload: {
      commitmentId: ids.commitmentId,
      budgetId: ids.budgetId,
      number: 'SUB-101',
      commitmentKind: 'subcontract',
      description: 'Fit-out subcontract',
      lineCount: 1,
      committedAmountMinor: spec.commitmentMinor,
      version: 1,
      createdAt: T1,
    },
  });

  // The change events (the boundary the assessments measure against). The
  // first one carries the impacts; the rest only count (change pressure).
  for (const [index, changeEventId] of ids.changeEventIds.entries()) {
    await append({
      commandName: 'contracts.raiseChangeEvent',
      eventName: 'contracts.changeEventRaised',
      occurredAt: T2,
      aggregate: contractAggregate,
      payload: {
        contractId: ids.contractId,
        changeEventId,
        title: index === 0 ? 'Fit-out scope amendment' : 'Fit-out sequencing note',
        changeType: index === 0 ? 'scope' : 'scope',
        status: 'proposed',
        affectedObligationIds: [],
        evidenceLinks: [],
        costImpactLinks:
          index === 0
            ? [{ budgetId: ids.budgetId, costItemId: null }]
            : [],
        scheduleImpactActivityIds: index === 0 ? [ids.activityId] : [],
        version: 3 + index,
      },
    });
  }

  // The post-change assertions (positions after the boundary).
  if (spec.updatedDurationDays !== null) {
    await append({
      commandName: 'schedule.updateActivity',
      eventName: 'schedule.activityUpdated',
      occurredAt: T2,
      aggregate: scheduleAggregate,
      payload: {
        scheduleId: ids.scheduleId,
        activityId: ids.activityId,
        code: 'A0',
        plannedDuration: spec.updatedDurationDays,
        version: 4 + spec.changeEventCount,
        updatedAt: T2,
      },
    });
  }
  if (spec.postChangeItemMinor !== null) {
    await append({
      commandName: 'cost.reviseBudget',
      eventName: 'cost.budgetRevised',
      occurredAt: T3,
      aggregate: budgetAggregate,
      payload: {
        budgetId: ids.budgetId,
        revisionId: ids.budgetRevisionId,
        sequence: 1,
        label: 'Re-baseline after fit-out change',
        supersedes: null,
        costItemCount: 1,
        version: 5 + spec.changeEventCount,
        createdAt: T3,
      },
    });
    await append({
      commandName: 'cost.recordCostItem',
      eventName: 'cost.costItemRecorded',
      occurredAt: T3,
      aggregate: budgetAggregate,
      payload: {
        budgetId: ids.budgetId,
        costItemId: ids.costItem2Id,
        code: '02-41-10',
        description: 'Additional fit-out works',
        unit: 'lot',
        quantityMilli: 1000,
        unitRateMinor: 1000,
        amountMinor: spec.postChangeItemMinor,
        version: 6 + spec.changeEventCount,
      },
    });
  }

  // The change orders (all linked to the first change event).
  for (const [index, order] of spec.orders.entries()) {
    const changeOrderId = ids.changeOrderIds[index];
    if (changeOrderId === undefined) throw new Error('order id mismatch');
    await append({
      commandName: 'contracts.submitChangeOrder',
      eventName: 'contracts.changeOrderSubmitted',
      occurredAt: T4,
      aggregate: contractAggregate,
      payload: {
        contractId: ids.contractId,
        changeOrderId,
        changeEventId: ids.changeEventIds[0],
        title: `CO-${String(index + 1).padStart(2, '0')} fit-out amendment`,
        changeValue: { amount: order.valueMinor, currency: 'USD' },
        status: 'submitted',
        version: 7 + spec.changeEventCount + index,
      },
    });
    if (order.decision === 'approved' || order.decision === 'rejected') {
      await append({
        commandName:
          order.decision === 'approved'
            ? 'contracts.approveChangeOrder'
            : 'contracts.rejectChangeOrder',
        eventName:
          order.decision === 'approved'
            ? 'contracts.changeOrderApproved'
            : 'contracts.changeOrderRejected',
        occurredAt: T4,
        aggregate: contractAggregate,
        payload: {
          contractId: ids.contractId,
          changeOrderId,
          status: order.decision,
          decidedAt: T4,
          version: 8 + spec.changeEventCount + index,
        },
      });
    }
    if (order.decision === 'executed') {
      await append({
        commandName: 'contracts.executeChangeOrder',
        eventName: 'contracts.changeOrderExecuted',
        occurredAt: T4,
        aggregate: contractAggregate,
        payload: {
          contractId: ids.contractId,
          changeOrderId,
          status: 'executed',
          executedAt: T4,
          version: 8 + spec.changeEventCount + index,
        },
      });
    }
  }

  return unwrap(await source.readEvents());
};

/** One completed project's full deterministic pipeline output. */
export interface CompletedProjectRun {
  readonly spec: CompletedProjectSpec;
  readonly ids: ProjectIds;
  readonly stream: readonly LedgerEvent[];
  readonly facts: CommercialFacts;
  readonly subgraph: TraversalSubgraph;
  readonly assessments: readonly ImpactAssessment[];
}

/**
 * Run ONE golden completed project through the REAL engines: fold the
 * commercial facts, traverse the authorization-filtered subgraph around the
 * first change event, and calculate the recorded assessments (one per
 * assessmentCount, distinct deterministic ids, the fixed assessment clock).
 */
export const runCompletedProject = async (
  spec: CompletedProjectSpec,
): Promise<CompletedProjectRun> => {
  const source = newEventSource();
  const stream = await buildCompletedProject(source, spec);
  const ids = projectIdsOf(spec);
  const reader = assessmentReaderOf(spec.scope);
  const index = unwrap(projectRelationships(stream));
  const firstChangeEventId = ids.changeEventIds[0];
  if (firstChangeEventId === undefined) {
    throw new Error('spec has no change events');
  }
  const subgraph = unwrap(
    traverseRelationships(
      index,
      { start: { entityKind: CHANGE_EVENT_KIND, entityId: firstChangeEventId }, maxDepth: 2 },
      { policy: reader.policy, context: reader.context },
    ),
  );
  const facts = unwrap(projectCommercialFacts(stream));
  const changeEvent = stream.find(
    (event) => event.envelope.eventName === 'contracts.changeEventRaised',
  );
  if (changeEvent === undefined) throw new Error('stream has no change event');
  const changeEventLedgerId = changeEvent.eventId;
  const assessments: ImpactAssessment[] = [];
  for (let number = 1; number <= spec.assessmentCount; number += 1) {
    assessments.push(
      unwrap(
        calculateImpact(
          { sourceEventId: changeEventLedgerId },
          { facts, subgraph },
          reader,
          { assessmentId: testAssessmentId(spec.seed * 10 + number), assessedAt: T5 },
        ),
      ),
    );
  }
  return { spec, ids, stream, facts, subgraph, assessments };
};

/** The recorded OutcomeRecord of one golden completed project (T5 clock). */
export const outcomeOfRun = (run: CompletedProjectRun) =>
  unwrap(
    deriveOutcome(
      { facts: run.facts, assessments: run.assessments },
      {
        outcomeId: testOutcomeId(run.spec.seed),
        recordedAt: T5,
        actor: USER_ACTOR,
        scope: run.spec.scope,
      },
    ),
  );

// ---------------------------------------------------------------------------
// THE three tenant-A golden completed projects + the tenant-B probe project.
// Numbers chosen for distinct, hand-checkable outcome metrics.
// ---------------------------------------------------------------------------

/** Project 1: one approved order, +3 days schedule variance, 1 change event. */
export const GOLDEN_PROJECT_ONE: CompletedProjectSpec = {
  seed: 1,
  scope: projectOneScope(),
  contractValueMinor: 10000000,
  budgetItemMinor: 6000000,
  commitmentMinor: 5000000,
  postChangeItemMinor: 1000000,
  orders: [{ valueMinor: 2000000, decision: 'approved' }],
  plannedDurationDays: 10,
  updatedDurationDays: 13,
  changeEventCount: 1,
  assessmentCount: 2,
};

/** Project 2: one rejected order, no schedule change, 2 change events. */
export const GOLDEN_PROJECT_TWO: CompletedProjectSpec = {
  seed: 2,
  scope: projectTwoScope(),
  contractValueMinor: 20000000,
  budgetItemMinor: 8000000,
  commitmentMinor: 7000000,
  postChangeItemMinor: null,
  orders: [{ valueMinor: 3000000, decision: 'rejected' }],
  plannedDurationDays: 10,
  updatedDurationDays: null,
  changeEventCount: 2,
  assessmentCount: 1,
};

/** Project 3: one pending order, +2 days schedule variance, 1 change event. */
export const GOLDEN_PROJECT_THREE: CompletedProjectSpec = {
  seed: 3,
  scope: projectThreeScope(),
  contractValueMinor: 8000000,
  budgetItemMinor: 5000000,
  commitmentMinor: 4000000,
  postChangeItemMinor: 500000,
  orders: [{ valueMinor: 1000000, decision: 'pending' }],
  plannedDurationDays: 8,
  updatedDurationDays: 10,
  changeEventCount: 1,
  assessmentCount: 1,
};

/** The tenant-B probe project (one approved order, no schedule change). */
export const GOLDEN_PROJECT_B1: CompletedProjectSpec = {
  seed: 4,
  scope: projectB1Scope(),
  contractValueMinor: 5000000,
  budgetItemMinor: 3000000,
  commitmentMinor: 2500000,
  postChangeItemMinor: null,
  orders: [{ valueMinor: 500000, decision: 'executed' }],
  plannedDurationDays: 6,
  updatedDurationDays: null,
  changeEventCount: 1,
  assessmentCount: 1,
};

// ---------------------------------------------------------------------------
// Memory-event stream factories (the rebuild input of the store tests).
// ---------------------------------------------------------------------------

/** One memory-event append: the built envelope + the aggregate it belongs to. */
export interface MemoryAppend {
  readonly envelope: DomainEventEnvelope;
  readonly aggregate: EntityRef;
}

/** The outcome-recorded append of one derived outcome. */
export const outcomeAppendOf = (outcome: ReturnType<typeof outcomeOfRun>): MemoryAppend => ({
  envelope: unwrap(outcomeRecordedEnvelope(outcome)),
  aggregate: { entityKind: 'project' as EntityRef['entityKind'], entityId: outcome.projectId },
});

/** The benchmark-computed append of one computed benchmark (anchored causality). */
export const benchmarkAppendOf = (
  benchmark: Parameters<typeof benchmarkComputedEnvelope>[0],
  causality: MemoryCausality,
): MemoryAppend => ({
  envelope: unwrap(benchmarkComputedEnvelope(benchmark, causality)),
  aggregate: { entityKind: 'project' as EntityRef['entityKind'], entityId: benchmark.scope.kind === 'project' ? benchmark.scope.projectId : testId('agg', benchmark.outcomeCount) },
});

/** The lesson-captured append of one captured lesson (its first link's entity). */
export const lessonAppendOf = (
  lesson: Lesson,
  causality: MemoryCausality,
): MemoryAppend => ({
  envelope: unwrap(lessonCapturedEnvelope(lesson, causality)),
  aggregate:
    lesson.links[0] === undefined
      ? { entityKind: 'project' as EntityRef['entityKind'], entityId: lesson.scope.kind === 'project' ? lesson.scope.projectId : testId('agg', 0) }
      : lesson.links[0].entity,
});

/** captureLesson unwrapped (the trusted-path test factory). */
export const captureLessonOk = (
  content: Parameters<typeof captureLesson>[0],
  identity: Parameters<typeof captureLesson>[1],
): Lesson => unwrap(captureLesson(content, identity));

/** Build the ledger events of one memory-event append list (in order). */
export const memoryLedgerOf = async (
  appends: readonly MemoryAppend[],
): Promise<readonly LedgerEvent[]> => {
  const source = newEventSource();
  for (const append of appends) {
    unwrap(await source.append(append.envelope, append.aggregate));
  }
  return unwrap(await source.readEvents());
};

/** The causality anchor of one ledger event (correlation carried over). */
export const causalityOf = (event: LedgerEvent): MemoryCausality => ({
  correlationId: event.envelope.causality.correlationId,
  causationId: event.eventId,
});
