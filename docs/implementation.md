# Implementation notes — modes A and C

The engine and both non-destructive modes are built. This is what exists, how
to run it, and where the code knowingly departs from the requirements.

## What is built

| Requirement area | Where |
|---|---|
| Spec validation, immutable versioning, canonical hashing (R1.1) | `sweeper/spec.py`, `sweeper/store.py` |
| Connector interface, registry, capability checks (R1.2) | `sweeper/connectors/` |
| Partitioning, watermarks, filter pushdown (R1.3) | `sweeper/engine.py`, per-connector |
| Queue-free worker pool, checkpointing, idempotency, DLQ (R1.4) | `sweeper/engine.py`, `sweeper/store.py` |
| Dry-run gate, blast-radius caps, divergence, kill switch, approvals (R1.5) | `Engine.preflight`, `RunContext` |
| Audit trail, counters, run states (R1.6) | `sweeper/store.py`, `record_event` |
| CLI control surface (R1.7) | `sweeper/cli.py` |
| Vault-referenced credentials (R1.8) | `sweeper/secrets.py` |
| Fake connector, fault injection, golden fixtures (R1.9) | `sweeper/connectors/memory.py`, `tests/` |
| Mode A: landing zone, parser versioning, change detection, schema contract, dedupe, politeness | `sweeper/collect/` |
| Mode C: rule library, blocking + scoring, review queue, survivorship, rollback | `sweeper/cleanse/`, `sweeper/rollback.py` |

Mode B (`erase`) is **not** built. A spec with `mode: erase` validates against
the schema and is then rejected by name — `ModeNotImplemented` — rather than
silently doing nothing. See `docs/broker-removal.md` for what it needs.

## Running it

```sh
pip install -e ".[dev]"
python -m pytest                     # 93 tests
python -m sweeper registry           # connectors, parsers, rules
```

End-to-end, mode A (offline, against `examples/demo/pages`):

```sh
python -m sweeper --db build/state.db dry-run examples/demo/collect-listings.json --actor alice
python -m sweeper --db build/state.db apply  examples/demo/collect-listings.json \
    --based-on <dry-run-id> --actor alice
```

End-to-end, mode C (seeded SQLite CRM, one approval required):

```sh
python examples/demo/seed.py
python -m sweeper --db build/state.db dry-run examples/demo/cleanse-contacts.json --actor alice
python -m sweeper --db build/state.db approve <dry-run-id> --approver bob
python -m sweeper --db build/state.db apply examples/demo/cleanse-contacts.json \
    --based-on <dry-run-id> --actor alice
python -m sweeper --db build/state.db review --run-id <live-run-id>
python -m sweeper --db build/state.db rollback <live-run-id> --actor carol
```

The demo cleanse run exercises every interesting path: six records normalised,
one high-confidence pair auto-merged, one uncertain pair parked in the review
queue, and a rollback that restores all seven rows to their seeded state
including re-inserting the record the merge deleted.

## Deliberate departures

Each of these is a considered trade, not an oversight. They are the things to
argue with first.

1. **SQLite, not Postgres.** `docs/data-model.sql` remains the production
   target; `sweeper/schema_sqlite.sql` mirrors it column-for-column, and all
   SQL is confined to `sweeper/store.py` so the swap is one file. Partitioning
   of `record_event` exists only in the Postgres DDL.

2. **Delivery is at-least-once, not exactly-once.** The checkpoint advances
   only after a whole batch is accounted for, so a worker that dies mid-batch
   causes that batch to be re-processed on resume. That is the safe direction
   (R1.3.2 says re-process, never skip), and the idempotency ledger is what
   makes it harmless. A test asserts the re-processing explicitly rather than
   pretending it does not happen.

3. **The divergence guard is one-sided during the run.** Over-application is
   caught while it is happening and aborts the run (R1.5.4). Under-application
   can only be reported at the end, because detecting it earlier would need a
   full plan-only pre-pass that doubles every source read. Over-application is
   the dangerous direction; the asymmetry is intentional and the under-count
   case is surfaced as a run note.

4. **`NullCipher` is the default.** Before/after payloads are stored in the
   clear in development. Hand-rolling a cipher in the one system whose value
   is trustworthy audit evidence would be a bad trade, so `sweeper/crypto.py`
   defines the interface and leaves the implementation to a KMS-backed class.
   The run record stores which cipher was used, so an unencrypted run is
   visible rather than assumed.

5. **The dedupe index is in memory.** `Matcher` holds only the comparator
   fields per record, and stops indexing at `max_index_records` — at which
   point it *says so* in the run notes rather than reporting a partial pass as
   complete. Past that scale, blocking belongs in the source or a dedicated
   index; the interface does not change.

6. **No queue broker.** Concurrency is a thread pool per batch. The engine's
   contract — resumable from checkpoints, idempotent mutations — is what a
   queue-backed worker needs anyway, so moving to SQS or Redis Streams is a
   change of driver, not of design.

7. **Infrastructure failures are not dead-lettered.** `RecordError` routes one
   record to the DLQ; `InfrastructureError` ends the run. Dead-lettering a lost
   worker would record thousands of perfectly good records as bad data.

8. **Mode A writes one row set per source record.** The destination connector
   declares `transactional_batch`, but the collect pipeline upserts per record
   for uniformity with the engine's per-record commit path. Batching that write
   is the obvious next optimisation.

## Test coverage of the hard parts

Requirements that are easy to claim and hard to hold get explicit tests:

- worker killed mid-batch, then resumed — no record skipped (`test_engine.py`)
- the same mutation delivered twice — applied once (`test_engine.py`)
- a failed apply releases its reservation and stays retryable
- initiator self-approval refused; a rejection blocks the run; a stale or
  modified dry run cannot authorise a live one
- blast-radius caps abort rather than truncate
- DLQ *rate* threshold aborts; a single bad record does not
- robots.txt disallow, empty host allowlist, and per-host crawl delay
- an uncertain match pair reaches the review queue instead of being merged
- rollback restores updates and re-inserts deletes, and refuses a dry run
