"""Registry ingest: the target list every removal workflow depends on.

The registry column names are not a published contract, so these tests pin the
behaviour that matters when they change — tolerance where a rename is
survivable, a loud failure where it is not.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sweeper.collect.parsers import ParseError, get_parser, normalise_header
from sweeper.spec import Spec

REPO = Path(__file__).resolve().parent.parent
PARSER = get_parser("ca-data-broker-registry", "1.0.0")

SAMPLE = (
    b"Data Broker Name,Registration Number,Website,Opt-Out URL,Data of Minors,Unmapped Column\n"
    b"Acme Data LLC,DB-1001,https://acme.test,https://acme.test/opt-out,Yes,alpha\n"
    b"  Beacon Analytics , DB-1002 ,https://beacon.test,,No,beta\n"
)


def test_canonical_fields_are_mapped():
    rows = PARSER(SAMPLE, {"registry": "ca", "registry_year": "2026"})
    assert len(rows) == 2
    first = rows[0]
    assert first["broker_name"] == "Acme Data LLC"
    assert first["registration_id"] == "DB-1001"
    assert first["website_url"] == "https://acme.test"
    assert first["opt_out_url"] == "https://acme.test/opt-out"
    assert first["collects_minors_data"] is True
    assert first["registry"] == "ca" and first["registry_year"] == "2026"


def test_values_are_trimmed_and_rows_numbered():
    rows = PARSER(SAMPLE, {})
    assert rows[1]["broker_name"] == "Beacon Analytics"
    assert rows[1]["registration_id"] == "DB-1002"
    assert [r["_row_number"] for r in rows] == [2, 3]


def test_unmapped_columns_are_preserved_not_dropped():
    """A registry adding a column must not lose data silently."""
    rows = PARSER(SAMPLE, {})
    assert rows[0]["extra"] == {"unmapped_column": "alpha"}


@pytest.mark.parametrize(
    "header",
    ["Data Broker Name", "data broker name", "  BUSINESS NAME  ", "Company Name", "Legal Name"],
)
def test_name_column_spellings_all_resolve(header):
    rows = PARSER(f"{header}\nAcme\n".encode(), {})
    assert rows[0]["broker_name"] == "Acme"


def test_missing_name_column_fails_loudly_and_names_the_headers():
    """The one failure worth killing the ingest for — and it must be diagnosable."""
    with pytest.raises(ParseError) as exc:
        PARSER(b"Foo,Bar\n1,2\n", {})
    assert "no recognisable broker-name column" in str(exc.value)
    assert "'Foo'" in str(exc.value) and "'Bar'" in str(exc.value)


def test_a_nameless_row_is_kept_for_row_level_rejection():
    """One bad row must not take the registry down; the contract rejects it."""
    rows = PARSER(b"Data Broker Name,Registration Number\n,DB-9\nReal Co,DB-10\n", {})
    assert len(rows) == 2
    assert "broker_name" not in rows[0]
    assert rows[0]["broker_key"] == "DB-9"


def test_broker_key_falls_back_to_a_name_slug():
    rows = PARSER(b"Data Broker Name,Registration Number\nUnregistered Slug Inc,\n", {})
    assert rows[0]["broker_key"] == "unregistered-slug-inc"


def test_unparseable_flag_value_is_kept_as_text_rather_than_guessed():
    rows = PARSER(b"Data Broker Name,Data of Minors\nAcme,sometimes\n", {})
    assert "collects_minors_data" not in rows[0]
    assert rows[0]["extra"] == {"data_of_minors": "sometimes"}


def test_empty_and_headerless_payloads_fail():
    with pytest.raises(ParseError, match="empty CSV"):
        PARSER(b"   ", {})
    with pytest.raises(ParseError, match="no rows"):
        PARSER(b"Data Broker Name\n", {})


def test_bom_is_tolerated():
    rows = PARSER("﻿Data Broker Name\nAcme\n".encode("utf-8"), {})
    assert rows[0]["broker_name"] == "Acme"


def test_header_normalisation():
    assert normalise_header("  Opt-Out URL ") == "opt_out_url"
    assert normalise_header("Data of Minors") == "data_of_minors"


def test_generic_csv_parser_keeps_headers_verbatim():
    rows = get_parser("csv-rows", "1.0.0")(b"A,B\n1,2\n", {})
    assert rows == [{"A": "1", "B": "2", "_row_number": 2}]


# --------------------------------------------------------------- end to end

def registry_spec(tmp_path, csv_bytes: bytes, **action_overrides):
    source = tmp_path / "registry"
    source.mkdir(exist_ok=True)
    (source / "registry.csv").write_bytes(csv_bytes)

    body = json.loads((REPO / "examples/demo/registry-from-file.json").read_text())
    body["source"]["config"]["root"] = str(source)
    body["action"]["landing_zone"]["bucket"] = str(tmp_path / "landing")
    body["action"]["destination"]["config"]["path"] = str(tmp_path / "registry.db")
    body["action"].update(action_overrides)
    return Spec(body)


def test_shipped_registry_specs_are_valid():
    for name in ("examples/specs/collect-ca-broker-registry.json",
                 "examples/demo/registry-from-file.json"):
        Spec(json.loads((REPO / name).read_text()))


def test_ingest_writes_brokers_and_dead_letters_the_bad_row(engine, tmp_path):
    sample = (REPO / "examples/demo/registry/registry-sample.csv").read_bytes()
    spec = registry_spec(tmp_path, sample)

    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    assert dry.ok and dry.counters["matched"] == 1
    assert dry.pipeline_stats["rows_rejected"] == 1
    assert any("1/5 rows rejected" in note for note in dry.notes)

    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)
    assert live.ok and live.pipeline_stats["rows_written"] == 4

    import sqlite3

    conn = sqlite3.connect(tmp_path / "registry.db")
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM data_broker ORDER BY _key")]
    assert [r["_key"] for r in rows] == [
        "ca|DB-1001", "ca|DB-1002", "ca|DB-1003", "ca|unregistered-slug-inc",
    ]
    assert rows[0]["opt_out_url"] == "https://acme.test/opt-out"
    assert json.loads(rows[0]["extra"]) == {"some_column_we_have_not_mapped": "alpha"}


def test_reingesting_an_unchanged_registry_is_free(engine, tmp_path):
    sample = (REPO / "examples/demo/registry/registry-sample.csv").read_bytes()
    spec = registry_spec(tmp_path, sample)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    again = engine.run(spec, dry_run=True, initiated_by="alice")
    assert again.counters["matched"] == 0
    assert again.pipeline_stats["unchanged"] == 1


def test_a_renamed_registry_column_does_not_lose_the_ingest(engine, tmp_path):
    """The realistic failure: the registry renames a column between refreshes."""
    renamed = (
        b"Company Name,Registration Number,Brand New Field\n"
        b"Acme Data LLC,DB-1001,whatever\n"
    )
    spec = registry_spec(tmp_path, renamed)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.ok and result.counters["matched"] == 1
    assert result.pipeline_stats.get("rows_rejected") is None


def test_a_wholesale_format_change_fails_the_record(engine, tmp_path):
    spec = registry_spec(tmp_path, b"Foo,Bar\n1,2\n3,4\n")
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.counters["matched"] == 0
    error = engine.store.dlq(result.run_id)[0]["error"]
    assert "no recognisable broker-name column" in error
