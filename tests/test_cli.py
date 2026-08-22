"""CLI smoke tests: the lifecycle an operator actually types."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from sweeper.cli import main

REPO = Path(__file__).resolve().parent.parent


def run(capsys, *argv: str) -> tuple[int, object]:
    code = main(list(argv))
    out = capsys.readouterr().out
    return code, (json.loads(out) if out.strip() else None)


def test_registry_lists_what_is_built(capsys):
    code, payload = run(capsys, "registry")
    assert code == 0
    assert "sqlite-table" in payload["connectors"]
    assert payload["modes_implemented"] == ["collect", "cleanse"]


def test_validate_accepts_an_implemented_spec(capsys, tmp_path):
    spec = json.loads((REPO / "examples/demo/cleanse-contacts.json").read_text())
    spec["source"]["config"]["path"] = str(tmp_path / "crm.db")
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec))

    code, payload = run(capsys, "validate", str(path))
    assert code == 0 and payload["problems"] == []


def test_validate_flags_an_unimplemented_mode(capsys):
    code, payload = run(capsys, "validate", str(REPO / "examples/specs/erase-dsar-subject.json"))
    assert code == 1
    assert any("not implemented" in p for p in payload["problems"])


def test_full_cleanse_lifecycle(capsys, tmp_path):
    import sys

    sys.path.insert(0, str(REPO / "examples/demo"))
    from seed import seed  # type: ignore[import-not-found]

    crm = seed(str(tmp_path / "crm.db"))
    spec = json.loads((REPO / "examples/demo/cleanse-contacts.json").read_text())
    spec["source"]["config"]["path"] = crm
    spec_path = tmp_path / "cleanse.json"
    spec_path.write_text(json.dumps(spec))
    db = str(tmp_path / "state.db")

    code, dry = run(capsys, "--db", db, "dry-run", str(spec_path), "--actor", "alice")
    assert code == 0 and dry["counters"]["acted"] == 0 and dry["counters"]["matched"] > 0

    # An unapproved live run is refused.
    assert main(["--db", db, "apply", str(spec_path), "--based-on", dry["run_id"], "--actor", "alice"]) == 2
    capsys.readouterr()

    run(capsys, "--db", db, "approve", dry["run_id"], "--approver", "bob")
    code, live = run(
        capsys, "--db", db, "apply", str(spec_path), "--based-on", dry["run_id"], "--actor", "alice"
    )
    assert code == 0 and live["counters"]["acted"] == dry["counters"]["matched"]

    code, events = run(capsys, "--db", db, "events", live["run_id"], "--decision", "match")
    assert code == 0 and all(e["applied"] for e in events)

    code, tasks = run(capsys, "--db", db, "review", "--run-id", live["run_id"])
    assert code == 0 and len(tasks) == 1

    code, rolled = run(capsys, "--db", db, "rollback", live["run_id"], "--actor", "carol")
    assert code == 0 and rolled["problems"] == []

    code, runs = run(capsys, "--db", db, "runs")
    assert code == 0 and {r["state"] for r in runs} == {"succeeded"}


def test_collect_lifecycle_reports_the_dlq(capsys, tmp_path):
    pages = tmp_path / "pages"
    shutil.copytree(REPO / "examples/demo/pages", pages)
    spec = json.loads((REPO / "examples/demo/collect-listings.json").read_text())
    spec["source"]["config"]["root"] = str(pages)
    spec["action"]["destination"]["config"]["path"] = str(tmp_path / "warehouse.db")
    spec["action"]["landing_zone"]["bucket"] = str(tmp_path / "landing")
    spec_path = tmp_path / "collect.json"
    spec_path.write_text(json.dumps(spec))
    db = str(tmp_path / "state.db")

    code, dry = run(capsys, "--db", db, "dry-run", str(spec_path), "--actor", "alice")
    assert code == 0 and dry["counters"]["failed"] == 1

    code, dlq = run(capsys, "--db", db, "dlq", dry["run_id"])
    assert code == 0 and "non-numeric age" in dlq[0]["error"]

    code, live = run(
        capsys, "--db", db, "apply", str(spec_path), "--based-on", dry["run_id"], "--actor", "alice"
    )
    assert code == 0 and live["counters"]["acted"] == 2


def test_cancel_marks_the_run(capsys, tmp_path):
    import sys

    sys.path.insert(0, str(REPO / "examples/demo"))
    from seed import seed  # type: ignore[import-not-found]

    crm = seed(str(tmp_path / "crm.db"))
    spec = json.loads((REPO / "examples/demo/cleanse-contacts.json").read_text())
    spec["source"]["config"]["path"] = crm
    spec_path = tmp_path / "cleanse.json"
    spec_path.write_text(json.dumps(spec))
    db = str(tmp_path / "state.db")

    _code, dry = run(capsys, "--db", db, "dry-run", str(spec_path))
    code, payload = run(capsys, "--db", db, "cancel", dry["run_id"], "--actor", "operator")
    assert code == 0 and payload["cancel_requested_by"] == "operator"


def test_unknown_run_id_is_a_clean_error(capsys):
    assert main(["--db", ":memory:", "events", "nope"]) == 2
