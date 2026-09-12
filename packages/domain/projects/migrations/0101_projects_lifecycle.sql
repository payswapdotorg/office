-- OFF-007 migration 0101 — the explicit project lifecycle (ALTER, forward-only).
--
-- The `projects` table itself is the OFF-004 foundation's (migration 0002,
-- immutable): tenant_id + project_id scope columns (freeze A12: tenant_id
-- first, project second boundary), typed core columns, JSONB reserved for
-- extension metadata (freeze A2), optimistic-concurrency `version`. What the
-- foundation table does NOT have is a lifecycle: OFF-004 stored project
-- metadata only. The Project AGGREGATE of the canonical enterprise graph
-- (freeze A1) needs the same explicit, one-way active->archived transition
-- the organization table got in 0100:
--   * `status` TEXT with the closed vocabulary ('active' default for
--     pre-existing rows, 'archived' terminal);
--   * `archived_at` TIMESTAMPTZ recording WHEN the lifecycle event happened;
--   * a row-level CHECK keeping the pair consistent in the database itself —
--     archive is an explicit recorded transition, never a delete and never a
--     silent flag.
--
-- This is a pure additive ALTER: no existing column is touched, no data is
-- rewritten (PostgreSQL fast default), and 0002 stays byte-identical.
--
-- Numbering: OFF-007 owns versions 0100+ (0100 = organizations under
-- packages/domain/organization/migrations). The persistence foundation owns
-- 0001/0002 (immutable) and the OFF-005 event ledger owns 0003/0004 under
-- packages/events/migrations; a runtime composes the full canonical chain in
-- ascending version order (see the package README).

ALTER TABLE projects
    ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD CONSTRAINT projects_lifecycle_consistency
        CHECK ((status = 'active' AND archived_at IS NULL)
            OR (status = 'archived' AND archived_at IS NOT NULL));
