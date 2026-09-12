-- OFF-004 migration 0002 — project metadata table.
--
-- Conventions on top of 0001:
--   * every tenant-owned table carries `tenant_id` as its FIRST scope column
--     (freeze A12: tenant isolation on every persisted entity and read/write
--     path — repositories scope every statement by this column by
--     construction);
--   * relational integrity: projects reference their owning tenant, with the
--     cascade rule keeping a tenant's rows unreachable the moment the tenant
--     row goes;
--   * JSONB is reserved for extension metadata only (freeze A2): core
--     columns (name, version, timestamps) stay typed;
--   * tenant-scoped access path: listing/filtering by tenant is supported by
--     a covering index in the repository's deterministic list order.

CREATE TABLE projects (
    tenant_id          TEXT NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
    project_id         TEXT PRIMARY KEY,
    name               TEXT NOT NULL CHECK (char_length(name) > 0),
    version            BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at         TIMESTAMPTZ NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL,
    extension_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX projects_by_tenant_created_at
    ON projects (tenant_id, created_at DESC, project_id);
