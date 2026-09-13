// Office action gateway — the workflow-engine-backed approval authority (OFF-017).
//
// The production seam between the gateway and the approval engine
// (@office/workflows, OFF-016): routing an approval-required action starts a
// workflow INSTANCE from a PINNED PUBLISHED definition resolved by the
// descriptor's routing key, and reporting the approval's state reads the
// CURRENT instance through the engine's scoped store (A12 visibility rules:
// foreign tenant → typed not-found, no existence oracle; wrong project →
// typed unauthorized).
//
// The routing is idempotent by construction: the engine-side start command
// carries the deterministic routing key derived from the action's idempotency
// key (approvalRoutingKeyOf), so re-routing the same action replays the SAME
// instance (the engine's own idempotency registry — no duplicate instances,
// no duplicate events) while the actor, scope, and causation of the start
// command are the PROPOSAL's (provenance: the approval instance is caused by
// the action command — causationId = the action's idempotency key).
//
// The adapter NEVER decides approvals: deciding (submit/approve/reject) is
// the engine's capability-gated command surface, driven by human approvers
// through the workflow commands — the gateway only routes and observes. The
// definition itself is NEVER created here: publishing the approval workflow
// definition is a workflow-operator concern (capability-gated in the engine);
// the adapter fails closed with a typed not-found until one is published.
import { domainError } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext } from '@office/domain-kernel';
import { parseCommandEnvelope } from '@office/contracts';
import {
  START_INSTANCE_COMMAND,
  type WorkflowCommandAuthorization,
  type WorkflowCommands,
  type WorkflowStore,
} from '@office/workflows';
import { approvalRoutingKeyOf, approvalRoutingMismatch } from './approval';
import type {
  ApprovalAuthority,
  ApprovalRecord,
  ApprovalRouting,
  ApprovalRoutingRequest,
} from './approval';

/** Wiring dependencies of the workflow-engine-backed approval authority. */
export interface WorkflowApprovalAuthorityDeps {
  /** The workflow engine's command surface (instances are started through it). */
  readonly commands: WorkflowCommands;
  /** The workflow engine's scoped store (current-state reads, A12 visibility). */
  readonly store: WorkflowStore;
  /**
   * The authorization the ADAPTER acts with at the engine (the platform's
   * engine-operation grant, e.g. workflows.write + an allow rule): starting
   * the approval instance is gateway machinery, not a policy decision on the
   * approval itself — the DECISION stays capability-gated inside the engine.
   */
  readonly authorization: WorkflowCommandAuthorization;
}

/**
 * The typed failure when no PUBLISHED definition of the routing key exists in
 * the target scope: the adapter never creates definitions (that is a
 * capability-gated workflow-operator concern) — publish one first.
 */
const definitionNotPublished = (
  parts: { readonly definitionKey: string; readonly routing: ApprovalRouting },
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `no published workflow definition '${parts.definitionKey}' is registered in the target scope; the approval routing for '${parts.routing.approvalKey}' requires one (publish the action-approval definition first — the gateway never creates workflow definitions)`,
    [
      {
        code: 'approval-definition-not-published',
        message: `definition key '${parts.definitionKey}'`,
        path: 'approval.definitionKey',
      },
    ],
    context,
  );

/** The typed failure when the instance carries no approval of the routing key. */
const approvalMissingOnInstance = (
  parts: { readonly instanceId: string; readonly approvalKey: string },
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'not-found',
    `workflow instance ${parts.instanceId} carries no approval '${parts.approvalKey}'`,
    [
      {
        code: 'approval-not-found',
        message: `instance ${parts.instanceId}, approval '${parts.approvalKey}'`,
        path: null,
      },
    ],
    context,
  );

/**
 * Create the @office/workflows-backed approval authority. `openApproval`
 * resolves the latest PUBLISHED definition of the routing key in the action's
 * scope, verifies it declares the descriptor's approval step with the
 * descriptor's decision gate, starts (or idempotently re-opens) the instance
 * through the engine's own command surface, and reports the approval's
 * CURRENT state read through the scoped store.
 */
export function createWorkflowApprovalAuthority(
  deps: WorkflowApprovalAuthorityDeps,
): ApprovalAuthority {
  const contextOf = (request: ApprovalRoutingRequest): DomainErrorContext => ({
    scope: request.command.scope,
    correlationId: request.command.causality.correlationId,
  });

  return {
    openApproval: async (request) => {
      const context = contextOf(request);
      const routing = request.routing;

      // 1. Resolve the latest PUBLISHED definition of the routing key in the
      //    action's scope (A12 visibility inside the store's finders).
      const definitions = deps.store.findDefinitionsByKey(
        request.command.scope,
        routing.definitionKey,
        context,
      );
      if (!definitions.ok) return definitions;
      const published = definitions.value.filter(
        (definition) => definition.status === 'published',
      );
      const pinned = published[published.length - 1];
      if (pinned === undefined) {
        return {
          ok: false,
          error: definitionNotPublished(
            { definitionKey: routing.definitionKey, routing },
            context,
          ),
        };
      }

      // 2. Verify the pinned definition declares the descriptor's approval
      //    step WITH the descriptor's decision gate (fail-closed wiring check).
      const declared = pinned.model.approvals.find(
        (approval) => approval.key === routing.approvalKey,
      );
      if (
        declared === undefined ||
        declared.requiredCapability !== routing.requiredCapability ||
        declared.policyRef !== routing.policyRef
      ) {
        return {
          ok: false,
          error: approvalRoutingMismatch(
            { definitionKey: routing.definitionKey, approvalKey: routing.approvalKey },
            context,
          ),
        };
      }

      // 3. Start (or idempotently re-open) the approval instance through the
      //    engine's own command surface — actor, scope, and causation are the
      //    PROPOSAL's; the engine-side idempotency key is the deterministic
      //    routing key derived from the action's key. The envelope is built
      //    from already-validated parts and re-validated fail-closed: a
      //    malformed derivation is a loud programming error, never a silent
      //    mis-routed approval.
      const routingKey = approvalRoutingKeyOf(request.command.idempotencyKey);
      const startEnvelope = parseCommandEnvelope({
        kind: 'command',
        commandName: START_INSTANCE_COMMAND,
        scope: request.command.scope,
        actor: request.command.actor,
        idempotencyKey: routingKey,
        causality: {
          correlationId: request.command.causality.correlationId,
          causationId: request.command.idempotencyKey,
        },
        issuedAt: request.command.issuedAt,
        schemaVersion: request.command.schemaVersion,
        payload: { definitionId: pinned.entityId, subject: request.subject },
      });
      if (!startEnvelope.ok) {
        throw new TypeError(
          `approval routing envelope failed its own contract: ${JSON.stringify(startEnvelope.error)}`,
        );
      }
      const started = await deps.commands.instances.startInstance(
        startEnvelope.value,
        deps.authorization,
      );
      if (!started.ok) return started;
      const opened = started.value;

      // 4. Read the approval's CURRENT state through the scoped store (the
      //    started/replayed instance state may predate a decision; the store
      //    always holds the current one).
      const loaded = deps.store.findInstance(
        request.command.scope,
        opened.state.entityId,
        context,
      );
      if (!loaded.ok) return loaded;
      const approval = loaded.value.approvals.find(
        (step) => step.key === routing.approvalKey,
      );
      if (approval === undefined) {
        return {
          ok: false,
          error: approvalMissingOnInstance(
            { instanceId: loaded.value.entityId, approvalKey: routing.approvalKey },
            context,
          ),
        };
      }

      const record: ApprovalRecord = {
        reference: {
          instanceId: loaded.value.entityId,
          approvalKey: approval.key,
        },
        status: approval.status,
        requiredCapability: approval.requiredCapability,
        policyRef: approval.policyRef,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt,
        replayed: opened.replayed,
      };
      return { ok: true, value: record };
    },
  };
}
