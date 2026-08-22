-- SQLite mirror of docs/data-model.sql, used for local runs and tests.
-- Postgres remains the production target; the column set is kept in step with
-- the canonical DDL. Differences are confined to types and partitioning.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sweep_spec (
    spec_id     TEXT    NOT NULL,
    version     INTEGER NOT NULL,
    mode        TEXT    NOT NULL,
    owner       TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    body_hash   TEXT    NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT    NOT NULL,
    created_at  TEXT    NOT NULL,
    PRIMARY KEY (spec_id, version)
);

CREATE TABLE IF NOT EXISTS sweep_run (
    run_id          TEXT    PRIMARY KEY,
    spec_id         TEXT    NOT NULL,
    spec_version    INTEGER NOT NULL,
    spec_hash       TEXT    NOT NULL,
    mode            TEXT    NOT NULL,
    dry_run         INTEGER NOT NULL,
    based_on_run_id TEXT    REFERENCES sweep_run(run_id),
    state           TEXT    NOT NULL DEFAULT 'pending',
    initiated_by    TEXT    NOT NULL,
    trigger         TEXT    NOT NULL,
    cipher          TEXT    NOT NULL DEFAULT 'null',
    started_at      TEXT,
    finished_at     TEXT,
    cancel_requested_at TEXT,
    cancel_requested_by TEXT,
    counters        TEXT    NOT NULL DEFAULT '{}',
    error           TEXT,
    FOREIGN KEY (spec_id, spec_version) REFERENCES sweep_spec (spec_id, version)
);

CREATE INDEX IF NOT EXISTS sweep_run_spec_idx ON sweep_run (spec_id, started_at DESC);

CREATE TABLE IF NOT EXISTS sweep_checkpoint (
    run_id       TEXT    NOT NULL REFERENCES sweep_run(run_id),
    partition    TEXT    NOT NULL,
    cursor       TEXT    NOT NULL,
    records_done INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT    NOT NULL,
    PRIMARY KEY (run_id, partition)
);

CREATE TABLE IF NOT EXISTS sweep_watermark (
    spec_id     TEXT NOT NULL,
    partition   TEXT NOT NULL,
    watermark   TEXT NOT NULL,
    advanced_by TEXT REFERENCES sweep_run(run_id),
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (spec_id, partition)
);

CREATE TABLE IF NOT EXISTS record_event (
    event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT    NOT NULL REFERENCES sweep_run(run_id),
    system           TEXT    NOT NULL,
    source_record_id TEXT    NOT NULL,
    decision         TEXT    NOT NULL,
    reason           TEXT,
    action           TEXT    NOT NULL,
    applied          INTEGER NOT NULL,
    before           BLOB,
    after            BLOB,
    idempotency_key  TEXT    NOT NULL,
    occurred_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS record_event_run_idx ON record_event (run_id);
CREATE INDEX IF NOT EXISTS record_event_record_idx
    ON record_event (system, source_record_id, occurred_at DESC);

-- Idempotency ledger (R1.4.3). Separate from record_event because
-- record_event is append-only evidence, while a mutation intent has to be
-- reserved before the mutation and confirmed after it.
CREATE TABLE IF NOT EXISTS applied_mutation (
    idempotency_key TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES sweep_run(run_id),
    state           TEXT NOT NULL CHECK (state IN ('reserved', 'applied')),
    reserved_at     TEXT NOT NULL,
    applied_at      TEXT
);

CREATE TABLE IF NOT EXISTS dead_letter (
    dlq_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT    NOT NULL REFERENCES sweep_run(run_id),
    source_record_id TEXT,
    payload          TEXT,
    error            TEXT    NOT NULL,
    error_class      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 1,
    first_seen_at    TEXT    NOT NULL,
    last_attempt_at  TEXT    NOT NULL,
    replayed_run_id  TEXT    REFERENCES sweep_run(run_id),
    resolved_at      TEXT
);

CREATE INDEX IF NOT EXISTS dead_letter_run_idx ON dead_letter (run_id);

CREATE TABLE IF NOT EXISTS approval (
    approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES sweep_run(run_id),
    spec_hash   TEXT NOT NULL,
    approver    TEXT NOT NULL,
    decision    TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    comment     TEXT,
    decided_at  TEXT NOT NULL,
    UNIQUE (run_id, approver)
);

CREATE TABLE IF NOT EXISTS review_task (
    task_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL REFERENCES sweep_run(run_id),
    rule_id     TEXT NOT NULL,
    score       REAL,
    candidates  TEXT NOT NULL,
    proposal    TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'accepted', 'rejected', 'deferred')),
    reviewer    TEXT,
    reviewed_at TEXT,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS review_task_open_idx ON review_task (run_id, state);

-- Mode A: content-hash index for change detection (A3).
CREATE TABLE IF NOT EXISTS content_seen (
    system           TEXT NOT NULL,
    source_record_id TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    landing_ref      TEXT,
    parser_version   TEXT,
    last_seen_at     TEXT NOT NULL,
    PRIMARY KEY (system, source_record_id)
);
