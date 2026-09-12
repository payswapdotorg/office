# ADR-003: Extensible Construction App Marketplace

Status: Accepted / Frozen

## Decision

Office provides a first-party and third-party app marketplace. An app is a versioned extension package that consumes declared capabilities and canonical contracts. Apps may provide UI, commands, workflows, projections, integrations, agents, reports, or specialized editors.

The marketplace is not a second SaaS backend marketplace. Apps extend Office's project graph and execution model.

## App manifest

Every installable app must declare, at minimum:

```json
{
  "id": "com.example.app",
  "version": "1.0.0",
  "sdkVersion": "1.0",
  "displayName": "Example App",
  "publisher": "Example",
  "entrypoints": ["web", "desktop"],
  "capabilities": ["project.read", "schedule.write"],
  "events": ["schedule.activity.changed"],
  "commands": ["schedule.activity.update"],
  "ui": ["project.tab", "project.context-action"],
  "dataScopes": ["project", "organization"],
  "permissions": ["schedule.read", "schedule.write"],
  "dependencies": [],
  "compatibility": {"officeApi": ">=1.0 <2.0"}
}
```

The exact schema lives in the App SDK implementation work item and is versioned independently from the marketplace catalog.

## App classes

1. View apps: spreadsheet, dashboard, scheduling, BIM/CAD, estimating, reporting.
2. Workflow apps: approvals, closeout, safety, procurement, quality.
3. Integration apps: external ERP/CDE/BIM/scheduling providers.
4. Intelligence apps: specialized agents, estimators, risk analysis, benchmarking.
5. Data apps: import/export, conversion, classification, document processing.
6. Platform apps: notifications, search extensions, automation utilities.

## Isolation model

Apps run with tenant-scoped identity and explicit permissions. They cannot access arbitrary SQL or hidden internal modules. App calls go through the App Runtime/SDK gateway. App data that is not canonical construction state is isolated under an app namespace and can be deleted on uninstall; canonical records created through authorized commands remain owned by their domain.

## Lifecycle

Discover -> inspect permissions -> install -> grant/deny -> initialize -> use -> update -> rollback/suspend -> uninstall.

Updates are versioned. The platform verifies manifest compatibility and declared permission deltas before activation.

## Marketplace trust

Marketplace submission requires:

- signed/versioned artifact
- manifest validation
- permission review
- dependency graph validation
- automated contract tests
- tenant isolation test
- event/command compatibility test
- security scan hooks
- rollback metadata
- publisher identity

Paid apps may use a platform entitlement contract, but billing is outside the domain core.

## Key invariant

An app can become a powerful view of the same project, but it cannot create a second canonical project, schedule, BOQ, cost, or model universe for the same Office project.
