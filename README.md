# BIGHEAVY

A **data sweeping** engine — a scheduled or operator-triggered pass over a data
source that enumerates records, decides on each one, and optionally acts on it.

Three sweep modes share one engine:

| Mode | Purpose | Status |
|---|---|---|
| **`collect`** | Harvest data from external sources into a store | **built** |
| **`cleanse`** | Dedupe, normalise and repair records in place | **built** |
| **`erase`** | Find and destroy data (DSAR deletion, retention purge) | specified only |

An `erase` spec validates against the schema and is then rejected by name
rather than silently doing nothing.

## Quick start

```sh
pip install -e ".[dev]"
python -m pytest                  # 118 tests
python -m sweeper registry        # connectors, parsers, rules
```

Run a cleanse sweep end to end — dry run, approval, apply, review, roll back:

```sh
python examples/demo/seed.py
python -m sweeper --db build/state.db dry-run examples/demo/cleanse-contacts.json --actor alice
python -m sweeper --db build/state.db approve <dry-run-id> --approver bob
python -m sweeper --db build/state.db apply examples/demo/cleanse-contacts.json \
    --based-on <dry-run-id> --actor alice
python -m sweeper --db build/state.db review --run-id <live-run-id>
python -m sweeper --db build/state.db rollback <live-run-id> --actor carol
```

The live run is refused unless a fresh dry run of the *same spec body* was
approved by someone other than the person running it.

## Layout

| Path | What it is |
|---|---|
| `sweeper/engine.py` | Safety gates, batching, checkpointing, idempotency, audit |
| `sweeper/collect/` | Mode A: landing zone, versioned parsers, schema contract, dedupe |
| `sweeper/cleanse/` | Mode C: rule library, blocking and scoring, survivorship |
| `sweeper/connectors/` | Source and destination adapters + capability declarations |
| `sweeper/rollback.py` | Reverses a cleanse run from its audit trail |
| `sweeper/cli.py` | Control surface |
| `schemas/` | Destination contracts for mode A |
| `examples/demo/` | Runnable specs and fixtures (offline) |
| `examples/specs/` | Production-shaped specs, including the CA broker-registry ingest |

## Documents

| Path | What it is |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | Full requirements: shared core, then each mode. Assumptions and open questions at the ends. |
| [`docs/implementation.md`](docs/implementation.md) | What is built, how to run it, and every deliberate departure from the requirements. |
| [`docs/broker-removal.md`](docs/broker-removal.md) | Mode `erase` against third-party data brokers — what an agent can and cannot automate. |
| [`docs/data-model.sql`](docs/data-model.sql) | Postgres schema (production target). `sweeper/schema_sqlite.sql` mirrors it. |
| [`docs/sweep-spec.schema.json`](docs/sweep-spec.schema.json) | JSON Schema for a sweep spec. |

## Design in one paragraph

The engine owns everything that must be true of *every* sweep: a spec is
immutably versioned and hashed; a live run cannot start without a fresh,
approved dry run of that exact spec body; every record touched writes an
append-only audit event with its before-state; every mutation is reserved in an
idempotency ledger before it is applied and confirmed after; checkpoints
advance only after a whole batch is accounted for, so a dead worker re-processes
rather than skips; and blast-radius caps abort the run instead of truncating it.
Pipelines decide what a record *means*. The engine decides whether the run is
allowed to touch it, whether it already has, and what gets written down either
way.
