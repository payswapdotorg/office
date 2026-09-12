-- OFF-007 migration 0100 — canonical organizations table (enterprise identity).
--
-- The Organization aggregate of the canonical enterprise graph (freeze A1:
-- tenant, organization, project, people, companies, ...). Conventions follow
-- the OFF-004 foundation exactly:
--   * canonical id column is TEXT PRIMARY KEY carrying the full canonical id
--     string (office-ent-v1-<opaque>) — never provider ids;
--   * tenant_id is the FIRST scope column (freeze A12): every read/write path
--     is tenant-scoped by construction; the row references its owning tenant
--     with the cascade rule keeping a tenant's rows unreachable the moment the
--     tenant row goes;
--   * typed columns for every core field; JSONB only for extension metadata
--     (freeze A2);
--   * optimistic-concurrency `version` (BIGINT, monotonic from 1);
--   * created_at / updated_at TIMESTAMPTZ supplied by the executing runtime's
--     injected clock (repositories never read a wall clock);
--   * the lifecycle is EXPLICIT, never a delete: `status` is the one-way
--     active->archived transition and `archived_at` records when it happened
--     (a row-level CHECK keeps the pair consistent in the database itself).
--
-- Numbering: OFF-007 owns versions 0100+. The persistence foundation owns
-- 0001/0002 (immutable) and the OFF-005 event ledger owns 0003/0004 under
-- packages/events/migrations; a runtime composes the full canonical chain in
-- ascending version order (see the package README).

CREATE TABLE organizations (
    tenant_id          TEXT NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
    organization_id    TEXT PRIMARY KEY,
    name               TEXT NOT NULL CHECK (char_length(name) > 0),
    status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'archived')),
    archived_at        TIMESTAMPTZ,
    version            BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at         TIMESTAMPTZ NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL,
    extension_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT organizations_lifecycle_consistency
        CHECK ((status = 'active' AND archived_at IS NULL)
            OR (status = 'archived' AND archived_at IS NOT NULL))
);

CREATE INDEX organizations_by_tenant_created_at
    ON organizations (tenant_id, created_at DESC, organization_id);
