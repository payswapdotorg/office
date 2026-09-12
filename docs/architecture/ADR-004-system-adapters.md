# ADR-004: Provider-Neutral System Adapters

Status: Accepted / Frozen

## Decision

External systems are connected through a stable Adapter SDK. The core domain must know only canonical interfaces. Provider-specific SDKs, authentication, rate limits, webhook formats, IDs, field mappings, and retry behavior live inside adapters.

Initial adapter families:

- Construction workflow/CDE adapters (including Procore-class systems)
- BIM/model adapters (including Autodesk-class systems)
- Scheduling/program-of-work adapters (including Primavera-class systems)
- Finance/ERP adapters
- File/email/collaboration adapters
- Spreadsheet import/export adapters

## Adapter responsibilities

An adapter owns:

- authentication and credential lifecycle
- source ID mapping
- incremental synchronization
- webhook/polling translation
- provider rate-limit handling
- provider error mapping
- source snapshots needed for reconciliation
- canonical command/event translation
- outbound writes when Office is authorized to act through the provider

## Canonical boundary

```text
Provider SDK/API
      |
      v
Provider Adapter
      |
      v
Canonical Adapter Contract
      |
      v
Application / Domain Commands
      |
      v
Canonical Domain + Event Ledger
```

No core module imports a provider SDK.

## Reconciliation

Every mapped external object has a stable `(provider, providerAccount, providerObjectType, providerObjectId)` reference. Synchronization records source version/hash and canonical version/hash. Material conflicts become explicit reconciliation records.

## Adapter extensibility

Adding a new provider must require creating an adapter and contract tests, not altering canonical entities. The same mechanism supports customer-specific adapters and future desktop/local connectors.

## Desktop/local adapters

A future desktop shell may expose a local filesystem/model engine as an adapter. The adapter communicates with Office using the same contracts; local files never become a competing canonical store.
