"""Mode C: normalisation, the review band, merges and rollback."""

from __future__ import annotations

import copy

import pytest

from sweeper.connectors import build
from sweeper.errors import SafetyViolation
from sweeper.rollback import rollback_run
from sweeper.spec import Spec

DUPES = [
    {"id": "c1", "first_name": "Dana", "last_name": " Reyes ", "email": "Dana@Example.ORG",
     "phone": "(512) 555-0134", "address_line1": "1200 west 6th street",
     "postal_code": "78703-1234", "source": "crm", "updated_at": "2026-01-04"},
    {"id": "c2", "first_name": "Dana", "last_name": "Reyes", "email": "dana@example.org",
     "phone": "512-555-0134", "address_line1": "1200 W 6th St", "postal_code": "78703",
     "source": "import", "updated_at": "2026-05-19"},
    {"id": "c3", "first_name": "Kim", "last_name": "Lee", "email": "kim.lee@example.net",
     "phone": "", "address_line1": "88 Pine Ave", "postal_code": "98101",
     "source": "crm", "updated_at": "2026-03-02"},
    {"id": "c4", "first_name": "Kimberly", "last_name": "Lee", "email": "kimberly.lee@example.net",
     "phone": "206-555-0199", "address_line1": "88 Pine Avenue", "postal_code": "98101",
     "source": "import", "updated_at": "2026-04-11"},
]

MATCHING = {
    "blocking_keys": ["postal_code", "email_domain", "last_name_soundex"],
    "comparators": [
        {"field": "email", "method": "exact", "weight": 0.45},
        {"field": "phone", "method": "exact", "weight": 0.25},
        {"field": "last_name", "method": "jaro_winkler", "weight": 0.15},
        {"field": "address_line1", "method": "token_set_ratio", "weight": 0.15},
    ],
    "auto_merge_above": 0.95,
    "review_below": 0.25,
}


@pytest.fixture
def dedupe_spec(cleanse_body):
    body = copy.deepcopy(cleanse_body)
    body["action"]["rules"] = [
        {"id": "trim-whitespace", "type": "normalise", "version": "1.0.0",
         "fields": ["first_name", "last_name", "email", "address_line1"]},
        {"id": "email-lowercase", "type": "normalise", "version": "1.0.0", "fields": ["email"]},
        {"id": "phone-e164", "type": "normalise", "version": "2.1.0", "fields": ["phone"],
         "config": {"default_region": "US"}},
        {"id": "postal-usps", "type": "normalise", "version": "1.4.0",
         "fields": ["address_line1", "postal_code"]},
        {"id": "contact-merge", "type": "merge", "version": "3.0.0"},
    ]
    body["action"]["matching"] = copy.deepcopy(MATCHING)
    body["action"]["survivorship"] = [
        {"field": "email", "policy": "most_recent"},
        {"field": "phone", "policy": "most_complete"},
    ]
    body["limits"]["batch_size"] = 10
    return body


def run_pair(engine, body, rows, initiated_by="alice"):
    spec = Spec(body)
    source = build("memory", {"rows": copy.deepcopy(rows)})
    engine.build_source = lambda _spec: source  # type: ignore[assignment]
    dry = engine.run(spec, dry_run=True, initiated_by=initiated_by)
    live = engine.run(
        spec, dry_run=False, initiated_by=initiated_by, based_on_run_id=dry.run_id
    )
    return spec, source, dry, live


def test_normalisation_updates_only_changed_fields(engine, cleanse_body, rows):
    spec = Spec(cleanse_body)
    source = build("memory", {"rows": copy.deepcopy(rows)})
    engine.build_source = lambda _spec: source  # type: ignore[assignment]

    dry = engine.run(spec, dry_run=True, initiated_by="alice")
    live = engine.run(spec, dry_run=False, initiated_by="alice", based_on_run_id=dry.run_id)

    assert live.counters["acted"] == 2
    assert [m.values for m in source.applied] == [
        {"name": "Ada Lovelace", "email": "ada@example.org"},
        {"name": "Alan Turing", "email": "alan@example.org"},
    ]


def test_already_clean_records_are_not_mutated(engine, cleanse_body, rows):
    clean = [{"id": "9", "name": "Grace Hopper", "email": "grace@example.org", "status": "active"}]
    _spec, source, _dry, live = run_pair(engine, cleanse_body, clean)
    assert live.counters["matched"] == 0
    assert source.applied == []


def test_validation_problem_is_recorded_but_does_not_block(engine, cleanse_body):
    body = copy.deepcopy(cleanse_body)
    body["action"]["rules"].append(
        {"id": "email-deliverable", "type": "validate", "version": "1.2.0", "fields": ["email"]}
    )
    rows = [{"id": "x", "name": "  Ari  ", "email": "ari@@broken", "status": "active"}]
    _spec, source, dry, live = run_pair(engine, body, rows)

    assert live.counters["acted"] == 1
    assert source.rows[0]["name"] == "Ari"
    reasons = [e["reason"] for e in engine.store.events(dry.run_id)]
    assert any("not a valid address" in (r or "") for r in reasons)


def test_on_invalid_exclude_withholds_the_mutation(engine, cleanse_body):
    body = copy.deepcopy(cleanse_body)
    body["action"]["on_invalid"] = "exclude"
    body["action"]["rules"].append(
        {"id": "email-deliverable", "type": "validate", "version": "1.2.0", "fields": ["email"]}
    )
    rows = [{"id": "x", "name": "  Ari  ", "email": "ari@@broken", "status": "active"}]
    _spec, source, dry, _live = run_pair(engine, body, rows)

    assert source.applied == []
    assert [e["decision"] for e in engine.store.events(dry.run_id)] == ["excluded"]


def test_high_confidence_pair_is_merged_and_the_loser_deleted(engine, dedupe_spec):
    _spec, source, _dry, live = run_pair(engine, dedupe_spec, DUPES[:2])

    assert live.pipeline_stats["auto_merges"] == 1
    kinds = [m.kind for m in source.applied]
    assert "delete" in kinds
    surviving = {r["id"] for r in source.rows}
    assert len(surviving) == 1
    survivor = source.rows[0]
    assert survivor["email"] == "dana@example.org"  # most_recent
    assert survivor["phone"] == "+15125550134"


def test_uncertain_pair_goes_to_the_review_queue(engine, dedupe_spec):
    _spec, source, _dry, live = run_pair(engine, dedupe_spec, DUPES[2:])

    assert live.counters["reviewed"] == 1
    assert live.pipeline_stats.get("auto_merges") is None
    assert len(source.rows) == 2, "an uncertain pair must not be merged automatically"

    task = engine.store.review_tasks(live.run_id)[0]
    assert 0.25 <= task["score"] < 0.95
    assert {task["proposal"]["survivor"], task["proposal"]["absorbed"]} == {"c3", "c4"}


def test_review_task_can_be_resolved(engine, dedupe_spec):
    _spec, _source, _dry, live = run_pair(engine, dedupe_spec, DUPES[2:])
    task = engine.store.review_tasks(live.run_id)[0]

    engine.store.resolve_review_task(task["task_id"], "rejected", "carol")
    assert engine.store.review_tasks(live.run_id, "open") == []
    assert engine.store.review_tasks(live.run_id, "rejected")[0]["reviewer"] == "carol"


def test_merge_records_the_discarded_values(engine, dedupe_spec):
    from sweeper.crypto import NullCipher, unseal

    _spec, _source, _dry, live = run_pair(engine, dedupe_spec, DUPES[:2])
    merges = [e for e in engine.store.events(live.run_id) if e["action"] == "merge"]

    assert merges, "the merge must be in the audit trail"
    before = unseal(NullCipher(), merges[0]["before"])
    assert before is not None and before.get("id")


# ---------------------------------------------------------- rollback

def test_rollback_restores_updates_and_reinserts_deletes(engine, dedupe_spec):
    _spec, source, _dry, live = run_pair(engine, dedupe_spec, DUPES)
    assert len(source.rows) < len(DUPES)

    result = rollback_run(engine.store, source, live.run_id, actor="carol", window_hours=24)

    assert result.problems == []
    assert result.reinserted >= 1
    restored = {r["id"]: r for r in source.rows}
    assert set(restored) == {d["id"] for d in DUPES}
    for original in DUPES:
        for field, value in original.items():
            assert restored[original["id"]][field] == value


def test_rollback_refuses_a_dry_run(engine, cleanse_body, rows):
    spec = Spec(cleanse_body)
    source = build("memory", {"rows": copy.deepcopy(rows)})
    engine.build_source = lambda _spec: source  # type: ignore[assignment]
    dry = engine.run(spec, dry_run=True, initiated_by="alice")

    with pytest.raises(SafetyViolation, match="nothing to roll back"):
        rollback_run(engine.store, source, dry.run_id, actor="carol")


def test_rollback_respects_its_window(engine, dedupe_spec):
    _spec, source, _dry, live = run_pair(engine, dedupe_spec, DUPES[:2])
    with engine.store._tx() as conn:
        conn.execute(
            "UPDATE sweep_run SET finished_at = '2020-01-01T00:00:00+00:00' WHERE run_id = ?",
            (live.run_id,),
        )

    with pytest.raises(SafetyViolation, match="rollback window"):
        rollback_run(engine.store, source, live.run_id, actor="carol", window_hours=1)

    assert rollback_run(
        engine.store, source, live.run_id, actor="carol", window_hours=1, force=True
    ).problems == []
