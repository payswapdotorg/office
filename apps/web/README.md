# @office/web

Placeholder package for the PaySwap Office **web client**.

## Status (OFF-001)

This package intentionally contains **no application code, no dependencies,
and no scripts**. It exists to pin the `apps/web` directory convention and a
TypeScript config that extends the workspace base (`tsconfig.base.json`).

The web client is delivered by work item **OFF-030** and, per the frozen
architecture (`docs/architecture/ARCHITECTURE_FREEZE.md`), must be built
strictly over the canonical application contracts introduced from OFF-002
onward. Web is a view over the same project state — never a second source of
truth.

Do not add frameworks, provider SDKs, or runtime code to this package outside
of OFF-030.
