-- Data sweeping app — core schema (PostgreSQL 15+)
-- Audit tables (sweep_run, record_event, erasure_certificate) are append-only.
-- Enforce that with grants, not just convention:
--   REVOKE UPDATE, DELETE ON record_event, erasure_certificate FROM app_rw;

CREATE TYPE sweep_mode    AS ENUM ('collect', 'erase', 'cleanse');
CREATE TYPE run_state     AS ENUM ('pending','approved','running','paused',
                                   'cancelled','succeeded','failed','aborted');
CREATE TYPE record_action AS ENUM ('insert','update','delete','anonymise',
                                   'crypto_shred','merge','skip','none');

-- ---------------------------------------------------------------- specs

-- Immutably versioned. Editing inserts a new row; nothing is ever updated
-- except `active`, because runs reference (spec_id, version) forever.
CREATE TABLE sweep_spec (
    spec_id     text        NOT NULL,
    version     integer     NOT NULL,
    mode        sweep_mode  NOT NULL,
    owner       text        NOT NULL,
    body        jsonb       NOT NULL,   -- validated against sweep-spec.schema.json
    body_hash   text        NOT NULL,   -- sha256 of canonicalised body
    active      boolean     NOT NULL DEFAULT true,
    created_by  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (spec_id, version)
);

-- ---------------------------------------------------------------- runs

CREATE TABLE sweep_run (
    run_id          uuid        PRIMARY KEY,
    spec_id         text        NOT NULL,
    spec_version    integer     NOT NULL,
    -- the spec body hash at execution time: approvals are void if it changes
    spec_hash       text        NOT NULL,
    mode            sweep_mode  NOT NULL,
    dry_run         boolean     NOT NULL,
    -- a live destructive run must cite the dry-run it was approved against (R1.5.1)
    based_on_run_id uuid        REFERENCES sweep_run(run_id),
    state           run_state   NOT NULL DEFAULT 'pending',
    initiated_by    text        NOT NULL,
    trigger         text        NOT NULL,  -- 'manual' | 'schedule' | 'api'
    -- which cipher sealed this run's before/after payloads; 'null' means the
    -- development cipher, which stores them in the clear (R1.6.5)
    cipher          text        NOT NULL DEFAULT 'null',
    started_at      timestamptz,
    finished_at     timestamptz,
    cancel_requested_at timestamptz,
    cancel_requested_by text,
    -- {scanned, matched, acted, skipped, failed}
    counters        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    error           text,
    FOREIGN KEY (spec_id, spec_version) REFERENCES sweep_spec (spec_id, version)
);

CREATE INDEX sweep_run_spec_idx  ON sweep_run (spec_id, started_at DESC);
CREATE INDEX sweep_run_state_idx ON sweep_run (state) WHERE state IN ('running','paused');

-- Resumability (R1.4.2). One row per partition; cursor advances only after the
-- batch it covers is durably committed.
CREATE TABLE sweep_checkpoint (
    run_id      uuid        NOT NULL REFERENCES sweep_run(run_id),
    partition   text        NOT NULL,
    cursor      jsonb       NOT NULL,
    records_done bigint     NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, partition)
);

-- Incremental watermarks survive individual runs (R1.3.2).
CREATE TABLE sweep_watermark (
    spec_id     text        NOT NULL,
    partition   text        NOT NULL,
    watermark   jsonb       NOT NULL,
    advanced_by uuid        REFERENCES sweep_run(run_id),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (spec_id, partition)
);

-- ------------------------------------------------------- audit trail

-- The evidence trail. Append-only. Partition by month; `before`/`after` are
-- encrypted at the application layer and access-controlled separately (R1.6.5).
CREATE TABLE record_event (
    event_id         bigserial,
    run_id           uuid          NOT NULL REFERENCES sweep_run(run_id),
    system           text          NOT NULL,   -- which system the record lives in
    source_record_id text          NOT NULL,
    decision         text          NOT NULL,   -- 'match' | 'no_match' | 'excluded'
    reason           text,                     -- rule id, or exclusion reason
    action           record_action NOT NULL,
    applied          boolean       NOT NULL,   -- false on dry-runs
    before           bytea,
    after            bytea,
    -- run_id + source_record_id + action_hash (R1.4.3)
    idempotency_key  text          NOT NULL,
    occurred_at      timestamptz   NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE UNIQUE INDEX record_event_idem_idx ON record_event (idempotency_key, occurred_at);
CREATE INDEX record_event_run_idx    ON record_event (run_id, occurred_at);
CREATE INDEX record_event_record_idx ON record_event (system, source_record_id, occurred_at DESC);

-- Idempotency ledger (R1.4.3). Kept separate from record_event: that table is
-- append-only evidence, while a mutation intent must be reserved before the
-- mutation and confirmed after it, so a crash in between is visible as a
-- dangling reservation rather than a silent double-apply.
CREATE TABLE applied_mutation (
    idempotency_key text        PRIMARY KEY,
    run_id          uuid        NOT NULL REFERENCES sweep_run(run_id),
    state           text        NOT NULL CHECK (state IN ('reserved', 'applied')),
    reserved_at     timestamptz NOT NULL DEFAULT now(),
    applied_at      timestamptz
);

CREATE INDEX applied_mutation_run_idx ON applied_mutation (run_id);

-- Mode A change detection (A3): last content hash seen per source record, so
-- an unchanged payload costs one fetch and nothing else.
CREATE TABLE content_seen (
    system           text        NOT NULL,
    source_record_id text        NOT NULL,
    content_hash     text        NOT NULL,
    landing_ref      text,
    parser_version   text,
    last_seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system, source_record_id)
);

-- ---------------------------------------------------------------- DLQ

CREATE TABLE dead_letter (
    dlq_id           bigserial   PRIMARY KEY,
    run_id           uuid        NOT NULL REFERENCES sweep_run(run_id),
    source_record_id text,
    payload          jsonb,
    error            text        NOT NULL,
    error_class      text,
    attempts         integer     NOT NULL DEFAULT 1,
    first_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_attempt_at  timestamptz NOT NULL DEFAULT now(),
    replayed_run_id  uuid        REFERENCES sweep_run(run_id),
    resolved_at      timestamptz
);

CREATE INDEX dead_letter_open_idx ON dead_letter (run_id) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------- approvals

-- Two distinct approvers, neither of them the initiator (R1.5.7). The unique
-- constraint stops one person approving twice; the initiator check belongs in
-- application logic since it needs sweep_run.initiated_by.
CREATE TABLE approval (
    approval_id  bigserial   PRIMARY KEY,
    run_id       uuid        NOT NULL REFERENCES sweep_run(run_id),
    -- approval is void if the spec body changes underneath it
    spec_hash    text        NOT NULL,
    approver     text        NOT NULL,
    decision     text        NOT NULL CHECK (decision IN ('approve','reject')),
    comment      text,
    decided_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, approver)
);

-- ------------------------------------------------- mode C: review queue

CREATE TABLE review_task (
    task_id      bigserial   PRIMARY KEY,
    run_id       uuid        NOT NULL REFERENCES sweep_run(run_id),
    rule_id      text        NOT NULL,
    score        numeric(5,4),
    candidates   jsonb       NOT NULL,   -- record ids + the fields being compared
    proposal     jsonb       NOT NULL,   -- the merge/repair that would be applied
    state        text        NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','accepted','rejected','deferred')),
    reviewer     text,
    reviewed_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_task_open_idx ON review_task (run_id) WHERE state = 'open';

-- ------------------------------------------- mode B: data map + certificates

-- Every system that may hold subject data. A system with no connector is
-- reported as manually actionable, never silently omitted (B2).
CREATE TABLE data_map_system (
    system          text        PRIMARY KEY,
    owner           text        NOT NULL,
    connector       text,                    -- NULL => manual action required
    classification  text        NOT NULL,    -- 'pii' | 'sensitive_pii' | ...
    erase_method    record_action,           -- delete | anonymise | crypto_shred
    is_backup       boolean     NOT NULL DEFAULT false,
    retention_days  integer,                 -- for backups: when data ages out
    active          boolean     NOT NULL DEFAULT true
);

CREATE TABLE legal_hold (
    hold_id     bigserial   PRIMARY KEY,
    subject_ref text        NOT NULL,
    scope       jsonb,                       -- NULL/absent => all systems
    reason      text        NOT NULL,
    placed_by   text        NOT NULL,
    placed_at   timestamptz NOT NULL DEFAULT now(),
    released_at timestamptz
);

CREATE INDEX legal_hold_active_idx ON legal_hold (subject_ref) WHERE released_at IS NULL;

-- Issued after the verification pass. Immutable and signed (B7).
CREATE TABLE erasure_certificate (
    certificate_id  uuid        PRIMARY KEY,
    run_id          uuid        NOT NULL REFERENCES sweep_run(run_id),
    subject_ref     text,                    -- NULL for bulk retention purges
    systems         jsonb       NOT NULL,    -- [{system, method, count, verified}]
    exclusions      jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{system, reason, count}]
    verified_at     timestamptz NOT NULL,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    content_hash    text        NOT NULL,
    signature       text        NOT NULL
);

-- Statutory response deadlines (B8).
CREATE TABLE erasure_request (
    request_id   uuid        PRIMARY KEY,
    subject_ref  text        NOT NULL,
    regime       text        NOT NULL,       -- 'gdpr' | 'ccpa' | ...
    received_at  timestamptz NOT NULL,
    due_at       timestamptz NOT NULL,
    discovery_run_id   uuid  REFERENCES sweep_run(run_id),
    destruction_run_id uuid  REFERENCES sweep_run(run_id),
    certificate_id     uuid  REFERENCES erasure_certificate(certificate_id),
    closed_at    timestamptz
);

CREATE INDEX erasure_request_due_idx ON erasure_request (due_at) WHERE closed_at IS NULL;
