# Office Definition of Done

A work item is DONE only if every applicable gate below passes.

## Correctness

- Business invariants have deterministic unit/integration tests.
- Tenant and project scope are enforced on reads and writes.
- Mutations are transactional where they change canonical state.
- Idempotency is proven for replayable commands.
- External synchronization records provenance and source versions.

## Architecture

- Implementation matches the frozen ADRs.
- Canonical data is not duplicated in UI/app/provider layers.
- Providers are behind adapters.
- AI accesses state through domain/application contracts and the Action Gateway.
- Marketplace apps use declared permissions/capabilities only.
- Client/platform code has no alternative source of truth.

## Security

- Authorization denial tests exist for the sensitive boundary.
- Cross-tenant access is impossible through the implemented path.
- App revocation takes effect without stale capability execution.
- Audit records exist for consequential actions.

## Events and projections

- Domain mutations emit required immutable events.
- Outbox delivery is safe under duplicate delivery.
- Derived projections can be rebuilt or reconciled.
- Event schema/versioning is explicit.

## UX/API

- Public application contracts are typed and versioned.
- Error semantics are explicit and machine-readable.
- New UI actions map to domain commands instead of bespoke state mutations.

## Testing

At minimum, run:

- formatter/linter
- unit tests for changed bounded context
- integration tests covering persistence/events
- architecture/conformance tests affected by the change
- contract tests for adapter/app boundaries where applicable

End-to-end tests are required for cross-domain flows and release gates.

## Documentation

- Work item status and acceptance evidence are updated.
- New public contracts are documented.
- Architectural deviations require an ADR, not an inline comment.
- Operational behavior affecting support is documented.
