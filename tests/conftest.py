from __future__ import annotations

import copy
from typing import Any

import pytest

from sweeper.engine import Engine
from sweeper.spec import Spec
from sweeper.store import Store

CLEANSE_BODY: dict[str, Any] = {
    "spec_version": "1",
    "id": "test-cleanse",
    "mode": "cleanse",
    "owner": "tests",
    "source": {"connector": "memory", "system": "test.contacts", "config": {}},
    "scope": {"strategy": "full"},
    "limits": {"batch_size": 2, "concurrency": 1, "max_mutations": 100, "max_dlq_rate_pct": 50},
    "safety": {
        "dry_run_required": True,
        "approvals_required": 0,
        "rollback_window_hours": 24,
        "divergence_tolerance_pct": 10,
    },
    "action": {
        "type": "cleanse",
        "rules": [
            {"id": "trim-whitespace", "type": "normalise", "version": "1.0.0", "fields": ["name"]},
            {"id": "email-lowercase", "type": "normalise", "version": "1.0.0", "fields": ["email"]},
        ],
    },
}

COLLECT_BODY: dict[str, Any] = {
    "spec_version": "1",
    "id": "test-collect",
    "mode": "collect",
    "owner": "tests",
    "source": {"connector": "filesystem", "system": "test.pages", "config": {}},
    "scope": {"strategy": "full"},
    "limits": {"batch_size": 5, "concurrency": 1, "max_dlq_rate_pct": 90},
    "safety": {"dry_run_required": True, "approvals_required": 0},
    "action": {
        "type": "collect",
        "parser": {"name": "people-search-listing", "version": "3.2.0"},
        "destination": {
            "connector": "sqlite-table",
            "table": "listing",
            "schema_ref": "broker_listing@2",
            "config": {"key": "_key"},
        },
        "dedupe": {"key": ["broker", "listing_id"], "conflict_policy": "last_wins"},
    },
}

ROWS = [
    {"id": "1", "name": "  Ada  Lovelace ", "email": "Ada@Example.ORG", "status": "active"},
    {"id": "2", "name": "Grace Hopper", "email": "grace@example.org", "status": "active"},
    {"id": "3", "name": " Alan Turing", "email": "Alan@Example.ORG", "status": "archived"},
    {"id": "4", "name": "Katherine Johnson", "email": "kj@example.org", "status": "active"},
]


@pytest.fixture
def store() -> Store:
    return Store(":memory:")


@pytest.fixture
def engine(store: Store) -> Engine:
    # Retries still happen; the waiting between them does not.
    return Engine(store, backoff_base=0.001)


@pytest.fixture
def cleanse_body() -> dict[str, Any]:
    return copy.deepcopy(CLEANSE_BODY)


@pytest.fixture
def collect_body() -> dict[str, Any]:
    return copy.deepcopy(COLLECT_BODY)


@pytest.fixture
def rows() -> list[dict[str, Any]]:
    return copy.deepcopy(ROWS)


def make_spec(body: dict[str, Any], **overrides: Any) -> Spec:
    merged = copy.deepcopy(body)
    for path, value in overrides.items():
        target = merged
        parts = path.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
    return Spec(merged)
