-- OFF-004 migration 0001 — tenant metadata table.
--
-- Schema conventions (freeze A2, A12):
--   * canonical id columns are TEXT primary keys carrying the full canonical
--     id string (office-tnt-v1-<opaque>) — never provider ids;
--   * typed columns for every core field (no JSON for core state);
--   * optimistic-concurrency `version` (BIGINT, monotonically increasing);
--   * created_at / updated_at TIMESTAMPTZ set by the executing runtime's
--     injected clock (repositories never read a wall clock themselves);
--   * CHECK constraints enforce row-level integrity in the database itself.
--
-- Migrations are immutable once applied and strictly forward-only; the
-- migrator records each applied version + checksum in schema_migrations.

CREATE TABLE tenants (
    tenant_id    TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (char_length(display_name) > 0),
    version      BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
);
