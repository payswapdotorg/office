// OFF-017 acceptance — THE gateway chokepoint: executeAction is the only path
// to canonical mutation, so every named acceptance of the item is proven HERE
// against the REAL gateway wired through the deterministic harness:
//
// - direct unauthorized writes fail: an agent/app/adapter (and every other
//   actor kind) without the required capability → typed denial BEFORE the
//   handler is invoked (handler-invocation counting proves it); no actor kind
//   bypasses the authorization step (systematic actor-kind × capability ×
//   policy matrix); A12 cross-tenant/cross-project → typed unauthorized;
// - duplicate action keys do not duplicate effects: the same key re-submitted
//   returns the ORIGINAL result, the handler is invoked exactly once
//   (counting proves it), and a duplicate-observed audit event is emitted;
// - approval-required actions NEVER execute without the workflow approval
//   completing (force-execute attempts → typed rejections);
// - classification is fail-closed: unknown commands prohibited by default;
//   prohibited actions never reach the handler;
// - A4 evidence/confidence requirements reject non-conforming proposals typed
//   and ride into the audit events of the executions they authorize.
import { describe, expect, it } from 'vitest';
import { parseCommandName, parseTimestamp } from '@office/contracts';
import type { ActorKind, DomainEventEnvelope } from '@office/contracts';
import { createInMemoryIdempotencyRegistry, ok } from '@office/domain-kernel';
import {
  ADAPTER,
  AGENT,
  APP,
  FAKE_EXECUTOR,
  MANAGER,
  PROJECT_2,
  SUBJECT_ID,
  TENANT_B,
  envelope,
  grantOf,
  fullGrant,
  handlerFailure,
  makeHarness,
  noCapabilitiesGrant,
  proposal,
  projectScopeOf,
  subjectRef,
  tenantScopeOf,
  unwrap,
  actorOf,
} from './test-support';
import {
  COMMIT_BUDGET_REVISION,
  LIST_COST_ITEMS,
  PURGE_COST_LEDGER,
  RECORD_PROGRESS,
  SUBMIT_DAILY_LOG,
} from './test-support';
import { allowReadOnlyPolicy, allowWriteOnlyPolicy, denyReadPolicy, denyWritePolicy } from './test-support';
import { createActionGateway } from './gateway';
import type { ApprovalReference } from './approval';
import { createInMemoryActionHandlers } from './handlers';
import { createInMemoryActionRegistry } from './registry';
import { createInMemoryApprovalAuthority } from './approval';
import { createInMemoryEventSink } from './audit-events';
import type { ActionAuditPayload, InMemoryEventSink } from './audit-events';
import type { CountingHandler } from './test-support';

// ----- assertion helpers -------------------------------------------------------------------

const ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'app', 'adapter', 'system'];

/** The counting handler of one canonical action in a harness. */
const handlerOf = (harness: ReturnType<typeof makeHarness>, name: string): CountingHandler =>
  harness.handlers[name] as CountingHandler;

/** Total handler invocations across the whole harness (the chokepoint proof). */
const totalInvocations = (harness: ReturnType<typeof makeHarness>): number =>
  Object.values(harness.handlers).reduce((sum, entry) => sum + entry.invocations.count, 0);

/** The audit payloads of the recorded sink events, in order. */
const auditPayloads = (sink: InMemoryEventSink): ActionAuditPayload[] =>
  sink.events.map((event) => (event as DomainEventEnvelope<ActionAuditPayload>).payload);

const lastPayload = (sink: InMemoryEventSink): ActionAuditPayload =>
  auditPayloads(sink)[sink.events.length - 1] as ActionAuditPayload;

/** The denial detail code of a typed failure (its first detail). */
const denialCodeOf = (error: { readonly details: readonly { readonly code: string }[] }): string =>
  error.details[0]?.code ?? '';

/**
 * The approval reference a gateway result routed to (fails loud in tests when
 * the action did not route; narrows the ActionResult union type-safely).
 */
const routedApprovalOf = (result: {
  readonly ok: boolean;
  readonly value?: unknown;
}): ApprovalReference | null => {
  if (!result.ok) {
    throw new Error(`expected a routing outcome, got a typed failure: ${JSON.stringify(result)}`);
  }
  const value = result.value as { readonly decision: string } | undefined;
  if (value === undefined || value.decision !== 'routed-to-approval') return null;
  return (value as unknown as { readonly approval: ApprovalReference }).approval;
};

// ----- happy path: reads and reversible writes execute only through the gateway -------------

describe('executeAction (the chokepoint happy path)', () => {
  it('executes a read action through the injected handler exactly once and audits it', async () => {
    const harness = makeHarness();
    const command = envelope({ query: 'all' }, LIST_COST_ITEMS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, { confidence: 'low' }),
      fullGrant,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.decision === 'executed') {
      expect(result.value.replayed).toBe(false);
      expect(result.value.value).toEqual({
        handled: 'cost.listCostItems',
        payload: { query: 'all' },
      });
    }
    expect(handlerOf(harness, 'cost.listCostItems').invocations.count).toBe(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]?.eventName).toBe('actions.actionExecuted');
    expect(lastPayload(harness.sink).decision).toBe('executed');
    expect(harness.registryStats.records).toBe(1);
  });

  it('executes a reversible write with evidence and confidence and audits the declared gate', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('app', APP),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
        confidence: 'high',
      }),
      fullGrant,
    );
    expect(result.ok).toBe(true);
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(1);
    const payload = lastPayload(harness.sink);
    expect(payload.decision).toBe('executed');
    expect(payload.actionClass).toBe('reversible');
    expect(payload.requiredCapabilities).toEqual(['work.write']);
    expect(payload.policyRef).toBe('policy/field-progress@2');
    expect(payload.compensatingCommand).toBe('field.correctProgress');
  });
});

// ----- THE named acceptance: direct unauthorized writes fail ---------------------------------

describe('direct unauthorized writes fail (THE named acceptance)', () => {
  it('denies an agent without the required capability BEFORE the handler runs (counting proof)', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      }),
      grantOf(['cost.read']), // no work.write
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(denialCodeOf(result.error)).toBe('missing-required-capability');
      expect(result.error.message).toContain('before execution');
    }
    // THE proof: the handler was never invoked, and the denial was audited.
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]?.eventName).toBe('actions.actionDenied');
    expect(lastPayload(harness.sink).denialCode).toBe('missing-required-capability');
    expect(harness.registryStats.records).toBe(0);
  });

  it('denies an app and an adapter actor without the capability the same way', async () => {
    for (const [kind, actorId] of [
      ['app', APP],
      ['adapter', ADAPTER],
    ] as const) {
      const harness = makeHarness();
      const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
        actor: actorOf(kind, actorId),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, {
          subject: subjectRef(),
          evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
        }),
        grantOf(['cost.read']),
      );
      expect(result.ok, `actor kind '${kind}'`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden');
      expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
      expect(lastPayload(harness.sink).decision).toBe('denied');
    }
  });

  it('no actor kind bypasses authorization (systematic actor × capability × policy matrix)', async () => {
    const full = ['cost.read', 'cost.write', 'work.write', 'documents.write'];
    const withoutWorkWrite = ['cost.read', 'cost.write', 'documents.write'];
    const cells = [
      {
        name: 'full capabilities + allow-all policy',
        authorization: grantOf(full),
        denial: null as string | null,
      },
      {
        name: 'full capabilities + explicit deny-write policy',
        authorization: grantOf(full, denyWritePolicy),
        denial: 'explicit-deny',
      },
      {
        name: 'full capabilities + read-only policy (no matching allow rule)',
        authorization: grantOf(full, allowReadOnlyPolicy),
        denial: 'no-allow-rule',
      },
      {
        name: 'missing work.write capability + allow-all policy',
        authorization: grantOf(withoutWorkWrite),
        denial: 'missing-required-capability',
      },
      {
        name: 'missing work.write capability + deny-write policy',
        authorization: grantOf(withoutWorkWrite, denyWritePolicy),
        denial: 'missing-required-capability',
      },
      {
        name: 'no capabilities at all',
        authorization: noCapabilitiesGrant,
        denial: 'missing-required-capability',
      },
    ];
    for (const kind of ACTOR_KINDS) {
      for (const cell of cells) {
        const harness = makeHarness();
        const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
          actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
        });
        const result = await harness.gateway.executeAction(
          proposal(command, {
            subject: subjectRef(),
            evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
          }),
          cell.authorization,
        );
        const label = `actor '${kind}' / ${cell.name}`;
        if (cell.denial === null) {
          expect(result.ok, label).toBe(true);
          expect(handlerOf(harness, 'field.recordProgress').invocations.count, label).toBe(1);
        } else {
          expect(result.ok, label).toBe(false);
          if (!result.ok) {
            expect(result.error.code, label).toBe('forbidden');
            expect(denialCodeOf(result.error), label).toBe(cell.denial);
          }
          // THE proof, for every actor kind × every denial reason: the
          // handler never ran.
          expect(handlerOf(harness, 'field.recordProgress').invocations.count, label).toBe(0);
          expect(lastPayload(harness.sink).decision, label).toBe('denied');
        }
      }
    }
  });

  it('no actor kind bypasses the policy gate on reads either', async () => {
    for (const kind of ACTOR_KINDS) {
      const harness = makeHarness();
      const command = envelope({}, LIST_COST_ITEMS.commandName, {
        actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, { confidence: 'low' }),
        grantOf(['cost.read'], denyReadPolicy),
      );
      expect(result.ok, `actor '${kind}'`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(denialCodeOf(result.error)).toBe('explicit-deny');
      }
      expect(handlerOf(harness, 'cost.listCostItems').invocations.count).toBe(0);
    }
    for (const kind of ACTOR_KINDS) {
      const harness = makeHarness();
      const command = envelope({}, LIST_COST_ITEMS.commandName, {
        actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, { confidence: 'low' }),
        grantOf(['cost.read', 'cost.write', 'work.write', 'documents.write'], allowWriteOnlyPolicy),
      );
      expect(result.ok, `actor '${kind}'`).toBe(false);
      if (!result.ok) expect(denialCodeOf(result.error)).toBe('no-allow-rule');
      expect(handlerOf(harness, 'cost.listCostItems').invocations.count).toBe(0);
    }
  });

  it("denies actor kinds the descriptor does not accept, before anything else", async () => {
    // SUBMIT_DAILY_LOG accepts only 'user' actors.
    for (const kind of ACTOR_KINDS) {
      const harness = makeHarness();
      const command = envelope({}, SUBMIT_DAILY_LOG.commandName, {
        actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, {}),
        fullGrant,
      );
      if (kind === 'user') {
        expect(result.ok, `actor '${kind}'`).toBe(true);
        expect(handlerOf(harness, 'documents.submitDailyLog').invocations.count).toBe(1);
      } else {
        expect(result.ok, `actor '${kind}'`).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('forbidden');
          expect(denialCodeOf(result.error)).toBe('actor-kind-not-permitted');
        }
        expect(handlerOf(harness, 'documents.submitDailyLog').invocations.count).toBe(0);
      }
    }
  });

  it('A12: a cross-tenant resource is typed unauthorized, for every actor kind, handler never invoked', async () => {
    for (const kind of ACTOR_KINDS) {
      const harness = makeHarness();
      const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
        actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, {
          subject: subjectRef(),
          evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
          resourceScope: tenantScopeOf(TENANT_B),
        }),
        fullGrant, // full capabilities + allow-all policy still cannot allow it
      );
      expect(result.ok, `actor '${kind}'`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unauthorized');
        expect(denialCodeOf(result.error)).toBe('tenant-scope-violation');
      }
      expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
      expect(lastPayload(harness.sink).decision).toBe('denied');
    }
  });

  it('A12: a cross-project resource of the same tenant is typed unauthorized too', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
        resourceScope: projectScopeOf(PROJECT_2),
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(denialCodeOf(result.error)).toBe('project-scope-violation');
    }
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
  });
});

// ----- THE named acceptance: duplicate action keys do not duplicate effects ------------------

describe('duplicate action keys do not duplicate effects (THE named acceptance)', () => {
  it('returns the ORIGINAL result, invokes the handler exactly once, audits the duplicate', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const prop = proposal(command, {
      subject: subjectRef(),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
    });
    const first = await harness.gateway.executeAction(prop, fullGrant);
    expect(first.ok).toBe(true);
    const original =
      first.ok && first.value.decision === 'executed' ? first.value.value : undefined;
    expect(first.ok && first.value.decision === 'executed' ? first.value.replayed : null).toBe(
      false,
    );

    // The re-submission: SAME command (same scope + key + fingerprint).
    const duplicate = await harness.gateway.executeAction(prop, fullGrant);
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok && duplicate.value.decision === 'executed') {
      expect(duplicate.value.replayed).toBe(true);
      // THE proof: the ORIGINAL value returns…
      expect(duplicate.value.value).toEqual(original);
    }
    // …the handler was invoked EXACTLY once…
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(1);
    // …and the duplicate observation was audited.
    expect(harness.sink.events).toHaveLength(2);
    expect(harness.sink.events[1]?.eventName).toBe('actions.actionDuplicateObserved');
    const payload = lastPayload(harness.sink);
    expect(payload.decision).toBe('duplicate-observed');
    expect(payload.replayed).toBe(true);
    expect(harness.registryStats.records).toBe(1);
  });

  it('replays a read duplicate the same way (one handler invocation total)', async () => {
    const harness = makeHarness();
    const command = envelope({ query: 'all' }, LIST_COST_ITEMS.commandName);
    const prop = proposal(command, { confidence: 'low' });
    await harness.gateway.executeAction(prop, fullGrant);
    const duplicate = await harness.gateway.executeAction(prop, fullGrant);
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.replayed).toBe(true);
    expect(handlerOf(harness, 'cost.listCostItems').invocations.count).toBe(1);
    expect(harness.sink.events[1]?.eventName).toBe('actions.actionDuplicateObserved');
  });

  it('a third submission still replays the original (no accumulating effects)', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName);
    const prop = proposal(command, {
      subject: subjectRef(),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
    });
    await harness.gateway.executeAction(prop, fullGrant);
    await harness.gateway.executeAction(prop, fullGrant);
    const third = await harness.gateway.executeAction(prop, fullGrant);
    expect(third.ok).toBe(true);
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(1);
    expect(harness.sink.events).toHaveLength(3);
    expect(auditPayloads(harness.sink).filter((payload) => payload.decision === 'executed')).toHaveLength(1);
  });

  it('rejects the same key re-used for a different command (typed idempotency-conflict)', async () => {
    const harness = makeHarness();
    const key = 'act-same-key-0001';
    const first = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, { key });
    await harness.gateway.executeAction(
      proposal(first, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      }),
      fullGrant,
    );
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(1);

    // Same (scope, key), different payload → different fingerprint.
    const swapped = envelope({ note: 'R-2' }, RECORD_PROGRESS.commandName, { key });
    const result = await harness.gateway.executeAction(
      proposal(swapped, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('idempotency-conflict');
      expect(denialCodeOf(result.error)).toBe('idempotency-key-reuse');
    }
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(1);
    expect(harness.registryStats.records).toBe(1);
  });

  it('a failed execution stays retryable under the same key (only successes record)', async () => {
    // A local wiring with a handler that fails the first time, succeeds after.
    let failing = true;
    const invocations = { count: 0 };
    const registry = createInMemoryActionRegistry([RECORD_PROGRESS]);
    const handlers = createInMemoryActionHandlers({
      [RECORD_PROGRESS.commandName as string]: async (command) => {
        invocations.count += 1;
        if (failing) return { ok: false, error: handlerFailure() };
        return ok({ handled: command.commandName as string });
      },
    });
    const sink = createInMemoryEventSink();
    const gateway = createActionGateway({
      registry,
      handlers,
      idempotencyRegistry: createInMemoryIdempotencyRegistry(),
      eventSink: sink,
      approvalAuthority: createInMemoryApprovalAuthority(),
      now: () => unwrap(parseTimestamp('2026-09-12T10:15:31.000Z')),
      newEntityId: () => AGENT,
      executor: FAKE_EXECUTOR,
    });
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      key: 'act-retry-key-0001',
    });
    const prop = proposal(command, {
      subject: subjectRef(),
      evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
    });
    const failed = await gateway.executeAction(prop, fullGrant);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('invariant-violation');
      expect(denialCodeOf(failed.error)).toBe('handler-rejected');
    }
    // The domain failure is the domain's own typed outcome: no gateway audit
    // event, no idempotency record — the key stays retryable.
    expect(sink.events).toHaveLength(0);

    failing = false;
    const retried = await gateway.executeAction(prop, fullGrant);
    expect(retried.ok).toBe(true);
    expect(invocations.count).toBe(2); // the retry DID re-invoke the handler
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventName).toBe('actions.actionExecuted');
  });
});

// ----- approval-required actions never execute without the completed approval ---------------

describe('approval-required actions never execute without the completed approval', () => {
  const commitProposal = (command: ReturnType<typeof envelope>, options: {
    readonly approval?: { instanceId: string; approvalKey: string } | null;
  } = {}) =>
    proposal(command, {
      subject: subjectRef(),
      evidence: [
        { slot: 'justification', ref: 'note-0001' },
        { slot: 'margin-assessment', ref: 'margin-0001' },
      ],
      confidence: 'high',
      approval: options.approval ?? null,
    });

  it('routes into the approval engine instead of executing (handler never invoked)', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.decision === 'routed-to-approval') {
      expect(result.value.replayed).toBe(false);
      expect(result.value.approval.approvalKey).toBe('action');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.approvalAuthority.opened).toBe(1);
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]?.eventName).toBe('actions.actionRoutedToApproval');
    const payload = lastPayload(harness.sink);
    expect(payload.decision).toBe('routed-to-approval');
    expect(payload.approval?.approvalKey).toBe('action');
    expect(payload.approvalStatus).toBe('pending');
  });

  it('force-execute while the approval is still pending → typed rejection, handler never invoked', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const reference = routedApprovalOf(routed);
    expect(reference).not.toBeNull();

    // THE force-execute attempt: re-enter carrying the (still pending)
    // approval reference as if it had completed.
    const forced = await harness.gateway.executeAction(
      commitProposal(command, { approval: reference }),
      fullGrant,
    );
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.error.code).toBe('forbidden');
      expect(denialCodeOf(forced.error)).toBe('approval-not-completed');
      expect(forced.error.message).toContain('never executes an approval-required action');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.sink.events[harness.sink.events.length - 1]?.eventName).toBe(
      'actions.actionDenied',
    );
  });

  it('force-execute after the approval was REJECTED → typed rejection, handler never invoked', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('app', APP),
    });
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const reference = routedApprovalOf(routed);
    expect(reference).not.toBeNull();
    if (reference) {
      const decided = harness.approvalAuthority.decide(
        reference,
        'rejected',
        MANAGER,
        unwrap(parseTimestamp('2026-09-12T10:20:00.000Z')),
      );
      expect(decided.ok).toBe(true);
    }

    const forced = await harness.gateway.executeAction(
      commitProposal(command, { approval: reference }),
      fullGrant,
    );
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.error.code).toBe('forbidden');
      expect(denialCodeOf(forced.error)).toBe('approval-rejected');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
  });

  it('a foreign approval reference is typed rejected (no existence oracle needed)', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const reference = routedApprovalOf(routed);
    expect(reference).not.toBeNull();
      // A mismatched instance id (e.g. another approval leaked to this actor):
    // any valid EntityId that is not THIS proposal's routed instance.
    const foreign = await harness.gateway.executeAction(
      commitProposal(command, {
        approval: { instanceId: SUBJECT_ID, approvalKey: 'action' },
      }),
      fullGrant,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe('forbidden');
      expect(denialCodeOf(foreign.error)).toBe('approval-reference-mismatch');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
  });

  it('re-entry without the approval reference replays the pending routing (no second approval)', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const reference = routedApprovalOf(routed);

    const replay = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(replay.ok).toBe(true);
    if (replay.ok && replay.value.decision === 'routed-to-approval') {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.approval).toEqual(reference);
    }
    expect(harness.approvalAuthority.opened).toBe(1); // the authority was NOT called again
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.sink.events[1]?.eventName).toBe('actions.actionDuplicateObserved');
  });

  it('executes ONLY after the approval completed, carrying the approval provenance', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const routed = await harness.gateway.executeAction(commitProposal(command), fullGrant);
    expect(routed.ok).toBe(true);
    const reference = routedApprovalOf(routed);
    expect(reference).not.toBeNull();
    const decidedAt = unwrap(parseTimestamp('2026-09-12T10:20:00.000Z'));
    if (reference) {
      const decided = harness.approvalAuthority.decide(reference, 'approved', MANAGER, decidedAt);
      expect(decided.ok).toBe(true);
    }

    const executed = await harness.gateway.executeAction(
      commitProposal(command, { approval: reference }),
      fullGrant,
    );
    expect(executed.ok).toBe(true);
    if (executed.ok) {
      expect(executed.value.decision).toBe('executed');
      expect(executed.value.replayed).toBe(false);
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(1);
    const payload = lastPayload(harness.sink);
    expect(payload.decision).toBe('executed');
    expect(payload.approval).toEqual(
      reference ? { instanceId: reference.instanceId, approvalKey: 'action' } : null,
    );
    expect(payload.approvalStatus).toBe('approved');
    expect(payload.decidedBy).toBe(MANAGER);
    expect(payload.decidedAt).toBe(decidedAt);

    // A further duplicate of the SAME key still replays the executed outcome.
    const duplicate = await harness.gateway.executeAction(
      commitProposal(command, { approval: reference }),
      fullGrant,
    );
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.replayed).toBe(true);
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(1);
  });

  it('an approval-required proposal without a subject is a typed wiring failure', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: null,
        evidence: [
          { slot: 'justification', ref: 'note-0001' },
          { slot: 'margin-assessment', ref: 'margin-0001' },
        ],
        confidence: 'high',
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(denialCodeOf(result.error)).toBe('approval-subject-required');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.approvalAuthority.opened).toBe(0);
  });
});

// ----- classification is fail-closed ----------------------------------------------------------

describe('classification is fail-closed', () => {
  it('an unknown command is prohibited by default and never reaches any handler', async () => {
    const harness = makeHarness();
    const command = envelope({}, unwrap(parseCommandName('cost.unknownAction')));
    const result = await harness.gateway.executeAction(
      proposal(command, {}),
      fullGrant, // full capabilities + allow-all policy change nothing
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
      expect(denialCodeOf(result.error)).toBe('unknown-action');
      expect(result.error.message).toContain('prohibited by default');
    }
    expect(totalInvocations(harness)).toBe(0); // NO handler of any action ran
    expect(harness.sink.events).toHaveLength(1);
    expect(harness.sink.events[0]?.eventName).toBe('actions.actionDenied');
    expect(lastPayload(harness.sink).denialCode).toBe('unknown-action');
  });

  it('a prohibited action never executes — for any actor kind, under any grant', async () => {
    for (const kind of ACTOR_KINDS) {
      const harness = makeHarness();
      const command = envelope({}, PURGE_COST_LEDGER.commandName, {
        actor: actorOf(kind, kind === 'system' ? undefined : AGENT),
      });
      const result = await harness.gateway.executeAction(
        proposal(command, {}),
        fullGrant,
      );
      expect(result.ok, `actor '${kind}'`).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden');
        expect(denialCodeOf(result.error)).toBe('prohibited-action');
      }
      expect(handlerOf(harness, 'cost.purgeCostLedger').invocations.count).toBe(0);
      expect(harness.approvalAuthority.opened).toBe(0);
      expect(lastPayload(harness.sink).denialCode).toBe('prohibited-action');
    }
  });
});

// ----- A4 evidence + confidence enforcement --------------------------------------------------

describe('A4 evidence and confidence enforcement', () => {
  it('rejects a write proposal missing the declared evidence slot (typed)', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, { subject: subjectRef() }), // no 'observation' evidence
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(denialCodeOf(result.error)).toBe('missing-required-evidence');
      expect(result.error.message).toContain('observation');
    }
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
    expect(lastPayload(harness.sink).denialCode).toBe('missing-required-evidence');
  });

  it('rejects an approval-required proposal missing one of two declared slots (typed)', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'justification', ref: 'note-0001' }], // margin-assessment missing
        confidence: 'high',
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(denialCodeOf(result.error)).toBe('missing-required-evidence');
      expect(result.error.message).toContain('margin-assessment');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.approvalAuthority.opened).toBe(0);
  });

  it('rejects a proposal below the declared confidence (typed)', async () => {
    const harness = makeHarness();
    const command = envelope({ revision: 'BR-1' }, COMMIT_BUDGET_REVISION.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [
          { slot: 'justification', ref: 'note-0001' },
          { slot: 'margin-assessment', ref: 'margin-0001' },
        ],
        confidence: 'medium', // 'high' is the declared minimum
      }),
      fullGrant,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invariant-violation');
      expect(denialCodeOf(result.error)).toBe('insufficient-confidence');
    }
    expect(handlerOf(harness, 'cost.commitBudgetRevision').invocations.count).toBe(0);
    expect(harness.approvalAuthority.opened).toBe(0);
  });

  it('authorization runs before evidence: a capability denial wins the denial code', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('adapter', ADAPTER),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, { subject: subjectRef() }), // missing evidence TOO
      grantOf(['cost.read']), // and missing work.write
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(denialCodeOf(result.error)).toBe('missing-required-capability');
    expect(handlerOf(harness, 'field.recordProgress').invocations.count).toBe(0);
  });

  it('an approved execution carries its evidence refs and confidence into the audit event', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
        confidence: 'high',
      }),
      fullGrant,
    );
    expect(result.ok).toBe(true);
    const payload = lastPayload(harness.sink);
    expect(payload.evidence).toEqual([{ slot: 'observation', ref: 'field-obs-0001' }]);
    expect(payload.confidence).toBe('high');
    expect(payload.actorKind).toBe('agent');
    expect(payload.commandName).toBe('field.recordProgress');
  });

  it('a denied proposal still audits the provenance it carried', async () => {
    const harness = makeHarness();
    const command = envelope({ note: 'R-1' }, RECORD_PROGRESS.commandName, {
      actor: actorOf('agent', AGENT),
    });
    const result = await harness.gateway.executeAction(
      proposal(command, {
        subject: subjectRef(),
        evidence: [{ slot: 'observation', ref: 'field-obs-0001' }],
        confidence: 'high',
      }),
      grantOf(['cost.read']),
    );
    expect(result.ok).toBe(false);
    const payload = lastPayload(harness.sink);
    expect(payload.decision).toBe('denied');
    expect(payload.evidence).toEqual([{ slot: 'observation', ref: 'field-obs-0001' }]);
    expect(payload.confidence).toBe('high');
  });
});
