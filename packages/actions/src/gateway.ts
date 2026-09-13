// Office action gateway — executeAction(), THE execution chokepoint (OFF-017).
//
// Freeze A8 (AI execution boundary) + the canonical 'agent action' flow:
// agents/apps/adapters/humans NEVER write canonical state directly — every
// consequential action passes through THIS function, which enforces the full
// decision pipeline BEFORE any execution, in the frozen order:
//
//   1. CLASSIFY (fail-closed): resolve the ActionDescriptor; an UNKNOWN
//      command is prohibited by default — typed rejection + audit event,
//      before anything else runs;
//   2. PROHIBITED rejection: a prohibited action is never executed, for any
//      actor, under any policy;
//   3. AUTHORIZATION (deny-by-default; no actor kind bypasses it — the very
//      same @office/authz authorize() every module uses):
//      a. the descriptor's actor-kind requirement,
//      b. the descriptor's required capabilities,
//      c. the caller-supplied policy (structural A12 isolation first, then
//         explicit deny, then allow, then default deny);
//   4. A4 EVIDENCE: every declared evidence slot must be filled;
//   5. A4 CONFIDENCE: the proposal's confidence must meet the declared
//      minimum;
//   6. IDEMPOTENCY (freeze A8 / ADR-005): the (scope, idempotency key) pair is
//      looked up BEFORE the handler runs — a same-fingerprint replay returns
//      the ORIGINAL outcome with NO duplicate effects (and a
//      duplicate-observed audit event); a different fingerprint under the
//      same key is a typed idempotency-conflict;
//   7. ROUTING BY CLASS:
//      - 'read' / 'reversible': execute against the INJECTED typed command
//        handler (never a store), append the executed audit event through the
//        EventSink port in the same transaction, record the outcome;
//      - 'approval-required': route INTO the approval engine (the injected
//        ApprovalAuthority — the @office/workflows adapter in production) and
//        return the pending state. The action executes ONLY when the proposal
//        re-enters carrying the approval reference AND the authority reports
//        the approval decided 'approved'; anything else — a pending approval,
//        a rejected one, a foreign reference — is a typed rejection. There is
//        no path from this function to the handler for an approval-required
//        action that has not completed its approval.
//
// Only SUCCESSFUL executions (and successful approval routings) are recorded
// in the idempotency registry — a failed execution stays retryable under the
// same key. Every decision emits a DomainEventEnvelope through the EventSink
// port: executed / routed-to-approval / denied / duplicate-observed (see
// audit-events.ts). Denials never record, so the same key re-runs the gates.
import type { EntityId, Timestamp } from '@office/contracts';
import { authorizationContext, authorize, resourceScope } from '@office/authz';
import {
  commandFingerprint,
  domainError,
  fail,
  ok,
} from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, IdempotencyRegistry, Result } from '@office/domain-kernel';
import type { SqlExecutor } from '@office/persistence';
import { classifyAction, authorizationActionOf } from './classification';
import type { ActionClass, ActionDescriptor } from './descriptor';
import type { ActionRegistry } from './registry';
import type { ActionAuthorization, ActionProposal } from './proposal';
import type { ActionHandlers } from './handlers';
import type { ApprovalAuthority, ApprovalRecord, ApprovalReference } from './approval';
import type { EventSink } from './audit-events';
import {
  ACTION_DENIED_EVENT,
  ACTION_DUPLICATE_OBSERVED_EVENT,
  ACTION_EXECUTED_EVENT,
  ACTION_ROUTED_TO_APPROVAL_EVENT,
  actionEventEnvelope,
  auditPayloadBaseOf,
  withApprovalOnPayload,
} from './audit-events';
import type { ActionAuditPayload } from './audit-events';
import { meetsConfidence } from './evidence';

/** Wiring dependencies of the action gateway. */
export interface ActionGatewayDeps {
  /** The registry of known actions (fail-closed classification source). */
  readonly registry: ActionRegistry;
  /** The injected typed command handlers (read/reversible execution). */
  readonly handlers: ActionHandlers;
  /** The idempotency registry keyed by (scope, idempotency key). */
  readonly idempotencyRegistry: IdempotencyRegistry;
  /** The audit-event sink (the gateway's own audit trail). */
  readonly eventSink: EventSink;
  /** The approval engine seam (approval-required routing). */
  readonly approvalAuthority: ApprovalAuthority;
  /** Injected clock: the canonical 'now' of each decision. */
  readonly now: () => Timestamp;
  /** Injected canonical-id supplier handed to executed handlers. */
  readonly newEntityId: () => EntityId;
  /** The executor (transaction handle) the sink appends with. */
  readonly executor: SqlExecutor;
}

/** The typed outcome of one action through the gateway. */
export type ActionResult =
  /** The action executed against the injected handler (replayed = duplicate). */
  | { readonly decision: 'executed'; readonly replayed: boolean; readonly value: unknown }
  /** The action awaits its workflow approval (replayed = duplicate routing). */
  | {
      readonly decision: 'routed-to-approval';
      readonly replayed: boolean;
      readonly approval: ApprovalReference;
    };

/**
 * The recorded outcome of a prior gateway decision under an idempotency key:
 * either a committed execution (its value) or a live approval routing (its
 * reference). Replays reconstruct the ActionResult from this record — the
 * handler is never invoked twice for one key.
 */
export type RecordedActionOutcome =
  | { readonly decision: 'executed'; readonly value: unknown }
  | { readonly decision: 'routed-to-approval'; readonly approval: ApprovalReference };

/** THE gateway: executeAction is the only path to canonical mutation. */
export interface ActionGateway {
  /**
   * Propose one action for execution. Every gate runs before any execution;
   * every decision emits an audit event; duplicates replay the original
   * outcome with no duplicate effects.
   */
  executeAction(
    proposal: ActionProposal,
    authorization: ActionAuthorization,
  ): Promise<Result<ActionResult, DomainError>>;
};

/** Create the action gateway (the chokepoint instance). */
export function createActionGateway(deps: ActionGatewayDeps): ActionGateway {
  const errorContextOf = (proposal: ActionProposal): DomainErrorContext => ({
    scope: proposal.command.scope,
    correlationId: proposal.command.causality.correlationId,
  });

  /** Append one audit event through the sink (typed failure passthrough). */
  const audit = async (
    proposal: ActionProposal,
    eventName: Parameters<typeof actionEventEnvelope>[0]['eventName'],
    payload: ActionAuditPayload,
  ): Promise<Result<true, DomainError>> =>
    deps.eventSink.appendEvents(deps.executor, [
      actionEventEnvelope({
        command: proposal.command,
        eventName,
        payload,
        subject: proposal.subject,
        occurredAt: deps.now(),
      }),
    ]);

  /** Deny the action: emit the denied audit event, then return the typed failure. */
  const deny = async (
    proposal: ActionProposal,
    error: DomainError,
    parts: {
      readonly commandName: string;
      readonly actionClass: ActionClass;
      readonly denialCode: string;
      readonly requiredCapabilities: readonly string[];
      readonly policyRef: string | null;
      readonly compensatingCommand: string | null;
      readonly approval?: ApprovalReference | null;
      readonly approvalStatus?: string | null;
    },
  ): Promise<Result<ActionResult, DomainError>> => {
    const appended = await audit(
      proposal,
      ACTION_DENIED_EVENT,
      withApprovalOnPayload(
        {
          ...auditPayloadBaseOf({
            proposal,
            commandName: parts.commandName,
            actionClass: parts.actionClass,
            decision: 'denied',
            requiredCapabilities: parts.requiredCapabilities,
            policyRef: parts.policyRef,
            compensatingCommand: parts.compensatingCommand,
          }),
          denialCode: parts.denialCode,
        },
        parts.approval ?? null,
        parts.approval === undefined ? null : (parts.approvalStatus ?? null),
      ),
    );
    if (!appended.ok) return appended;
    return fail(error);
  };

  /** Execute against the injected handler + append the executed audit event + record. */
  const execute = async (
    proposal: ActionProposal,
    descriptor: ActionDescriptor,
    approval: { readonly record: ApprovalRecord } | null,
  ): Promise<Result<ActionResult, DomainError>> => {
    const command = proposal.command;
    const handler = deps.handlers.resolve(command.commandName);
    if (handler === null) {
      // A declared action without a handler is a wiring defect, not a policy
      // decision: typed invariant-violation, no audit event, no record.
      return fail(
        domainError(
          'invariant-violation',
          `action '${command.commandName}' is declared but no typed command handler is registered for it`,
          [
            {
              code: 'handler-not-registered',
              message: `no handler for '${command.commandName}'`,
              path: null,
            },
          ],
          errorContextOf(proposal),
        ),
      );
    }
    const executed = await handler(command, {
      transaction: deps.executor,
      now: deps.now,
      newEntityId: deps.newEntityId,
    });
    if (!executed.ok) {
      // Domain failures are the domain's own typed outcomes: passthrough, no
      // gateway audit event, no idempotency record (the key stays retryable).
      return executed;
    }
    const payload = withApprovalOnPayload(
      auditPayloadBaseOf({
        proposal,
        commandName: command.commandName,
        actionClass: descriptor.actionClass,
        decision: 'executed',
        requiredCapabilities: descriptor.requiredCapabilities,
        policyRef: descriptor.policyRef,
        compensatingCommand: descriptor.compensatingCommand,
      }),
      approval === null ? null : approval.record.reference,
      approval === null ? null : approval.record.status,
      approval === null ? null : approval.record.decidedBy,
      approval === null ? null : approval.record.decidedAt,
    );
    const appended = await audit(proposal, ACTION_EXECUTED_EVENT, payload);
    if (!appended.ok) return appended;
    const recorded = deps.idempotencyRegistry.record(
      command.scope,
      command.idempotencyKey,
      commandFingerprint(command),
      { decision: 'executed', value: executed.value } satisfies RecordedActionOutcome,
      errorContextOf(proposal),
    );
    if (!recorded.ok) return recorded;
    return ok({ decision: 'executed', replayed: false, value: executed.value } satisfies ActionResult);
  };

  /** Route an approval-required action into the approval engine. */
  const routeForApproval = async (
    proposal: ActionProposal,
    descriptor: ActionDescriptor,
    routing: NonNullable<ActionDescriptor['approval']>,
  ): Promise<Result<ApprovalRecord, DomainError>> => {
    if (proposal.subject === null) {
      return fail(
        domainError(
          'invariant-violation',
          `approval-required action '${proposal.command.commandName}' needs a proposal subject to route into the approval engine`,
          [
            {
              code: 'approval-subject-required',
              message: 'the proposal carries no subject EntityRef',
              path: 'subject',
            },
          ],
          errorContextOf(proposal),
        ),
      );
    }
    const opened = await deps.approvalAuthority.openApproval({
      command: proposal.command,
      subject: proposal.subject,
      routing,
    });
    if (!opened.ok) return opened;
    const record = opened.value;
    if (
      record.requiredCapability !== routing.requiredCapability ||
      record.policyRef !== routing.policyRef
    ) {
      // The authority's approval disagrees with the descriptor's declared
      // decision gate — a wiring mismatch, fail-closed.
      return fail(
        domainError(
          'invariant-violation',
          `the approval routed for '${proposal.command.commandName}' enforces a different decision gate than its descriptor declares`,
          [
            {
              code: 'approval-routing-mismatch',
              message: `descriptor requires '${routing.requiredCapability}'@'${routing.policyRef}', routed approval enforces '${record.requiredCapability}'@'${record.policyRef}'`,
              path: 'approval',
            },
          ],
          errorContextOf(proposal),
        ),
      );
    }
    return ok(record);
  };

  return {
    executeAction: async (proposal, authorization) => {
      const command = proposal.command;
      const context = errorContextOf(proposal);

      // 1. CLASSIFY — fail-closed: unknown commands are prohibited by default.
      const classification = classifyAction(deps.registry, command.commandName);
      if (classification.actionClass === 'prohibited') {
        const unknown = !classification.known;
        return deny(
          proposal,
          domainError(
            'forbidden',
            unknown
              ? `command '${command.commandName}' is not a registered action and is prohibited by default (fail-closed classification)`
              : `action '${command.commandName}' is prohibited and can never execute through the gateway`,
            [
              {
                code: unknown ? 'unknown-action' : 'prohibited-action',
                message: unknown
                  ? 'no registered ActionDescriptor names this command'
                  : 'the action descriptor declares class prohibited',
                path: 'commandName',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: 'prohibited',
            denialCode: unknown ? 'unknown-action' : 'prohibited-action',
            requiredCapabilities: [],
            policyRef: null,
            compensatingCommand: null,
          },
        );
      }
      const descriptor = classification.descriptor;
      if (descriptor === null) {
        // Unreachable behind the classification guard; kept total for safety.
        throw new TypeError('classification invariant violated: descriptor is null');
      }

      // 2. ACTOR-KIND REQUIREMENT — the descriptor's own gate, first.
      if (!descriptor.actorKinds.includes(command.actor.kind)) {
        return deny(
          proposal,
          domainError(
            'forbidden',
            `action '${command.commandName}' does not accept actor kind '${command.actor.kind}' (declared: ${descriptor.actorKinds.join(', ')})`,
            [
              {
                code: 'actor-kind-not-permitted',
                message: `actor kind '${command.actor.kind}' not in [${descriptor.actorKinds.join(', ')}]`,
                path: 'command.actor',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'actor-kind-not-permitted',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }

      // 3a. REQUIRED CAPABILITIES — the proposing actor must hold them all.
      const held = authorization.capabilities as readonly string[];
      const missing = descriptor.requiredCapabilities.filter(
        (required) => !held.includes(required),
      );
      if (missing.length > 0) {
        return deny(
          proposal,
          domainError(
            'forbidden',
            `action '${command.commandName}' requires capabilities [${missing.join(', ')}] which the actor does not hold; the action is denied before execution`,
            [
              {
                code: 'missing-required-capability',
                message: `missing [${missing.join(', ')}]`,
                path: null,
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'missing-required-capability',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }

      // 3b. POLICY — deny-by-default through the SAME evaluator every module
      // uses; structural A12 isolation runs first inside it, so cross-tenant
      // and cross-project resources are typed 'unauthorized' no rule can
      // allow, and no actor kind (agent, app, adapter, system, user) bypasses.
      const decision = authorize(
        authorization.policy,
        authorizationContext({
          actor: command.actor,
          scope: command.scope,
          capabilities: authorization.capabilities,
        }),
        resourceScope({
          scope: proposal.resourceScope ?? command.scope,
          resourceKind: descriptor.resourceKind,
          resourceId: proposal.subject === null ? null : proposal.subject.entityId,
          ownerId: null,
        }),
        authorizationActionOf(descriptor.actionClass),
        context,
      );
      if (!decision.ok) {
        return deny(
          proposal,
          decision.error,
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: decision.error.details[0]?.code ?? 'policy-denied',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }

      // 4. A4 EVIDENCE — every declared slot must be filled by the proposal.
      const carriedSlots = new Set(proposal.evidence.map((reference) => reference.slot));
      const missingSlots = descriptor.evidenceRequirements.filter(
        (requirement) => !carriedSlots.has(requirement.slot),
      );
      if (missingSlots.length > 0) {
        return deny(
          proposal,
          domainError(
            'invariant-violation',
            `action '${command.commandName}' requires evidence for slot(s) [${missingSlots
              .map((requirement) => requirement.slot)
              .join(', ')}] which the proposal does not carry (freeze A4)`,
            [
              {
                code: 'missing-required-evidence',
                message: `missing slot(s) [${missingSlots
                  .map((requirement) => requirement.slot)
                  .join(', ')}]`,
                path: 'evidence',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'missing-required-evidence',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }

      // 5. A4 CONFIDENCE — the proposal must meet the declared minimum.
      if (!meetsConfidence(proposal.confidence, descriptor.requiredConfidence)) {
        return deny(
          proposal,
          domainError(
            'invariant-violation',
            `action '${command.commandName}' requires confidence '${descriptor.requiredConfidence}' but the proposal carries '${proposal.confidence}' (freeze A4)`,
            [
              {
                code: 'insufficient-confidence',
                message: `required '${descriptor.requiredConfidence}', carried '${proposal.confidence}'`,
                path: 'confidence',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'insufficient-confidence',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }

      // 6. IDEMPOTENCY — the key is checked BEFORE any execution.
      const fingerprint = commandFingerprint(command);
      const lookedUp = deps.idempotencyRegistry.lookup(
        command.scope,
        command.idempotencyKey,
        fingerprint,
        context,
      );
      if (!lookedUp.ok) {
        return deny(
          proposal,
          lookedUp.error,
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'idempotency-conflict',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }
      if (lookedUp.value.status === 'replay') {
        const outcome = lookedUp.value.outcome as RecordedActionOutcome;
        if (outcome.decision === 'executed') {
          // THE duplicate acceptance: the ORIGINAL result returns, the handler
          // is not invoked, and the duplicate observation is audited.
          const appended = await audit(
            proposal,
            ACTION_DUPLICATE_OBSERVED_EVENT,
            {
              ...auditPayloadBaseOf({
                proposal,
                commandName: command.commandName,
                actionClass: descriptor.actionClass,
                decision: 'duplicate-observed',
                requiredCapabilities: descriptor.requiredCapabilities,
                policyRef: descriptor.policyRef,
                compensatingCommand: descriptor.compensatingCommand,
              }),
              replayed: true,
            },
          );
          if (!appended.ok) return appended;
          return ok({
            decision: 'executed',
            replayed: true,
            value: outcome.value,
          } satisfies ActionResult);
        }
        // A live approval routing is recorded under this key.
        if (proposal.approval === null) {
          // The re-submitted proposal does not re-enter with approval
          // evidence: the ORIGINAL pending outcome returns and the duplicate
          // routing is audited — the approval authority is NOT called again.
          const appended = await audit(
            proposal,
            ACTION_DUPLICATE_OBSERVED_EVENT,
            withApprovalOnPayload(
              {
                ...auditPayloadBaseOf({
                  proposal,
                  commandName: command.commandName,
                  actionClass: descriptor.actionClass,
                  decision: 'duplicate-observed',
                  requiredCapabilities: descriptor.requiredCapabilities,
                  policyRef: descriptor.policyRef,
                  compensatingCommand: descriptor.compensatingCommand,
                }),
                replayed: true,
              },
              outcome.approval,
              'pending',
            ),
          );
          if (!appended.ok) return appended;
          return ok({
            decision: 'routed-to-approval',
            replayed: true,
            approval: outcome.approval,
          } satisfies ActionResult);
        }
        // Re-entry WITH approval evidence: the referenced approval must be
        // the one THIS proposal's key routed to.
        if (
          proposal.approval.instanceId !== outcome.approval.instanceId ||
          proposal.approval.approvalKey !== outcome.approval.approvalKey
        ) {
          return deny(
            proposal,
            domainError(
              'forbidden',
              `the approval reference carried by the proposal does not match the approval opened for idempotency key ${command.idempotencyKey}`,
              [
                {
                  code: 'approval-reference-mismatch',
                  message: `referenced instance ${proposal.approval.instanceId} / approval '${proposal.approval.approvalKey}', routed instance ${outcome.approval.instanceId} / approval '${outcome.approval.approvalKey}'`,
                  path: 'approval',
                },
              ],
              context,
            ),
            {
              commandName: command.commandName,
              actionClass: descriptor.actionClass,
              denialCode: 'approval-reference-mismatch',
              requiredCapabilities: descriptor.requiredCapabilities,
              policyRef: descriptor.policyRef,
              compensatingCommand: descriptor.compensatingCommand,
            },
          );
        }
        // Fall through: the approval-completed upgrade path re-verifies the
        // approval through the authority before executing.
      }

      // 7. ROUTING BY CLASS.
      if (descriptor.actionClass === 'read' || descriptor.actionClass === 'reversible') {
        return execute(proposal, descriptor, null);
      }

      // approval-required: the routing contract is present by descriptor
      // validation (parseActionDescriptor's structural class rules).
      const routing = descriptor.approval;
      if (routing === null) {
        throw new TypeError(
          `descriptor invariant violated: approval-required action '${command.commandName}' carries no approval routing`,
        );
      }
      const routed = await routeForApproval(proposal, descriptor, routing);
      if (!routed.ok) return routed;
      const record = routed.value;

      if (proposal.approval === null) {
        // First entry: route + audit + record the pending outcome.
        const appended = await audit(
          proposal,
          ACTION_ROUTED_TO_APPROVAL_EVENT,
          withApprovalOnPayload(
            auditPayloadBaseOf({
              proposal,
              commandName: command.commandName,
              actionClass: descriptor.actionClass,
              decision: 'routed-to-approval',
              requiredCapabilities: descriptor.requiredCapabilities,
              policyRef: descriptor.policyRef,
              compensatingCommand: descriptor.compensatingCommand,
            }),
            record.reference,
            record.status,
          ),
        );
        if (!appended.ok) return appended;
        const recorded = deps.idempotencyRegistry.record(
          command.scope,
          command.idempotencyKey,
          fingerprint,
          { decision: 'routed-to-approval', approval: record.reference } satisfies RecordedActionOutcome,
          context,
        );
        if (!recorded.ok) return recorded;
        return ok({
          decision: 'routed-to-approval',
          replayed: false,
          approval: record.reference,
        } satisfies ActionResult);
      }

      // Re-entry with approval evidence: the referenced approval must be the
      // one the authority re-opened for THIS proposal (the re-route replays
      // the same approval instance — engine idempotency), and it must have
      // been decided 'approved'. Anything else is THE force-execute rejection.
      if (
        proposal.approval.instanceId !== record.reference.instanceId ||
        proposal.approval.approvalKey !== record.reference.approvalKey
      ) {
        return deny(
          proposal,
          domainError(
            'forbidden',
            `the approval reference carried by the proposal does not match the approval opened for idempotency key ${command.idempotencyKey}`,
            [
              {
                code: 'approval-reference-mismatch',
                message: `referenced instance ${proposal.approval.instanceId} / approval '${proposal.approval.approvalKey}', routed instance ${record.reference.instanceId} / approval '${record.reference.approvalKey}'`,
                path: 'approval',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode: 'approval-reference-mismatch',
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
          },
        );
      }
      if (record.status !== 'approved') {
        const denialCode =
          record.status === 'rejected'
            ? 'approval-rejected'
            : record.status === 'submitted'
              ? 'approval-submitted-not-decided'
              : 'approval-not-completed';
        return deny(
          proposal,
          domainError(
            'forbidden',
            `approval-required action '${command.commandName}' cannot execute: its approval (instance ${record.reference.instanceId}, '${record.reference.approvalKey}') is '${record.status}', not 'approved' — the gateway never executes an approval-required action without the completed approval`,
            [
              {
                code: denialCode,
                message: `approval status '${record.status}'`,
                path: 'approval',
              },
            ],
            context,
          ),
          {
            commandName: command.commandName,
            actionClass: descriptor.actionClass,
            denialCode,
            requiredCapabilities: descriptor.requiredCapabilities,
            policyRef: descriptor.policyRef,
            compensatingCommand: descriptor.compensatingCommand,
            approval: record.reference,
            approvalStatus: record.status,
          },
        );
      }
      // The approval completed: execute with the approval provenance carried
      // into the audit event (the only execution path for this class).
      return execute(proposal, descriptor, { record });
    },
  };
}
