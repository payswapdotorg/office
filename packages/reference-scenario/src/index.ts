// Office reference-scenario — public surface (OFF-037).
//
// src/index.ts is the package's WHOLE public surface: the release gates
// (OFF-038/039/040) and tests consume the package only through this root
// entry point, never through deeper paths. Anything not re-exported here is
// package-internal and may change without notice. Test internals are NEVER
// re-exported (the golden/a12/boundary suites are not part of the surface).
//
// The public surface is minimal and documented: THE deterministic scenario
// driver (runReferenceScenario + its typed parts/run records), the replay +
// causal-walk proofs, and the seeded-world/adapter-rig composition types the
// driver's record exposes. See README.md for the chain diagram and the two
// named invariants.

// THE seeded construction world + the four-adapter fixture rig.
export type {
  CommandJournalEntry,
  ScenarioSession,
  SeededWorld,
  SeededWorldParts,
  WorldEventRecorder,
  WorldLedger,
  WorldSeedIdentities,
} from './scenario/world';
export { costOpaqueId, seedWorld, sessionCoversScope } from './scenario/world';
export type {
  AdapterProposal,
  AdapterRig,
  AdapterRigParts,
  CoordinateKey,
  RecordedMapping,
  SourceMappingTwin,
} from './scenario/adapters';
export { CHAIN_PROVIDER_IDS, createAdapterRig, proposalsOf } from './scenario/adapters';

// THE golden chain driver + the two named proofs.
export type {
  ApprovalStep,
  CausalHop,
  CausalWalk,
  ChainCommandRecord,
  CostImpactStep,
  EvidenceStep,
  ExecutionStep,
  ModelIngressStep,
  ObservedApplication,
  ObserverStep,
  ReferenceScenarioParts,
  ReplayOutcome,
  ScenarioRun,
  ScheduleIngressStep,
} from './scenario/chain';
export { causalWalk, replayNotifications, runReferenceScenario } from './scenario/chain';
