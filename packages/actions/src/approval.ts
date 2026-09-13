// Office action gateway — approval routing (OFF-017).
//
// Freeze A8: high-impact financial, contractual, schedule-baseline, access,
// and destructive actions require explicit approval unless an organization
// policy grants automation. An action descriptor of class 'approval-required'
// declares WHERE the approval lives: the workflow definition key, the
// approval step key inside it, the capability an approver must hold, and the
// policy reference governing the decision.
//
// THE ApprovalAuthority port is the seam between the gateway and the
// workflow/approval engine (@office/workflows, OFF-016): opening an approval
// routes the proposal INTO the engine (a workflow instance whose approval
// step awaits decision); the gateway NEVER executes an approval-required
// action directly. The port is idempotent by construction: routing the same
// action (same scope + same idempotency-derived routing key) re-opens the
// SAME approval — the engine's own idempotency registry guarantees no
// duplicate approval instances, and this package's implementations key the
// same way (approvalRoutingKeyOf).
//
// Two implementations ship:
// - createInMemoryApprovalAuthority — the deterministic stub for tests;
// - createWorkflowApprovalAuthority — the @office/workflows-backed adapter
//   that starts instances from a PINNED PUBLISHED definition resolved by key
//   and reports the approval's CURRENT state (see workflow-approval.ts).
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, DomainErrorContext, Result } from '@office/domain-kernel';
import { parseEntityId, parseFail, parseOk, formatEntityId } from '@office/contracts';
import type {
  CommandEnvelope,
  EntityId,
  EntityRef,
  IdempotencyKey,
  ParseResult,
  Timestamp,
} from '@office/contracts';
import {
  describeValue,
  isPlainObject,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import type { Capability } from '@office/authz';
import { capability } from '@office/authz';

// ----- the routing contract (descriptor side) --------------------------------------------

/** Grammar description used in parse failures. */
export const KEBAB_RULE: StringRule = {
  min: 1,
  max: 64,
  pattern: /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/,
  description: 'lowercase kebab-case key (no leading/trailing/double dashes)',
};

const POLICY_REF_RULE: StringRule = {
  min: 1,
  max: 200,
  description: 'policy reference',
};

/**
 * The approval routing contract of an 'approval-required' action descriptor:
 * which workflow definition key holds the approval step, the step's key
 * inside it, the capability an approver must hold to decide it, and the
 * policy reference governing the decision (freeze A8).
 */
export interface ApprovalRouting {
  /** Workflow definition key resolving to a PUBLISHED definition (OFF-016). */
  readonly definitionKey: string;
  /** The approval step key inside that definition. */
  readonly approvalKey: string;
  /** THE capability an approver must hold (the decision gate, no bypass). */
  readonly requiredCapability: Capability;
  /** Policy reference governing the approval decision. */
  readonly policyRef: string;
}

const APPROVAL_ROUTING_KEYS = [
  'definitionKey',
  'approvalKey',
  'requiredCapability',
  'policyRef',
] as const;
const APPROVAL_ROUTING_GRAMMAR =
  'ApprovalRouting: { definitionKey: kebab (1..64), approvalKey: kebab (1..64), requiredCapability: declared capability, policyRef: string (1..200) }';

/** Parse an untrusted value as an ApprovalRouting (total, fail-closed, strict keys). */
export function parseApprovalRouting(raw: unknown): ParseResult<ApprovalRouting> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPROVAL_ROUTING_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    APPROVAL_ROUTING_KEYS,
    '',
    APPROVAL_ROUTING_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const definitionKey = requireString(raw, 'definitionKey', '', KEBAB_RULE);
  if (!definitionKey.ok) return definitionKey;
  const approvalKey = requireString(raw, 'approvalKey', '', KEBAB_RULE);
  if (!approvalKey.ok) return approvalKey;
  const requiredCapabilityRaw = raw['requiredCapability'];
  if (requiredCapabilityRaw === undefined) {
    return parseFail(
      'missing-field',
      'requiredCapability',
      'declared capability (the approval decision gate)',
      'undefined',
    );
  }
  if (typeof requiredCapabilityRaw !== 'string') {
    return parseFail(
      'invalid-type',
      'requiredCapability',
      'declared capability (the approval decision gate)',
      describeValue(requiredCapabilityRaw),
    );
  }
  let requiredCapability: Capability;
  try {
    requiredCapability = capability(requiredCapabilityRaw);
  } catch {
    return parseFail(
      'invalid-value',
      'requiredCapability',
      'declared capability (the approval decision gate)',
      describeValue(requiredCapabilityRaw),
    );
  }
  const policyRef = requireString(raw, 'policyRef', '', POLICY_REF_RULE);
  if (!policyRef.ok) return policyRef;
  return parseOk(
    {
      definitionKey: definitionKey.value,
      approvalKey: approvalKey.value,
      requiredCapability,
      policyRef: policyRef.value,
    } satisfies ApprovalRouting,
  );
}

// ----- the approval reference (proposal side) --------------------------------------------

/**
 * A reference to one opened approval: the workflow instance carrying the
 * approval step, plus the step's key. Proposals re-entering the gateway after
 * routing carry this reference; the gateway verifies it is the approval THIS
 * proposal opened and that it has been decided 'approved' before executing.
 */
export interface ApprovalReference {
  /** The workflow instance carrying the approval step. */
  readonly instanceId: EntityId;
  /** The approval step key inside that instance. */
  readonly approvalKey: string;
}

const APPROVAL_REFERENCE_KEYS = ['instanceId', 'approvalKey'] as const;
const APPROVAL_REFERENCE_GRAMMAR =
  'ApprovalReference: { instanceId: EntityId, approvalKey: kebab (1..64) }';

/** Parse an untrusted value as an ApprovalReference (total, fail-closed, strict keys). */
export function parseApprovalReference(raw: unknown): ParseResult<ApprovalReference> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', APPROVAL_REFERENCE_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(
    raw,
    APPROVAL_REFERENCE_KEYS,
    '',
    APPROVAL_REFERENCE_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const instanceId = raw['instanceId'];
  if (instanceId === undefined) {
    return parseFail('missing-field', 'instanceId', 'canonical EntityId', 'undefined');
  }
  const parsedId = parseEntityId(instanceId);
  if (!parsedId.ok) {
    return parseFail('invalid-value', 'instanceId', 'canonical EntityId', describeValue(instanceId));
  }
  const approvalKey = requireString(raw, 'approvalKey', '', KEBAB_RULE);
  if (!approvalKey.ok) return approvalKey;
  return parseOk(
    { instanceId: parsedId.value, approvalKey: approvalKey.value } satisfies ApprovalReference,
  );
}

// ----- the approval record (authority response) ------------------------------------------

/** Lifecycle status of an approval step (mirrors the workflow engine's vocabulary). */
export type ApprovalStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

/** Every approval status, in canonical lifecycle order. */
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'submitted',
  'approved',
  'rejected',
] as const;

/**
 * The current state of one opened approval, as reported by the authority: the
 * reference, the lifecycle status, the decision gate (capability + policy
 * reference) the routed step enforces, the decider when decided, and whether
 * THIS open call replayed a prior routing (no new effects).
 */
export interface ApprovalRecord {
  readonly reference: ApprovalReference;
  readonly status: ApprovalStatus;
  readonly requiredCapability: Capability;
  readonly policyRef: string;
  readonly decidedBy: EntityId | null;
  readonly decidedAt: Timestamp | null;
  /** True when a prior routing of the same action was replayed (no new approval). */
  readonly replayed: boolean;
}

/** One request to route an action proposal into the approval engine. */
export interface ApprovalRoutingRequest {
  /** The action's own command envelope (actor, scope, key, causality from it). */
  readonly command: CommandEnvelope;
  /** The workflow subject of the approval (the entity the action is about). */
  readonly subject: EntityRef;
  /** The descriptor's routing contract. */
  readonly routing: ApprovalRouting;
}

/**
 * THE approval authority port: route an approval-required action into the
 * workflow/approval engine and report the approval's CURRENT state. Opening
 * is idempotent per (scope, action idempotency key): the same action re-opens
 * the SAME approval with no duplicate effects.
 */
export interface ApprovalAuthority {
  openApproval(request: ApprovalRoutingRequest): Promise<Result<ApprovalRecord, DomainError>>;
}

/** The typed routing-mismatch failure (the engine disagrees with the descriptor). */
export const approvalRoutingMismatch = (
  parts: { readonly definitionKey: string; readonly approvalKey: string },
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `the published workflow definition '${parts.definitionKey}' does not declare approval '${parts.approvalKey}' with the descriptor's decision gate`,
    [
      {
        code: 'approval-routing-mismatch',
        message: `definition '${parts.definitionKey}', approval '${parts.approvalKey}'`,
        path: 'approval',
      },
    ],
    context,
  );

/** The typed failure of deciding an already-terminal approval (stub). */
export const approvalAlreadyDecided = (
  reference: ApprovalReference,
  context?: DomainErrorContext,
): DomainError =>
  domainError(
    'invariant-violation',
    `approval '${reference.approvalKey}' on workflow instance ${reference.instanceId} is already decided`,
    [
      {
        code: 'approval-already-decided',
        message: `instance ${reference.instanceId}, approval '${reference.approvalKey}'`,
        path: null,
      },
    ],
    context,
  );

// ----- the deterministic routing key ------------------------------------------------------

const ROUTING_KEY_PREFIX = 'apv-';
const MAX_ROUTING_KEY_LENGTH = 128;

/**
 * The deterministic routing key derived from an action's idempotency key
 * ('apv-' + the key, truncated to the 128-character envelope grammar): the
 * engine-side idempotency key of the approval routing, so re-routing the same
 * action re-opens the SAME approval (no duplicate approval instances) while
 * never colliding with the action's own registry entry. Pure string
 * arithmetic — no clock, no randomness.
 */
export function approvalRoutingKeyOf(actionKey: IdempotencyKey): IdempotencyKey {
  const derived = `${ROUTING_KEY_PREFIX}${actionKey}`.slice(0, MAX_ROUTING_KEY_LENGTH);
  return derived as IdempotencyKey;
}

// ----- the in-memory approval authority (deterministic stub) ------------------------------

/** Mutable test-facing surface of the in-memory approval authority. */
export interface InMemoryApprovalAuthority extends ApprovalAuthority {
  /** How many openApproval calls reached this authority (test introspection). */
  readonly opened: number;
  /** Decide an opened approval (test driver; typed not-found when unknown). */
  decide(
    reference: ApprovalReference,
    decision: 'approved' | 'rejected',
    decidedBy: EntityId,
    decidedAt?: Timestamp,
  ): Result<true, DomainError>;
}

interface StubEntry {
  readonly routing: ApprovalRouting;
  readonly reference: ApprovalReference;
  status: ApprovalStatus;
  decidedBy: EntityId | null;
  decidedAt: Timestamp | null;
}

const scopeKeyOf = (scope: ApprovalRoutingRequest['command']['scope']): string =>
  JSON.stringify({
    kind: scope.kind,
    tenantId: scope.tenantId,
    ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
  });

/**
 * Create the deterministic in-memory approval authority (tests, pure in-memory
 * composition). Records approvals keyed by (scope, routing key): the same
 * action re-opens the same approval; a different scope (e.g. another tenant
 * re-using a leaked reference) opens a DISTINCT approval, so the gateway's
 * reference check rejects the mismatch without an existence oracle.
 * `newInstanceId` mints instance ids — a sequential deterministic supplier by
 * default; inject a fixed one for byte-identical determinism proofs.
 */
export function createInMemoryApprovalAuthority(
  options: { readonly newInstanceId?: () => EntityId } = {},
): InMemoryApprovalAuthority {
  let issued = 0;
  const newInstanceId =
    options.newInstanceId ??
    (() => {
      issued += 1;
      return formatEntityId({ version: 'v1', opaque: String(issued).padStart(16, '0') });
    });
  const entries = new Map<string, StubEntry>();
  const byReference = new Map<string, StubEntry>();
  const referenceKey = (reference: ApprovalReference): string =>
    `${reference.instanceId}\u0000${reference.approvalKey}`;
  const opened = { count: 0 };

  const authority: InMemoryApprovalAuthority = {
    get opened(): number {
      return opened.count;
    },
    openApproval: async (request) => {
      opened.count += 1;
      const context: DomainErrorContext = {
        scope: request.command.scope,
        correlationId: request.command.causality.correlationId,
      };
      const routingKey = approvalRoutingKeyOf(request.command.idempotencyKey);
      const composite = `${scopeKeyOf(request.command.scope)}\u0000${routingKey}`;
      const existing = entries.get(composite);
      if (existing !== undefined) {
        // Idempotent re-open of the same action: same approval, current state.
        if (
          existing.routing.definitionKey !== request.routing.definitionKey ||
          existing.routing.approvalKey !== request.routing.approvalKey ||
          existing.routing.requiredCapability !== request.routing.requiredCapability ||
          existing.routing.policyRef !== request.routing.policyRef
        ) {
          return fail(approvalRoutingMismatch(
            {
              definitionKey: request.routing.definitionKey,
              approvalKey: request.routing.approvalKey,
            },
            context,
          ));
        }
        return ok({
          reference: existing.reference,
          status: existing.status,
          requiredCapability: existing.routing.requiredCapability,
          policyRef: existing.routing.policyRef,
          decidedBy: existing.decidedBy,
          decidedAt: existing.decidedAt,
          replayed: true,
        } satisfies ApprovalRecord);
      }
      const reference: ApprovalReference = {
        instanceId: newInstanceId(),
        approvalKey: request.routing.approvalKey,
      };
      const entry: StubEntry = {
        routing: request.routing,
        reference,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
      };
      entries.set(composite, entry);
      byReference.set(referenceKey(reference), entry);
      return ok({
        reference,
        status: entry.status,
        requiredCapability: entry.routing.requiredCapability,
        policyRef: entry.routing.policyRef,
        decidedBy: null,
        decidedAt: null,
        replayed: false,
      } satisfies ApprovalRecord);
    },
    decide: (reference, decision, decidedBy, decidedAt) => {
      const entry = byReference.get(referenceKey(reference));
      if (entry === undefined) {
        return fail(
          domainError(
            'not-found',
            `approval '${reference.approvalKey}' on workflow instance ${reference.instanceId} not found`,
            [
              {
                code: 'approval-not-found',
                message: `instance ${reference.instanceId}, approval '${reference.approvalKey}'`,
                path: null,
              },
            ],
          ),
        );
      }
      if (entry.status === 'approved' || entry.status === 'rejected') {
        return fail(approvalAlreadyDecided(reference));
      }
      entry.status = decision;
      entry.decidedBy = decidedBy;
      entry.decidedAt = decidedAt ?? null;
      return ok(true);
    },
  };
  return authority;
}
