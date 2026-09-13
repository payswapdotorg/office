// Office security — THE audit-completeness conformance check (OFF-036, A3).
//
// Drives the REAL gateway + REAL app runtime through a golden set of
// consequential mutations — executed reads and writes, an approval routing,
// a typed denial, a duplicate replay, an app command dispatch (which audits
// BOTH the runtime's dispatch decision and the gateway's execution
// decision), an audited pre-gateway rejection, an event delivery — and
// records, for every mutation, the audit envelopes it MUST produce. Agent
// runs and sync conflicts are recorded through the @office/contracts
// envelope grammar (the sanctioned type-level path for the agents/sync
// execution records): the driver composes contract-valid envelopes of the
// 'agents.*' / 'sync.*' audit classes and appends them to the audit ledger,
// exactly as those surfaces would.
//
// The pure evaluator performs the COMPLETENESS COUNTING: the multiset of
// (tenant, causation, event name) the mutations expect must equal the
// multiset the audit ledger actually holds — no missing envelope (an
// unaudited consequential mutation), no unclaimed envelope (an audit event
// with no accounted mutation), no duplicates beyond the accounted ones.
import type { TenantId } from '@office/contracts';
import { actionProposal } from '@office/actions';
import type { ConformanceFailure } from './evidence';
import { conformanceFailure, conformanceResult } from './evidence';
import type { ConformanceCheckResult } from './evidence';
import type { ConformanceHarness } from './harness';
import {
  AGENT,
  actorOf,
  allowAllPolicy,
  appActorOf,
  commandEnvelopeOf,
  domainEventOf,
  expectOk,
  subjectRef,
  tenantAScope,
} from './harness';

/** Every consequential-mutation kind the completeness model accounts for. */
export type ConsequentialMutationKind =
  | 'gateway-decision'
  | 'app-command-dispatch'
  | 'app-event-delivery'
  | 'agent-run'
  | 'sync-conflict';

/** One accounted consequential mutation and the audit evidence it must leave. */
export interface ConsequentialMutationRecord {
  /** The mutation's label (stable, deterministic). */
  readonly label: string;
  /** Which surface performed the mutation. */
  readonly kind: ConsequentialMutationKind;
  /** The tenant the mutation ran under (whose trail must hold the evidence). */
  readonly tenantId: TenantId;
  /** The causation id the audit envelopes must point at, or null. */
  readonly causationId: string | null;
  /** Every audit event name this mutation must produce (with multiplicity). */
  readonly expectedAuditEvents: readonly string[];
}

/** The ledger snapshot the evaluator counts (post-drive). */
export interface AuditLedgerSnapshotEntry {
  readonly eventName: string;
  readonly tenantId: TenantId;
  readonly causationId: string | null;
}

/** The recorded audit-completeness evidence of one scenario. */
export interface AuditCompletenessEvidence {
  readonly mutations: readonly ConsequentialMutationRecord[];
  readonly ledger: readonly AuditLedgerSnapshotEntry[];
}

/** The multiset key of one expected/observed audit envelope. */
const envelopeKey = (
  tenantId: TenantId,
  causationId: string | null,
  eventName: string,
): string => `${tenantId}|${causationId ?? '<root>'}|${eventName}`;

/** One gateway-driven mutation (records its own evidence). */
const gatewayMutation = async (
  harness: ConformanceHarness,
  label: string,
  parts: {
    readonly commandName: string;
    readonly evidence?: readonly { readonly slot: string; readonly ref: string }[];
    readonly confidence?: string;
    readonly subject?: boolean;
    readonly capabilities: readonly string[];
    readonly expectedAuditEvents: readonly string[];
  },
): Promise<ConsequentialMutationRecord> => {
  const key = harness.nextKey();
  const command = commandEnvelopeOf(parts.commandName, {
    key,
    actor: actorOf('user'),
  });
  const proposal = actionProposal({
    command,
    subject: parts.subject === true ? subjectRef() : null,
    evidence: parts.evidence ?? [],
    confidence: parts.confidence ?? 'certain',
    resourceScope: null,
    approval: null,
  });
  // The mutation is accounted whether the gateway executed, routed, or
  // denied it — every consequential DECISION leaves its audit envelope.
  await harness.gateway.executeAction(proposal, {
    policy: allowAllPolicy,
    capabilities: parts.capabilities,
  });
  return {
    label,
    kind: 'gateway-decision',
    tenantId: command.scope.tenantId,
    causationId: key,
    expectedAuditEvents: parts.expectedAuditEvents,
  };
};

/**
 * Drive the golden consequential-mutation set through the REAL gateway +
 * REAL app runtime and record every mutation's expected audit evidence.
 */
export async function driveConsequentialMutations(
  harness: ConformanceHarness,
): Promise<readonly ConsequentialMutationRecord[]> {
  const mutations: ConsequentialMutationRecord[] = [];

  // 1. A read-class execution (gateway decision: executed).
  mutations.push(
    await gatewayMutation(harness, 'read-execution', {
      commandName: 'cost.listCostItems',
      capabilities: ['cost.read'],
      expectedAuditEvents: ['actions.actionExecuted'],
    }),
  );

  // 2. A reversible-class execution carrying its A4 evidence.
  mutations.push(
    await gatewayMutation(harness, 'reversible-execution', {
      commandName: 'field.recordProgress',
      evidence: [{ slot: 'observation', ref: 'evidence://field/observation-1' }],
      confidence: 'high',
      capabilities: ['work.write'],
      expectedAuditEvents: ['actions.actionExecuted'],
    }),
  );

  // 3. An approval-required routing (the approval awaits its decision).
  mutations.push(
    await gatewayMutation(harness, 'approval-routing', {
      commandName: 'cost.commitBudgetRevision',
      evidence: [
        { slot: 'justification', ref: 'evidence://revision/justification-1' },
        { slot: 'margin-assessment', ref: 'evidence://revision/margin-1' },
      ],
      confidence: 'certain',
      subject: true,
      capabilities: ['cost.write'],
      expectedAuditEvents: ['actions.actionRoutedToApproval'],
    }),
  );

  // 4. A typed capability denial (a consequential attempt, denied + audited).
  mutations.push(
    await gatewayMutation(harness, 'capability-denial', {
      commandName: 'cost.listCostItems',
      capabilities: [],
      expectedAuditEvents: ['actions.actionDenied'],
    }),
  );

  // 5. A duplicate replay of mutation 2's EXACT command — the original
  //    outcome returns and the duplicate observation is audited.
  const replayKey = mutations[1]?.causationId ?? null;
  if (replayKey !== null) {
    const replayCommand = commandEnvelopeOf('field.recordProgress', {
      key: replayKey,
      actor: actorOf('user'),
    });
    await harness.gateway.executeAction(
      actionProposal({
        command: replayCommand,
        subject: null,
        evidence: [{ slot: 'observation', ref: 'evidence://field/observation-1' }],
        confidence: 'high',
        resourceScope: null,
        approval: null,
      }),
      { policy: allowAllPolicy, capabilities: ['work.write'] },
    );
    mutations.push({
      label: 'duplicate-replay',
      kind: 'gateway-decision',
      tenantId: replayCommand.scope.tenantId,
      causationId: replayKey,
      expectedAuditEvents: ['actions.actionDuplicateObserved'],
    });
  }

  // 6. An app command dispatch through the REAL runtime — BOTH the runtime's
  //    dispatch decision and the gateway's execution decision are audited.
  const appKey = harness.nextKey();
  const appCommand = commandEnvelopeOf('field.recordProgress', {
    key: appKey,
    scope: tenantAScope(),
    actor: appActorOf(harness.installations.a),
  });
  await harness.appRuntime.dispatchCommand({
    installationId: harness.installations.a,
    command: appCommand,
    evidence: [{ slot: 'observation', ref: 'evidence://field/observation-2' }],
    confidence: 'high',
    subject: null,
    resourceScope: null,
  });
  mutations.push({
    label: 'app-command-dispatch',
    kind: 'app-command-dispatch',
    tenantId: appCommand.scope.tenantId,
    causationId: appKey,
    expectedAuditEvents: ['apps.appCommandDispatched', 'actions.actionExecuted'],
  });

  // 7. An audited pre-gateway rejection (a spoofed actor — the runtime's
  //    own actor gate fires before the gateway is ever reached).
  const spoofKey = harness.nextKey();
  const spoofedCommand = commandEnvelopeOf('field.recordProgress', {
    key: spoofKey,
    scope: tenantAScope(),
    actor: actorOf('user'),
  });
  await harness.appRuntime.dispatchCommand({
    installationId: harness.installations.a,
    command: spoofedCommand,
    evidence: [{ slot: 'observation', ref: 'evidence://field/observation-3' }],
    confidence: 'high',
    subject: null,
    resourceScope: null,
  });
  mutations.push({
    label: 'app-command-rejected',
    kind: 'app-command-dispatch',
    tenantId: spoofedCommand.scope.tenantId,
    causationId: spoofKey,
    expectedAuditEvents: ['apps.appCommandRejected'],
  });

  // 8. An event delivery through the REAL runtime (the delivery record is
  //    audited; the delivered event's causation is the record's cause).
  const deliveredKey = harness.nextKey();
  const deliveredEvent = domainEventOf('work.progressRecorded', {
    scope: tenantAScope(),
    entityKind: 'field-report',
    causationId: deliveredKey,
  });
  await harness.appRuntime.dispatchEvent({
    installationId: harness.installations.a,
    event: deliveredEvent,
  });
  mutations.push({
    label: 'app-event-delivery',
    kind: 'app-event-delivery',
    tenantId: deliveredEvent.scope.tenantId,
    causationId: deliveredKey,
    expectedAuditEvents: ['apps.appEventDelivered'],
  });

  // 9. An agent-run audit envelope (the @office/contracts envelope grammar —
  //    the sanctioned type-level path for the agents' execution records).
  const agentRunKey = harness.nextKey();
  const agentRun = domainEventOf('agents.agentRunCompleted', {
    scope: tenantAScope(),
    actor: actorOf('agent', AGENT),
    entityKind: 'agent-run',
    causationId: agentRunKey,
    payload: { runId: agentRunKey, decision: 'completed', actionsExecuted: 1 },
  });
  expectOk(harness.ledger.append(agentRun));
  mutations.push({
    label: 'agent-run-completed',
    kind: 'agent-run',
    tenantId: agentRun.scope.tenantId,
    causationId: agentRunKey,
    expectedAuditEvents: ['agents.agentRunCompleted'],
  });

  // 10. A sync-conflict audit envelope (same grammar-only path).
  const conflictKey = harness.nextKey();
  const conflict = domainEventOf('sync.conflictSurfaced', {
    scope: tenantAScope(),
    actor: actorOf('user'),
    entityKind: 'conflict-record',
    causationId: conflictKey,
    payload: { conflictId: conflictKey, resolution: 'pending' },
  });
  expectOk(harness.ledger.append(conflict));
  mutations.push({
    label: 'sync-conflict-surfaced',
    kind: 'sync-conflict',
    tenantId: conflict.scope.tenantId,
    causationId: conflictKey,
    expectedAuditEvents: ['sync.conflictSurfaced'],
  });

  return mutations;
};

/** Snapshot the audit ledger for the completeness evidence (pure). */
export const auditLedgerSnapshot = (
  harness: ConformanceHarness,
): readonly AuditLedgerSnapshotEntry[] =>
  harness.ledger.events().map((event) => ({
    eventName: event.envelope.eventName,
    tenantId: event.envelope.scope.tenantId,
    causationId: event.envelope.causality.causationId,
  }));

/**
 * Evaluate the audit-completeness evidence (pure, deterministic): the
 * (tenant, causation, event name) multiset the mutations account for must
 * equal the multiset the ledger holds — every consequential mutation leaves
 * its audit envelope, and every audit envelope belongs to an accounted
 * mutation.
 */
export function evaluateAuditCompleteness(
  evidence: AuditCompletenessEvidence,
): ConformanceCheckResult {
  const failures: ConformanceFailure[] = [];
  const expected = new Map<string, { count: number; label: string }>();
  for (const mutation of evidence.mutations) {
    for (const eventName of mutation.expectedAuditEvents) {
      const key = envelopeKey(mutation.tenantId, mutation.causationId, eventName);
      const prior = expected.get(key);
      expected.set(key, { count: (prior?.count ?? 0) + 1, label: mutation.label });
    }
  }
  const observed = new Map<string, number>();
  for (const entry of evidence.ledger) {
    const key = envelopeKey(entry.tenantId, entry.causationId, entry.eventName);
    observed.set(key, (observed.get(key) ?? 0) + 1);
  }
  for (const [key, accounted] of expected) {
    const held = observed.get(key) ?? 0;
    if (held < accounted.count) {
      failures.push(
        conformanceFailure(
          accounted.label,
          'audit-envelope-missing',
          `mutation leaves ${accounted.count} audit envelope(s) of [${key}], the ledger holds ${held} (A3 violated)`,
        ),
      );
    }
  }
  for (const [key, held] of observed) {
    const accounted = expected.get(key)?.count ?? 0;
    if (held > accounted) {
      failures.push(
        conformanceFailure(
          '<ledger>',
          'unclaimed-audit-envelope',
          `${held - accounted} audit envelope(s) of [${key}] have no accounted consequential mutation`,
        ),
      );
    }
  }
  return conformanceResult('audit-completeness', evidence.mutations.length, failures);
}
