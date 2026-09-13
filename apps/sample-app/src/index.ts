// @office-sample/app — public surface (OFF-025).
//
// The sample app's whole surface is its manifest. It exists to prove the
// marketplace app contract: an app compiles against ONLY @office/app-sdk +
// @office/contracts (no domain, intelligence, sync, adapters, agents, or
// client-sync packages anywhere in its import graph) and ships a typed
// manifest — never executable core code. The boundary test in this directory
// enforces both halves; the SDK's own suites enforce the manifest vocabulary.
export { FIELD_PROGRESS_TRACKER } from './manifest';
