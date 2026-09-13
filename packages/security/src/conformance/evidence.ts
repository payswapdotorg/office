// Office security — conformance evidence records (OFF-036).
//
// The typed evidence vocabulary every conformance check is built from: a
// check DRIVES the real surfaces (the action gateway, the app runtime)
// through probes, records the observed evidence, and a PURE evaluator turns
// the evidence into a typed ConformanceCheckResult. The split is
// deliberate: the evaluators are the release gate (OFF-038 runs them against
// recorded evidence), and their detection power is provable — a forged
// evidence record (an accepted cross-tenant attempt, a deny-by-default
// violation, a missing audit envelope) is typed-reported as a failure.
import type { DomainError } from '@office/domain-kernel';

/** Every conformance check id, in canonical report order. */
export const CONFORMANCE_CHECK_IDS = [
  'tenant-isolation',
  'authorization-boundaries',
  'audit-completeness',
  'revocation',
] as const;

/** One conformance check id (see CONFORMANCE_CHECK_IDS). */
export type ConformanceCheckId = (typeof CONFORMANCE_CHECK_IDS)[number];

/** Grammar description used in failures. */
export const CONFORMANCE_CHECK_ID_GRAMMAR =
  "'tenant-isolation' | 'authorization-boundaries' | 'audit-completeness' | 'revocation'";

/** One typed conformance failure: which code, what was observed, where. */
export interface ConformanceFailure {
  /** The stable failure code of the check's failure vocabulary. */
  readonly code: string;
  /** What the check observed (human-readable, deterministic). */
  readonly message: string;
  /** The evidence record the failure came from (its label). */
  readonly probe: string;
}

/** The typed result of one conformance check over recorded evidence. */
export interface ConformanceCheckResult {
  /** Which check this is (see CONFORMANCE_CHECK_IDS). */
  readonly check: ConformanceCheckId;
  /** True iff the evidence satisfies the check's every expectation. */
  readonly passed: boolean;
  /** How many evidence records the check evaluated. */
  readonly probes: number;
  /** Every typed failure (empty iff passed). */
  readonly failures: readonly ConformanceFailure[];
}

/** Build a check result from its evidence label + failures (pure). */
export const conformanceResult = (
  check: ConformanceCheckId,
  probes: number,
  failures: readonly ConformanceFailure[],
): ConformanceCheckResult => ({
  check,
  passed: failures.length === 0,
  probes,
  failures: [...failures],
});

/** One typed failure of a check (internal helper shared by the evaluators). */
export const conformanceFailure = (
  probe: string,
  code: string,
  message: string,
): ConformanceFailure => ({ probe, code, message });

/**
 * The first detail code of a typed rejection (the stable machine-readable
 * denial vocabulary — 'tenant-scope-violation', 'no-allow-rule',
 * 'installation-suspended', ...), or null when the result is not a failure.
 */
export const rejectionCodeOf = (result: { readonly ok: boolean } & {
  readonly error?: DomainError;
}): string | null => {
  if (result.ok || result.error === undefined) return null;
  return result.error.details[0]?.code ?? null;
};

/** The observed decision of one gateway attempt, normalized. */
export type ObservedDecision = 'executed' | 'routed' | 'denied' | 'other';

/**
 * Normalize a typed gateway outcome into the observed decision vocabulary:
 * executed (committed effect), routed (awaiting its approval), denied (typed
 * rejection), or other (an unexpected outcome shape — itself a finding).
 */
export const observedDecisionOf = (
  result: { readonly ok: boolean } & {
    readonly value?: { readonly decision?: unknown; readonly replayed?: unknown };
    readonly error?: DomainError;
  },
): ObservedDecision => {
  if (!result.ok) return 'denied';
  const decision = result.value?.decision;
  if (decision === 'executed') return 'executed';
  if (decision === 'routed-to-approval') return 'routed';
  return 'other';
};
