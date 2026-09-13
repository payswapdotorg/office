// Office intelligence — memory events + the sink port (OFF-015).
//
// Every recorded outcome, computed benchmark snapshot, and captured lesson
// emits exactly ONE DomainEventEnvelope through the MemoryEventSink port,
// mirroring the landed packages' EventSink shape byte-for-byte in structure
// (appendEvents(executor, events) inside the CALLER's transaction — see
// packages/domain/*/src/events.ts and the margin engine's mirrored
// AssessmentEventSink): downstream consumers OFF-018/019/034/035 treat
// memory like any other derived stream, and the store projection folds the
// same three event names back into the rebuildable memory store (A7).
//
// The envelope payloads are the JSON-safe summaries of the typed records;
// the fail-closed parsers in this module reconstruct the EXACT typed
// records from those payloads (the fold's rebuild path). A documented
// local structural type (the dependency rule forbids importing the owning
// package): MemorySinkExecutor mirrors @office/persistence's SqlExecutor
// surface — a real implementation receives the caller's open transaction
// executor exactly like the domain sinks do.
//
// Causality (A3): the outcome event is CAUSED BY the terminal assessed
// change event (its ledger id — the events package's causedByEvent
// convention) with the assessment chain's correlation id carried over.
// Benchmark/lesson envelopes take their causality from the caller (the
// runtime anchors a benchmark at its last outcome-recorded event; a
// human lesson is a new causal root with no causation id).
import {
  CURRENT_SCHEMA_VERSION,
  isActor,
  isEntityId,
  isEventName,
  isScope,
  isTimestamp,
  parseDomainEventEnvelope,
} from '@office/contracts';
import type { Actor, DomainEventEnvelope, EntityRef, Scope, Timestamp } from '@office/contracts';
import { isLedgerEventId } from '@office/events';
import type { LedgerEventId } from '@office/events';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { parseAssessmentId, parseCurrencyCode } from '@office/intelligence-margin';
import type { EntityId } from '@office/contracts';
import {
  BENCHMARK_COMPUTED_EVENT,
  LESSON_CAPTURED_EVENT,
  OUTCOME_RECORDED_EVENT,
  parseBenchmarkId,
  parseLessonId,
  parseOutcomeId,
} from './vocabulary';
import { compareAssessmentSources, compareLessonLinks, compareLessonTags } from './model';
import type {
  Benchmark,
  BenchmarkMetricStats,
  BenchmarkPosition,
  ChangePressureOutcome,
  ContractMarginPosition,
  EntitlementOrderOutcome,
  EntitlementOutcome,
  Lesson,
  LessonLink,
  LessonTag,
  MarginOutcome,
  OutcomeAssessmentSource,
  OutcomeEventSource,
  OutcomeRecord,
  Rational,
  ScheduleOutcome,
} from './model';

// ---------------------------------------------------------------------------
// The sink executor port (local structural mirror of SqlExecutor).
// ---------------------------------------------------------------------------

/**
 * The executor surface a memory sink needs (a local structural mirror of
 * @office/persistence's SqlExecutor — that package is not importable from
 * the intelligence layer; the shape is the port, mirroring the landed
 * domain EventSink convention exactly).
 */
export interface MemorySinkExecutor {
  readonly query: (
    text: string,
    values?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

// ---------------------------------------------------------------------------
// The EventSink port (mirrors the landed domain packages' shape).
// ---------------------------------------------------------------------------

/**
 * THE memory event sink port: append memory events inside the caller's
 * transaction (the executor it hands over). A failure result MUST abort
 * the surrounding write, exactly like the domain packages' EventSink.
 */
export interface MemoryEventSink {
  /**
   * Append `events` inside the transaction of `executor`. A failure result
   * MUST abort the surrounding mutation, so a partially-applied write can
   * never commit.
   */
  appendEvents(
    executor: MemorySinkExecutor,
    events: readonly DomainEventEnvelope[],
  ): Promise<Result<true, DomainError>>;
}

/** One recorded append of the in-memory sink (test introspection). */
export interface RecordedMemoryAppend {
  readonly executor: MemorySinkExecutor;
  readonly events: readonly DomainEventEnvelope[];
}

/** The in-memory memory event sink: records appends instead of writing (tests). */
export interface InMemoryMemoryEventSink extends MemoryEventSink {
  /** Every append call, in order (executor + events). */
  readonly appends: readonly RecordedMemoryAppend[];
  /** Every recorded event, flattened across appends, in order. */
  readonly events: readonly DomainEventEnvelope[];
}

/** Create an in-memory memory event sink for deterministic tests. */
export function createInMemoryMemoryEventSink(): InMemoryMemoryEventSink {
  const appends: RecordedMemoryAppend[] = [];
  return {
    appends,
    get events(): readonly DomainEventEnvelope[] {
      return appends.flatMap((append) => append.events);
    },
    appendEvents: async (executor, events) => {
      appends.push({ executor, events: [...events] });
      return ok(true);
    },
  };
}

/** Build a typed sink failure (for tests and wiring guards). */
export const memorySinkFailure = (
  reason: string,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `memory event sink rejected the append: ${reason}`,
    [{ code: 'memory-sink-rejected', message: reason, path: null }],
    context,
  );

/** Convenience: a sink that always fails with a typed error (tests/limits). */
export const failingMemoryEventSink = (reason: string): MemoryEventSink => ({
  appendEvents: async () => fail(memorySinkFailure(reason)),
});

// ---------------------------------------------------------------------------
// Fail-closed payload readers (typed errors carry the field path).
// ---------------------------------------------------------------------------

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const payloadFailure = (
  code: string,
  path: string,
  expected: string,
  received: unknown,
): DomainError =>
  domainError(
    'invariant-violation',
    `memory cannot consume the payload: field '${path}' is not ${expected}`,
    [
      {
        code,
        message: `expected ${expected} at '${path}', received ${JSON.stringify(received)}`,
        path,
      },
    ],
  );

const readRecord = (path: string, raw: unknown): Result<Record<string, unknown>, DomainError> => {
  if (!isRecord(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'an object', raw));
  }
  return ok(raw);
};

const readStrictKeys = (
  path: string,
  record: Record<string, unknown>,
  keys: readonly string[],
): Result<true, DomainError> => {
  const known = new Set<string>(keys);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return fail(payloadFailure('memory-payload-valid', `${path}.${key}`, 'absent (strict keys)', 'present'));
    }
  }
  return ok(true);
};

const readString = (path: string, raw: unknown): Result<string, DomainError> => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail(payloadFailure('memory-payload-valid', path, 'a non-empty string', raw));
  }
  return ok(raw);
};

const readBoundedString = (
  path: string,
  raw: unknown,
  maxLength: number,
): Result<string, DomainError> => {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > maxLength) {
    return fail(payloadFailure('memory-payload-valid', path, `a non-empty string of 1..${maxLength} characters`, raw));
  }
  return ok(raw);
};

const readInteger = (
  path: string,
  raw: unknown,
  min: number,
  max: number,
): Result<number, DomainError> => {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    return fail(payloadFailure('memory-payload-valid', path, `an integer ${min}..${max}`, raw));
  }
  return ok(raw);
};

const readNullable = <T>(
  path: string,
  raw: unknown,
  read: (path: string, raw: unknown) => Result<T, DomainError>,
): Result<T | null, DomainError> => {
  if (raw === null) return ok(null);
  return read(path, raw);
};

const readArray = <T>(
  path: string,
  raw: unknown,
  read: (path: string, raw: unknown) => Result<T, DomainError>,
): Result<readonly T[], DomainError> => {
  if (!Array.isArray(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'an array', raw));
  }
  const values: T[] = [];
  for (const [index, entry] of raw.entries()) {
    const value = read(`${path}[${index}]`, entry);
    if (!value.ok) return value;
    values.push(value.value);
  }
  return ok(values);
};

const readEntityId = (path: string, raw: unknown): Result<EntityId, DomainError> => {
  if (!isEntityId(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical EntityId', raw));
  }
  return ok(raw);
};

const readLedgerEventId = (path: string, raw: unknown): Result<LedgerEventId, DomainError> => {
  if (!isLedgerEventId(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical LedgerEventId', raw));
  }
  return ok(raw);
};

const readTimestamp = (path: string, raw: unknown): Result<Timestamp, DomainError> => {
  if (!isTimestamp(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical Timestamp', raw));
  }
  return ok(raw);
};

const readActor = (path: string, raw: unknown): Result<Actor, DomainError> => {
  if (!isActor(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical Actor', raw));
  }
  return ok(raw);
};

const readScope = (path: string, raw: unknown): Result<Scope, DomainError> => {
  if (!isScope(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical Scope', raw));
  }
  return ok(raw);
};

const readEventName = (path: string, raw: unknown): Result<OutcomeEventSource['eventName'], DomainError> => {
  if (!isEventName(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a canonical EventName', raw));
  }
  return ok(raw);
};

const readRational = (path: string, raw: unknown): Result<Rational, DomainError> => {
  if (!isRecord(raw)) {
    return fail(payloadFailure('memory-payload-valid', path, 'a rational { numerator, denominator }', raw));
  }
  const numerator = readInteger(`${path}.numerator`, raw['numerator'], -9007199254740991, 9007199254740991);
  if (!numerator.ok) return numerator;
  const denominator = readInteger(`${path}.denominator`, raw['denominator'], 1, 9007199254740991);
  if (!denominator.ok) return denominator;
  return ok({ numerator: numerator.value, denominator: denominator.value });
};

const readNullableRational = (
  path: string,
  raw: unknown,
): Result<Rational | null, DomainError> => readNullable(path, raw, readRational);

// ---------------------------------------------------------------------------
// The outcome payload (builder + fail-closed parser).
// ---------------------------------------------------------------------------

const assessmentSourcePayload = (source: OutcomeAssessmentSource): Record<string, unknown> => ({
  kind: 'assessment',
  assessmentId: source.assessmentId,
  assessedAt: source.assessedAt,
  sourceEventId: source.sourceEventId,
  correlationId: source.correlationId,
  changeEventId: source.changeEventId,
  contractId: source.contractId,
});

const eventSourcePayload = (source: OutcomeEventSource): Record<string, unknown> => ({
  kind: 'event',
  eventId: source.eventId,
  eventName: source.eventName,
  occurredAt: source.occurredAt,
});

const evidencePayload = (
  evidence: readonly (OutcomeAssessmentSource | OutcomeEventSource)[],
): readonly Record<string, unknown>[] =>
  evidence.map((entry) =>
    entry.kind === 'assessment' ? assessmentSourcePayload(entry) : eventSourcePayload(entry),
  );

const readAssessmentSource = (
  path: string,
  raw: unknown,
): Result<OutcomeAssessmentSource, DomainError> => {
  const record = readRecord(path, raw);
  if (!record.ok) return record;
  if (!readStrictKeys(path, record.value, ['kind', 'assessmentId', 'assessedAt', 'sourceEventId', 'correlationId', 'changeEventId', 'contractId']).ok) {
    return fail(payloadFailure('memory-payload-valid', path, 'an assessment source { kind, assessmentId, assessedAt, sourceEventId, correlationId, changeEventId, contractId }', raw));
  }
  if (record.value['kind'] !== 'assessment') {
    return fail(payloadFailure('memory-payload-valid', `${path}.kind`, "'assessment'", record.value['kind']));
  }
  const assessmentId = parseAssessmentId(record.value['assessmentId']);
  if (!assessmentId.ok) {
    return fail(payloadFailure('memory-payload-valid', `${path}.assessmentId`, 'an AssessmentId token', record.value['assessmentId']));
  }
  const assessedAt = readTimestamp(`${path}.assessedAt`, record.value['assessedAt']);
  if (!assessedAt.ok) return assessedAt;
  const sourceEventId = readLedgerEventId(`${path}.sourceEventId`, record.value['sourceEventId']);
  if (!sourceEventId.ok) return sourceEventId;
  const correlationId = readString(`${path}.correlationId`, record.value['correlationId']);
  if (!correlationId.ok) return correlationId;
  const changeEventId = readEntityId(`${path}.changeEventId`, record.value['changeEventId']);
  if (!changeEventId.ok) return changeEventId;
  const contractId = readEntityId(`${path}.contractId`, record.value['contractId']);
  if (!contractId.ok) return contractId;
  return ok({
    kind: 'assessment',
    assessmentId: assessmentId.value,
    assessedAt: assessedAt.value,
    sourceEventId: sourceEventId.value,
    correlationId: correlationId.value,
    changeEventId: changeEventId.value,
    contractId: contractId.value,
  } satisfies OutcomeAssessmentSource);
};

const readEventSource = (
  path: string,
  raw: unknown,
): Result<OutcomeEventSource, DomainError> => {
  const record = readRecord(path, raw);
  if (!record.ok) return record;
  if (!readStrictKeys(path, record.value, ['kind', 'eventId', 'eventName', 'occurredAt']).ok) {
    return fail(payloadFailure('memory-payload-valid', path, 'an event source { kind, eventId, eventName, occurredAt }', raw));
  }
  if (record.value['kind'] !== 'event') {
    return fail(payloadFailure('memory-payload-valid', `${path}.kind`, "'event'", record.value['kind']));
  }
  const eventId = readLedgerEventId(`${path}.eventId`, record.value['eventId']);
  if (!eventId.ok) return eventId;
  const eventName = readEventName(`${path}.eventName`, record.value['eventName']);
  if (!eventName.ok) return eventName;
  const occurredAt = readTimestamp(`${path}.occurredAt`, record.value['occurredAt']);
  if (!occurredAt.ok) return occurredAt;
  return ok({
    kind: 'event',
    eventId: eventId.value,
    eventName: eventName.value,
    occurredAt: occurredAt.value,
  } satisfies OutcomeEventSource);
};

const readEvidence = (
  path: string,
  raw: unknown,
): Result<readonly (OutcomeAssessmentSource | OutcomeEventSource)[], DomainError> =>
  readArray(path, raw, (
    entryPath: string,
    entry: unknown,
  ): Result<OutcomeAssessmentSource | OutcomeEventSource, DomainError> => {
    const kind = readRecord(entryPath, entry);
    if (!kind.ok) return kind;
    if (kind.value['kind'] === 'assessment') {
      return readAssessmentSource(entryPath, entry);
    }
    return readEventSource(entryPath, entry);
  });

/** Build the JSON-safe payload of one outcome record. */
export const outcomePayload = (outcome: OutcomeRecord): Record<string, unknown> => ({
  outcomeId: outcome.outcomeId,
  outcomeVersion: outcome.outcomeVersion,
  engine: outcome.engine,
  recordedAt: outcome.recordedAt,
  actor: outcome.actor,
  scope: outcome.scope,
  projectId: outcome.projectId,
  schedule: {
    baselineDurationDays: outcome.schedule.baselineDurationDays,
    finalDurationDays: outcome.schedule.finalDurationDays,
    varianceDays: outcome.schedule.varianceDays,
    sources: outcome.schedule.sources.map(assessmentSourcePayload),
  },
  margin: {
    currency: outcome.margin.currency,
    originalContractedValueMinor: outcome.margin.originalContractedValueMinor,
    contractedValueMinor: outcome.margin.contractedValueMinor,
    committedCostMinor: outcome.margin.committedCostMinor,
    projectedCostMinor: outcome.margin.projectedCostMinor,
    marginMinor: outcome.margin.marginMinor,
    marginRatio: outcome.margin.marginRatio,
    perContract: outcome.margin.perContract.map((position) => ({
      contractId: position.contractId,
      assessmentId: position.assessmentId,
      currency: position.currency,
      contractedValueMinor: position.contractedValueMinor,
      committedCostMinor: position.committedCostMinor,
      projectedCostMinor: position.projectedCostMinor,
      marginMinor: position.marginMinor,
      marginRatio: position.marginRatio,
    })),
    sources: outcome.margin.sources.map(assessmentSourcePayload),
    eventSources: outcome.margin.eventSources.map(eventSourcePayload),
  },
  entitlement: {
    approvedCount: outcome.entitlement.approvedCount,
    executedCount: outcome.entitlement.executedCount,
    rejectedCount: outcome.entitlement.rejectedCount,
    pendingCount: outcome.entitlement.pendingCount,
    approvedValueMinor: outcome.entitlement.approvedValueMinor,
    rejectedValueMinor: outcome.entitlement.rejectedValueMinor,
    pendingValueMinor: outcome.entitlement.pendingValueMinor,
    approvalRate: outcome.entitlement.approvalRate,
    orders: outcome.entitlement.orders.map((order) => ({
      changeOrderId: order.changeOrderId,
      valueMinor: order.valueMinor,
      status: order.status,
      submissionEventId: order.submissionEventId,
      decisionEventId: order.decisionEventId,
    })),
    eventSources: outcome.entitlement.eventSources.map(eventSourcePayload),
  },
  changePressure: {
    changeEventCount: outcome.changePressure.changeEventCount,
    changeOrderCount: outcome.changePressure.changeOrderCount,
    contractCount: outcome.changePressure.contractCount,
    eventSources: outcome.changePressure.eventSources.map(eventSourcePayload),
  },
  consumed: { ...outcome.consumed },
  evidence: evidencePayload(outcome.evidence),
});

/** Parse an untrusted outcomeRecorded payload back into the typed record (fail-closed). */
export function parseOutcomePayload(raw: unknown): Result<OutcomeRecord, DomainError> {
  const root = readRecord('outcome', raw);
  if (!root.ok) return root;
  const OUTCOME_KEYS = [
    'outcomeId', 'outcomeVersion', 'engine', 'recordedAt', 'actor', 'scope', 'projectId',
    'schedule', 'margin', 'entitlement', 'changePressure', 'consumed', 'evidence',
  ];
  if (!readStrictKeys('outcome', root.value, OUTCOME_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome', `an outcomeRecorded payload with exactly the keys ${OUTCOME_KEYS.join(', ')}`, raw));
  }
  const outcomeId = parseOutcomeId(root.value['outcomeId']);
  if (!outcomeId.ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.outcomeId', 'an OutcomeId token', root.value['outcomeId']));
  }
  const outcomeVersion = readInteger('outcome.outcomeVersion', root.value['outcomeVersion'], 1, 1);
  if (!outcomeVersion.ok) return outcomeVersion;
  const engine = readString('outcome.engine', root.value['engine']);
  if (!engine.ok) return engine;
  if (engine.value !== 'intelligence-memory') {
    return fail(payloadFailure('memory-payload-valid', 'outcome.engine', "'intelligence-memory'", engine.value));
  }
  const recordedAt = readTimestamp('outcome.recordedAt', root.value['recordedAt']);
  if (!recordedAt.ok) return recordedAt;
  const actor = readActor('outcome.actor', root.value['actor']);
  if (!actor.ok) return actor;
  const scope = readScope('outcome.scope', root.value['scope']);
  if (!scope.ok) return scope;
  const projectId = readEntityId('outcome.projectId', root.value['projectId']);
  if (!projectId.ok) return projectId;

  // ----- schedule ----------------------------------------------------------
  const scheduleRecord = readRecord('outcome.schedule', root.value['schedule']);
  if (!scheduleRecord.ok) return scheduleRecord;
  if (!readStrictKeys('outcome.schedule', scheduleRecord.value, ['baselineDurationDays', 'finalDurationDays', 'varianceDays', 'sources']).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.schedule', '{ baselineDurationDays, finalDurationDays, varianceDays, sources }', root.value['schedule']));
  }
  const baseline = readInteger('outcome.schedule.baselineDurationDays', scheduleRecord.value['baselineDurationDays'], 0, 100000);
  if (!baseline.ok) return baseline;
  const finalDuration = readInteger('outcome.schedule.finalDurationDays', scheduleRecord.value['finalDurationDays'], 0, 100000);
  if (!finalDuration.ok) return finalDuration;
  const variance = readInteger('outcome.schedule.varianceDays', scheduleRecord.value['varianceDays'], -100000, 100000);
  if (!variance.ok) return variance;
  const scheduleSources = readArray('outcome.schedule.sources', scheduleRecord.value['sources'], readAssessmentSource);
  if (!scheduleSources.ok) return scheduleSources;
  const schedule: ScheduleOutcome = {
    baselineDurationDays: baseline.value,
    finalDurationDays: finalDuration.value,
    varianceDays: variance.value,
    sources: scheduleSources.value,
  };

  // ----- margin -------------------------------------------------------------
  const marginRecord = readRecord('outcome.margin', root.value['margin']);
  if (!marginRecord.ok) return marginRecord;
  const MARGIN_KEYS = [
    'currency', 'originalContractedValueMinor', 'contractedValueMinor', 'committedCostMinor',
    'projectedCostMinor', 'marginMinor', 'marginRatio', 'perContract', 'sources', 'eventSources',
  ];
  if (!readStrictKeys('outcome.margin', marginRecord.value, MARGIN_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.margin', `a margin block with exactly the keys ${MARGIN_KEYS.join(', ')}`, root.value['margin']));
  }
  const currency = parseCurrencyCode(marginRecord.value['currency']);
  if (!currency.ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.margin.currency', 'an ISO-4217-style currency code', marginRecord.value['currency']));
  }
  const moneyField = (field: string): Result<number, DomainError> =>
    readInteger(`outcome.margin.${field}`, marginRecord.value[field], -9007199254740991, 9007199254740991);
  const originalContracted = moneyField('originalContractedValueMinor');
  if (!originalContracted.ok) return originalContracted;
  const contracted = moneyField('contractedValueMinor');
  if (!contracted.ok) return contracted;
  const committed = moneyField('committedCostMinor');
  if (!committed.ok) return committed;
  const projected = moneyField('projectedCostMinor');
  if (!projected.ok) return projected;
  const marginMinor = moneyField('marginMinor');
  if (!marginMinor.ok) return marginMinor;
  const marginRatio = readNullableRational('outcome.margin.marginRatio', marginRecord.value['marginRatio']);
  if (!marginRatio.ok) return marginRatio;
  const perContract = readArray('outcome.margin.perContract', marginRecord.value['perContract'], (path, entry) => {
    const record = readRecord(path, entry);
    if (!record.ok) return record;
    const KEYS = ['contractId', 'assessmentId', 'currency', 'contractedValueMinor', 'committedCostMinor', 'projectedCostMinor', 'marginMinor', 'marginRatio'];
    if (!readStrictKeys(path, record.value, KEYS).ok) {
      return fail(payloadFailure('memory-payload-valid', path, `a per-contract position with exactly the keys ${KEYS.join(', ')}`, entry));
    }
    const contractId = readEntityId(`${path}.contractId`, record.value['contractId']);
    if (!contractId.ok) return contractId;
    const assessmentId = parseAssessmentId(record.value['assessmentId']);
    if (!assessmentId.ok) {
      return fail(payloadFailure('memory-payload-valid', `${path}.assessmentId`, 'an AssessmentId token', record.value['assessmentId']));
    }
    const positionCurrency = parseCurrencyCode(record.value['currency']);
    if (!positionCurrency.ok) {
      return fail(payloadFailure('memory-payload-valid', `${path}.currency`, 'an ISO-4217-style currency code', record.value['currency']));
    }
    const amounts = ['contractedValueMinor', 'committedCostMinor', 'projectedCostMinor', 'marginMinor'].map((field) =>
      readInteger(`${path}.${field}`, record.value[field], -9007199254740991, 9007199254740991),
    );
    for (const amount of amounts) {
      if (!amount.ok) return amount;
    }
    const ratio = readNullableRational(`${path}.marginRatio`, record.value['marginRatio']);
    if (!ratio.ok) return ratio;
    return ok({
      contractId: contractId.value,
      assessmentId: assessmentId.value,
      currency: positionCurrency.value,
      contractedValueMinor: (amounts[0] as { readonly value: number }).value,
      committedCostMinor: (amounts[1] as { readonly value: number }).value,
      projectedCostMinor: (amounts[2] as { readonly value: number }).value,
      marginMinor: (amounts[3] as { readonly value: number }).value,
      marginRatio: ratio.value,
    } satisfies ContractMarginPosition);
  });
  if (!perContract.ok) return perContract;
  const marginSources = readArray('outcome.margin.sources', marginRecord.value['sources'], readAssessmentSource);
  if (!marginSources.ok) return marginSources;
  const marginEventSources = readArray('outcome.margin.eventSources', marginRecord.value['eventSources'], readEventSource);
  if (!marginEventSources.ok) return marginEventSources;
  const margin: MarginOutcome = {
    currency: currency.value,
    originalContractedValueMinor: originalContracted.value,
    contractedValueMinor: contracted.value,
    committedCostMinor: committed.value,
    projectedCostMinor: projected.value,
    marginMinor: marginMinor.value,
    marginRatio: marginRatio.value,
    perContract: perContract.value,
    sources: marginSources.value,
    eventSources: marginEventSources.value,
  };

  // ----- entitlement ----------------------------------------------------------
  const entitlementRecord = readRecord('outcome.entitlement', root.value['entitlement']);
  if (!entitlementRecord.ok) return entitlementRecord;
  const ENTITLEMENT_KEYS = [
    'approvedCount', 'executedCount', 'rejectedCount', 'pendingCount', 'approvedValueMinor',
    'rejectedValueMinor', 'pendingValueMinor', 'approvalRate', 'orders', 'eventSources',
  ];
  if (!readStrictKeys('outcome.entitlement', entitlementRecord.value, ENTITLEMENT_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.entitlement', `an entitlement block with exactly the keys ${ENTITLEMENT_KEYS.join(', ')}`, root.value['entitlement']));
  }
  const counts = (['approvedCount', 'executedCount', 'rejectedCount', 'pendingCount'] as const).map((field) =>
    readInteger(`outcome.entitlement.${field}`, entitlementRecord.value[field], 0, 1000000),
  );
  for (const count of counts) {
    if (!count.ok) return count;
  }
  const entitlementValues = (['approvedValueMinor', 'rejectedValueMinor', 'pendingValueMinor'] as const).map((field) =>
    readInteger(`outcome.entitlement.${field}`, entitlementRecord.value[field], -9007199254740991, 9007199254740991),
  );
  for (const value of entitlementValues) {
    if (!value.ok) return value;
  }
  const approvalRate = readRational('outcome.entitlement.approvalRate', entitlementRecord.value['approvalRate']);
  if (!approvalRate.ok) return approvalRate;
  const orders = readArray('outcome.entitlement.orders', entitlementRecord.value['orders'], (path, entry) => {
    const record = readRecord(path, entry);
    if (!record.ok) return record;
    const KEYS = ['changeOrderId', 'valueMinor', 'status', 'submissionEventId', 'decisionEventId'];
    if (!readStrictKeys(path, record.value, KEYS).ok) {
      return fail(payloadFailure('memory-payload-valid', path, `an order outcome with exactly the keys ${KEYS.join(', ')}`, entry));
    }
    const changeOrderId = readEntityId(`${path}.changeOrderId`, record.value['changeOrderId']);
    if (!changeOrderId.ok) return changeOrderId;
    const value = readNullable(`${path}.valueMinor`, record.value['valueMinor'], (p, v) => readInteger(p, v, -9007199254740991, 9007199254740991));
    if (!value.ok) return value;
    const status = readString(`${path}.status`, record.value['status']);
    if (!status.ok) return status;
    if (!['submitted', 'approved', 'rejected', 'executed'].includes(status.value)) {
      return fail(payloadFailure('memory-payload-valid', `${path}.status`, "one of 'submitted', 'approved', 'rejected', 'executed'", status.value));
    }
    const submissionEventId = readLedgerEventId(`${path}.submissionEventId`, record.value['submissionEventId']);
    if (!submissionEventId.ok) return submissionEventId;
    const decisionEventId = readNullable(`${path}.decisionEventId`, record.value['decisionEventId'], readLedgerEventId);
    if (!decisionEventId.ok) return decisionEventId;
    return ok({
      changeOrderId: changeOrderId.value,
      valueMinor: value.value,
      status: status.value as EntitlementOrderOutcome['status'],
      submissionEventId: submissionEventId.value,
      decisionEventId: decisionEventId.value,
    } satisfies EntitlementOrderOutcome);
  });
  if (!orders.ok) return orders;
  const entitlementEventSources = readArray('outcome.entitlement.eventSources', entitlementRecord.value['eventSources'], readEventSource);
  if (!entitlementEventSources.ok) return entitlementEventSources;
  const entitlement: EntitlementOutcome = {
    approvedCount: (counts[0] as { readonly value: number }).value,
    executedCount: (counts[1] as { readonly value: number }).value,
    rejectedCount: (counts[2] as { readonly value: number }).value,
    pendingCount: (counts[3] as { readonly value: number }).value,
    approvedValueMinor: (entitlementValues[0] as { readonly value: number }).value,
    rejectedValueMinor: (entitlementValues[1] as { readonly value: number }).value,
    pendingValueMinor: (entitlementValues[2] as { readonly value: number }).value,
    approvalRate: approvalRate.value,
    orders: orders.value,
    eventSources: entitlementEventSources.value,
  };

  // ----- change pressure --------------------------------------------------------
  const pressureRecord = readRecord('outcome.changePressure', root.value['changePressure']);
  if (!pressureRecord.ok) return pressureRecord;
  if (!readStrictKeys('outcome.changePressure', pressureRecord.value, ['changeEventCount', 'changeOrderCount', 'contractCount', 'eventSources']).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.changePressure', '{ changeEventCount, changeOrderCount, contractCount, eventSources }', root.value['changePressure']));
  }
  const pressureCounts = (['changeEventCount', 'changeOrderCount', 'contractCount'] as const).map((field) =>
    readInteger(`outcome.changePressure.${field}`, pressureRecord.value[field], 0, 1000000),
  );
  for (const count of pressureCounts) {
    if (!count.ok) return count;
  }
  const pressureEventSources = readArray('outcome.changePressure.eventSources', pressureRecord.value['eventSources'], readEventSource);
  if (!pressureEventSources.ok) return pressureEventSources;
  const changePressure: ChangePressureOutcome = {
    changeEventCount: (pressureCounts[0] as { readonly value: number }).value,
    changeOrderCount: (pressureCounts[1] as { readonly value: number }).value,
    contractCount: (pressureCounts[2] as { readonly value: number }).value,
    eventSources: pressureEventSources.value,
  };

  // ----- consumed + evidence ------------------------------------------------------
  const consumedRecord = readRecord('outcome.consumed', root.value['consumed']);
  if (!consumedRecord.ok) return consumedRecord;
  if (!readStrictKeys('outcome.consumed', consumedRecord.value, ['projectedEventCount', 'assessmentCount']).ok) {
    return fail(payloadFailure('memory-payload-valid', 'outcome.consumed', '{ projectedEventCount, assessmentCount }', root.value['consumed']));
  }
  const projectedEventCount = readInteger('outcome.consumed.projectedEventCount', consumedRecord.value['projectedEventCount'], 0, 1000000000);
  if (!projectedEventCount.ok) return projectedEventCount;
  const assessmentCount = readInteger('outcome.consumed.assessmentCount', consumedRecord.value['assessmentCount'], 1, 1000000);
  if (!assessmentCount.ok) return assessmentCount;
  const evidence = readEvidence('outcome.evidence', root.value['evidence']);
  if (!evidence.ok) return evidence;

  return ok({
    outcomeId: outcomeId.value,
    outcomeVersion: outcomeVersion.value as OutcomeRecord['outcomeVersion'],
    engine: engine.value as OutcomeRecord['engine'],
    recordedAt: recordedAt.value,
    actor: actor.value,
    scope: scope.value,
    projectId: projectId.value,
    schedule,
    margin,
    entitlement,
    changePressure,
    consumed: {
      projectedEventCount: projectedEventCount.value,
      assessmentCount: assessmentCount.value,
    },
    evidence: evidence.value,
  } satisfies OutcomeRecord);
}

// ---------------------------------------------------------------------------
// The benchmark payload (builder + fail-closed parser).
// ---------------------------------------------------------------------------

/** Build the JSON-safe payload of one benchmark snapshot. */
export const benchmarkPayload = (benchmark: Benchmark): Record<string, unknown> => ({
  benchmarkId: benchmark.benchmarkId,
  benchmarkVersion: benchmark.benchmarkVersion,
  engine: benchmark.engine,
  computedAt: benchmark.computedAt,
  actor: benchmark.actor,
  scope: benchmark.scope,
  outcomeCount: benchmark.outcomeCount,
  metrics: benchmark.metrics.map((metric) => ({
    kind: metric.kind,
    outcomeIds: [...metric.outcomeIds],
    min: metric.min,
    max: metric.max,
    mean: metric.mean,
    median: metric.median,
    percentile90: metric.percentile90,
  })),
  positions: benchmark.positions.map((position) => ({
    metricKind: position.metricKind,
    outcomeId: position.outcomeId,
    position: position.position,
  })),
});

const METRIC_KEYS = ['kind', 'outcomeIds', 'min', 'max', 'mean', 'median', 'percentile90'];

const readMetricStats = (
  path: string,
  raw: unknown,
): Result<BenchmarkMetricStats, DomainError> => {
  const record = readRecord(path, raw);
  if (!record.ok) return record;
  if (!readStrictKeys(path, record.value, METRIC_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', path, `a metric stats block with exactly the keys ${METRIC_KEYS.join(', ')}`, raw));
  }
  const kind = readString(`${path}.kind`, record.value['kind']);
  if (!kind.ok) return kind;
  if (!['schedule-variance-days', 'margin-ratio', 'entitlement-approval-rate', 'change-event-count'].includes(kind.value)) {
    return fail(payloadFailure('memory-payload-valid', `${path}.kind`, 'a declared benchmark metric kind', kind.value));
  }
  const outcomeIds = readArray(`${path}.outcomeIds`, record.value['outcomeIds'], (p, v) => {
    const parsed = parseOutcomeId(v);
    if (!parsed.ok) {
      return fail(payloadFailure('memory-payload-valid', p, 'an OutcomeId token', v));
    }
    return ok(parsed.value);
  });
  if (!outcomeIds.ok) return outcomeIds;
  const stats = (['min', 'max', 'mean', 'median', 'percentile90'] as const).map((field) =>
    readRational(`${path}.${field}`, record.value[field]),
  );
  for (const stat of stats) {
    if (!stat.ok) return stat;
  }
  return ok({
    kind: kind.value as BenchmarkMetricStats['kind'],
    outcomeIds: outcomeIds.value,
    min: (stats[0] as { readonly value: Rational }).value,
    max: (stats[1] as { readonly value: Rational }).value,
    mean: (stats[2] as { readonly value: Rational }).value,
    median: (stats[3] as { readonly value: Rational }).value,
    percentile90: (stats[4] as { readonly value: Rational }).value,
  } satisfies BenchmarkMetricStats);
};

/** Parse an untrusted benchmarkComputed payload back into the typed snapshot (fail-closed). */
export function parseBenchmarkPayload(raw: unknown): Result<Benchmark, DomainError> {
  const root = readRecord('benchmark', raw);
  if (!root.ok) return root;
  const BENCHMARK_KEYS = [
    'benchmarkId', 'benchmarkVersion', 'engine', 'computedAt', 'actor', 'scope',
    'outcomeCount', 'metrics', 'positions',
  ];
  if (!readStrictKeys('benchmark', root.value, BENCHMARK_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', 'benchmark', `a benchmarkComputed payload with exactly the keys ${BENCHMARK_KEYS.join(', ')}`, raw));
  }
  const benchmarkId = parseBenchmarkId(root.value['benchmarkId']);
  if (!benchmarkId.ok) {
    return fail(payloadFailure('memory-payload-valid', 'benchmark.benchmarkId', 'a BenchmarkId token', root.value['benchmarkId']));
  }
  const benchmarkVersion = readInteger('benchmark.benchmarkVersion', root.value['benchmarkVersion'], 1, 1);
  if (!benchmarkVersion.ok) return benchmarkVersion;
  const engine = readString('benchmark.engine', root.value['engine']);
  if (!engine.ok) return engine;
  if (engine.value !== 'intelligence-memory') {
    return fail(payloadFailure('memory-payload-valid', 'benchmark.engine', "'intelligence-memory'", engine.value));
  }
  const computedAt = readTimestamp('benchmark.computedAt', root.value['computedAt']);
  if (!computedAt.ok) return computedAt;
  const actor = readActor('benchmark.actor', root.value['actor']);
  if (!actor.ok) return actor;
  const scope = readScope('benchmark.scope', root.value['scope']);
  if (!scope.ok) return scope;
  const outcomeCount = readInteger('benchmark.outcomeCount', root.value['outcomeCount'], 1, 1000000);
  if (!outcomeCount.ok) return outcomeCount;
  const metrics = readArray('benchmark.metrics', root.value['metrics'], readMetricStats);
  if (!metrics.ok) return metrics;
  const positions = readArray('benchmark.positions', root.value['positions'], (path, entry) => {
    const record = readRecord(path, entry);
    if (!record.ok) return record;
    if (!readStrictKeys(path, record.value, ['metricKind', 'outcomeId', 'position']).ok) {
      return fail(payloadFailure('memory-payload-valid', path, '{ metricKind, outcomeId, position }', entry));
    }
    const metricKind = readString(`${path}.metricKind`, record.value['metricKind']);
    if (!metricKind.ok) return metricKind;
    if (!['schedule-variance-days', 'margin-ratio', 'entitlement-approval-rate', 'change-event-count'].includes(metricKind.value)) {
      return fail(payloadFailure('memory-payload-valid', `${path}.metricKind`, 'a declared benchmark metric kind', metricKind.value));
    }
    const outcomeId = parseOutcomeId(record.value['outcomeId']);
    if (!outcomeId.ok) {
      return fail(payloadFailure('memory-payload-valid', `${path}.outcomeId`, 'an OutcomeId token', record.value['outcomeId']));
    }
    const position = readRational(`${path}.position`, record.value['position']);
    if (!position.ok) return position;
    return ok({
      metricKind: metricKind.value as BenchmarkPosition['metricKind'],
      outcomeId: outcomeId.value,
      position: position.value,
    } satisfies BenchmarkPosition);
  });
  if (!positions.ok) return positions;

  return ok({
    benchmarkId: benchmarkId.value,
    benchmarkVersion: benchmarkVersion.value as Benchmark['benchmarkVersion'],
    engine: engine.value as Benchmark['engine'],
    computedAt: computedAt.value,
    actor: actor.value,
    scope: scope.value,
    outcomeCount: outcomeCount.value,
    metrics: metrics.value,
    positions: positions.value,
  } satisfies Benchmark);
}

// ---------------------------------------------------------------------------
// The lesson payload (builder + fail-closed parser).
// ---------------------------------------------------------------------------

/** Build the JSON-safe payload of one lesson record. */
export const lessonPayload = (lesson: Lesson): Record<string, unknown> => ({
  lessonId: lesson.lessonId,
  lessonVersion: lesson.lessonVersion,
  engine: lesson.engine,
  capturedAt: lesson.capturedAt,
  actor: lesson.actor,
  scope: lesson.scope,
  title: lesson.title,
  statement: lesson.statement,
  applicability: lesson.applicability.map((tag) => ({ area: tag.area, value: tag.value })),
  links: lesson.links.map((link) => ({
    entity: link.entity,
    documentId: link.documentId,
    revisionId: link.revisionId,
    sourceEventId: link.sourceEventId,
  })),
  provenance: {
    origin: lesson.provenance.origin,
    author: lesson.provenance.author,
    derivedFromOutcomeIds: [...lesson.provenance.derivedFromOutcomeIds],
    engine: lesson.provenance.engine,
  },
});

/** Parse an untrusted lessonCaptured payload back into the typed record (fail-closed). */
export function parseLessonPayload(raw: unknown): Result<Lesson, DomainError> {
  const root = readRecord('lesson', raw);
  if (!root.ok) return root;
  const LESSON_KEYS = [
    'lessonId', 'lessonVersion', 'engine', 'capturedAt', 'actor', 'scope',
    'title', 'statement', 'applicability', 'links', 'provenance',
  ];
  if (!readStrictKeys('lesson', root.value, LESSON_KEYS).ok) {
    return fail(payloadFailure('memory-payload-valid', 'lesson', `a lessonCaptured payload with exactly the keys ${LESSON_KEYS.join(', ')}`, raw));
  }
  const lessonId = parseLessonId(root.value['lessonId']);
  if (!lessonId.ok) {
    return fail(payloadFailure('memory-payload-valid', 'lesson.lessonId', 'a LessonId token', root.value['lessonId']));
  }
  const lessonVersion = readInteger('lesson.lessonVersion', root.value['lessonVersion'], 1, 1);
  if (!lessonVersion.ok) return lessonVersion;
  const engine = readString('lesson.engine', root.value['engine']);
  if (!engine.ok) return engine;
  if (engine.value !== 'intelligence-memory') {
    return fail(payloadFailure('memory-payload-valid', 'lesson.engine', "'intelligence-memory'", engine.value));
  }
  const capturedAt = readTimestamp('lesson.capturedAt', root.value['capturedAt']);
  if (!capturedAt.ok) return capturedAt;
  const actor = readActor('lesson.actor', root.value['actor']);
  if (!actor.ok) return actor;
  const scope = readScope('lesson.scope', root.value['scope']);
  if (!scope.ok) return scope;
  const title = readBoundedString('lesson.title', root.value['title'], 200);
  if (!title.ok) return title;
  const statement = readBoundedString('lesson.statement', root.value['statement'], 2000);
  if (!statement.ok) return statement;
  const applicability = readArray('lesson.applicability', root.value['applicability'], (path, entry) => {
    const record = readRecord(path, entry);
    if (!record.ok) return record;
    if (!readStrictKeys(path, record.value, ['area', 'value']).ok) {
      return fail(payloadFailure('memory-payload-valid', path, '{ area, value }', entry));
    }
    const area = readString(`${path}.area`, record.value['area']);
    if (!area.ok) return area;
    if (!['schedule', 'cost', 'contracts', 'entitlement', 'field', 'general'].includes(area.value)) {
      return fail(payloadFailure('memory-payload-valid', `${path}.area`, 'a declared lesson area', area.value));
    }
    const value = readBoundedString(`${path}.value`, record.value['value'], 64);
    if (!value.ok) return value;
    return ok({ area: area.value as LessonTag['area'], value: value.value } satisfies LessonTag);
  });
  if (!applicability.ok) return applicability;
  const links = readArray('lesson.links', root.value['links'], (path, entry) => {
    const record = readRecord(path, entry);
    if (!record.ok) return record;
    const KEYS = ['entity', 'documentId', 'revisionId', 'sourceEventId'];
    if (!readStrictKeys(path, record.value, KEYS).ok) {
      return fail(payloadFailure('memory-payload-valid', path, `a typed link with exactly the keys ${KEYS.join(', ')}`, entry));
    }
    const entity = record.value['entity'];
    if (
      typeof entity !== 'object' ||
      entity === null ||
      Array.isArray(entity) ||
      !isEntityId((entity as Record<string, unknown>)['entityId'])
    ) {
      return fail(payloadFailure('memory-payload-valid', `${path}.entity`, 'a canonical EntityRef', entity));
    }
    const documentId = readNullable(`${path}.documentId`, record.value['documentId'], readEntityId);
    if (!documentId.ok) return documentId;
    const revisionId = readNullable(`${path}.revisionId`, record.value['revisionId'], readEntityId);
    if (!revisionId.ok) return revisionId;
    const sourceEventId = readNullable(`${path}.sourceEventId`, record.value['sourceEventId'], readLedgerEventId);
    if (!sourceEventId.ok) return sourceEventId;
    // The rebuild path enforces the capture-time evidence invariant: a
    // revision never arrives without its document (fail-closed parsing —
    // the folded store never serves structurally invalid lessons).
    if (revisionId.value !== null && documentId.value === null) {
      return fail(payloadFailure('memory-payload-valid', `${path}.revisionId`, 'a documentId paired with the revision (evidence links pair document + revision)', record.value['revisionId']));
    }
    return ok({
      entity: entity as LessonLink['entity'],
      documentId: documentId.value,
      revisionId: revisionId.value,
      sourceEventId: sourceEventId.value,
    } satisfies LessonLink);
  });
  if (!links.ok) return links;
  const provenanceRecord = readRecord('lesson.provenance', root.value['provenance']);
  if (!provenanceRecord.ok) return provenanceRecord;
  if (!readStrictKeys('lesson.provenance', provenanceRecord.value, ['origin', 'author', 'derivedFromOutcomeIds', 'engine']).ok) {
    return fail(payloadFailure('memory-payload-valid', 'lesson.provenance', '{ origin, author, derivedFromOutcomeIds, engine }', root.value['provenance']));
  }
  const origin = readString('lesson.provenance.origin', provenanceRecord.value['origin']);
  if (!origin.ok) return origin;
  if (origin.value !== 'human' && origin.value !== 'derived') {
    return fail(payloadFailure('memory-payload-valid', 'lesson.provenance.origin', "'human' or 'derived'", origin.value));
  }
  const author = readActor('lesson.provenance.author', provenanceRecord.value['author']);
  if (!author.ok) return author;
  const derivedFrom = readArray('lesson.provenance.derivedFromOutcomeIds', provenanceRecord.value['derivedFromOutcomeIds'], (p, v) => {
    const parsed = parseOutcomeId(v);
    if (!parsed.ok) {
      return fail(payloadFailure('memory-payload-valid', p, 'an OutcomeId token', v));
    }
    return ok(parsed.value);
  });
  if (!derivedFrom.ok) return derivedFrom;
  const provenanceEngine = readString('lesson.provenance.engine', provenanceRecord.value['engine']);
  if (!provenanceEngine.ok) return provenanceEngine;
  if (provenanceEngine.value !== 'intelligence-memory') {
    return fail(payloadFailure('memory-payload-valid', 'lesson.provenance.engine', "'intelligence-memory'", provenanceEngine.value));
  }

  return ok({
    lessonId: lessonId.value,
    lessonVersion: lessonVersion.value as Lesson['lessonVersion'],
    engine: engine.value as Lesson['engine'],
    capturedAt: capturedAt.value,
    actor: actor.value,
    scope: scope.value,
    title: title.value,
    statement: statement.value,
    applicability: [...applicability.value].sort(compareLessonTags),
    links: [...links.value].sort(compareLessonLinks),
    provenance: {
      origin: origin.value,
      author: author.value,
      derivedFromOutcomeIds: [...derivedFrom.value].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
      engine: provenanceEngine.value as Lesson['provenance']['engine'],
    },
  } satisfies Lesson);
}

// ---------------------------------------------------------------------------
// The envelope builders (A3 causality + A4 provenance through the boundary).
// ---------------------------------------------------------------------------

/** The causality a memory event carries (correlation + optional causation). */
export interface MemoryCausality {
  readonly correlationId: string;
  readonly causationId: LedgerEventId | null;
}

const memoryEventFailure = (reason: string): DomainError =>
  domainError(
    'invariant-violation',
    `the memory record cannot be emitted as an event: ${reason}`,
    [{ code: 'memory-event-valid', message: reason, path: null }],
  );

/**
 * Build the event of ONE recorded outcome: an `intelligence.outcomeRecorded`
 * DomainEventEnvelope whose causation id is the terminal assessed change
 * event's ledger id (the causedByEvent convention — the outcome is
 * downstream of the change events it closed under), whose correlation id
 * is carried over from the terminal assessment's causal chain, whose
 * source is 'system' (machine-derived by the intelligence engine), and
 * whose entity ref points at the completed project.
 */
export function outcomeRecordedEnvelope(
  outcome: OutcomeRecord,
): Result<DomainEventEnvelope, DomainError> {
  const terminal = outcome.evidence
    .filter((entry): entry is OutcomeAssessmentSource => entry.kind === 'assessment')
    .sort(compareAssessmentSources)
    .at(-1);
  if (terminal === undefined) {
    return fail(memoryEventFailure('the outcome carries no assessment source to anchor causality'));
  }
  const projectRef: EntityRef = { entityKind: 'project' as EntityRef['entityKind'], entityId: outcome.projectId };
  const envelope = parseDomainEventEnvelope({
    kind: 'event',
    eventName: OUTCOME_RECORDED_EVENT,
    scope: outcome.scope,
    actor: outcome.actor,
    source: 'system',
    causality: {
      correlationId: terminal.correlationId,
      causationId: terminal.sourceEventId,
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: outcome.recordedAt,
    entityRefs: { before: null, after: projectRef },
    payload: outcomePayload(outcome),
  });
  if (!envelope.ok) {
    return fail(
      memoryEventFailure(
        `the outcomeRecorded envelope failed its own contract: ${JSON.stringify(envelope.error)}`,
      ),
    );
  }
  return ok(envelope.value);
}

/**
 * Build the event of ONE computed benchmark snapshot: an
 * `intelligence.benchmarkComputed` envelope with the caller-supplied
 * causality (the runtime anchors the benchmark at its last
 * outcome-recorded event; correlation carried over) and the full
 * benchmark + producing outcome ids in the payload.
 */
export function benchmarkComputedEnvelope(
  benchmark: Benchmark,
  causality: MemoryCausality,
): Result<DomainEventEnvelope, DomainError> {
  const envelope = parseDomainEventEnvelope({
    kind: 'event',
    eventName: BENCHMARK_COMPUTED_EVENT,
    scope: benchmark.scope,
    actor: benchmark.actor,
    source: 'system',
    causality: {
      correlationId: causality.correlationId,
      causationId: causality.causationId,
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: benchmark.computedAt,
    entityRefs: { before: null, after: null },
    payload: benchmarkPayload(benchmark),
  });
  if (!envelope.ok) {
    return fail(
      memoryEventFailure(
        `the benchmarkComputed envelope failed its own contract: ${JSON.stringify(envelope.error)}`,
      ),
    );
  }
  return ok(envelope.value);
}

/**
 * Build the event of ONE captured lesson: an `intelligence.lessonCaptured`
 * envelope with the caller-supplied causality (a human lesson is a new
 * causal root — null causation id, fresh correlation; a derived lesson
 * anchors at a deriving event) and the entity ref of its first typed link.
 */
export function lessonCapturedEnvelope(
  lesson: Lesson,
  causality: MemoryCausality,
): Result<DomainEventEnvelope, DomainError> {
  const firstLink = lesson.links[0] ?? null;
  const envelope = parseDomainEventEnvelope({
    kind: 'event',
    eventName: LESSON_CAPTURED_EVENT,
    scope: lesson.scope,
    actor: lesson.actor,
    source: 'system',
    causality: {
      correlationId: causality.correlationId,
      causationId: causality.causationId,
    },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    occurredAt: lesson.capturedAt,
    entityRefs: { before: null, after: firstLink === null ? null : firstLink.entity },
    payload: lessonPayload(lesson),
  });
  if (!envelope.ok) {
    return fail(
      memoryEventFailure(
        `the lessonCaptured envelope failed its own contract: ${JSON.stringify(envelope.error)}`,
      ),
    );
  }
  return ok(envelope.value);
}

// ---------------------------------------------------------------------------
// The emit conveniences (sink + executor + record).
// ---------------------------------------------------------------------------

/**
 * Emit ONE recorded outcome through a MemoryEventSink — build the envelope
 * and hand it to the sink with the caller's executor. The sink's failure
 * propagates (typed) so the caller's transaction aborts.
 */
export async function emitOutcomeRecorded(
  sink: MemoryEventSink,
  executor: MemorySinkExecutor,
  outcome: OutcomeRecord,
): Promise<Result<true, DomainError>> {
  const envelope = outcomeRecordedEnvelope(outcome);
  if (!envelope.ok) return envelope;
  return sink.appendEvents(executor, [envelope.value]);
}

/** Emit ONE computed benchmark snapshot (see benchmarkComputedEnvelope). */
export async function emitBenchmarkComputed(
  sink: MemoryEventSink,
  executor: MemorySinkExecutor,
  benchmark: Benchmark,
  causality: MemoryCausality,
): Promise<Result<true, DomainError>> {
  const envelope = benchmarkComputedEnvelope(benchmark, causality);
  if (!envelope.ok) return envelope;
  return sink.appendEvents(executor, [envelope.value]);
}

/** Emit ONE captured lesson (see lessonCapturedEnvelope). */
export async function emitLessonCaptured(
  sink: MemoryEventSink,
  executor: MemorySinkExecutor,
  lesson: Lesson,
  causality: MemoryCausality,
): Promise<Result<true, DomainError>> {
  const envelope = lessonCapturedEnvelope(lesson, causality);
  if (!envelope.ok) return envelope;
  return sink.appendEvents(executor, [envelope.value]);
}
