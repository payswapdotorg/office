// Office intelligence — THE recovery candidate record (OFF-033).
//
// A CandidateRecovery is ONE deterministic, versioned machine-generated
// PROJECTION: the evidence-backed claim that a revenue recovery opportunity
// exists — a candidate change order or claim detected over the contracts
// model and the intelligence peers' outputs. It is a SUGGESTION-shaped
// record, never an assertion: it references the canonical contracts-domain
// records it was detected over, carries the complete A4 evidence chain
// (records + producing ledger events + assessments + outcomes + benchmarks
// — every reference resolves to a producing source record) PLUS the
// agents-typed qualified EvidenceSet, cites (never re-derives) the economic
// impact basis through its producing assessment ids, and grounds its
// expectation in the referenced historical basis (memory outcome records +
// benchmark facts).
//
// The record contains no clock, no randomness, no environment: candidates
// are stamped by the detection scan from the injected scan identity and
// clock (detection.ts), so the same inputs always produce the
// byte-identical candidate set (A7 rebuildability discipline).
import type { Actor, EntityRef, EventName, Scope, Timestamp } from '@office/contracts';
import type {
  CandidateEvidenceSet,
  PriorityScore,
  ProducingLedgerEventId,
  RecoveryEconomicBasis,
  RecoveryEvidence,
  RecoveryHistoricalBasis,
  RecoverySeverity,
} from './model';
import { RECOVERY_KINDS } from './vocabulary';
import type { CandidateId, RecoveryKind, RecoveryScanId } from './vocabulary';

// ---------------------------------------------------------------------------
// Detection provenance + the primary producing source (A3/A4).
// ---------------------------------------------------------------------------

/**
 * The primary producing source of a candidate (the A3 causation anchor of
 * the emitted recovery event): the `contracts.changeEventRaised` event the
 * producing assessment assessed.
 */
export interface RecoveryPrimarySource {
  /** The ledger id of the primary producing event. */
  readonly eventId: ProducingLedgerEventId;
  /** The primary producing event's name ('contracts.changeEventRaised'). */
  readonly eventName: EventName;
  /** The primary producing event's occurred-at time. */
  readonly occurredAt: Timestamp;
  /** The correlation id of the primary source's causal chain (A3 carry-over). */
  readonly correlationId: string;
}

/** The detection provenance of one recovery candidate (A4). */
export interface DetectionProvenance {
  /** The scan that produced this candidate (the injected scan identity). */
  readonly scanId: RecoveryScanId;
  /** When the scan ran (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The consumed inputs' shape (the admitted, policy-filtered set). */
  readonly consumed: {
    readonly contractCount: number;
    readonly changeEventCount: number;
    readonly changeOrderCount: number;
    readonly claimReferenceCount: number;
    readonly assessmentCount: number;
    readonly outcomeCount: number;
    readonly benchmarkCount: number;
  };
}

// ---------------------------------------------------------------------------
// THE recovery candidate model.
// ---------------------------------------------------------------------------

/** The schema version of the CandidateRecovery model (bump on shape change). */
export const CANDIDATE_SCHEMA_VERSION = 1;

/** The source identity of the revenue recovery engine (A4 'source identity'). */
export const RECOVERY_ENGINE = 'intelligence-revenue';

/**
 * THE recovery candidate: a detected revenue recovery opportunity —
 * deterministic, versioned, evidence-chained. Every claim (kind, severity,
 * economic basis, historical basis) carries the source references that
 * produced it; the detection provenance names the scan and its injected
 * timestamp. Candidates are PROJECTIONS of the contracts model + the
 * intelligence peers' outputs (A2/A7): the same scan inputs always
 * reproduce the identical candidate set. A candidate is a SUGGESTION —
 * the engine never asserts a claim from it (see proposal.ts).
 */
export interface CandidateRecovery {
  /** The scan-derived identity (deterministic given the scan identity). */
  readonly candidateId: CandidateId;
  /** The model schema version of this candidate. */
  readonly candidateVersion: typeof CANDIDATE_SCHEMA_VERSION;
  /** The source identity of the detecting engine (A4). */
  readonly engine: typeof RECOVERY_ENGINE;
  /** When the candidate was detected (injected clock — never wall time). */
  readonly detectedAt: Timestamp;
  /** The actor the scan ran for (A4 source identity). */
  readonly actor: Actor;
  /** The scope the candidate was detected under (the subject's scope, A12). */
  readonly scope: Scope;
  /** The detected condition's kind (closed vocabulary). */
  readonly kind: RecoveryKind;
  /** The deterministic human-readable summary of the condition. */
  readonly title: string;
  /** The referenced canonical contracts-domain records, canonical order. */
  readonly referencedRecords: readonly EntityRef[];
  /** The typed severity (deterministically computed, benchmark-calibrated). */
  readonly severity: RecoverySeverity;
  /** The economic impact basis (cited money + producing assessment ids). */
  readonly economicBasis: RecoveryEconomicBasis;
  /** The historical basis (referenced outcome + benchmark facts). */
  readonly historicalBasis: RecoveryHistoricalBasis;
  /**
   * THE evidence chain acceptance: every source record/event/assessment/
   * outcome/benchmark reference behind any claim of this candidate,
   * deduplicated and in canonical order — every reference resolves to a
   * producing source record (A4).
   */
  readonly evidence: readonly RecoveryEvidence[];
  /**
   * THE complete evidence set (the agents discipline): the qualified,
   * non-empty EvidenceSet the candidate grounds its consequential
   * suggestion on — an empty or out-of-scope set is a typed rejection
   * (detection.ts's qualification gate).
   */
  readonly evidenceSet: CandidateEvidenceSet;
  /** The detection provenance (scan id, injected timestamp, consumed shape). */
  readonly provenance: DetectionProvenance;
  /** The primary producing event (the A3 causation anchor of the detection). */
  readonly primarySource: RecoveryPrimarySource;
}

/** The canonical position of one recovery kind (the vocabulary order). */
const recoveryKindOrder = (kind: RecoveryKind): number => {
  const index = (RECOVERY_KINDS as readonly string[]).indexOf(kind);
  return index < 0 ? RECOVERY_KINDS.length : index;
};

/**
 * Canonical candidate order: kind (the closed vocabulary's canonical order
 * — the detection rules' emission order), then candidate id.
 */
export const compareCandidates = (
  left: CandidateRecovery,
  right: CandidateRecovery,
): number => {
  if (left.kind !== right.kind) {
    return recoveryKindOrder(left.kind) - recoveryKindOrder(right.kind);
  }
  if (left.candidateId !== right.candidateId) {
    return left.candidateId < right.candidateId ? -1 : 1;
  }
  return 0;
};

/** One recovery candidate ranked by the seeded prioritization (the total order). */
export interface RankedCandidate {
  /** The 1-based position in the stable priority order (identical across runs). */
  readonly rank: number;
  /** The ranked candidate. */
  readonly candidate: CandidateRecovery;
  /** The exposed priority score (recomputable from the model alone). */
  readonly score: PriorityScore;
}
