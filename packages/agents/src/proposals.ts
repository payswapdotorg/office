// Office agent runtime — the ProposedAction model (OFF-018).
//
// THE typed action proposal of the agent runtime (freeze A8, canonical
// 'agent action' flow): the command envelope the run proposes, the A4
// evidence references it grounds on (the same { slot, ref } shape the action
// gateway enforces), the proposal's confidence, the rationale (the A4
// reasoning summary — the one field the gateway's own proposal shape does not
// carry), the target resource's owning scope, and — on re-entry after a
// routed approval — the approval reference.
//
// A ProposedAction is DATA. It never executes anything: the runtime hands it
// to the OFF-017 gateway's executeAction() as an ActionProposal (via
// toGatewayProposal below) and records the gateway's decision verbatim.
// Consequential proposals (reversible / approval-required class) MUST carry
// evidence backed by the run's qualified EvidenceSet — the runtime rejects
// them typed BEFORE the gateway call (run.ts, the named acceptance).
import {
  parseCommandEnvelope,
  parseEntityRef,
  parseFail,
  parseOk,
  parseScope,
} from '@office/contracts';
import type { CommandEnvelope, EntityRef, ParseResult, Scope } from '@office/contracts';
import {
  actionProposal,
  parseApprovalReference,
  parseConfidenceLevel,
  parseEvidenceReferences,
} from '@office/actions';
import type { ActionProposal, ApprovalReference, ConfidenceLevel, EvidenceReference } from '@office/actions';
import {
  describeValue,
  isPlainObject,
  optionalNullableFieldWith,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
} from './parse';
import { RATIONALE_RULE } from './vocabulary';

/**
 * One typed action proposal of an agent run: the command envelope plus its A4
 * provenance (evidence references + confidence), the rationale, the target
 * resource's owning scope, and the approval reference on re-entry.
 */
export interface ProposedAction {
  /** The typed command being proposed (actor, scope, idempotency key, causality). */
  readonly command: CommandEnvelope;
  /** The entity the action is about, or null (the workflow subject when routed). */
  readonly subject: EntityRef | null;
  /** The A4 evidence references carried by the proposal. */
  readonly evidence: readonly EvidenceReference[];
  /** The proposal's A4 confidence level. */
  readonly confidence: ConfidenceLevel;
  /** The proposal's reasoning summary (1..2000 characters). */
  readonly rationale: string;
  /** The target resource's owning scope when known, or null. */
  readonly resourceScope: Scope | null;
  /** The approval reference when re-entering after a routed approval, or null. */
  readonly approval: ApprovalReference | null;
}

const PROPOSED_ACTION_KEYS = [
  'command',
  'subject',
  'evidence',
  'confidence',
  'rationale',
  'resourceScope',
  'approval',
] as const;

const PROPOSED_ACTION_GRAMMAR =
  'ProposedAction: { command: CommandEnvelope, subject?: EntityRef | null, evidence: EvidenceReference[], confidence: ConfidenceLevel, rationale: string (1..2000), resourceScope?: Scope | null, approval?: ApprovalReference | null }';

/** Parse an untrusted value as a ProposedAction (total, fail-closed, strict keys). */
export function parseProposedAction(raw: unknown): ParseResult<ProposedAction> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PROPOSED_ACTION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PROPOSED_ACTION_KEYS, '', PROPOSED_ACTION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const command = requireFieldWith(raw, 'command', '', parseCommandEnvelope);
  if (!command.ok) return command;
  const subject = optionalNullableFieldWith(raw, 'subject', '', parseEntityRef);
  if (!subject.ok) return subject;
  const evidence = requireFieldWith(raw, 'evidence', '', (value) =>
    parseEvidenceReferences(value, ''),
  );
  if (!evidence.ok) return evidence;
  const confidence = requireFieldWith(raw, 'confidence', '', parseConfidenceLevel);
  if (!confidence.ok) return confidence;
  const rationale = requireString(raw, 'rationale', '', RATIONALE_RULE);
  if (!rationale.ok) return rationale;
  const resourceScope = optionalNullableFieldWith(raw, 'resourceScope', '', parseScope);
  if (!resourceScope.ok) return resourceScope;
  const approval = optionalNullableFieldWith(raw, 'approval', '', parseApprovalReference);
  if (!approval.ok) return approval;
  return parseOk(
    {
      command: command.value,
      subject: subject.value,
      evidence: evidence.value,
      confidence: confidence.value,
      rationale: rationale.value,
      resourceScope: resourceScope.value,
      approval: approval.value,
    } satisfies ProposedAction,
  );
}

/** Type guard for structurally valid ProposedAction values. */
export function isProposedAction(raw: unknown): raw is ProposedAction {
  return parseProposedAction(raw).ok;
}

/**
 * Compose a validated ProposedAction (trusted path): validates the input with
 * the same fail-closed checks as parseProposedAction and throws a loud
 * TypeError instead of returning the failure. Accepts plain parts — the
 * command may be an already-validated envelope.
 */
export function proposedAction(parts: {
  readonly command: CommandEnvelope;
  readonly subject?: EntityRef | null;
  readonly evidence?: readonly { slot: string; ref: string }[];
  readonly confidence: string;
  readonly rationale: string;
  readonly resourceScope?: Scope | null;
  readonly approval?: { instanceId: string; approvalKey: string } | null;
}): ProposedAction {
  const result = parseProposedAction({
    command: parts.command,
    subject: parts.subject ?? null,
    evidence: parts.evidence ?? [],
    confidence: parts.confidence,
    rationale: parts.rationale,
    resourceScope: parts.resourceScope ?? null,
    approval: parts.approval ?? null,
  });
  if (!result.ok) {
    throw new TypeError(
      `invalid proposed action: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

/**
 * Convert a ProposedAction into the gateway's ActionProposal (the exact shape
 * executeAction() takes): the command, subject, evidence references,
 * confidence, resource scope, and approval reference flow through unchanged —
 * the rationale stays in the agent's own records and audit trail.
 */
export const toGatewayProposal = (action: ProposedAction): ActionProposal =>
  actionProposal({
    command: action.command,
    subject: action.subject,
    evidence: action.evidence.map((reference) => ({
      slot: reference.slot,
      ref: reference.ref,
    })),
    confidence: action.confidence,
    resourceScope: action.resourceScope,
    approval:
      action.approval === null
        ? null
        : { instanceId: action.approval.instanceId, approvalKey: action.approval.approvalKey },
  });
