// Office intelligence — THE replacement-potential assessment pass (OFF-035).
//
// `assessStackReplacement` is the deterministic software-stack analysis
// scan: the typed coverage records (per external system, per installed app)
// plus one typed ReplacementAssessment per measured subject, whose score is
// DERIVED from the observed coverage composition — NEVER an arbitrary
// manual score.
//
// THE derived-score discipline (the named acceptance): the replacement
// score is exactly
//
//     replacementScore = coveredCapabilities / observedSurfaceCapabilities
//
// an exact rational (the memory engine's Rational shape — no floats)
// computed from the COUNTED capability lists of the assessment's own
// coverage record, each of which is itself derived from the referenced
// input records (the adapter's declared object-kind surfaces; the pinned
// manifest's permission declarations). The composition is EXPOSED on every
// assessment (the formula constant, the exact value, and both counts), so
// the score is recomputable BY HAND from the referenced records alone —
// and there is NO score input anywhere in the package's surface: no
// weights, no thresholds, no manual scores (the scan inputs carry records
// only; the fail-closed strict-keys validation rejects any unknown field,
// so a manual score fed anywhere is a typed rejection).
//
// The gate order (mirroring the landed intelligence peers):
//   1. the CAPABILITY gate — apps.read + contracts.read + cost.read +
//      schedule.read BEFORE any input is read (the poisoned-scope probe
//      proves the ordering);
//   2. fail-closed INPUT validation (strict keys, re-parse through the
//      owning packages' parsers, duplicate identities, cross-reference
//      resolution);
//   3. STRUCTURAL scope coverage of every input (freeze A12) — typed
//      rejections, both directions, never revealing the foreign scope;
//   4. the POLICY gate — policy-denied SUBJECT records (observed systems,
//      installation links) are EXCLUDED from the measured portfolio
//      (invisible, tallied, never errors);
//   5. the coverage measurement + the assessment derivation, in canonical
//      emission order with scan-derived ids.
//
// Suggestion-only (freeze A7): every assessment exits as a typed
// suggestion record derived from its own score composition — there is NO
// command construction, NO marketplace mutation, NO canonical state
// mutation anywhere in this engine.
import type { Actor, Scope, Timestamp } from '@office/contracts';
import { domainError, fail, ok } from '@office/domain-kernel';
import type { DomainError, Result } from '@office/domain-kernel';
import { RATIONAL_ONE, RATIONAL_ZERO, compareRationals, rationalOf } from '@office/intelligence-memory';
import {
  ASSESSMENT_ID_SEPARATOR,
  ASSESSMENT_ORDINAL_WIDTH,
  parseAssessmentId,
} from './vocabulary';
import type { AssessmentId, AssessmentKind, StackScanId } from './vocabulary';
import {
  REPLACEMENT_FORMULA,
  SCORE_SCHEMA_VERSION,
  SUGGESTION_SCHEMA_VERSION,
  STACK_ENGINE,
  assessmentKindOrder,
  canonicalStackEvidence,
} from './model';
import type {
  PerformanceBasis,
  ReplacementScore,
  ReplacementSuggestion,
  StackEvidence,
} from './model';
import {
  measureStackCoverage,
  validateStackScanInputs,
} from './coverage';
import type {
  ExternalSystemCoverage,
  InstalledAppCoverage,
  MeasuredInstallation,
  ObservedExternalSystem,
  StackScanInputs,
  ValidatedStackInputs,
} from './coverage';
import {
  APP_ENTITLEMENT_KIND,
  BENCHMARK_KIND,
  PROJECT_KIND,
} from './vocabulary';
import {
  checkStackCapabilities,
  checkStackPolicy,
  checkStackScopeCovers,
  installationLinkResource,
  observedSystemResource,
  stackInputScopeFailure,
  stackResource,
} from './authorization';
import type { StackAuthorization } from './authorization';

// ---------------------------------------------------------------------------
// The scan parts + the provenance/consumed model.
// ---------------------------------------------------------------------------

/** The injected scan identity + clock (no wall time, no randomness). */
export interface StackScanParts {
  /** The caller-supplied scan identity (every assessment id derives from it). */
  readonly scanId: StackScanId;
  /** The injected clock's instant for the assessments' assessedAt stamps. */
  readonly now: Timestamp;
}

/**
 * The consumed-input shape of one scan (the provenance tally every
 * assessment carries): what was supplied, what was measured, and what was
 * deterministically skipped (severed links, revoked-entitlement links,
 * policy-denied subjects) — never silent skips.
 */
export interface StackConsumedCounts {
  readonly systemCount: number;
  readonly releaseCount: number;
  readonly entitlementCount: number;
  readonly linkCount: number;
  readonly measuredAppCount: number;
  readonly skippedUnlinkedLinkCount: number;
  readonly skippedRevokedEntitlementLinkCount: number;
  readonly policySkippedSystemCount: number;
  readonly policySkippedLinkCount: number;
  readonly outcomeCount: number;
  readonly benchmarkCount: number;
  readonly assessmentCount: number;
}

/** The provenance of one assessment (A4: the scan it was derived by). */
export interface AssessmentProvenance {
  /** The scan that produced this assessment (the injected scan identity). */
  readonly scanId: StackScanId;
  /** The consumed-input shape of the producing scan. */
  readonly consumed: StackConsumedCounts;
}

// ---------------------------------------------------------------------------
// THE replacement assessment record.
// ---------------------------------------------------------------------------

/** The schema version of the ReplacementAssessment model (bump on shape change). */
export const ASSESSMENT_SCHEMA_VERSION = 1;

/** The schema version of the StackAnalysisResult model (bump on shape change). */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** The coverage record of the assessed subject (discriminated by measurement direction). */
export type SubjectCoverage = ExternalSystemCoverage | InstalledAppCoverage;

/**
 * THE replacement assessment: one measured subject's coverage record PLUS
 * the DERIVED replacement score (the exposed, recomputable composition over
 * the coverage lists) PLUS the typed suggestion (the engine's only exit)
 * PLUS the complete evidence chain (A4 — every referenced input record)
 * PLUS the observed-performance basis (referenced memory record ids, where
 * applicable). A PROJECTION (A2/A7): the same scan inputs + authorization +
 * scan identity ALWAYS produce the byte-identical assessment set.
 */
export interface ReplacementAssessment {
  /** The scan-derived identity (`<scanId>#<ordinal>`, canonical emission order). */
  readonly assessmentId: AssessmentId;
  /** The model schema version of this assessment. */
  readonly assessmentVersion: typeof ASSESSMENT_SCHEMA_VERSION;
  /** The source identity of the assessing engine (A4). */
  readonly engine: typeof STACK_ENGINE;
  /** When the assessment was derived (injected clock — never wall time). */
  readonly assessedAt: Timestamp;
  /** The actor the scan ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the assessment was derived under (the scan's execution scope, A12). */
  readonly scope: Scope;
  /** The measurement direction (by external system or by installed app). */
  readonly kind: AssessmentKind;
  /** The deterministic human-readable summary. */
  readonly title: string;
  /** The typed coverage record (the measured workflow/capability surface). */
  readonly coverage: SubjectCoverage;
  /** THE derived replacement score (exposed composition — recomputable by hand). */
  readonly score: ReplacementScore;
  /** The typed suggestion (suggestion-only: data, never a command). */
  readonly suggestion: ReplacementSuggestion;
  /** The evidence chain: every referenced input record, canonical order (A4). */
  readonly evidence: readonly StackEvidence[];
  /** The referenced observed-performance basis (memory record ids), or null. */
  readonly performanceBasis: PerformanceBasis | null;
  /** The derivation provenance (scan id + the scan's consumed shape). */
  readonly provenance: AssessmentProvenance;
}

/** THE scan result: the assessments in canonical emission order + the tallies. */
export interface StackAnalysisResult {
  /** The scan identity every assessment id derives from. */
  readonly scanId: StackScanId;
  /** The model schema version of this analysis result. */
  readonly analysisVersion: typeof ANALYSIS_SCHEMA_VERSION;
  /** The source identity of the assessing engine (A4). */
  readonly engine: typeof STACK_ENGINE;
  /** When the scan ran (injected clock — never wall time). */
  readonly assessedAt: Timestamp;
  /** The actor the scan ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the scan executed under (A12). */
  readonly scope: Scope;
  /** Every assessment, canonical emission order (systems, then apps). */
  readonly assessments: readonly ReplacementAssessment[];
  /** The scan's consumed-input shape (the non-silent skip tallies). */
  readonly consumed: StackConsumedCounts;
}

// ---------------------------------------------------------------------------
// Type guards for the two measurement directions.
// ---------------------------------------------------------------------------

/** Is this assessment the external-system direction? */
export const isExternalSystemAssessment = (
  assessment: ReplacementAssessment,
): assessment is ReplacementAssessment & { readonly coverage: ExternalSystemCoverage } =>
  assessment.coverage.kind === 'external-system-coverage';

/** Is this assessment the installed-app direction? */
export const isInstalledAppAssessment = (
  assessment: ReplacementAssessment,
): assessment is ReplacementAssessment & { readonly coverage: InstalledAppCoverage } =>
  assessment.coverage.kind === 'installed-app-coverage';

/** The canonical subject key of one assessment (kind, then subject identity). */
const subjectKeyOf = (assessment: ReplacementAssessment): string => {
  if (assessment.coverage.kind === 'external-system-coverage') {
    return `${assessment.coverage.adapterKind}|${assessment.coverage.systemId}`;
  }
  return `${assessment.coverage.appId}|${assessment.coverage.linkId}`;
};

/**
 * Canonical assessment order: kind (the closed vocabulary's canonical
 * order — the emission order: external systems, then installed apps), then
 * subject key, then assessment id. Stable by construction.
 */
export const compareAssessments = (
  left: ReplacementAssessment,
  right: ReplacementAssessment,
): number => {
  const leftKind = assessmentKindOrder(left.kind);
  const rightKind = assessmentKindOrder(right.kind);
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  const leftSubject = subjectKeyOf(left);
  const rightSubject = subjectKeyOf(right);
  if (leftSubject !== rightSubject) {
    return leftSubject < rightSubject ? -1 : 1;
  }
  if (left.assessmentId !== right.assessmentId) {
    return left.assessmentId < right.assessmentId ? -1 : 1;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// The derived score + the derived suggestion (pure functions of the
// coverage composition — the only places a score ever comes from).
// ---------------------------------------------------------------------------

const scoreFailure = (reason: string): DomainError =>
  domainError(
    'invariant-violation',
    `the replacement score cannot be derived: ${reason}`,
    [{ code: 'stack-score-derivation', message: reason, path: null }],
  );

/**
 * DERIVE the replacement score from the counted coverage composition:
 * coveredCount / surfaceCount as an exact rational. The only inputs are the
 * two counts of the assessment's own coverage lists — there is no other
 * score source in the package (no weights, no thresholds, no manual input).
 * The score's value is null exactly when the surface is empty (the ratio is
 * undefined, never invented).
 */
const deriveReplacementScore = (
  coveredCount: number,
  surfaceCount: number,
): Result<ReplacementScore, DomainError> => {
  if (surfaceCount === 0) {
    return ok({
      scoreVersion: SCORE_SCHEMA_VERSION,
      formula: REPLACEMENT_FORMULA,
      value: null,
      coveredCount,
      surfaceCount,
    } satisfies ReplacementScore);
  }
  const value = rationalOf(coveredCount, surfaceCount);
  if (!value.ok) return value;
  return ok({
    scoreVersion: SCORE_SCHEMA_VERSION,
    formula: REPLACEMENT_FORMULA,
    value: value.value,
    coveredCount,
    surfaceCount,
  } satisfies ReplacementScore);
};

/**
 * DERIVE the typed suggestion from the score composition (the engine's
 * ONLY exit — a data record, never a command): complete overlap ->
 * consolidate; partial -> extend-coverage; none -> maintain; an empty
 * surface -> maintain with the no-surface reason.
 */
const deriveSuggestion = (
  subject: string,
  score: ReplacementScore,
): ReplacementSuggestion => {
  const value = score.value;
  if (value === null) {
    return {
      suggestionVersion: SUGGESTION_SCHEMA_VERSION,
      kind: 'maintain',
      rationale: `${subject} declares no capability surface — the replacement ratio is undefined and there is no replacement basis`,
      reasons: ['no-declared-capability-surface'],
    } satisfies ReplacementSuggestion;
  }
  if (compareRationals(value, RATIONAL_ONE) === 0) {
    return {
      suggestionVersion: SUGGESTION_SCHEMA_VERSION,
      kind: 'consolidate',
      rationale: `${subject}: the observed overlap is complete (${score.coveredCount}/${score.surfaceCount} capabilities) — a consolidation candidate`,
      reasons: [
        'coverage-complete',
        `covered-capabilities:${score.coveredCount}`,
        `surface-capabilities:${score.surfaceCount}`,
      ],
    } satisfies ReplacementSuggestion;
  }
  if (compareRationals(value, RATIONAL_ZERO) === 0) {
    return {
      suggestionVersion: SUGGESTION_SCHEMA_VERSION,
      kind: 'maintain',
      rationale: `${subject}: there is no observed overlap (0/${score.surfaceCount} capabilities) — no replacement basis`,
      reasons: [
        'coverage-none',
        'covered-capabilities:0',
        `surface-capabilities:${score.surfaceCount}`,
      ],
    } satisfies ReplacementSuggestion;
  }
  return {
    suggestionVersion: SUGGESTION_SCHEMA_VERSION,
    kind: 'extend-coverage',
    rationale: `${subject}: the observed overlap is partial (${score.coveredCount}/${score.surfaceCount} capabilities) — close the typed coverage gaps before any consolidation`,
    reasons: [
      'coverage-partial',
      `covered-capabilities:${score.coveredCount}`,
      `gap-capabilities:${score.surfaceCount - score.coveredCount}`,
    ],
  } satisfies ReplacementSuggestion;
};

// ---------------------------------------------------------------------------
// The scan-derived assessment identity (deterministic, no id supplier).
// ---------------------------------------------------------------------------

const assessmentIdFailure = (reason: string): DomainError =>
  domainError(
    'invariant-violation',
    `the assessment identity cannot be derived: ${reason}`,
    [{ code: 'stack-assessment-id-unreachable', message: reason, path: null }],
  );

const derivedAssessmentId = (
  scanId: StackScanId,
  ordinal: number,
): Result<AssessmentId, DomainError> => {
  const token = `${scanId}${ASSESSMENT_ID_SEPARATOR}${String(ordinal).padStart(
    ASSESSMENT_ORDINAL_WIDTH,
    '0',
  )}`;
  const parsed = parseAssessmentId(token);
  if (!parsed.ok) {
    return fail(
      assessmentIdFailure(
        `the derived token '${token}' violates the assessment id grammar (the scan id leaves no room for the ordinal suffix)`,
      ),
    );
  }
  return ok(parsed.value);
};

// ---------------------------------------------------------------------------
// THE scan.
// ---------------------------------------------------------------------------

const measuredAppsOf = (
  validated: ValidatedStackInputs,
  authorization: StackAuthorization,
): Result<
  {
    readonly apps: readonly MeasuredInstallation[];
    readonly skippedUnlinkedLinkCount: number;
    readonly skippedRevokedEntitlementLinkCount: number;
    readonly policySkippedLinkCount: number;
  },
  DomainError
> => {
  const releasesById = new Map(validated.releases.map((release) => [release.releaseId, release]));
  const entitlementsById = new Map(
    validated.entitlements.map((entitlement) => [entitlement.entitlementId, entitlement]),
  );
  const apps: MeasuredInstallation[] = [];
  let skippedUnlinkedLinkCount = 0;
  let skippedRevokedEntitlementLinkCount = 0;
  let policySkippedLinkCount = 0;
  for (const link of validated.links) {
    // Policy gate first (a policy-denied subject is invisible, tallied).
    if (!checkStackPolicy(authorization, installationLinkResource(link)).ok) {
      policySkippedLinkCount += 1;
      continue;
    }
    // The measured portfolio rule: linked installations with ACTIVE entitlements.
    if (link.state !== 'linked') {
      skippedUnlinkedLinkCount += 1;
      continue;
    }
    const entitlement = entitlementsById.get(link.entitlementId);
    if (entitlement === undefined || entitlement.state !== 'active') {
      skippedRevokedEntitlementLinkCount += 1;
      continue;
    }
    const release = releasesById.get(link.releaseId);
    if (release === undefined) {
      // Unreachable after cross-reference validation — kept fail-closed.
      return fail(
        scoreFailure(`installation link '${link.linkId}' references an unresolved release`),
      );
    }
    apps.push({ link, release, entitlement, manifest: release.manifest });
  }
  return ok({
    apps,
    skippedUnlinkedLinkCount,
    skippedRevokedEntitlementLinkCount,
    policySkippedLinkCount,
  });
};

/**
 * THE deterministic stack analysis scan: authorization gates first, then
 * the fail-closed input validation, then the structural scope coverage
 * (A12), then the policy exclusions (tallied), then the coverage
 * measurement and the assessment derivation in canonical emission order.
 * The same inputs + authorization + scan identity ALWAYS produce the
 * byte-identical analysis (run-twice + shuffled-input determinism — every
 * iteration order is canonical, so the input arrays' orders never matter).
 */
export function assessStackReplacement(
  inputs: StackScanInputs,
  authorization: StackAuthorization,
  parts: StackScanParts,
): Result<StackAnalysisResult, DomainError> {
  // 1. The capability gate — BEFORE any input is read.
  const capabilities = checkStackCapabilities(authorization);
  if (!capabilities.ok) return capabilities;

  // 2. Fail-closed input validation (strict keys, re-parse, duplicates, cross-refs).
  const validated = validateStackScanInputs(inputs);
  if (!validated.ok) return validated;

  // 3. Structural scope coverage of every tenant-owned input (A12) — typed
  //    rejections naming the input path, never the foreign scope. Releases
  //    are catalog records resolved through the tenant's own links, so the
  //    gate applies to the LINK (checked per link below through the same
  //    layer at query/policy time) — not the catalog record it pins.
  for (const [index, system] of validated.value.systems.entries()) {
    if (!checkStackScopeCovers(authorization, observedSystemResource(system)).ok) {
      return fail(stackInputScopeFailure(`systems[${index}]`));
    }
  }
  for (const [index, link] of validated.value.links.entries()) {
    if (!checkStackScopeCovers(authorization, installationLinkResource(link)).ok) {
      return fail(stackInputScopeFailure(`links[${index}]`));
    }
  }
  for (const [index, entitlement] of validated.value.entitlements.entries()) {
    if (
      !checkStackScopeCovers(
        authorization,
        stackResource({
          scope: { kind: 'tenant', tenantId: entitlement.tenantId },
          entityKind: APP_ENTITLEMENT_KIND,
          entityId: null,
        }),
      ).ok
    ) {
      return fail(stackInputScopeFailure(`entitlements[${index}]`));
    }
  }
  for (const [index, outcome] of validated.value.outcomes.entries()) {
    if (
      !checkStackScopeCovers(
        authorization,
        stackResource({
          scope: outcome.scope,
          entityKind: PROJECT_KIND,
          entityId: outcome.projectId,
        }),
      ).ok
    ) {
      return fail(stackInputScopeFailure(`outcomes[${index}]`));
    }
  }
  for (const [index, benchmark] of validated.value.benchmarks.entries()) {
    if (
      !checkStackScopeCovers(
        authorization,
        stackResource({
          scope: benchmark.scope,
          entityKind: BENCHMARK_KIND,
          entityId: null,
        }),
      ).ok
    ) {
      return fail(stackInputScopeFailure(`benchmarks[${index}]`));
    }
  }

  // 4. The policy gate over the SUBJECT records (excluded = invisible, tallied).
  const admittedSystems: ObservedExternalSystem[] = [];
  let policySkippedSystemCount = 0;
  for (const system of validated.value.systems) {
    if (checkStackPolicy(authorization, observedSystemResource(system)).ok) {
      admittedSystems.push(system);
    } else {
      policySkippedSystemCount += 1;
    }
  }
  const measured = measuredAppsOf(validated.value, authorization);
  if (!measured.ok) return measured;

  // 5. The coverage measurement + the assessment derivation.
  const coverage = measureStackCoverage({
    systems: admittedSystems,
    apps: measured.value.apps,
  });

  const outcomeIds = validated.value.outcomes.map((outcome) => outcome.outcomeId);
  const benchmarkIds = validated.value.benchmarks.map((benchmark) => benchmark.benchmarkId);
  const performanceBasis: PerformanceBasis | null =
    outcomeIds.length > 0 || benchmarkIds.length > 0
      ? { outcomeIds, benchmarkIds }
      : null;

  const consumed: StackConsumedCounts = {
    systemCount: admittedSystems.length,
    releaseCount: validated.value.releases.length,
    entitlementCount: validated.value.entitlements.length,
    linkCount: validated.value.links.length,
    measuredAppCount: measured.value.apps.length,
    skippedUnlinkedLinkCount: measured.value.skippedUnlinkedLinkCount,
    skippedRevokedEntitlementLinkCount: measured.value.skippedRevokedEntitlementLinkCount,
    policySkippedSystemCount,
    policySkippedLinkCount: measured.value.policySkippedLinkCount,
    outcomeCount: validated.value.outcomes.length,
    benchmarkCount: validated.value.benchmarks.length,
    assessmentCount: coverage.systems.length + coverage.apps.length,
  };

  const assessments: ReplacementAssessment[] = [];
  let ordinal = 1;
  for (const systemCoverage of coverage.systems) {
    const assessmentId = derivedAssessmentId(parts.scanId, ordinal);
    if (!assessmentId.ok) return assessmentId;
    ordinal += 1;
    const assessment = systemAssessmentOf(
      systemCoverage,
      assessmentId.value,
      authorization,
      parts,
      performanceBasis,
      consumed,
    );
    if (!assessment.ok) return assessment;
    assessments.push(assessment.value);
  }
  for (const appCoverage of coverage.apps) {
    const assessmentId = derivedAssessmentId(parts.scanId, ordinal);
    if (!assessmentId.ok) return assessmentId;
    ordinal += 1;
    const assessment = appAssessmentOf(
      appCoverage,
      assessmentId.value,
      authorization,
      parts,
      performanceBasis,
      consumed,
    );
    if (!assessment.ok) return assessment;
    assessments.push(assessment.value);
  }

  return ok({
    scanId: parts.scanId,
    analysisVersion: ANALYSIS_SCHEMA_VERSION,
    engine: STACK_ENGINE,
    assessedAt: parts.now,
    actor: authorization.context.actor,
    scope: authorization.context.scope,
    assessments,
    consumed,
  } satisfies StackAnalysisResult);
}

// ---------------------------------------------------------------------------
// The per-direction assessment derivations (pure).
// ---------------------------------------------------------------------------

const systemSubject = (coverage: ExternalSystemCoverage): string =>
  `external system '${coverage.adapterKind}/${coverage.systemId}'`;

const appSubject = (coverage: InstalledAppCoverage): string =>
  `installed app '${coverage.appId}' (version ${coverage.currentVersion})`;

const systemAssessmentOf = (
  coverage: ExternalSystemCoverage,
  assessmentId: AssessmentId,
  authorization: StackAuthorization,
  parts: StackScanParts,
  performanceBasis: PerformanceBasis | null,
  consumed: StackConsumedCounts,
): Result<ReplacementAssessment, DomainError> => {
  const score = deriveReplacementScore(coverage.coveredCount, coverage.surfaceCount);
  if (!score.ok) return score;
  const subject = systemSubject(coverage);
  const evidence: StackEvidence[] = [
    {
      evidenceKind: 'system',
      kind: 'external-system-ref',
      adapterKind: coverage.adapterKind,
      systemId: coverage.systemId,
    },
  ];
  for (const covered of coverage.covered) {
    for (const provider of covered.providedBy) {
      evidence.push({ evidenceKind: 'installation-link', linkId: provider.linkId });
      evidence.push({ evidenceKind: 'release', releaseId: provider.releaseId });
      evidence.push({ evidenceKind: 'entitlement', entitlementId: provider.entitlementId });
    }
  }
  if (performanceBasis !== null) {
    for (const outcomeId of performanceBasis.outcomeIds) {
      evidence.push({ evidenceKind: 'outcome', outcomeId });
    }
    for (const benchmarkId of performanceBasis.benchmarkIds) {
      evidence.push({ evidenceKind: 'benchmark', benchmarkId });
    }
  }
  return ok({
    assessmentId,
    assessmentVersion: ASSESSMENT_SCHEMA_VERSION,
    engine: STACK_ENGINE,
    assessedAt: parts.now,
    actor: authorization.context.actor,
    scope: authorization.context.scope,
    kind: 'external-system',
    title: `External system '${coverage.adapterKind}/${coverage.systemId}': ${score.value.coveredCount}/${score.value.surfaceCount} observed capabilities covered by installed apps`,
    coverage,
    score: score.value,
    suggestion: deriveSuggestion(subject, score.value),
    evidence: canonicalStackEvidence(evidence),
    performanceBasis,
    provenance: { scanId: parts.scanId, consumed },
  } satisfies ReplacementAssessment);
};

const appAssessmentOf = (
  coverage: InstalledAppCoverage,
  assessmentId: AssessmentId,
  authorization: StackAuthorization,
  parts: StackScanParts,
  performanceBasis: PerformanceBasis | null,
  consumed: StackConsumedCounts,
): Result<ReplacementAssessment, DomainError> => {
  const score = deriveReplacementScore(coverage.overlappingCount, coverage.surfaceCount);
  if (!score.ok) return score;
  const subject = appSubject(coverage);
  const evidence: StackEvidence[] = [
    { evidenceKind: 'installation-link', linkId: coverage.linkId },
    { evidenceKind: 'release', releaseId: coverage.releaseId },
    { evidenceKind: 'entitlement', entitlementId: coverage.entitlementId },
  ];
  for (const overlapped of coverage.overlapping) {
    for (const provider of overlapped.providedBy) {
      evidence.push({
        evidenceKind: 'system',
        kind: 'external-system-ref',
        adapterKind: provider.adapterKind,
        systemId: provider.systemId,
      });
    }
  }
  if (performanceBasis !== null) {
    for (const outcomeId of performanceBasis.outcomeIds) {
      evidence.push({ evidenceKind: 'outcome', outcomeId });
    }
    for (const benchmarkId of performanceBasis.benchmarkIds) {
      evidence.push({ evidenceKind: 'benchmark', benchmarkId });
    }
  }
  return ok({
    assessmentId,
    assessmentVersion: ASSESSMENT_SCHEMA_VERSION,
    engine: STACK_ENGINE,
    assessedAt: parts.now,
    actor: authorization.context.actor,
    scope: authorization.context.scope,
    kind: 'installed-app',
    title: `Installed app '${coverage.appId}' ${coverage.currentVersion}: ${score.value.coveredCount}/${score.value.surfaceCount} declared capabilities provided by external systems`,
    coverage,
    score: score.value,
    suggestion: deriveSuggestion(subject, score.value),
    evidence: canonicalStackEvidence(evidence),
    performanceBasis,
    provenance: { scanId: parts.scanId, consumed },
  } satisfies ReplacementAssessment);
};
