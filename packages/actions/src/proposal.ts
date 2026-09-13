// Office action gateway — the action proposal (OFF-017).
//
// A proposal is everything the gateway needs to decide one action (freeze A8,
// canonical 'agent action' flow): the typed CommandEnvelope (the command
// itself — actor, scope, idempotency key, causality, payload), the A4
// provenance a consequential proposal must carry (evidence references filling
// the descriptor's declared slots + the proposal's confidence level), the
// target subject (the entity the action is about — the workflow subject when
// approval routing is needed), the resource's owning scope when the calling
// surface knows it (the A12 structural check needs it; derived server-side
// from the addressed entity, never from client claims), and — on re-entry
// after an approval — the approval reference to verify.
//
// The authorization inputs travel WITH the call (never inside the envelope):
// the caller-supplied deny-by-default policy and the capabilities granted to
// the command's actor FOR THIS REQUEST (the same shape the workflow engine's
// command surface takes).
import { parseCommandEnvelope, parseEntityRef, parseFail, parseOk, parseScope } from '@office/contracts';
import type { CommandEnvelope, EntityRef, ParseResult, Scope } from '@office/contracts';
import type { Policy } from '@office/authz';
import {
  describeValue,
  isPlainObject,
  optionalNullableFieldWith,
  requireFieldWith,
  unknownKeyFailure,
} from './parse';
import { parseConfidenceLevel, parseEvidenceReferences } from './evidence';
import type { ConfidenceLevel, EvidenceReference } from './evidence';
import { parseApprovalReference } from './approval';
import type { ApprovalReference } from './approval';

/**
 * One action proposal through the gateway: the typed command envelope plus
 * its A4 provenance (evidence references + confidence), the target subject,
 * the resource's owning scope when known, and the approval reference on
 * re-entry after a routed approval.
 */
export interface ActionProposal {
  /** The typed command being proposed (actor, scope, idempotency key, causality). */
  readonly command: CommandEnvelope;
  /** The entity the action is about, or null (the workflow subject when routed). */
  readonly subject: EntityRef | null;
  /** The A4 evidence references carried by the proposal. */
  readonly evidence: readonly EvidenceReference[];
  /** The proposal's A4 confidence level. */
  readonly confidence: ConfidenceLevel;
  /** The target resource's owning scope when the surface knows it, or null. */
  readonly resourceScope: Scope | null;
  /** The approval reference when re-entering after a routed approval, or null. */
  readonly approval: ApprovalReference | null;
}

const PROPOSAL_KEYS = [
  'command',
  'subject',
  'evidence',
  'confidence',
  'resourceScope',
  'approval',
] as const;

const PROPOSAL_GRAMMAR =
  'ActionProposal: { command: CommandEnvelope, subject?: EntityRef | null, evidence: EvidenceReference[], confidence: ConfidenceLevel, resourceScope?: Scope | null, approval?: ApprovalReference | null }';

/** Parse an untrusted value as an ActionProposal (total, fail-closed, strict keys). */
export function parseActionProposal(raw: unknown): ParseResult<ActionProposal> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', PROPOSAL_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, PROPOSAL_KEYS, '', PROPOSAL_GRAMMAR);
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
      resourceScope: resourceScope.value,
      approval: approval.value,
    } satisfies ActionProposal,
  );
}

/** Type guard for structurally valid ActionProposal values. */
export function isActionProposal(raw: unknown): raw is ActionProposal {
  return parseActionProposal(raw).ok;
}

/**
 * Compose a validated ActionProposal (trusted path): validates the input with
 * the same fail-closed checks as parseActionProposal and throws a loud
 * TypeError instead of returning the failure. Accepts plain parts — the
 * command may be an already-validated envelope.
 */
export function actionProposal(parts: {
  readonly command: CommandEnvelope;
  readonly subject?: EntityRef | null;
  readonly evidence?: readonly { slot: string; ref: string }[];
  readonly confidence: string;
  readonly resourceScope?: Scope | null;
  readonly approval?: { instanceId: string; approvalKey: string } | null;
}): ActionProposal {
  const result = parseActionProposal({
    command: parts.command,
    subject: parts.subject ?? null,
    evidence: parts.evidence ?? [],
    confidence: parts.confidence,
    resourceScope: parts.resourceScope ?? null,
    approval: parts.approval ?? null,
  });
  if (!result.ok) {
    throw new TypeError(
      `invalid action proposal: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}

/**
 * Caller-supplied authorization inputs for one action execution (the same
 * shape the workflow engine takes): the deny-by-default policy and the
 * capabilities granted to the command's actor for THIS request.
 */
export interface ActionAuthorization {
  /** The static, data-driven, deny-by-default policy. */
  readonly policy: Policy;
  /** Capabilities granted to the actor for this request (declared names). */
  readonly capabilities: readonly string[];
}
