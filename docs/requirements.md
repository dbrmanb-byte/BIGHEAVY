# Data Sweeping App — Requirements

A "sweep" is a scheduled or operator-triggered pass over a data source that
enumerates records, decides on each one, and optionally acts on it. This app
supports three sweep modes over one shared engine:

| Mode | Purpose | Acts on |
|---|---|---|
| **A. `collect`** | Harvest data from external sources into a store | Destination store |
| **B. `erase`** | Find and destroy data (DSAR deletion, retention purge, media wipe) | Source of record |
| **C. `cleanse`** | Dedupe, normalize and repair records in place | Source of record |

Modes B and C mutate systems of record and are therefore **destructive by
default**. Every requirement marked **[SAFETY]** is non-negotiable for those
modes.

## Assumptions

These are stated so they can be corrected, not because they have been confirmed:

1. **Volume**: engine targets 10^6–10^8 records per sweep. Single-process,
   in-memory sweeps are out of scope; everything is queue-backed and resumable.
2. **Sources are heterogeneous** — SaaS APIs, relational DBs, object stores,
   document stores. No source-specific logic lives in the engine.
3. **Multi-tenant is not required** in v1, but the data model carries an
   `owner` on specs so it can be added without migration pain.
4. **Deployment** is a container platform with a managed Postgres and a
   managed queue. No on-prem/air-gapped requirement.

Open questions are listed at the end; none of them block the work below.

---

## 1. Shared core

### 1.1 Sweep specification

- **R1.1.1** A sweep is defined declaratively (see `docs/sweep-spec.schema.json`),
  not in code. The spec names the source, scope, limits, action, schedule and
  safety policy.
- **R1.1.2** Specs are **immutably versioned**. Editing a spec creates a new
  version; prior versions remain readable forever because runs reference them.
- **R1.1.3** Every run records the exact `(spec_id, spec_version)` that produced
  it. It must always be possible to answer "what rule deleted this record?"
- **R1.1.4** Spec validation runs at save time and again at execution start —
  a spec whose referenced connector, parser version or credential no longer
  exists must fail before the first record is touched, not midway.

### 1.2 Connectors

- **R1.2.1** A connector implements a narrow interface: `enumerate(cursor) ->
  (records, next_cursor)`, `read(id)`, `apply(mutation)`, `capabilities()`.
  Modes are engine-level; connectors only declare what they support.
- **R1.2.2** `capabilities()` declares support for incremental enumeration,
  hard delete, soft delete, field-level update, and transactional batches. The
  engine refuses a spec the connector cannot honour (e.g. an `erase` spec with
  `method: hard_delete` against a read-only connector).
- **R1.2.3** Credentials are referenced by URI (`vault://path#key`), never
  inlined in a spec or environment. Rotation must not require a spec edit.
- **R1.2.4** Connectors are rate-limit aware: a per-source token bucket, honoured
  across all concurrent workers, with exponential backoff plus jitter on 429/503
  and respect for `Retry-After`.

### 1.3 Scope and enumeration

- **R1.3.1** Two strategies: `full` (enumerate everything in scope) and
  `incremental` (enumerate what changed since a watermark — `updated_at`,
  change feed, CDC log, or content hash).
- **R1.3.2** Watermarks are stored per `(spec_id, partition)` and only advanced
  after the corresponding batch is durably committed. A crash must re-process,
  never skip.
- **R1.3.3** Enumeration is partitionable (by key range, tenant, date bucket) so
  a large sweep fans out across workers.
- **R1.3.4** Filters in the spec are evaluated **server-side at the source where
  the connector supports it**, and only otherwise in the engine. A retention
  purge must not stream 100M rows to filter 900 of them.

### 1.4 Execution engine

- **R1.4.1** Runs execute on a worker pool fed by a durable queue. Nothing
  long-running happens inside an API request.
- **R1.4.2** **Checkpointing**: a killed, evicted or redeployed worker resumes
  from the last checkpoint rather than restarting the sweep.
- **R1.4.3** **Idempotency**: every mutation carries a deterministic key
  (`run_id + source_record_id + action_hash`). Replaying a batch must not
  double-apply. The engine records applied keys and skips duplicates.
- **R1.4.4** Configurable concurrency, batch size and global rate limit, all
  adjustable **while a run is in flight** without restarting it.
- **R1.4.5** Per-record failures go to a dead-letter queue with the payload,
  error and attempt count. A run does not die on a bad record; it dies on a
  DLQ rate exceeding a configured threshold (default 5%).
- **R1.4.6** DLQ entries are individually replayable after the run completes.

### 1.5 Safety **[SAFETY]**

- **R1.5.1** **Dry-run is mandatory before any live run** of a spec version.
  A live run whose `(spec_id, spec_version)` has no successful dry-run within
  the configured freshness window is rejected.
- **R1.5.2** A dry-run produces a **complete, inspectable preview**: for each
  matched record, the before-state and the exact mutation that would be applied.
  Sampling is not acceptable for `erase`.
- **R1.5.3** **Blast-radius caps**: `max_records_matched` and `max_mutations`
  are required fields on destructive specs. Exceeding either aborts the run and
  raises an alert — it does not truncate and continue silently.
- **R1.5.4** **Divergence check**: if a live run's match count differs from its
  approved dry-run by more than a configured tolerance (default 10%), the run
  pauses for re-approval.
- **R1.5.5** **Kill switch**: any in-flight run can be cancelled; workers check
  for cancellation between batches and stop cleanly at a checkpoint.
- **R1.5.6** **Rollback**: `cleanse` runs must be reversible from the recorded
  before-state. `erase` runs are by definition not reversible — which is why
  they require approval and verification instead.
- **R1.5.7** Destructive live runs require **two distinct approvers** (the
  initiator cannot self-approve). Approvals are bound to a specific dry-run
  result, and are void if the spec version changes.

### 1.6 Audit and observability

- **R1.6.1** Every run writes an immutable record: spec id and version, mode,
  dry-run flag, initiator, approvers, start/end, terminal state, and counters
  (`scanned`, `matched`, `acted`, `skipped`, `failed`).
- **R1.6.2** Every record touched writes a `record_event` with the decision,
  before-state, after-state and idempotency key. This is the evidence trail;
  it is append-only and has its own retention policy (default 7 years).
- **R1.6.3** Audit storage is **write-once** at the application layer —
  no update or delete paths exist in code, enforced by DB grants.
- **R1.6.4** Metrics: run duration, throughput, match rate, DLQ rate, source
  error rate, queue depth, checkpoint lag. Alerts on run failure, DLQ threshold
  breach, anomalous match rate, and stalled runs.
- **R1.6.5** Logs redact PII by field classification. Before/after states in
  `record_event` are stored encrypted and are access-controlled separately from
  ordinary run metadata.

### 1.7 Control surface

- **R1.7.1** API: create/version a spec, validate, trigger dry-run, request
  approval, trigger live run, cancel, list runs, fetch run detail, export audit,
  replay DLQ.
- **R1.7.2** UI: run history with counters, side-by-side dry-run diff viewer,
  approval workflow, DLQ triage, and per-record search across the audit trail.
- **R1.7.3** Schedules: cron with timezone, overlap policy (`skip`, `queue`,
  `cancel_previous`), and catch-up behaviour after downtime.

### 1.8 Security and compliance

- **R1.8.1** RBAC with at minimum: `viewer`, `author` (writes specs, runs
  dry-runs), `operator` (triggers live runs), `approver`, `admin`. Author and
  approver are separable roles — that separation is what makes R1.5.7 real.
- **R1.8.2** TLS in transit; encryption at rest for the database and object
  storage. Before/after payloads encrypted with a separate key.
- **R1.8.3** Data classification on connector fields (public / internal / PII /
  sensitive-PII) drives redaction, encryption and access control.
- **R1.8.4** Legal-hold registry: a record under hold is excluded from `erase`
  and flagged rather than skipped silently.

### 1.9 Testing

- **R1.9.1** A fake connector with a seedable dataset for engine tests.
- **R1.9.2** Golden fixtures per parser and per matching rule; changes must be
  diffed against them in CI.
- **R1.9.3** Fault injection: source timeouts, partial batch failure, worker
  kill mid-batch, duplicate delivery. Resumability and idempotency are tested,
  not assumed.
- **R1.9.4** A staging source that mirrors production schema. No spec reaches a
  production live run without a staging dry-run.

---

## 2. Mode A — `collect`

Harvest from external sources into a destination store.

- **A1** **Raw landing zone**: the unparsed source payload is persisted before
  parsing, addressed by content hash. Parser bugs must be fixable by reparsing,
  not by re-crawling.
- **A2** **Parser versioning**: every parsed record records the parser name and
  version that produced it, enabling backfill after a parser fix.
- **A3** **Change detection** by content hash — unchanged payloads skip the
  parse and write path entirely.
- **A4** **Dedupe / entity resolution** on a declared natural key, with a
  conflict policy (`first_wins`, `last_wins`, `merge`).
- **A5** **Politeness and legality for web sources**: robots.txt honoured,
  per-host crawl delay, identifying User-Agent, and an allowlist of hosts. A
  spec targeting a host not on the allowlist is rejected. ToS review is a
  documented gate on adding a host, not a runtime check.
- **A6** **Proxy/egress pool** with per-host stickiness, only where the source's
  terms permit it.
- **A7** **Schema contract** on the destination: incoming records validated
  against a versioned schema; violations to DLQ, not to the table.
- **A8** Backfill mode: re-run a parser version over the landing zone without
  touching the source.

## 3. Mode B — `erase` **[SAFETY throughout]**

Destroy data: subject-access deletion, retention purge, or media sanitisation.

- **B1** **Two-phase**: a *discovery* run enumerates and reports everything
  matching the subject/criteria across all registered systems. A *destruction*
  run acts only on an approved discovery result set. These are separate runs
  with separate approvals.
- **B2** **Data map**: a registry of every system that may hold subject data,
  each with an owner and a connector. Discovery covers the whole registry; a
  system with no connector is reported as **manually actionable**, never
  silently omitted. Coverage gaps are visible in the certificate.
- **B3** **Methods**: `hard_delete`, `crypto_shred` (destroy the key, retain the
  ciphertext), `anonymise` (irreversibly strip identifiers, retain aggregates).
  The method is per-system, since not every store supports hard delete.
- **B4** **Propagation** to replicas, read caches, search indexes, analytics
  warehouses, and **backups**. Backups are the common failure: either the
  backup is rewritten, or the deletion is queued against backup restores and
  the retention window is documented so the data provably ages out.
- **B5** **Legal hold and regulatory retention** override deletion. Excluded
  records are enumerated with the reason on the certificate.
- **B6** **Verification pass**: after destruction, an independent read-back
  confirms the data is gone from each system. Verification is a distinct code
  path from deletion, so a broken delete cannot self-certify.
- **B7** **Certificate of destruction**: per subject or per purge batch —
  systems covered, method used, record counts, exclusions with reasons,
  verification results, timestamps, approvers. Signed and immutable.
- **B8** **Deadline tracking** for statutory response windows (GDPR Art. 17 —
  one month, extendable; CCPA — 45 days). Alert before breach.
- **B9** For physical media sanitisation, align with **NIST SP 800-88** —
  clear / purge / destroy selected by media type and data classification, with
  the verification and certificate requirements above.
- **B10** The audit trail of an erasure must itself survive the erasure: it
  records *that* a record was destroyed and its identifier hash, never a copy
  of the destroyed content.

**Third-party targets.** When the systems holding the data are *not yours* —
data brokers, people-search sites — you have no delete connector and your
leverage is legal rather than technical. That variant, including what an agent
can and cannot automate, is specified in [`docs/broker-removal.md`](broker-removal.md).

## 4. Mode C — `cleanse`

Dedupe, normalise and repair records in place.

- **C1** **Rule library**: normalisation (casing, whitespace, phone/address/date
  formats), validation, enrichment, and merge. Rules are versioned and
  individually toggleable.
- **C2** **Blocking + scoring** for dedupe: blocking keys to make comparison
  tractable at volume, then a scored comparison per candidate pair.
- **C3** **Two thresholds**: `auto_merge_above` and `review_below`. The band
  between them goes to a human review queue. A single threshold is a bug.
- **C4** **Survivorship rules** per field for merges (most recent, most
  complete, highest-trust source, longest value), with the losing values
  retained in the audit record.
- **C5** **Review queue** with side-by-side comparison, accept/reject/defer, and
  reviewer attribution. Reviewer decisions feed back as labelled training data
  for threshold tuning.
- **C6** **Per-record undo** and whole-run rollback from the recorded
  before-state, bounded by a configurable window.
- **C7** **Quality metrics** before/after each run: completeness, validity,
  duplicate rate, so the sweep's effect is measurable rather than asserted.
- **C8** **Golden dataset** with known-correct labels; every rule or threshold
  change reports precision/recall against it before it can be activated.

---

## 5. Reference architecture

```
   API + UI  ──►  Postgres  ◄──  Workers  ──►  Connectors ──► sources
      │           (specs, runs,      │
      │            events, DLQ)      │
      └──────►  Queue  ──────────────┘
                                Object store (landing zone, exports)
                                Vault (credentials)
```

Nothing exotic is required. The cost of this system is in the audit trail,
dry-run fidelity and resumability — not in the runtime.

- **Postgres** — specs, runs, checkpoints, record events, DLQ, approvals,
  review tasks, certificates. Partition `record_event` by month.
- **Queue** — SQS/Redis Streams/RabbitMQ. Needs visibility timeouts and DLQ.
- **Workers** — horizontally scaled, stateless, resumable from checkpoints.
- **Object store** — raw landing zone (mode A), audit exports, certificates.
- **Vault** — connector credentials, and the shred keys for mode B.

Data model: `docs/data-model.sql`. Spec format: `docs/sweep-spec.schema.json`.
Worked examples for each mode: `examples/specs/`.

---

## 6. Phasing

1. **Engine core** — spec storage/versioning, queue, workers, checkpointing,
   idempotency, DLQ, audit tables, fake connector, fault-injection tests.
2. **Mode C** first. It is destructive but reversible, so it exercises the
   safety machinery (dry-run, diff, approval, rollback) where mistakes are
   recoverable.
3. **Mode A** — landing zone, parser versioning, politeness controls.
4. **Mode B** last, on proven safety machinery: data map, discovery/destruction
   split, propagation, verification, certificates.

Building B first on unproven dry-run and audit code is the single highest-risk
sequencing choice available here.

---

## 7. Open questions

1. **Sources and volumes** — which systems, how many records each, and read/write
   API limits? This sets partitioning and the rate-limit budget.
2. **Mode B scope** — DSAR-driven (per subject, ad hoc, deadline-bound) or
   retention-driven (bulk, scheduled)? Both are supported, but they have very
   different UX and SLA needs.
3. **Backup deletion posture** — rewrite backups, or queue deletions against
   restores? This is a legal/ops decision, not an engineering one.
4. **Regulatory regimes** in scope (GDPR, CCPA, HIPAA, sector-specific) — drives
   deadlines, certificate content and retention floors.
5. **Approver population** — is there a second human available for R1.5.7, or
   does the two-person rule need a documented break-glass path?
6. **Multi-tenancy** — single org, or per-customer isolation?
