// Office authz — capability vocabulary (OFF-006).
//
// A Capability is a declared, named permission from a CLOSED vocabulary:
// '<area>.<read|write>', e.g. 'projects.read'. This is the typed
// authorization vocabulary of the platform (freeze A7 — marketplace apps
// declare capabilities; A8 — agents act only through permitted actions).
// Reads and writes are distinct: the action dimension is structural in the
// capability name, and every declared area carries both halves.
//
// Fail-closed: parseCapability rejects unknown strings — undeclared areas,
// other suffixes, malformed names — so an undeclared capability can never
// enter a context, a role definition, or a policy rule through a parse
// boundary. capability() is the trusted-path counterpart (loud TypeError).
// Extending the vocabulary is an authz-owner change (this package).
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { describeValue, parseValueArray } from './parse';

/** The two authorization actions (A8's read/reversible/approval-required/prohibited classification belongs to OFF-017). */
export type Action = 'read' | 'write';

declare const capabilityBrand: unique symbol;

/**
 * Names of the declared capability vocabulary, one <area>.<read|write> pair
 * per canonical bounded-context resource area, in canonical order.
 */
const DECLARED_CAPABILITY_NAMES = [
  // Identity & tenancy / organization & people (bounded contexts 1–2).
  'organization.read',
  'organization.write',
  'people.read',
  'people.write',
  // Projects & locations (3).
  'projects.read',
  'projects.write',
  // Documents & evidence (4).
  'documents.read',
  'documents.write',
  // BIM/model references (5).
  'models.read',
  'models.write',
  // Work & field operations (6).
  'work.read',
  'work.write',
  // Schedule & program of work (7).
  'schedule.read',
  'schedule.write',
  // Cost, budget & commitments (8).
  'cost.read',
  'cost.write',
  // Procurement & vendors (9).
  'procurement.read',
  'procurement.write',
  // Contracts & change events (10).
  'contracts.read',
  'contracts.write',
  // Quality & safety (11).
  'quality.read',
  'quality.write',
  // Workflow & approvals (12).
  'workflows.read',
  'workflows.write',
  // Marketplace & app lifecycle (17).
  'apps.read',
  'apps.write',
] as const;

/** Literal union of the declared capability names (the typed vocabulary). */
export type CapabilityName = (typeof DECLARED_CAPABILITY_NAMES)[number];

/** A declared capability, e.g. 'projects.read' (branded canonical value). */
export type Capability = CapabilityName & { readonly [capabilityBrand]: 'Capability' };

/** Grammar description used in parse failures. */
export const CAPABILITY_GRAMMAR =
  "declared capability '<area>.<read|write>' — area is lowercase kebab-case (1..32 chars); the name must be one of the declared vocabulary (CAPABILITIES), e.g. 'projects.read'";

const CAPABILITY_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,31}\.(read|write)$/;

const DECLARED_EXPECTED = 'one of the declared capabilities (CAPABILITIES)';

/**
 * The declared capability vocabulary, in canonical (declaration) order.
 * Built through the trusted builder at module load: a malformed entry in
 * DECLARED_CAPABILITY_NAMES breaks the import loudly (fail-closed), never
 * silently.
 */
export const CAPABILITIES: readonly Capability[] = DECLARED_CAPABILITY_NAMES.map((name) =>
  capability(name),
);

/**
 * Parse an untrusted value as a Capability (total, fail-closed). Grammar
 * violations and well-formed-but-undeclared names are both rejected — the
 * vocabulary is closed.
 */
export function parseCapability(raw: unknown): ParseResult<Capability> {
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', CAPABILITY_GRAMMAR, describeValue(raw));
  }
  if (!CAPABILITY_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', CAPABILITY_GRAMMAR, describeValue(raw));
  }
  if (!(DECLARED_CAPABILITY_NAMES as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', DECLARED_EXPECTED, `undeclared capability '${raw}'`);
  }
  return parseOk(raw as Capability);
}

/** Type guard for declared Capability values. */
export function isCapability(raw: unknown): raw is Capability {
  return parseCapability(raw).ok;
}

/** Compose a Capability from its declared name (trusted path; loud TypeError). */
export function capability(name: string): Capability {
  const parsed = parseCapability(name);
  if (!parsed.ok) {
    throw new TypeError(`unknown capability: ${String(name)}`);
  }
  return parsed.value;
}

/** The action a capability grants — structural in the capability name. */
export function capabilityAction(value: Capability): Action {
  return value.endsWith('.read') ? 'read' : 'write';
}

/**
 * Parse an untrusted array of capability names (package-internal): a real
 * array, every element a declared capability, no duplicates. Element
 * failures report paths like '<field>[2]'.
 */
export function parseCapabilityList(
  raw: unknown,
  field: string,
): ParseResult<readonly Capability[]> {
  return parseValueArray(
    raw,
    field,
    parseCapability,
    'array of declared capability names (no duplicates)',
  );
}
