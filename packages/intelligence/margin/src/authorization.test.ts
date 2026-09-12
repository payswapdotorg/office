import { describe, expect, it } from 'vitest';
import { projectRelationships, traverseRelationships } from '@office/intelligence-relationships';
import { formatLedgerEventId } from '@office/events';
import type { LedgerEvent, LedgerEventId } from '@office/events';
import type { EntityRef } from '@office/contracts';
import { buildCostScenario } from './scenarios';
import { calculateImpact } from './calculation';
import { projectCommercialFacts } from './facts';
import { CHANGE_EVENT_KIND } from './model';
import { parseAssessmentId } from './vocabulary';
import {
  ALL_ASSESSMENT_CAPABILITIES,
  DENY_ALL_READS_POLICY,
  EMPTY_POLICY,
  PROJECT_2,
  T0,
  TENANT_B,
  appendCommandEvent,
  assessmentAuthorizationOf,
  newEventSource,
  projectOneReader,
  projectOneScope,
  projectTwoScope,
  tenantBScope,
  testCommand,
  testCorrelationId,
  testId,
  testKey,
  unwrap,
} from './test-support';
import type { AssessmentAuthorization } from './authorization';

// OFF-014 assessment authorization — freeze A12, enforced BEFORE any
// calculation: the capability gate (contracts.read AND cost.read AND
// schedule.read — an assessment spans three bounded contexts at once) fires
// before an input is even read; a foreign source event is a typed not-found
// IDENTICAL to an absent one (no existence oracle); cross-scope inputs are
// typed-rejected before computing; and the policy gate (explicit deny wins,
// no allow rule denies) fires before the numbers are derived — proven by
// feeding inputs whose calculation would fail closed: the denial, never the
// calculation error, is what the caller receives.

const CONTRACT_ID = testId('con', 1);
const CHANGE_EVENT_ID = testId('chg', 1);

const contractAggregate: EntityRef = {
  entityKind: 'contract' as EntityRef['entityKind'],
  entityId: CONTRACT_ID,
};

const PROBE_ASSESSMENT_ID = unwrap(parseAssessmentId('assessment-authority-probe'));

const changeEventIdOf = (stream: readonly LedgerEvent[]): LedgerEventId => {
  const changeEvent = stream.find(
    (event) => event.envelope.eventName === 'contracts.changeEventRaised',
  );
  if (changeEvent === undefined) throw new Error('stream has no change event');
  return changeEvent.eventId;
};

/** Build the happy-path inputs of the cost scenario (project one). */
const costInputs = async () => {
  const source = newEventSource();
  await buildCostScenario(source);
  const stream = unwrap(await source.readEvents());
  return subgraphAndFactsOf(stream);
};

/** Project + traverse + fold one stream with the project-one reader. */
const subgraphAndFactsOf = async (stream: readonly LedgerEvent[]) => {
  const index = unwrap(projectRelationships(stream));
  const reader = projectOneReader();
  const subgraph = unwrap(
    traverseRelationships(
      index,
      { start: { entityKind: CHANGE_EVENT_KIND, entityId: CHANGE_EVENT_ID }, maxDepth: 2 },
      { policy: reader.policy, context: reader.context },
    ),
  );
  const facts = unwrap(projectCommercialFacts(stream));
  return { stream, subgraph, facts };
};

const assessWith = (
  inputs: Awaited<ReturnType<typeof subgraphAndFactsOf>>,
  sourceEventId: LedgerEventId,
  authorization: AssessmentAuthorization,
) =>
  calculateImpact(
    { sourceEventId },
    { facts: inputs.facts, subgraph: inputs.subgraph },
    authorization,
    { assessmentId: PROBE_ASSESSMENT_ID, assessedAt: T0 },
  );

describe('assessment capability gate (OFF-014, deny-by-default)', () => {
  for (const missing of ['contracts.read', 'cost.read', 'schedule.read'] as const) {
    it(`denies without the ${missing} capability (typed, naming it)`, async () => {
      const inputs = await costInputs();
      const authorization = assessmentAuthorizationOf(projectOneScope(), {
        capabilities: ALL_ASSESSMENT_CAPABILITIES.filter((capability) => capability !== missing),
      });
      const result = assessWith(inputs, changeEventIdOf(inputs.stream), authorization);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(result.error.details).toHaveLength(1);
        expect(result.error.details[0]?.code).toBe('missing-assessment-capability');
        expect(result.error.details[0]?.message).toContain(missing);
      }
    });
  }

  it('fires before the source lookup: a missing capability beats an absent source event', async () => {
    const inputs = await costInputs();
    const absentId = formatLedgerEventId({
      version: 'v1',
      opaque: '0123456789abcdef0123456789abcdef',
    });
    const authorization = assessmentAuthorizationOf(projectOneScope(), {
      capabilities: ['organization.read', 'projects.read'],
    });
    const result = assessWith(inputs, absentId, authorization);

    // The capability gate is FIRST: even a nonexistent source event never
    // reaches the lookup while a capability is missing.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('missing-assessment-capability');
    }
  });

  it('fires before calculation: a denied request never computes (inconsistent inputs stay uncomputed)', async () => {
    // A stream whose contractCreated event never happened: the margin
    // calculation would fail closed ('assessment-inputs-consistent').
    const source = newEventSource();
    const events = await buildCostScenario(source);
    const stream = unwrap(await source.readEvents()).filter(
      (event) => event.eventId !== events.contractCreated.eventId,
    );
    const inputs = await subgraphAndFactsOf(stream);

    // With every capability held, the calculation DOES run and fails closed
    // — proving these inputs really are uncomputable.
    const computed = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope()),
    );
    expect(computed.ok).toBe(false);
    if (!computed.ok) {
      expect(computed.error.code).toBe('invariant-violation');
      expect(computed.error.details[0]?.code).toBe('assessment-inputs-consistent');
    }

    // Without one capability, the denial is the capability error — the
    // uncomputable numbers were never touched.
    const denied = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope(), {
        capabilities: ALL_ASSESSMENT_CAPABILITIES.filter((c) => c !== 'cost.read'),
      }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('missing-assessment-capability');
    }
  });
});

describe('assessment policy gate (OFF-014, deny-by-default)', () => {
  it('explicit deny wins over the allow-all-reads baseline', async () => {
    const inputs = await costInputs();
    const result = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope(), { policy: DENY_ALL_READS_POLICY }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('explicit-deny');
    }
  });

  it('no allow rule denies (empty policy)', async () => {
    const inputs = await costInputs();
    const result = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope(), { policy: EMPTY_POLICY }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(result.error.details[0]?.code).toBe('no-allow-rule');
    }
  });

  it('fires before calculation: a policy denial beats uncomputable inputs', async () => {
    const source = newEventSource();
    const events = await buildCostScenario(source);
    const stream = unwrap(await source.readEvents()).filter(
      (event) => event.eventId !== events.contractCreated.eventId,
    );
    const inputs = await subgraphAndFactsOf(stream);

    const denied = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope(), { policy: DENY_ALL_READS_POLICY }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      // The policy denial, NOT the calculation's invariant violation —
      // the numbers were never computed.
      expect(denied.error.code).toBe('forbidden');
      expect(denied.error.details[0]?.code).toBe('explicit-deny');
    }
  });
});

describe('structural A12 isolation (OFF-014, no existence oracle)', () => {
  it('a cross-tenant source event is a not-found identical to an absent one', async () => {
    // A minimal tenant-B stream: a contract + a raised change event.
    const tenantBSource = newEventSource();
    await appendCommandEvent(tenantBSource, {
      command: testCommand({
        commandName: 'contracts.createContract',
        scope: tenantBScope(),
        idempotencyKey: testKey(1),
        correlationId: testCorrelationId(1),
        issuedAt: T0,
      }),
      eventName: 'contracts.contractCreated',
      scope: tenantBScope(),
      occurredAt: T0,
      aggregate: contractAggregate,
      payload: {
        contractId: CONTRACT_ID,
        title: 'Foreign works contract',
        version: 1,
        contractValue: { amount: 1000000, currency: 'USD' },
        executionStatus: 'draft',
        createdAt: T0,
      },
    });
    const foreignChange = await appendCommandEvent(tenantBSource, {
      command: testCommand({
        commandName: 'contracts.raiseChangeEvent',
        scope: tenantBScope(),
        idempotencyKey: testKey(2),
        correlationId: testCorrelationId(2),
        issuedAt: T0,
      }),
      eventName: 'contracts.changeEventRaised',
      scope: tenantBScope(),
      occurredAt: T0,
      aggregate: contractAggregate,
      payload: {
        contractId: CONTRACT_ID,
        changeEventId: testId('chg', 1),
        title: 'Foreign change',
        changeType: 'scope',
        status: 'proposed',
        affectedObligationIds: [],
        evidenceLinks: [],
        costImpactLinks: [],
        scheduleImpactActivityIds: [],
        version: 2,
      },
    });

    const inputs = await costInputs();
    const absentId = formatLedgerEventId({
      version: 'v1',
      opaque: '0123456789abcdef0123456789abcdef',
    });

    // The tenant-A reader probing the tenant-B change event…
    const foreign = assessWith(
      inputs,
      foreignChange.eventId,
      assessmentAuthorizationOf(projectOneScope()),
    );
    // …and probing an event that never existed anywhere.
    const absent = assessWith(
      inputs,
      absentId,
      assessmentAuthorizationOf(projectOneScope()),
    );

    expect(foreign.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!foreign.ok && !absent.ok) {
      // IDENTICAL typed not-founds: same code, same detail codes, same
      // denial context — the only difference is the echoed PROBE id the
      // caller supplied itself, so the assessment surface never reveals
      // whether the foreign event exists.
      expect(foreign.error.code).toBe('not-found');
      expect(foreign.error.details[0]?.code).toBe('source-event-not-found');
      expect(foreign.error.details).toHaveLength(absent.error.details.length);
      expect(foreign.error.details.map((detail) => detail.code)).toStrictEqual(
        absent.error.details.map((detail) => detail.code),
      );
      expect(foreign.error.scope).toStrictEqual(absent.error.scope);
      expect(foreign.error.message.startsWith('source ledger event ')).toBe(
        absent.error.message.startsWith('source ledger event '),
      );
      // No tenant-B identity leaks into the denial.
      expect(JSON.stringify(foreign.error)).not.toContain(TENANT_B);
      expect(JSON.stringify(foreign.error)).not.toContain(CONTRACT_ID);
    }
  });

  it('a cross-project source event (same tenant) is the same not-found', async () => {
    const inputs = await costInputs();
    const result = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectTwoScope()),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not-found');
      expect(result.error.details[0]?.code).toBe('source-event-not-found');
    }
  });

  it('cross-scope INPUTS are typed-rejected before any calculation', async () => {
    // The cost scenario in project one, plus one budget creation event in
    // project two of the same tenant: the folded facts carry a foreign-scope
    // input, so the assessment is typed-rejected — never computed.
    const foreignBudgetId = testId('bud', 9);
    const source = newEventSource();
    await buildCostScenario(source);
    await appendCommandEvent(source, {
      command: testCommand({
        commandName: 'cost.createBudget',
        scope: projectTwoScope(),
        idempotencyKey: testKey(99),
        correlationId: testCorrelationId(99),
        issuedAt: T0,
      }),
      eventName: 'cost.budgetCreated',
      scope: projectTwoScope(),
      occurredAt: T0,
      aggregate: {
        entityKind: 'budget' as EntityRef['entityKind'],
        entityId: foreignBudgetId,
      },
      payload: {
        budgetId: foreignBudgetId,
        name: 'Foreign budget',
        currency: 'USD',
        version: 1,
        createdAt: T0,
      },
    });
    const inputs = await subgraphAndFactsOf(unwrap(await source.readEvents()));
    expect(inputs.facts.budgets).toHaveLength(2);

    const result = assessWith(
      inputs,
      changeEventIdOf(inputs.stream),
      assessmentAuthorizationOf(projectOneScope()),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.details[0]?.code).toBe('assessment-input-scope');
      // The rejection never reveals the foreign scope's identity.
      expect(JSON.stringify(result.error)).not.toContain(String(foreignBudgetId));
      expect(JSON.stringify(result.error)).not.toContain(String(PROJECT_2));
    }
  });
});
