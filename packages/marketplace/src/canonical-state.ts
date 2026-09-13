// Office marketplace — THE canonical-state observation port (OFF-027).
//
// Freeze A11: one canonical graph — the marketplace owns catalog/lifecycle
// METADATA, never project truth. This port is the typed, inspectable form of
// that boundary: the environment hands the marketplace engine a way to
// OBSERVE canonical project state (a stable fingerprint + mutation counter),
// and the marketplace provably NEVER invokes it — not to read, not to write.
// The acceptance harness wraps the port in a counting proxy and asserts
// ZERO invocations across an entire golden lifecycle scenario, plus
// byte-identical fingerprints before and after every marketplace operation.
//
// The port is deliberately read-ONLY: the marketplace could not mutate
// canonical state through it even if it tried — there is no mutation
// surface here at all. The marketplace never issues canonical events
// either (the audit ledger in audit.ts is its OWN typed record, never a
// DomainEventEnvelope).

/**
 * A stable observation of the whole canonical project state the host owns:
 * `fingerprint` is a digest over every canonical record (byte-identical
 * across observations iff nothing canonical changed), and `mutationCount`
 * is the total number of canonical mutations ever applied (monotonic; a
 * zero delta across an operation proves the operation mutated nothing).
 */
export interface CanonicalStateSnapshot {
  /** Stable digest over the canonical project state (deterministic). */
  readonly fingerprint: string;
  /** Total canonical mutations ever applied (monotonic, never resets). */
  readonly mutationCount: number;
}

/**
 * THE canonical-state observation port (freeze A11). Read-only by
 * construction: no mutation surface exists on it at all. The marketplace
 * engine is CONSTRUCTED with one and provably never touches it — see
 * engine.ts and the golden acceptance suite (a counting proxy around this
 * port is the A11 behavioral proof).
 */
export interface CanonicalStatePort {
  /** Observe the canonical project state (pure read; deterministic). */
  snapshot(): CanonicalStateSnapshot;
}
