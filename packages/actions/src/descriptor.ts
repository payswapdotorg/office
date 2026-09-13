// Office action gateway — the ActionDescriptor model (OFF-017).
//
// The registry of KNOWN actions (freeze A8): for each typed command name, the
// gateway knows
// - the action CLASS — 'read' | 'reversible' | 'approval-required' |
//   'prohibited' (classification.ts owns the vocabulary; the descriptor
//   declares which one the action is);
// - the actor-kind requirements — which actor kinds may perform it at all;
// - the required capabilities — what the proposing actor must hold;
// - the policy reference — which organization policy governs it;
// - the A4 evidence requirements — which named evidence slots a proposal must
//   fill (evidence.ts);
// - the minimum confidence — which proposal confidence is accepted (A4);
// - the reversibility contract — the compensating action reference, if any;
// - the approval routing — for 'approval-required' actions, where the
//   approval lives in the workflow engine (approval.ts).
//
// Parsing is total and fail-closed with STRUCTURAL CLASS RULES: the class
// dictates what the rest of the descriptor may declare (a read action may not
// declare a compensating write; an approval-required action MUST declare its
// approval routing; no other class may). An invalid descriptor never enters a
// registry — unknown actions are prohibited by default (classification.ts).
import { parseCommandName, parseEntityKind, parseFail, parseOk } from '@office/contracts';
import type { ActorKind, CommandName, EntityKind, ParseResult } from '@office/contracts';
import { parseCapability } from '@office/authz';
import type { Capability } from '@office/authz';
import {
  parseConfidenceLevel,
  parseEvidenceRequirements,
  type ConfidenceLevel,
  type EvidenceRequirement,
} from './evidence';
import { parseApprovalRouting } from './approval';
import type { ApprovalRouting } from './approval';
import {
  describeValue,
  isPlainObject,
  optionalNullableFieldWith,
  optionalFieldWith,
  parseValueArrayWith,
  requireFieldWith,
  requireString,
  unknownKeyFailure,
  type StringRule,
} from './parse';
import { parseLiteralOf } from './parse';

// ----- the action classes ------------------------------------------------------------------

/** The four action classes of the AI execution boundary (freeze A8). */
export type ActionClass = 'read' | 'reversible' | 'approval-required' | 'prohibited';

/** Every action class, in vocabulary order. */
export const ACTION_CLASSES: readonly ActionClass[] = [
  'read',
  'reversible',
  'approval-required',
  'prohibited',
] as const;

const parseActionClassLiteral = parseLiteralOf(
  ACTION_CLASSES,
  "the four action classes of freeze A8: 'read' | 'reversible' | 'approval-required' | 'prohibited'",
);

/** Grammar description used in parse failures. */
export const ACTION_CLASS_GRAMMAR =
  "action class 'read' | 'reversible' | 'approval-required' | 'prohibited' (freeze A8)";

/** Parse an untrusted value as an ActionClass (total, fail-closed). */
export function parseActionClass(raw: unknown): ParseResult<ActionClass> {
  return parseActionClassLiteral(raw);
}

/** Type guard for declared ActionClass values. */
export function isActionClass(raw: unknown): raw is ActionClass {
  return parseActionClass(raw).ok;
}

// ----- the descriptor ----------------------------------------------------------------------

const ACTOR_KINDS: readonly string[] = ['user', 'agent', 'app', 'adapter', 'system'];

const TITLE_RULE: StringRule = { min: 1, max: 200, description: 'title' };
const DESCRIPTION_RULE: StringRule = { min: 1, max: 2000, description: 'description' };
const POLICY_REF_RULE: StringRule = { min: 1, max: 200, description: 'policy reference' };

/**
 * One known action of the registry: everything the gateway needs to classify,
 * authorize, and route a proposal of the typed command. See the module header
 * for the field-by-field contract.
 */
export interface ActionDescriptor {
  /** The typed command name this action executes. */
  readonly commandName: CommandName;
  /** Human-readable title (1..200 characters). */
  readonly title: string;
  /** Human-readable description, or null. */
  readonly description: string | null;
  /** The action class (freeze A8 four-class vocabulary). */
  readonly actionClass: ActionClass;
  /** The actor kinds that may perform this action (empty only when prohibited). */
  readonly actorKinds: readonly ActorKind[];
  /** The capabilities the proposing actor must hold (empty only when prohibited). */
  readonly requiredCapabilities: readonly Capability[];
  /** The policy reference governing this action. */
  readonly policyRef: string;
  /** The A4 evidence slots a proposal must fill. */
  readonly evidenceRequirements: readonly EvidenceRequirement[];
  /** The minimum proposal confidence accepted (A4). */
  readonly requiredConfidence: ConfidenceLevel;
  /** The canonical kind of the resource this action targets. */
  readonly resourceKind: EntityKind;
  /**
   * The reversibility contract: the compensating action's command name, or
   * null when the action declares no compensating action (reads and
   * prohibited actions never declare one).
   */
  readonly compensatingCommand: CommandName | null;
  /** The approval routing (required for 'approval-required', forbidden otherwise). */
  readonly approval: ApprovalRouting | null;
}

const DESCRIPTOR_KEYS = [
  'commandName',
  'title',
  'description',
  'actionClass',
  'actorKinds',
  'requiredCapabilities',
  'policyRef',
  'evidenceRequirements',
  'requiredConfidence',
  'resourceKind',
  'compensatingCommand',
  'approval',
] as const;

const DESCRIPTOR_GRAMMAR =
  "ActionDescriptor: { commandName, title, description?, actionClass, actorKinds, requiredCapabilities, policyRef, evidenceRequirements, requiredConfidence, resourceKind, compensatingCommand?, approval? } — approval is required for 'approval-required' and forbidden otherwise; compensatingCommand is required for 'reversible' and forbidden for 'read'/'prohibited'";

const parseActorKindList = (raw: unknown, field: string): ParseResult<readonly ActorKind[]> => {
  const parsed = parseValueArrayWith(
    raw,
    field,
    (value) => {
      if (typeof value !== 'string') {
        return parseFail(
          'invalid-type',
          '',
          "actor kind ('user' | 'agent' | 'app' | 'adapter' | 'system')",
          describeValue(value),
        );
      }
      if (!ACTOR_KINDS.includes(value)) {
        return parseFail(
          'invalid-value',
          '',
          "actor kind ('user' | 'agent' | 'app' | 'adapter' | 'system')",
          describeValue(value),
        );
      }
      return parseOk(value as ActorKind);
    },
    "actor kinds ('user' | 'agent' | 'app' | 'adapter' | 'system'), no duplicates",
  );
  if (!parsed.ok) return parsed;
  const kinds = parsed.value.map((kind) => kind as string);
  const duplicates = kinds.filter((kind, index) => kinds.indexOf(kind) !== index);
  if (duplicates.length > 0) {
    return parseFail(
      'invalid-value',
      field,
      "actor kinds ('user' | 'agent' | 'app' | 'adapter' | 'system'), no duplicates",
      `duplicate actor kind(s): ${duplicates.join(', ')}`,
    );
  }
  return parseOk(parsed.value);
};

const parseCapabilityList = (raw: unknown, field: string): ParseResult<readonly Capability[]> => {
  const parsed = parseValueArrayWith(
    raw,
    field,
    parseCapability,
    'declared capability names, no duplicates',
  );
  if (!parsed.ok) return parsed;
  const names = parsed.value.map((value) => value as string);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    return parseFail(
      'invalid-value',
      field,
      'declared capability names, no duplicates',
      `duplicate capability '${duplicates[0] ?? ''}'`,
    );
  }
  return parseOk(parsed.value);
};

/**
 * Parse an untrusted value as an ActionDescriptor (total, fail-closed, strict
 * keys) INCLUDING the structural class rules:
 * - 'read': no compensating command, no approval routing, non-empty
 *   all-read required capabilities;
 * - 'reversible': a compensating command, no approval routing, non-empty
 *   capabilities with at least one write capability;
 * - 'approval-required': an approval routing, non-empty capabilities with at
 *   least one write capability, compensating command optional;
 * - 'prohibited': no compensating command, no approval routing, no actor kinds
 *   (prohibited binds every actor kind), capabilities may be empty.
 */
export function parseActionDescriptor(raw: unknown): ParseResult<ActionDescriptor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', DESCRIPTOR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, DESCRIPTOR_KEYS, '', DESCRIPTOR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const commandName = requireFieldWith(raw, 'commandName', '', parseCommandName);
  if (!commandName.ok) return commandName;
  const title = requireString(raw, 'title', '', TITLE_RULE);
  if (!title.ok) return title;
  const description = optionalFieldWith(raw, 'description', '', (value) => {
    if (typeof value !== 'string') {
      return parseFail('invalid-type', 'description', DESCRIPTION_RULE.description, describeValue(value));
    }
    if (value.length < DESCRIPTION_RULE.min || value.length > DESCRIPTION_RULE.max) {
      return parseFail('invalid-value', 'description', DESCRIPTION_RULE.description, `string of length ${value.length}`);
    }
    return parseOk(value);
  });
  if (!description.ok) return description;
  const actionClass = requireFieldWith(raw, 'actionClass', '', parseActionClassLiteral);
  if (!actionClass.ok) return actionClass;
  const actorKinds = requireFieldWith(raw, 'actorKinds', '', (value) =>
    parseActorKindList(value, ''),
  );
  if (!actorKinds.ok) return actorKinds;
  const requiredCapabilities = requireFieldWith(raw, 'requiredCapabilities', '', (value) =>
    parseCapabilityList(value, ''),
  );
  if (!requiredCapabilities.ok) return requiredCapabilities;
  const policyRef = requireString(raw, 'policyRef', '', POLICY_REF_RULE);
  if (!policyRef.ok) return policyRef;
  const evidenceRequirements = requireFieldWith(
    raw,
    'evidenceRequirements',
    '',
    (value) => parseEvidenceRequirements(value, ''),
  );
  if (!evidenceRequirements.ok) return evidenceRequirements;
  const requiredConfidence = requireFieldWith(raw, 'requiredConfidence', '', parseConfidenceLevel);
  if (!requiredConfidence.ok) return requiredConfidence;
  const resourceKind = requireFieldWith(raw, 'resourceKind', '', parseEntityKind);
  if (!resourceKind.ok) return resourceKind;
  const compensatingCommand = optionalNullableFieldWith(
    raw,
    'compensatingCommand',
    '',
    parseCommandName,
  );
  if (!compensatingCommand.ok) return compensatingCommand;
  const approval = optionalNullableFieldWith(raw, 'approval', '', parseApprovalRouting);
  if (!approval.ok) return approval;

  // --- structural class rules (fail-closed) ---
  const classValue = actionClass.value;
  if (classValue === 'prohibited') {
    if (actorKinds.value.length > 0) {
      return parseFail(
        'invalid-value',
        'actorKinds',
        "an empty actor-kind list for 'prohibited' actions (no actor kind may perform them)",
        `${actorKinds.value.length} actor kind(s)`,
      );
    }
  } else if (actorKinds.value.length === 0) {
    return parseFail(
      'invalid-value',
      'actorKinds',
      'a non-empty actor-kind list (prohibited actions are the only class that binds no actor kind)',
      'array of length 0',
    );
  }
  if (classValue !== 'prohibited' && requiredCapabilities.value.length === 0) {
    return parseFail(
      'invalid-value',
      'requiredCapabilities',
      'a non-empty capability list (prohibited actions may declare none — they never execute)',
      'array of length 0',
    );
  }
  if (classValue === 'read') {
    const nonRead = requiredCapabilities.value.filter((item) => !item.endsWith('.read'));
    if (nonRead.length > 0) {
      return parseFail(
        'invalid-value',
        'requiredCapabilities',
        "only read capabilities for 'read' actions",
        `write capability '${nonRead[0] ?? ''}'`,
      );
    }
  }
  if (classValue === 'reversible' || classValue === 'approval-required') {
    const hasWrite = requiredCapabilities.value.some((item) => item.endsWith('.write'));
    if (!hasWrite) {
      return parseFail(
        'invalid-value',
        'requiredCapabilities',
        `at least one write capability for '${classValue}' actions`,
        'no write capability',
      );
    }
  }
  if (classValue === 'reversible' && compensatingCommand.value === null) {
    return parseFail(
      'invalid-value',
      'compensatingCommand',
      "the compensating action's command name for 'reversible' actions",
      'null',
    );
  }
  if (
    (classValue === 'read' || classValue === 'prohibited') &&
    compensatingCommand.value !== null
  ) {
    return parseFail(
      'invalid-value',
      'compensatingCommand',
      `null for '${classValue}' actions (only reversible/approval-required actions declare a compensating action)`,
      'a command name',
    );
  }
  if (classValue === 'approval-required') {
    if (approval.value === null) {
      return parseFail(
        'invalid-value',
        'approval',
        "the approval routing for 'approval-required' actions (definitionKey, approvalKey, requiredCapability, policyRef)",
        'null',
      );
    }
  } else if (approval.value !== null) {
    return parseFail(
      'invalid-value',
      'approval',
      `null for '${classValue}' actions (only approval-required actions route into the approval engine)`,
      'an approval routing',
    );
  }

  return parseOk(
    {
      commandName: commandName.value,
      title: title.value,
      description: description.value ?? null,
      actionClass: classValue,
      actorKinds: actorKinds.value,
      requiredCapabilities: requiredCapabilities.value,
      policyRef: policyRef.value,
      evidenceRequirements: evidenceRequirements.value,
      requiredConfidence: requiredConfidence.value,
      resourceKind: resourceKind.value,
      compensatingCommand: compensatingCommand.value,
      approval: approval.value,
    } satisfies ActionDescriptor,
  );
}

/** Type guard for structurally valid ActionDescriptor values. */
export function isActionDescriptor(raw: unknown): raw is ActionDescriptor {
  return parseActionDescriptor(raw).ok;
}

/**
 * Compose a validated ActionDescriptor (trusted path): validates the input
 * with the same fail-closed checks as parseActionDescriptor and throws a loud
 * TypeError instead of returning the failure.
 */
export function defineActionDescriptor(raw: unknown): ActionDescriptor {
  const result = parseActionDescriptor(raw);
  if (!result.ok) {
    throw new TypeError(
      `invalid action descriptor: ${result.error.code} at '${
        result.error.path === '' ? '<root>' : result.error.path
      }' — expected ${result.error.expected}, received ${result.error.received}`,
    );
  }
  return result.value;
}
