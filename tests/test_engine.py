"""Engine behaviour: the guarantees that must hold for every sweep."""

from __future__ import annotations

import pytest

from sweeper.connectors import build
from sweeper.errors import CapabilityError, ModeNotImplemented, SafetyViolation
from sweeper.spec import Spec

from .conftest import make_spec


def injected(engine, body, rows, **overrides):
    """A spec plus a live connector instance the test can mutate between runs.

    Seeding rows through the spec body would change the spec hash, which is
    exactly what the safety gates are meant to catch — so the source has to be
    varied outside the spec.
    """
    spec = make_spec(body, **overrides)
    source = build("memory", {"rows": rows})
    engine.build_source = lambda _spec: source  # type: ignore[assignment]
    return spec, source


def cleanse(engine, body, rows, **overrides):
    """Build a spec whose memory connector is seeded with `rows`."""
    body = dict(body)
    body["source"] = dict(body["source"])
    body["source"]["config"] = {**body["source"].get("config", {}), "rows": rows}
    return make_spec(body, **overrides)


# ------------------------------------------------------------- dry runs

def test_dry_run_applies_nothing(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.ok
    assert result.counters["matched"] == 2  # rows 1 and 3 need normalising
    assert result.counters["acted"] == 0
    assert all(not e["applied"] for e in engine.store.events(result.run_id))


def test_dry_run_preview_carries_before_and_after(engine, cleanse_body, rows):
    from sweeper.crypto import NullCipher, unseal

    spec = cleanse(engine, cleanse_body, rows)
    result = engine.run(spec, dry_run=True, initiated_by="alice")
    matched = [e for e in engine.store.events(result.run_id) if e["decision"] == "match"]

    assert matched, "a dry run must produce an inspectable preview (R1.5.2)"
    for event in matched:
        assert unseal(NullCipher(), event["before"]) is not None
        assert unseal(NullCipher(), event["after"]) is not None


# -------------------------------------------------------- safety gates

def test_live_run_without_a_dry_run_is_refused(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows)
    with pytest.raises(SafetyViolation, match="requires an approved dry run"):
        engine.run(spec, dry_run=False, initiated_by="alice")


def test_live_run_refused_when_spec_changed_since_the_dry_run(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")

    changed = cleanse(engine, cleanse_body, rows, name="renamed")
    with pytest.raises(SafetyViolation, match="spec changed"):
        engine.run(changed, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)


def test_initiator_cannot_self_approve(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows, **{"safety.approvals_required": 1})
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.store.add_approval(dry.run_id, spec.hash, "alice", "approve")

    with pytest.raises(SafetyViolation, match="other than alice"):
        engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    engine.store.add_approval(dry.run_id, spec.hash, "bob", "approve")
    assert engine.run(
        spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id
    ).ok


def test_a_rejection_blocks_the_run(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows, **{"safety.approvals_required": 1})
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    engine.store.add_approval(dry.run_id, spec.hash, "bob", "approve")
    engine.store.add_approval(dry.run_id, spec.hash, "carol", "reject", "wrong scope")

    with pytest.raises(SafetyViolation, match="rejected by carol"):
        engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)


def test_stale_dry_run_is_refused(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows, **{"safety.dry_run_max_age_hours": 1})
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    with engine.store._tx() as conn:
        conn.execute(
            "UPDATE sweep_run SET finished_at = '2020-01-01T00:00:00+00:00' WHERE run_id = ?",
            (dry.run_id,),
        )
    with pytest.raises(SafetyViolation, match="freshness window"):
        engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)


def test_failed_dry_run_cannot_authorise_a_live_run(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    with engine.store._tx() as conn:
        conn.execute("UPDATE sweep_run SET state = 'failed' WHERE run_id = ?", (dry.run_id,))
    with pytest.raises(SafetyViolation, match="not 'succeeded'"):
        engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)


# --------------------------------------------------------- blast radius

def test_mutation_cap_aborts_the_run(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows, **{"limits.max_mutations": 1})
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    assert live.state == "aborted"
    assert "max_mutations" in live.error
    assert live.counters["acted"] == 1  # the cap stopped it, it did not truncate silently


def test_match_cap_aborts_before_applying(engine, cleanse_body, rows):
    spec = cleanse(engine, cleanse_body, rows, **{"limits.max_records_matched": 1})
    result = engine.run(spec, dry_run=True, initiated_by="alice")
    assert result.state == "aborted"
    assert "max_records_matched" in result.error


def test_divergence_from_the_approved_dry_run_aborts(engine, cleanse_body, rows):
    """The source growing between approval and execution must not be applied."""
    spec, source = injected(engine, cleanse_body, rows)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    assert dry.counters["matched"] == 2

    source.rows.extend(
        {"id": f"{i}", "name": f"  Name {i} ", "email": f"P{i}@Example.ORG", "status": "active"}
        for i in range(10, 20)
    )
    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    assert live.state == "aborted"
    assert "diverged" in live.error


def test_undercount_divergence_is_reported(engine, cleanse_body, rows):
    spec, source = injected(engine, cleanse_body, rows)
    dry = engine.run(spec, dry_run=True, initiated_by="alice")

    source.rows[:] = [r for r in source.rows if r["id"] == "2"]  # nothing left to normalise
    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    assert live.ok
    assert any("below the" in note for note in live.notes)


# ---------------------------------------------------------- resilience

def test_bad_record_goes_to_the_dlq_and_the_run_continues(engine, cleanse_body, rows):
    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": rows, "fail_ids": ["1"]}}
    spec = make_spec(body)
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert result.ok
    assert result.counters["failed"] == 1
    assert result.counters["scanned"] == len(rows)
    dlq = engine.store.dlq(result.run_id)
    assert len(dlq) == 1 and dlq[0]["source_record_id"] == "1"


def test_dlq_rate_threshold_aborts(engine, cleanse_body):
    many = [
        {"id": str(i), "name": f" n{i} ", "email": f"E{i}@x.org", "status": "active"}
        for i in range(40)
    ]
    body = dict(cleanse_body)
    body["source"] = {
        **body["source"],
        "config": {"rows": many, "fail_ids": [str(i) for i in range(20)]},
    }
    body["limits"] = {**body["limits"], "batch_size": 10, "max_dlq_rate_pct": 10}
    result = engine.run(make_spec(body), dry_run=True, initiated_by="alice")

    assert result.state == "aborted"
    assert "dead-letter rate" in result.error


def test_read_is_retried_before_dead_lettering(engine, cleanse_body, rows):
    from sweeper.connectors import Record
    from sweeper.errors import RecordError

    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": rows}}
    spec = make_spec(body)
    source = engine.build_source(spec)
    attempts = {"n": 0}

    def flaky(record: Record) -> Record:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RecordError("transient")
        return record

    source.read = flaky  # type: ignore[method-assign]
    engine.build_source = lambda _spec: source  # type: ignore[assignment]
    result = engine.run(spec, dry_run=True, initiated_by="alice")

    assert attempts["n"] >= 3
    assert result.counters["failed"] == 0


def test_cancellation_stops_at_a_checkpoint(engine, cleanse_body):
    many = [
        {"id": f"{i:03d}", "name": f" n{i} ", "email": f"E{i}@x.org", "status": "active"}
        for i in range(20)
    ]
    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": many}}
    body["limits"] = {**body["limits"], "batch_size": 2}
    spec = make_spec(body)

    store = engine.store
    real_enumerate = None

    def cancel_after_first_batch(*args, **kwargs):
        result = real_enumerate(*args, **kwargs)
        runs = store.list_runs(spec.id, 1)
        if runs:
            store.request_cancel(runs[0]["run_id"], "operator")
        return result

    source = engine.build_source(spec)
    real_enumerate = source.enumerate
    source.enumerate = cancel_after_first_batch  # type: ignore[method-assign]
    engine.build_source = lambda _spec: source  # type: ignore[assignment]

    result = engine.run(spec, dry_run=True, initiated_by="alice")
    assert result.state == "cancelled"
    assert result.counters["scanned"] < len(many)


# --------------------------------------------- resumability + idempotency

def test_run_resumes_from_its_checkpoint_after_a_worker_dies(engine, cleanse_body):
    many = [
        {"id": f"{i:03d}", "name": f"  n{i} ", "email": f"E{i}@x.org", "status": "active"}
        for i in range(10)
    ]
    spec, source = injected(
        engine, cleanse_body, many, **{"limits.batch_size": 2, "limits.concurrency": 1}
    )
    source.kill_after = 5

    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    assert dry.state == "failed" and "WorkerKilled" in (dry.error or "")
    assert 0 < dry.counters["scanned"] < len(many)

    source.kill_after = None  # a fresh worker picks the run back up
    resumed = engine.run(spec, dry_run=True, initiated_by="alice", resume_run_id=dry.run_id)

    assert resumed.ok
    scanned_ids = {e["source_record_id"] for e in engine.store.events(dry.run_id)}
    assert scanned_ids == {r["id"] for r in many}, "resume must not skip records"
    # Delivery is at-least-once by design: the checkpoint advances only after a
    # whole batch is accounted for, so the batch the worker died inside is
    # re-processed. Idempotency, not exactly-once enumeration, is what keeps
    # that safe (R1.4.2, R1.4.3).
    assert resumed.counters["scanned"] >= len(many)
    assert resumed.counters["scanned"] - len(many) <= spec.batch_size


def test_duplicate_delivery_is_suppressed(engine, cleanse_body, rows):
    """The same mutation delivered twice must be applied once (R1.4.3)."""
    from sweeper.core import Decision
    from sweeper.engine import RunContext
    from sweeper.store import Counters

    spec, _source = injected(engine, cleanse_body, rows)
    engine.store.put_spec(spec.body, "alice")
    run_id = engine.store.create_run(
        spec_id=spec.id, spec_version=1, spec_hash=spec.hash, mode=spec.mode,
        dry_run=False, initiated_by="alice",
    )
    ctx = RunContext(engine, spec, run_id, False, Counters(), None)

    applied: list[int] = []
    decision = Decision(
        record_id="1", decision="match", action="update",
        before={"name": "  Ada  "}, after={"name": "Ada Lovelace"},
    )

    assert ctx.commit(decision, lambda: applied.append(1)) is True
    assert ctx.commit(decision, lambda: applied.append(1)) is False
    assert applied == [1]
    assert ctx.counters.acted == 1
    assert any("duplicate mutation suppressed" in n for n in ctx.notes)


def test_a_failed_mutation_releases_its_reservation(engine, cleanse_body, rows):
    """A failed apply must stay retryable, not be recorded as done."""
    from sweeper.core import Decision
    from sweeper.engine import RunContext
    from sweeper.store import Counters

    spec, _source = injected(engine, cleanse_body, rows)
    engine.store.put_spec(spec.body, "alice")
    run_id = engine.store.create_run(
        spec_id=spec.id, spec_version=1, spec_hash=spec.hash, mode=spec.mode,
        dry_run=False, initiated_by="alice",
    )
    ctx = RunContext(engine, spec, run_id, False, Counters(), None)
    decision = Decision(record_id="1", decision="match", action="update", after={"name": "x"})

    def boom() -> None:
        raise RuntimeError("source rejected the write")

    with pytest.raises(RuntimeError):
        ctx.commit(decision, boom)

    calls: list[int] = []
    assert ctx.commit(decision, lambda: calls.append(1)) is True
    assert calls == [1]


def test_watermark_advances_only_on_live_runs(engine, cleanse_body, rows):
    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": rows}}
    body["scope"] = {"strategy": "incremental", "watermark_field": "id"}
    spec = make_spec(body)

    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    assert engine.store.get_watermark(spec.id, "default") is None

    engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)
    assert engine.store.get_watermark(spec.id, "default") == "4"


def test_partitions_are_swept_independently(engine, cleanse_body, rows):
    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": rows, "partition_by": "status"}}
    body["scope"] = {"strategy": "full", "partition_by": "status"}
    result = engine.run(make_spec(body), dry_run=True, initiated_by="alice")

    assert result.counters["scanned"] == len(rows)
    assert engine.store.get_checkpoint(result.run_id, "active") is not None
    assert engine.store.get_checkpoint(result.run_id, "archived") is not None


# ------------------------------------------------------- capabilities

def test_pushdown_requirement_is_enforced(engine, collect_body, tmp_path):
    (tmp_path / "a.html").write_text('<div class="listing" data-id="1"><span class="name">A</span></div>')
    collect_body["source"]["config"] = {"root": str(tmp_path)}
    collect_body["scope"] = {"strategy": "full", "pushdown_required": True}
    with pytest.raises(CapabilityError, match="filter_pushdown"):
        engine.run(Spec(collect_body), dry_run=True, initiated_by="alice")


def test_unimplemented_mode_is_named_clearly(engine):
    import json
    from pathlib import Path

    body = json.loads(
        (Path(__file__).resolve().parent.parent / "examples/specs/erase-dsar-subject.json").read_text()
    )
    with pytest.raises(ModeNotImplemented, match="erase"):
        engine.run(Spec(body), dry_run=True, initiated_by="alice")


def test_concurrent_batches_keep_counters_consistent(engine, cleanse_body):
    many = [
        {"id": f"{i:03d}", "name": f"  n{i} ", "email": f"E{i}@x.org", "status": "active"}
        for i in range(50)
    ]
    body = dict(cleanse_body)
    body["source"] = {**body["source"], "config": {"rows": many}}
    body["limits"] = {**body["limits"], "batch_size": 10, "concurrency": 8}
    result = engine.run(make_spec(body), dry_run=True, initiated_by="alice")

    assert result.counters["scanned"] == 50
    assert result.counters["matched"] == 50
    assert len(engine.store.events(result.run_id)) == 50
