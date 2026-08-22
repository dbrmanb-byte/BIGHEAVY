"""Mode A: landing zone, change detection, parser versioning, schema contract."""

from __future__ import annotations

import pytest

from sweeper.collect.landing import LandingZone, content_hash
from sweeper.collect.parsers import ParseError, get_parser, register_parser
from sweeper.collect.pipeline import load_destination_schema
from sweeper.errors import SpecInvalid
from sweeper.spec import Spec

PAGE = b"""<div class="listing" data-id="L-1" data-url="https://x.test/1">
  <span class="name">Dana   Reyes</span><span class="age">41</span>
  <span class="city">Austin</span><span class="relatives">Sam Reyes, Ali Reyes</span>
</div>"""

BAD_PAGE = b'<div class="listing" data-id="L-2"><span class="name">A</span><span class="age">x</span></div>'


@pytest.fixture
def pages(tmp_path):
    (tmp_path / "one.html").write_bytes(PAGE)
    return tmp_path


def spec_for(collect_body, root, tmp_path, **extra):
    collect_body["source"]["config"] = {"root": str(root), "glob": "*.html"}
    collect_body["action"]["destination"]["config"] = {
        "path": str(tmp_path / "warehouse.db"),
        "key": "_key",
    }
    collect_body["action"]["landing_zone"] = {"bucket": str(tmp_path / "landing")}
    collect_body["action"].update(extra)
    return Spec(collect_body)


# ------------------------------------------------------------- landing

def test_landing_is_content_addressed_and_idempotent(tmp_path):
    zone = LandingZone(tmp_path / "landing")
    first = zone.put(PAGE, {"url": "https://x.test/1"})
    second = zone.put(PAGE, {"url": "https://x.test/1"})

    assert first.digest == second.digest == content_hash(PAGE)
    assert zone.get(str(first)) == PAGE
    assert zone.has(first.digest)


def test_landing_survives_a_partial_write(tmp_path):
    zone = LandingZone(tmp_path / "landing")
    ref = zone.put(PAGE, None)
    # A .tmp left behind by a crash must never be mistaken for the payload.
    assert not list(ref.path.parent.glob("*.tmp"))


# -------------------------------------------------------------- parsers

def test_parser_is_addressed_by_version():
    rows = get_parser("people-search-listing", "3.2.0")(PAGE, {"broker": "b", "url": "u"})
    assert rows[0]["name"] == "Dana   Reyes"  # collect does not normalise; that is mode C
    assert rows[0]["relatives"] == ["Sam Reyes", "Ali Reyes"]
    assert rows[0]["age"] == 41

    with pytest.raises(ParseError, match="no parser"):
        get_parser("people-search-listing", "3.1.0")


def test_parser_failure_is_a_record_error_not_a_crash():
    with pytest.raises(ParseError, match="non-numeric age"):
        get_parser("people-search-listing", "3.2.0")(BAD_PAGE, {})


def test_unknown_schema_ref_is_rejected():
    with pytest.raises(SpecInvalid, match="unknown destination schema_ref"):
        load_destination_schema("no-such-schema@1")


def test_known_schema_ref_loads():
    assert load_destination_schema("broker_listing@2")["title"] == "broker_listing@2"


# ------------------------------------------------------------ end to end

def test_collect_writes_rows_and_lands_the_payload(engine, collect_body, pages, tmp_path):
    spec = spec_for(collect_body, pages, tmp_path)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    assert dry.ok and dry.counters["matched"] == 1 and dry.counters["acted"] == 0
    assert not (tmp_path / "landing").exists() or not any((tmp_path / "landing").rglob("*"))

    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)
    assert live.ok and live.counters["acted"] == 1
    assert live.pipeline_stats["rows_written"] == 1
    assert LandingZone(tmp_path / "landing").has(content_hash(PAGE))


def test_unchanged_content_is_skipped_on_the_next_pass(engine, collect_body, pages, tmp_path):
    spec = spec_for(collect_body, pages, tmp_path)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    again = engine.run(spec, dry_run=True, initiated_by="alice")
    assert again.counters["matched"] == 0
    assert again.pipeline_stats["unchanged"] == 1


def test_changed_content_is_re_collected(engine, collect_body, pages, tmp_path):
    spec = spec_for(collect_body, pages, tmp_path)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    (pages / "one.html").write_bytes(PAGE.replace(b"41", b"42"))
    again = engine.run(spec, dry_run=True, initiated_by="alice")
    assert again.counters["matched"] == 1


def test_schema_violation_goes_to_the_dlq_not_the_table(engine, collect_body, tmp_path):
    root = tmp_path / "pages"
    root.mkdir()
    # `age` above the schema maximum: a parse success but a contract failure.
    (root / "bad.html").write_bytes(
        b'<div class="listing" data-id="L-9"><span class="name">X</span>'
        b'<span class="age">900</span></div>'
    )
    spec = spec_for(collect_body, root, tmp_path)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.counters["matched"] == 0
    dlq = engine.store.dlq(result.run_id)
    # Every row in this payload is bad, so the whole record fails rather than
    # writing nothing and reporting success.
    assert len(dlq) == 1 and "rows rejected" in dlq[0]["error"]
    assert "greater than the maximum" in dlq[0]["error"]


def test_a_few_bad_rows_are_dead_lettered_and_the_rest_are_written(engine, collect_body, tmp_path):
    """A 500-row file must not be lost to three bad rows (nor silently trimmed)."""
    root = tmp_path / "pages"
    root.mkdir()
    good = "".join(
        f'<div class="listing" data-id="L-{i}"><span class="name">P{i}</span>'
        f'<span class="age">3{i}</span></div>'
        for i in range(9)
    )
    bad = '<div class="listing" data-id="L-X"><span class="name">Y</span><span class="age">900</span></div>'
    (root / "mixed.html").write_text(good + bad)

    spec = spec_for(collect_body, root, tmp_path, max_row_rejection_pct=20)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.ok
    assert result.counters["matched"] == 1, "the good rows still form a match"
    assert result.pipeline_stats["rows_rejected"] == 1
    dlq = engine.store.dlq(result.run_id)
    assert len(dlq) == 1 and dlq[0]["error_class"] == "RowRejected"
    assert dlq[0]["source_record_id"] == "mixed.html#row9"
    # A rejection is never silent: the run says how many and against what ceiling.
    assert any("1/10 rows rejected" in note for note in result.notes)
    assert result.counters["failed"] == 0, "row rejections must not distort the DLQ rate"


def test_too_many_bad_rows_fails_the_whole_record(engine, collect_body, tmp_path):
    root = tmp_path / "pages"
    root.mkdir()
    rows = "".join(
        f'<div class="listing" data-id="L-{i}"><span class="name">P{i}</span>'
        f'<span class="age">{"900" if i % 2 else "40"}</span></div>'
        for i in range(10)
    )
    (root / "mostly-bad.html").write_text(rows)

    spec = spec_for(collect_body, root, tmp_path, max_row_rejection_pct=10)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.counters["matched"] == 0
    assert "source format has probably changed" in engine.store.dlq(result.run_id)[0]["error"]


def test_missing_dedupe_key_field_is_dead_lettered(engine, collect_body, tmp_path):
    root = tmp_path / "pages"
    root.mkdir()
    (root / "nokey.html").write_bytes(
        b'<div class="listing"><span class="name">No listing id</span></div>'
    )
    spec = spec_for(collect_body, root, tmp_path)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    dlq = engine.store.dlq(result.run_id)
    assert len(dlq) == 1 and "dedupe key" in dlq[0]["error"]


def test_dedupe_conflict_policy_first_wins(tmp_path):
    from sweeper.connectors import build

    dest = build("sqlite-table", {"path": str(tmp_path / "d.db"), "table": "t", "key": "k"})
    dest.upsert([{"k": "a", "v": "first"}], ["k"], "first_wins")
    dest.upsert([{"k": "a", "v": "second"}], ["k"], "first_wins")
    assert dest.enumerate("default", None, 10, {}).records[0].payload["v"] == "first"

    dest.upsert([{"k": "a", "v": "third"}], ["k"], "last_wins")
    assert dest.enumerate("default", None, 10, {}).records[0].payload["v"] == "third"


def test_a_new_parser_version_can_backfill_from_the_landing_zone(engine, collect_body, pages, tmp_path):
    """A parser fix must be applicable without touching the source again (A8)."""
    spec = spec_for(collect_body, pages, tmp_path)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    zone = LandingZone(tmp_path / "landing")
    raw = zone.get(content_hash(PAGE))

    @register_parser("people-search-listing", "3.3.0")
    def _v33(payload: bytes, meta: dict) -> list[dict]:
        rows = get_parser("people-search-listing", "3.2.0")(payload, meta)
        for row in rows:
            row["name"] = " ".join(row["name"].split())
        return rows

    assert get_parser("people-search-listing", "3.3.0")(raw, {"broker": "b"})[0]["name"] == "Dana Reyes"
