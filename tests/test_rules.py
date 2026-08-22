"""Cleansing rules — the behaviour a version bump is supposed to protect."""

from __future__ import annotations

import pytest

from sweeper.cleanse.matching import Matcher, jaro_winkler, soundex, token_set_ratio
from sweeper.cleanse.rules import RuleSpec, UnknownRule, apply_rules, get_rule
from sweeper.cleanse.survivorship import merge_records


def rule(rule_id: str, version: str, type_: str = "normalise", **kw) -> RuleSpec:
    return RuleSpec.from_dict({"id": rule_id, "type": type_, "version": version, **kw})


def test_trim_collapses_internal_whitespace():
    out, problems = apply_rules({"name": "  Ada   Lovelace "}, [rule("trim-whitespace", "1.0.0")])
    assert out["name"] == "Ada Lovelace"
    assert problems == []


def test_email_lowercase_can_preserve_local_part():
    rules = [rule("email-lowercase", "1.0.0", fields=["email"])]
    assert apply_rules({"email": "Ada@EXAMPLE.Com"}, rules)[0]["email"] == "ada@example.com"
    rules = [rule("email-lowercase", "1.0.0", fields=["email"], config={"lowercase_local": False})]
    assert apply_rules({"email": "Ada@EXAMPLE.Com"}, rules)[0]["email"] == "Ada@example.com"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("(512) 555-0134", "+15125550134"),
        ("512-555-0134", "+15125550134"),
        ("1 512 555 0134", "+15125550134"),
        ("+44 20 7946 0000", "+442079460000"),
        ("555-0134", "555-0134"),  # not a full NANP number: left for review
        ("", ""),
    ],
)
def test_phone_e164(raw, expected):
    rules = [rule("phone-e164", "2.1.0", fields=["phone"], config={"default_region": "US"})]
    assert apply_rules({"phone": raw}, rules)[0]["phone"] == expected


def test_postal_normalisation():
    rules = [rule("postal-usps", "1.4.0", fields=["addr", "zip"])]
    out, _ = apply_rules({"addr": "1200 west 6th street", "zip": "78703-1234"}, rules)
    assert out["addr"] == "1200 W 6TH ST"
    assert out["zip"] == "78703"


def test_validation_reports_without_blocking_normalisation():
    rules = [
        rule("trim-whitespace", "1.0.0", fields=["name"]),
        rule("email-deliverable", "1.2.0", "validate", fields=["email"]),
    ]
    out, problems = apply_rules({"name": " Ari ", "email": "ari@@broken"}, rules)
    assert out["name"] == "Ari"
    assert problems and "not a valid address" in problems[0]


def test_disabled_rule_is_skipped():
    rules = [rule("trim-whitespace", "1.0.0", fields=["name"], enabled=False)]
    assert apply_rules({"name": " x "}, rules)[0]["name"] == " x "


def test_unknown_rule_version_is_an_error():
    with pytest.raises(UnknownRule):
        get_rule(rule("trim-whitespace", "9.9.9"))


def test_similarity_functions():
    assert jaro_winkler("Reyes", "Reyes") == 1.0
    assert 0.9 < jaro_winkler("Reyes", "Reyess") < 1.0
    assert jaro_winkler("Reyes", "Nguyen") < 0.7
    assert token_set_ratio("1200 W 6TH ST", "6TH ST 1200 W") == 1.0
    assert soundex("Reyes") == soundex("Reyess") == "R200"


def test_matcher_rejects_inverted_thresholds():
    with pytest.raises(ValueError, match="review_below"):
        Matcher(["email_domain"], [], auto_merge_above=0.5, review_below=0.9)


def test_missing_on_both_sides_is_not_evidence_against_a_match():
    matcher = Matcher(
        ["email_domain"],
        [{"field": "email", "method": "exact", "weight": 0.5},
         {"field": "phone", "method": "exact", "weight": 0.5}],
        auto_merge_above=0.9,
        review_below=0.5,
    )
    both_missing, _ = matcher.score({"email": "a@x.com"}, {"email": "a@x.com"})
    one_missing, _ = matcher.score({"email": "a@x.com", "phone": "+1"}, {"email": "a@x.com"})
    assert both_missing == 1.0
    assert one_missing == 0.5


def test_oversized_blocks_are_reported_not_silently_dropped():
    matcher = Matcher(["city"], [{"field": "name", "method": "exact"}], 0.9, 0.1, max_block_size=3)
    for i in range(5):
        matcher.index(str(i), {"city": "austin", "name": "same"})
    assert list(matcher.candidates()) == []
    assert matcher.oversized_blocks == [("city=austin", 5)]


def test_survivorship_keeps_discarded_values():
    merged, discarded = merge_records(
        [
            {"id": "a", "email": "old@x.com", "phone": None, "updated_at": "2026-01-01"},
            {"id": "b", "email": "new@x.com", "phone": "+15125550134", "updated_at": "2026-05-01"},
        ],
        [{"field": "email", "policy": "most_recent"}],
    )
    assert merged["email"] == "new@x.com"
    assert merged["phone"] == "+15125550134"
    assert "old@x.com" in discarded["email"]
