// Office intelligence — the stack analysis engine's shared model (OFF-035).
//
// The typed model every measurement direction shares: the discriminated
// evidence chain (every referenced record kind — external systems,
// installation links, releases, entitlements, memory outcomes, memory
// benchmarks — deduplicated and canonically ordered), the observed-
// performance basis (referenced OutcomeRecord/benchmark ids, carried
// evidence only), THE exposed replacement-score composition (an exact
// rational over the referenced capability records — never a manual score,
// never a float), and the typed suggestion record (the engine's ONLY exit:
// data, never a command, never a mutation).
//
// THE discipline: the score composition is EXPOSED on every assessment —
// the formula constant, the exact rational value, and the two counts
// (covered capabilities, observed surface capabilities) the value is the
// ratio of — so any consumer can recompute the score BY HAND from the
// referenced records alone (the golden tests do exactly that). There is NO
// score input anywhere: no weights, no thresholds, no manual tuning — the
// scan inputs carry records only, and the formula has no tunable numbers.
import { CAPABILITIES } from '@office/authz';
import type { Capability } from '@office/authz';
import type { EntityId } from '@office/contracts';
import { RATIONAL_ONE, RATIONAL_ZERO, compareRationals } from '@office/intelligence-memory';
import type { BenchmarkId, OutcomeId, Rational } from '@office/intelligence-memory';
import type { AdapterKind, ProviderSystemId } from '@office/adapters-sdk';
import type { AppId, AppVersion } from '@office/app-sdk';
import type { EntitlementId, InstallationLinkId, ReleaseId } from '@office/marketplace';
import { ASSESSMENT_KINDS, SUGGESTION_KINDS } from './vocabulary';
import type { AssessmentKind, SuggestionKind } from './vocabulary';

// ---------------------------------------------------------------------------
// The canonical capability order (the authz vocabulary's declaration
// order — the one closed, typed ordering the whole platform shares).
// ---------------------------------------------------------------------------

const capabilityOrder = new Map<string, number>(
  CAPABILITIES.map((entry, index) => [entry, index]),
);

/**
 * Compare two capabilities by the CLOSED authz vocabulary's canonical
 * declaration order (then lexically for safety). Every capability list the
 * engine emits is sorted through this comparator, so orders are stable by
 * construction.
 */
export const compareCapabilities = (left: Capability, right: Capability): number => {
  const leftIndex = capabilityOrder.get(left) ?? CAPABILITIES.length;
  const rightIndex = capabilityOrder.get(right) ?? CAPABILITIES.length;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// The referenced-record references (the A4 evidence chain vocabulary).
// ---------------------------------------------------------------------------

/** One referenced observed external system (the adapters-sdk vocabulary). */
export interface ExternalSystemRef {
  readonly kind: 'external-system-ref';
  /** The adapter family kind of the referenced system. */
  readonly adapterKind: AdapterKind;
  /** The provider system id of the referenced system. */
  readonly systemId: ProviderSystemId;
}

/** One referenced installed app installation (the marketplace linkage). */
export interface AppInstallationRef {
  readonly kind: 'app-installation-ref';
  /** The installed app. */
  readonly appId: AppId;
  /** The canonical installation identity (the app-runtime record). */
  readonly installationId: EntityId;
  /** The marketplace installation link that recorded the installation. */
  readonly linkId: InstallationLinkId;
  /** The release the installation currently runs. */
  readonly releaseId: ReleaseId;
  /** The entitlement the installation resulted from. */
  readonly entitlementId: EntitlementId;
}

/** The canonical order of referenced external systems (adapter kind, then system id). */
export const compareExternalSystemRefs = (
  left: ExternalSystemRef,
  right: ExternalSystemRef,
): number => {
  if (left.adapterKind !== right.adapterKind) {
    return left.adapterKind < right.adapterKind ? -1 : 1;
  }
  if (left.systemId !== right.systemId) {
    return left.systemId < right.systemId ? -1 : 1;
  }
  return 0;
};

/** The canonical order of referenced app installations (app id, then link id). */
export const compareAppInstallationRefs = (
  left: AppInstallationRef,
  right: AppInstallationRef,
): number => {
  if (left.appId !== right.appId) {
    return left.appId < right.appId ? -1 : 1;
  }
  if (left.linkId !== right.linkId) {
    return left.linkId < right.linkId ? -1 : 1;
  }
  return 0;
};

/**
 * One evidence reference of an assessment: the discriminated reference to
 * the input record that PRODUCED its claims (A4). Every reference resolves
 * to a scan input record — an observed external system, a marketplace
 * installation link / release / entitlement, or a memory outcome /
 * benchmark fact of the observed-performance basis.
 */
export type StackEvidence =
  | (ExternalSystemRef & { readonly evidenceKind: 'system' })
  | { readonly evidenceKind: 'installation-link'; readonly linkId: InstallationLinkId }
  | { readonly evidenceKind: 'release'; readonly releaseId: ReleaseId }
  | { readonly evidenceKind: 'entitlement'; readonly entitlementId: EntitlementId }
  | { readonly evidenceKind: 'outcome'; readonly outcomeId: OutcomeId }
  | { readonly evidenceKind: 'benchmark'; readonly benchmarkId: BenchmarkId };

/** The canonical evidence-kind order (subjects first, then referenced bases). */
const EVIDENCE_KIND_ORDER: readonly StackEvidence['evidenceKind'][] = [
  'system',
  'installation-link',
  'release',
  'entitlement',
  'outcome',
  'benchmark',
];

const evidenceKey = (evidence: StackEvidence): string => {
  switch (evidence.evidenceKind) {
    case 'system':
      return `${evidence.adapterKind}|${evidence.systemId}`;
    case 'installation-link':
      return evidence.linkId;
    case 'release':
      return evidence.releaseId;
    case 'entitlement':
      return evidence.entitlementId;
    case 'outcome':
      return evidence.outcomeId;
    case 'benchmark':
      return evidence.benchmarkId;
  }
};

/** Canonical evidence order: evidence-kind order, then reference key. */
export const compareStackEvidence = (
  left: StackEvidence,
  right: StackEvidence,
): number => {
  const leftKind = EVIDENCE_KIND_ORDER.indexOf(left.evidenceKind);
  const rightKind = EVIDENCE_KIND_ORDER.indexOf(right.evidenceKind);
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  const leftKey = evidenceKey(left);
  const rightKey = evidenceKey(right);
  if (leftKey !== rightKey) {
    return leftKey < rightKey ? -1 : 1;
  }
  return 0;
};

/** Deduplicate and canonically order evidence references. */
export const canonicalStackEvidence = (
  references: readonly StackEvidence[],
): readonly StackEvidence[] => {
  const byKey = new Map<string, StackEvidence>();
  for (const reference of references) {
    const key = `${reference.evidenceKind}|${evidenceKey(reference)}`;
    if (!byKey.has(key)) {
      byKey.set(key, reference);
    }
  }
  return [...byKey.values()].sort(compareStackEvidence);
};

// ---------------------------------------------------------------------------
// The observed-performance basis (referenced memory facts, carried evidence).
// ---------------------------------------------------------------------------

/**
 * The observed-performance basis of an assessment: the REFERENCED memory
 * engine record ids (outcome records + benchmark facts of the scanned
 * tenant) that form the observed historical basis of the portfolio —
 * carried as evidence references only, never re-derived numbers. Null when
 * the scan supplied no memory facts ("where applicable").
 */
export interface PerformanceBasis {
  /** Every referenced OutcomeRecord id, canonical order. */
  readonly outcomeIds: readonly OutcomeId[];
  /** Every referenced Benchmark id, canonical order. */
  readonly benchmarkIds: readonly BenchmarkId[];
}

// ---------------------------------------------------------------------------
// THE exposed replacement-score composition (never a manual score).
// ---------------------------------------------------------------------------

/**
 * THE replacement-score formula, exposed as a constant on every score: the
 * exact ratio of COVERED capabilities over the subject's OBSERVED surface
 * capabilities. For an external system, 'covered' is the fraction of its
 * declared adapter-capability surface the tenant's installed apps already
 * declare; for an installed app, 'covered' is the fraction of its declared
 * manifest-permission surface the external systems also provide. There are
 * no weights and no thresholds anywhere — the composition is pure counted
 * set arithmetic over referenced records.
 */
export const REPLACEMENT_FORMULA =
  'replacementScore = coveredCapabilities / observedSurfaceCapabilities (the exact rational over the referenced capability records; no weights, no thresholds, no manual scores)';

/** The model schema version of the replacement-score model (bump on shape change). */
export const SCORE_SCHEMA_VERSION = 1;

/**
 * THE exposed replacement-score composition: the exact rational value PLUS
 * both counts it is the ratio of PLUS the formula it was computed by —
 * recomputable BY HAND from the assessment's own coverage lists (count the
 * covered entries, count the surface entries, reduce). `value` is null
 * exactly when the subject's observed surface is empty (a declared-capability-less
 * app — the ratio is undefined, never invented).
 */
export interface ReplacementScore {
  /** The model schema version of this score. */
  readonly scoreVersion: typeof SCORE_SCHEMA_VERSION;
  /** The formula this score was computed by (exposed, never a black box). */
  readonly formula: typeof REPLACEMENT_FORMULA;
  /** The exact rational value (covered / surface, reduced); null when the surface is empty. */
  readonly value: Rational | null;
  /** The count of covered capabilities (the ratio's numerator). */
  readonly coveredCount: number;
  /** The count of observed surface capabilities (the ratio's denominator). */
  readonly surfaceCount: number;
}

// ---------------------------------------------------------------------------
// The typed suggestion record (the engine's ONLY exit — data, never a command).
// ---------------------------------------------------------------------------

/** The model schema version of the suggestion model (bump on shape change). */
export const SUGGESTION_SCHEMA_VERSION = 1;

/**
 * The typed suggestion record — the suggestion-only exit of every
 * assessment (freeze A7): a deterministic posture DERIVED from the score
 * composition (complete overlap -> consolidate; partial -> extend-coverage;
 * none -> maintain), with machine-readable reasons. A suggestion carries
 * NO command references, NO command payloads, and NO executable surface of
 * any kind: adopting it is explicit downstream human/host action through
 * the landed marketplace lifecycle commands, never this engine.
 */
export interface ReplacementSuggestion {
  /** The model schema version of this suggestion. */
  readonly suggestionVersion: typeof SUGGESTION_SCHEMA_VERSION;
  /** The deterministic posture derived from the assessment's score composition. */
  readonly kind: SuggestionKind;
  /** The deterministic human-readable rationale. */
  readonly rationale: string;
  /** Machine-readable reasons (derived from the composition, never opaque). */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Schema/engine identities + the assessment-kind order.
// ---------------------------------------------------------------------------

/** The source identity of the stack analysis engine (A4 'source identity'). */
export const STACK_ENGINE = 'intelligence-stack-analysis';

/** The canonical position of one assessment kind (the vocabulary order). */
export const assessmentKindOrder = (kind: AssessmentKind): number => {
  const index = (ASSESSMENT_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? ASSESSMENT_KINDS.length : index;
};

/** The canonical position of one suggestion kind (the vocabulary order). */
export const suggestionKindOrder = (kind: SuggestionKind): number => {
  const index = (SUGGESTION_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? SUGGESTION_KINDS.length : index;
};

/** The version a pinned app installation runs (evidence summaries). */
export type PinnedAppVersion = AppVersion;

/** Re-exported exact-rational constants (the memory engine's canonical shape). */
export { RATIONAL_ONE, RATIONAL_ZERO, compareRationals };
