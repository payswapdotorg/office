-- OFF-005 migration 0003 — event ledger (freeze A3).
--
-- The append-only ledger every consequential domain mutation records into
-- (A3: event name, tenant/project scope, actor, source, correlation/causation
-- ids, schema version, occurred-at, entity refs, payload). Conventions on top
-- of OFF-004's 0001/0002:
--   * `tenant_id` is the FIRST scope column on every table (A12); `project_id`
--     is the nullable second scope column on ledger rows (null when the event
--     is tenant-scoped);
--   * typed columns for every core scalar; JSONB only for the envelope's
--     structured sub-objects (`actor`, `entity_refs`) and the `payload` —
--     each decoded fail-closed on read through the @office/contracts parsers;
--   * NO wall-clock defaults: every timestamp comes from the envelope's
--     occurred-at, bound by the appending runtime's injected clock;
--   * no tenant FK, deliberately: the ledger is immutable history whose
--     lifetime exceeds entity lifecycle (a cascade would violate append-only
--     immutability; RESTRICT would block tenant archival). The tenant boundary
--     is enforced by scoped statements on every read/write path (A12), not by
--     relational cascade.
--
-- Determinism (A9-friendly): event ids are derived deterministically from the
-- ledger key (tenant, aggregate kind/id, sequence) by the package, and
-- sequence numbers are DENSE per (tenant, aggregate) — assigned from
-- event_sequences inside the appending transaction. The counter row and the
-- ledger row commit or vanish together, so replaying the same command
-- sequence reproduces the same ledger rows exactly.
--
-- Race safety: the counter upsert (`INSERT ... ON CONFLICT DO UPDATE`) takes
-- an exclusive row lock per (tenant, aggregate) held until commit, so
-- concurrent appends for the same aggregate serialize and receive strictly
-- monotonic sequences; the UNIQUE (tenant, aggregate, sequence) constraint is
-- the belt-and-suspenders net that makes sequence duplication impossible no
-- matter what wrote the rows.
--
-- Immutability is enforced IN THE DATABASE, not just in code: a trigger
-- rejects every UPDATE/DELETE on ledger rows — the append-only guarantee
-- (freeze A3 / anti-pattern "no destructive event mutation") survives even
-- hand-written SQL.

CREATE TABLE event_sequences (
    tenant_id       TEXT NOT NULL,
    aggregate_kind  TEXT NOT NULL CHECK (char_length(aggregate_kind) > 0),
    aggregate_id    TEXT NOT NULL CHECK (char_length(aggregate_id) > 0),
    last_sequence   BIGINT NOT NULL CHECK (last_sequence >= 0),
    PRIMARY KEY (tenant_id, aggregate_kind, aggregate_id)
);

CREATE TABLE event_ledger (
    tenant_id       TEXT NOT NULL,
    event_id        TEXT PRIMARY KEY,
    aggregate_kind  TEXT NOT NULL CHECK (char_length(aggregate_kind) > 0),
    aggregate_id    TEXT NOT NULL CHECK (char_length(aggregate_id) > 0),
    sequence        BIGINT NOT NULL CHECK (sequence >= 1),
    event_name      TEXT NOT NULL CHECK (char_length(event_name) > 0),
    project_id      TEXT,
    actor           JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
    source          TEXT NOT NULL CHECK (source IN ('domain', 'adapter', 'system')),
    correlation_id  TEXT NOT NULL CHECK (char_length(correlation_id) > 0),
    causation_id    TEXT,
    schema_version  TEXT NOT NULL CHECK (char_length(schema_version) > 0),
    occurred_at     TIMESTAMPTZ NOT NULL,
    entity_refs     JSONB NOT NULL CHECK (jsonb_typeof(entity_refs) = 'object'),
    payload         JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT event_ledger_aggregate_sequence_key
        UNIQUE (tenant_id, aggregate_kind, aggregate_id, sequence),
    CONSTRAINT event_ledger_event_id_shape
        CHECK (event_id LIKE 'office-evt-v1-%')
);

-- Dispatch/replay access paths: tenant-wide chronological order (stable under
-- replay: occurred_at comes from envelopes, event_id is derived), and causal
-- chain lookup by correlation id (OFF-013 consumes this).
CREATE INDEX event_ledger_tenant_occurred_at
    ON event_ledger (tenant_id, occurred_at, event_id);
CREATE INDEX event_ledger_tenant_correlation
    ON event_ledger (tenant_id, correlation_id);

-- Append-only guard: no UPDATE, no DELETE, ever — not from the package, not
-- from anything else. The aggregate-sequence UNIQUE key doubles as the
-- per-aggregate ordered scan index.
CREATE FUNCTION event_ledger_append_only_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'event_ledger is append-only and immutable (freeze A3): % is prohibited',
        TG_OP
        USING ERRCODE = 'P0001';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_ledger_append_only
    BEFORE UPDATE OR DELETE ON event_ledger
    FOR EACH ROW
    EXECUTE FUNCTION event_ledger_append_only_guard();
