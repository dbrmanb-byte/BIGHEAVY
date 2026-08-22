"""Field-level survivorship for merges (C4).

The losing values are returned alongside the merged record so they land in the
audit trail — a merge that silently discards data is not reversible in practice
even when the rollback path exists.
"""

from __future__ import annotations

from typing import Any


def _completeness(row: dict[str, Any]) -> int:
    return sum(1 for v in row.values() if v not in (None, "", [], {}))


def _pick(field: str, policy: str, rows: list[dict[str, Any]], trust: dict[str, int]) -> Any:
    values = [(row, row.get(field)) for row in rows if row.get(field) not in (None, "", [], {})]
    if not values:
        return None
    if policy == "most_recent":
        return max(values, key=lambda rv: str(rv[0].get("updated_at") or ""))[1]
    if policy == "most_complete":
        return max(values, key=lambda rv: _completeness(rv[0]))[1]
    if policy == "highest_trust_source":
        return max(values, key=lambda rv: trust.get(str(rv[0].get("source") or ""), 0))[1]
    if policy == "longest_value":
        return max(values, key=lambda rv: len(str(rv[1])))[1]
    raise ValueError(f"unknown survivorship policy {policy!r}")


def choose_survivor(rows: list[dict[str, Any]], key: str = "id") -> dict[str, Any]:
    """Most complete record wins; ties break on the id so the choice is stable."""
    return max(rows, key=lambda r: (_completeness(r), str(r.get(key, ""))))


def merge_records(
    rows: list[dict[str, Any]],
    policies: list[dict[str, str]],
    *,
    key: str = "id",
    trust: dict[str, int] | None = None,
) -> tuple[dict[str, Any], dict[str, list[Any]]]:
    """Return (merged record, discarded values by field)."""
    if not rows:
        raise ValueError("nothing to merge")
    trust = trust or {}
    survivor = choose_survivor(rows, key)
    merged = dict(survivor)
    by_field = {p["field"]: p["policy"] for p in policies}

    for field, policy in by_field.items():
        chosen = _pick(field, policy, rows, trust)
        if chosen is not None:
            merged[field] = chosen

    # Fields with no policy: fill only where the survivor is empty. Never
    # overwrite a survivor value on a rule nobody wrote.
    for row in rows:
        for field, value in row.items():
            if field in by_field or field == key:
                continue
            if merged.get(field) in (None, "", [], {}) and value not in (None, "", [], {}):
                merged[field] = value

    discarded: dict[str, list[Any]] = {}
    for row in rows:
        for field, value in row.items():
            if value in (None, "", [], {}):
                continue
            if merged.get(field) != value:
                discarded.setdefault(field, []).append(value)
    return merged, discarded
