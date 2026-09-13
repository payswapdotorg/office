import { describe, expect, it } from 'vitest';
import { parseCausationId, parseCorrelationId } from '@office/contracts';
import { GOLDEN_ASSESSED_AT, goldenStackInputs } from './scenarios';
import {
  REPLACEMENT_FORMULA,
} from './model';
import {
  STACK_ASSESSED_EVENT,
} from './vocabulary';
import {
  USER_ACTOR,
  stackAuthorizationOf,
  tenantAScope,
  testCorrelationId,
  testScanId,
  unwrap,
} from './test-support';
import {
  STACK_ASSESSED_PAYLOAD_GRAMMAR,
  createInMemoryStackEventSink,
  emitReplacementAssessed,
  failingStackEventSink,
  replacementAssessedEnvelope,
  stackSinkFailure,
} from './audit';
import type { StackCausality, StackSinkExecutor } from './audit';
import { assessStackReplacement } from './replacement';
import type { ReplacementAssessment, StackAnalysisResult } from './replacement';

// OFF-035 audit — the replacementAssessed event: the envelope shape (A3
// caller-supplied causality, system source, the scan's actor/scope, the
// entity refs of the assessed canonical subject), the JSON-safe payload
// (INCLUDING the exposed, recomputable score composition + the typed
// suggestion + every evidence id — A4 traceability survives the event
// boundary), the injected EventSink port (appends inside the caller's
// transaction, typed failure propagation), and the fail-closed rejections.

const analysis = (): StackAnalysisResult =>
  unwrap(
    assessStackReplacement(goldenStackInputs(), stackAuthorizationOf(tenantAScope()), {
      scanId: testScanId(1),
      now: GOLDEN_ASSESSED_AT,
    }),
  );

const executor: StackSinkExecutor = {
  query: async () => ({ rows: [], rowCount: 0 }),
};

const causality = (): StackCausality => ({
  correlationId: unwrap(parseCorrelationId(testCorrelationId(1))),
  causationId: unwrap(parseCausationId('cause-00000001')),
});

const assessmentAt = (ordinal: number): ReplacementAssessment => {
  const assessment = analysis().assessments[ordinal - 1];
  if (assessment === undefined) throw new Error(`missing assessment ${ordinal}`);
  return assessment;
};

const appAssessment = (): ReplacementAssessment => {
  const assessment = analysis().assessments.find(
    (candidate) => candidate.coverage.kind === 'installed-app-coverage',
  );
  if (assessment === undefined) throw new Error('missing app assessment');
  return assessment;
};

describe('the replacementAssessed envelope (A3/A4)', () => {
  it('emits the typed event name with the system source + the scan actor', () => {
    const envelope = unwrap(replacementAssessedEnvelope(assessmentAt(1), causality()));
    expect(envelope.kind).toBe('event');
    expect(envelope.eventName).toBe(STACK_ASSESSED_EVENT);
    expect(envelope.source).toBe('system');
    expect(envelope.actor).toStrictEqual(USER_ACTOR);
    expect(envelope.occurredAt).toBe(GOLDEN_ASSESSED_AT);
    expect(envelope.schemaVersion).toBe('1.0.0');
  });

  it('carries the CALLER-SUPPLIED causality and the scan\'s execution scope', () => {
    const envelope = unwrap(replacementAssessedEnvelope(assessmentAt(1), causality()));
    expect(envelope.causality.correlationId).toBe('corr-00000001');
    expect(envelope.causality.causationId).toBe('cause-00000001');
    expect(envelope.scope).toStrictEqual(tenantAScope());
  });

  it('points the entity refs at the assessed canonical subject (apps), null for systems', () => {
    const appEnvelope = unwrap(replacementAssessedEnvelope(appAssessment(), causality()));
    const appCoverage = appAssessment().coverage;
    if (appCoverage.kind !== 'installed-app-coverage') {
      throw new Error('unreachable');
    }
    expect(appEnvelope.entityRefs.after).toStrictEqual({
      entityKind: 'app-installation',
      entityId: appCoverage.installationId,
    });
    expect(appEnvelope.entityRefs.before).toBeNull();
    // An external system is not a canonical entity: both refs null.
    const systemEnvelope = unwrap(replacementAssessedEnvelope(assessmentAt(1), causality()));
    expect(systemEnvelope.entityRefs.after).toBeNull();
    expect(systemEnvelope.entityRefs.before).toBeNull();
  });

  it('carries the JSON-safe summary INCLUDING the exposed score composition', () => {
    const assessment = assessmentAt(1); // system-a: 3/3 covered.
    const payload = unwrap(replacementAssessedEnvelope(assessment, causality())).payload as Record<
      string,
      unknown
    >;
    expect(payload['assessmentId']).toBe(assessment.assessmentId);
    expect(payload['assessmentVersion']).toBe(assessment.assessmentVersion);
    expect(payload['engine']).toBe('intelligence-stack-analysis');
    expect(payload['scanId']).toBe('scan-0001');
    expect(payload['assessedAt']).toBe(GOLDEN_ASSESSED_AT);
    expect(payload['kind']).toBe('external-system');
    expect(payload['title']).toBe(assessment.title);
    expect(payload['subject']).toStrictEqual({
      adapterKind: 'system-a',
      systemId: 'instance-01',
      tenantId: assessment.coverage.kind === 'external-system-coverage'
        ? assessment.coverage.tenantId
        : null,
    });
    // THE exposed composition: the formula constant + the exact rational +
    // both counts — recomputable BY HAND from the event alone.
    expect(payload['score']).toStrictEqual({
      formula: REPLACEMENT_FORMULA,
      value: { numerator: 1, denominator: 1 },
      coveredCount: 3,
      surfaceCount: 3,
    });
    expect(payload['coveredCapabilities']).toStrictEqual([
      'organization.read',
      'people.read',
      'projects.read',
    ]);
    expect(payload['uncoveredCapabilities']).toStrictEqual([]);
    expect(payload['suggestion']).toStrictEqual({
      kind: 'consolidate',
      rationale: assessment.suggestion.rationale,
      reasons: [...assessment.suggestion.reasons],
    });
    expect(payload['performanceBasis']).toStrictEqual({
      outcomeIds: ['outcome-0001', 'outcome-0002'],
      benchmarkIds: ['benchmark-0001'],
    });
  });

  it('splits the evidence chain by kind (A4 traceability survives the boundary)', () => {
    const assessment = assessmentAt(1);
    const payload = unwrap(replacementAssessedEnvelope(assessment, causality())).payload as Record<
      string,
      unknown
    >;
    expect(payload['evidenceSystemRefs']).toStrictEqual([{ adapterKind: 'system-a', systemId: 'instance-01' }]);
    expect(payload['evidenceLinkIds']).toStrictEqual(
      assessment.evidence
        .filter((evidence) => evidence.evidenceKind === 'installation-link')
        .map((evidence) => (evidence.evidenceKind === 'installation-link' ? evidence.linkId : null)),
    );
    expect(payload['evidenceReleaseIds']).toStrictEqual(
      assessment.evidence
        .filter((evidence) => evidence.evidenceKind === 'release')
        .map((evidence) => (evidence.evidenceKind === 'release' ? evidence.releaseId : null)),
    );
    expect(payload['evidenceEntitlementIds']).toStrictEqual(
      assessment.evidence
        .filter((evidence) => evidence.evidenceKind === 'entitlement')
        .map((evidence) =>
          evidence.evidenceKind === 'entitlement' ? evidence.entitlementId : null,
        ),
    );
    expect(payload['evidenceOutcomeIds']).toStrictEqual(['outcome-0001', 'outcome-0002']);
    expect(payload['evidenceBenchmarkIds']).toStrictEqual(['benchmark-0001']);
  });

  it('the app direction carries the observed command/event workflow surfaces as data', () => {
    const payload = unwrap(
      replacementAssessedEnvelope(appAssessment(), causality()),
    ).payload as Record<string, unknown>;
    expect(payload['commandSurface']).toStrictEqual(['organization.listOrganizations']);
    expect(payload['subscriptionSurface']).toStrictEqual(['organization.organizationCreated']);
    // The system direction carries NO workflow-surface fields.
    const systemPayload = unwrap(
      replacementAssessedEnvelope(assessmentAt(1), causality()),
    ).payload as Record<string, unknown>;
    expect(systemPayload['commandSurface']).toBeUndefined();
    expect(systemPayload['subscriptionSurface']).toBeUndefined();
  });

  it('the payload is JSON-safe (round-trips byte-identically)', () => {
    for (const assessment of analysis().assessments) {
      const envelope = unwrap(replacementAssessedEnvelope(assessment, causality()));
      const roundTripped = JSON.parse(JSON.stringify(envelope.payload));
      expect(roundTripped).toStrictEqual(envelope.payload);
    }
  });

  it('the typed suggestion in the payload carries no command vocabulary (data only)', () => {
    for (const assessment of analysis().assessments) {
      const payload = unwrap(
        replacementAssessedEnvelope(assessment, causality()),
      ).payload as Record<string, unknown>;
      const serialized = JSON.stringify(payload['suggestion']);
      expect(serialized).not.toContain('commandName');
      expect(serialized).not.toContain('payload');
    }
  });

  it('rejects an assessment whose envelope fails its own contract (fail-closed)', () => {
    const broken = {
      ...assessmentAt(1),
      scope: { kind: 'galaxy' },
    } as unknown as ReplacementAssessment;
    const rejected = replacementAssessedEnvelope(broken, causality());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('stack-event-valid');
    }
  });

  it('pins the payload grammar documentation constant', () => {
    expect(STACK_ASSESSED_PAYLOAD_GRAMMAR).toContain('replacementAssessed payload');
    expect(STACK_ASSESSED_PAYLOAD_GRAMMAR).toContain('score');
    expect(STACK_ASSESSED_PAYLOAD_GRAMMAR).toContain('suggestion');
    expect(STACK_ASSESSED_PAYLOAD_GRAMMAR).toContain('performanceBasis');
  });
});

describe('the injected EventSink port (appends inside the caller\'s transaction)', () => {
  it('records the append + hands over the caller\'s executor', async () => {
    const sink = createInMemoryStackEventSink();
    const emitted = await emitReplacementAssessed(sink, executor, assessmentAt(1), causality());
    expect(emitted).toStrictEqual({ ok: true, value: true });
    expect(sink.appends).toHaveLength(1);
    const append = sink.appends[0];
    expect(append?.executor).toBe(executor);
    expect(append?.events).toHaveLength(1);
    expect(append?.events[0]?.eventName).toBe(STACK_ASSESSED_EVENT);
    expect(sink.events).toHaveLength(1);
  });

  it('emits one envelope per assessment across the golden set (in canonical order)', async () => {
    const sink = createInMemoryStackEventSink();
    for (const assessment of analysis().assessments) {
      expect((await emitReplacementAssessed(sink, executor, assessment, causality())).ok).toBe(
        true,
      );
    }
    expect(sink.events).toHaveLength(5);
    expect(sink.events.map((event) => (event.payload as Record<string, unknown>)['assessmentId'])).toStrictEqual(
      analysis().assessments.map((assessment) => assessment.assessmentId),
    );
  });

  it('a failing sink propagates the typed failure (the caller\'s transaction aborts)', async () => {
    const sink = failingStackEventSink('the ledger rejected the append');
    const rejected = await emitReplacementAssessed(sink, executor, assessmentAt(1), causality());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('invariant-violation');
      expect(rejected.error.details[0]?.code).toBe('stack-sink-rejected');
      expect(String(rejected.error.message)).toContain('the ledger rejected the append');
    }
  });

  it('stackSinkFailure builds the typed sink rejection', () => {
    const failure = stackSinkFailure('reason-here');
    expect(failure.code).toBe('invariant-violation');
    expect(failure.details[0]?.code).toBe('stack-sink-rejected');
    expect(failure.details[0]?.message).toBe('reason-here');
  });

  it('is deterministic: the same assessment emits the byte-identical envelope', () => {
    for (const assessment of analysis().assessments) {
      expect(JSON.stringify(unwrap(replacementAssessedEnvelope(assessment, causality())))).toBe(
        JSON.stringify(unwrap(replacementAssessedEnvelope(assessment, causality()))),
      );
    }
  });
});
