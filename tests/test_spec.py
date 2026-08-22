"""Spec validation is the first safety gate: bad specs must not reach a run."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from sweeper.errors import SpecInvalid
from sweeper.spec import Spec, spec_hash, validate_body

REPO = Path(__file__).resolve().parent.parent


@pytest.mark.parametrize("path", sorted((REPO / "examples").rglob("*.json")))
def test_shipped_examples_validate(path: Path) -> None:
    validate_body(json.loads(path.read_text()))


def test_erase_requires_two_approvers(cleanse_body):
    body = json.loads((REPO / "examples/specs/erase-dsar-subject.json").read_text())
    validate_body(body)
    body["safety"]["approvals_required"] = 1
    with pytest.raises(SpecInvalid):
        validate_body(body)


def test_erase_requires_dry_run():
    body = json.loads((REPO / "examples/specs/erase-dsar-subject.json").read_text())
    body["safety"]["dry_run_required"] = False
    with pytest.raises(SpecInvalid):
        validate_body(body)


def test_cleanse_requires_mutation_cap_and_rollback_window(cleanse_body):
    body = copy.deepcopy(cleanse_body)
    del body["limits"]["max_mutations"]
    with pytest.raises(SpecInvalid, match="max_mutations"):
        validate_body(body)

    body = copy.deepcopy(cleanse_body)
    del body["safety"]["rollback_window_hours"]
    with pytest.raises(SpecInvalid, match="rollback_window_hours"):
        validate_body(body)


def test_incremental_scope_requires_watermark(cleanse_body):
    cleanse_body["scope"] = {"strategy": "incremental"}
    with pytest.raises(SpecInvalid, match="watermark_field"):
        validate_body(cleanse_body)


def test_inline_secret_is_rejected(cleanse_body):
    cleanse_body["source"]["config"]["password"] = "hunter2"
    with pytest.raises(SpecInvalid, match="inline secret"):
        validate_body(cleanse_body)
    cleanse_body["source"]["config"]["password"] = "vault://db/crm#password"
    validate_body(cleanse_body)


def test_hash_is_stable_under_key_order(cleanse_body):
    reordered = dict(reversed(list(cleanse_body.items())))
    assert spec_hash(cleanse_body) == spec_hash(reordered)


def test_spec_version_is_carried(cleanse_body):
    assert Spec(cleanse_body, version=7).describe() == "test-cleanse@v7 (cleanse)"
