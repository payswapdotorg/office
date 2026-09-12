-- OFF-005 migration 0004 — transactional outbox + idempotent consumer cursor.
--
-- The outbox half of the atomic mutation contract (freeze A3 canonical flow:
-- "transaction persists state and an outbox event atomically"): a command's
-- state writes, its ledger append, and its outbox enqueue all execute inside
-- ONE TransactionRunner transaction, so the event is published if and only if
-- the state change committed. Delivery is at-least-once; consumers deduplicate
-- with the consumer cursor below.
--
-- Conventions (on top of 0003):
--   * `tenant_id` FIRST scope column; nullable `project_id` second scope
--     column (the enqueued event's scope), so dispatch can be scoped by
--     tenant or project (A12) exactly like every other read/write path;
--   * `event_id` references the immutable ledger row (relational integrity:
--     an outbox row cannot exist without its ledger event — the enqueue runs
--     in the SAME transaction as the append, so the FK is satisfied by the
--     uncommitted insert itself);
--   * outbox lifecycle is pending -> dispatched with retry bookkeeping
--     (`attempts`, `available_at` = next-attempt-at); every timestamp is
--     caller-supplied (envelope occurred-at / dispatcher policy clock) — no
--     wall-clock defaults;
--   * `outbox_id` is an insertion-ordered identity: dispatch drains rows in
--     commit order, which per aggregate equals ledger sequence order (the
--     counter row lock serializes same-aggregate appends until commit);
--   * the consumer cursor is keyed by (tenant, consumer name) tracking the
--     last consumed ledger sequence PER AGGREGATE — dense by the ledger's
--     counter/append invariant, which is what makes duplicate delivery
--     harmless: a re-delivered event's sequence is <= the cursor and is
--     skipped; a gap (sequence > cursor + 1) is a delivery fault that fails
--     closed rather than silently skipping events forever.

CREATE TABLE event_outbox (
    outbox_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      TEXT NOT NULL,
    project_id     TEXT,
    event_id       TEXT NOT NULL
        REFERENCES event_ledger (event_id),
    state          TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'dispatched')),
    attempts       BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at   TIMESTAMPTZ NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL,
    dispatched_at  TIMESTAMPTZ,
    CONSTRAINT event_outbox_event_id_shape
        CHECK (event_id LIKE 'office-evt-v1-%'),
    CONSTRAINT event_outbox_event_id_key
        UNIQUE (event_id)
);

-- The dispatcher's pending scan: tenant-scoped, pending, due (available_at
-- <= now), drained in insertion order.
CREATE INDEX event_outbox_dispatch_scan
    ON event_outbox (tenant_id, state, available_at, outbox_id);

CREATE TABLE consumer_cursors (
    tenant_id       TEXT NOT NULL,
    consumer_name   TEXT NOT NULL CHECK (char_length(consumer_name) > 0),
    aggregate_kind  TEXT NOT NULL CHECK (char_length(aggregate_kind) > 0),
    aggregate_id    TEXT NOT NULL CHECK (char_length(aggregate_id) > 0),
    last_sequence   BIGINT NOT NULL CHECK (last_sequence >= 1),
    updated_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, consumer_name, aggregate_kind, aggregate_id)
);
