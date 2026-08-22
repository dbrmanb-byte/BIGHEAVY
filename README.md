# BIGHEAVY

Requirements for a **data sweeping** application — a scheduled or
operator-triggered pass over a data source that enumerates records, decides on
each one, and optionally acts on it.

Three sweep modes share one engine:

- **`collect`** — harvest data from external sources into a store
- **`erase`** — find and destroy data (DSAR deletion, retention purge)
- **`cleanse`** — dedupe, normalise and repair records in place

## Documents

| Path | What it is |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | Full requirements: shared core, then each mode. Assumptions and open questions at the ends. |
| [`docs/broker-removal.md`](docs/broker-removal.md) | Mode `erase` against third-party data brokers — what an agent can and cannot automate. |
| [`docs/data-model.sql`](docs/data-model.sql) | Postgres schema: specs, runs, checkpoints, audit trail, DLQ, approvals, certificates. |
| [`docs/sweep-spec.schema.json`](docs/sweep-spec.schema.json) | JSON Schema for a sweep spec. |
| [`examples/specs/`](examples/specs/) | A worked spec for each mode, validated against the schema. |

## Validating the example specs

```sh
pip install jsonschema
python3 - <<'PY'
import glob, json, jsonschema
v = jsonschema.Draft202012Validator(json.load(open('docs/sweep-spec.schema.json')))
for f in sorted(glob.glob('examples/specs/*.json')):
    v.validate(json.load(open(f)))
    print(f, 'VALID')
PY
```

## Status

Requirements only — no implementation yet. Suggested build order is in
`docs/requirements.md` §6; open questions that shape it are in §7.
