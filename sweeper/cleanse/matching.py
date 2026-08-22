"""Blocking, comparison and scoring for dedupe (C2, C3).

Blocking is what makes this tractable: comparing every pair in a 10^6-row
table is 5*10^11 comparisons. Blocking on a few cheap keys reduces that to
pairs that share a key, at the cost of missing pairs that agree on nothing —
which is why C2 asks for several blocking keys rather than one.
"""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable


# ------------------------------------------------------------ similarity

def jaro(a: str, b: str) -> float:
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    reach = max(len(a), len(b)) // 2 - 1
    if reach < 0:
        reach = 0
    a_flags = [False] * len(a)
    b_flags = [False] * len(b)
    matches = 0
    for i, ch in enumerate(a):
        for j in range(max(0, i - reach), min(len(b), i + reach + 1)):
            if not b_flags[j] and b[j] == ch:
                a_flags[i] = b_flags[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    transpositions = 0
    k = 0
    for i, flagged in enumerate(a_flags):
        if not flagged:
            continue
        while not b_flags[k]:
            k += 1
        if a[i] != b[k]:
            transpositions += 1
        k += 1
    transpositions //= 2
    return (matches / len(a) + matches / len(b) + (matches - transpositions) / matches) / 3.0


def jaro_winkler(a: str, b: str, prefix_weight: float = 0.1) -> float:
    """Jaro with the standard prefix boost — good for names and typos."""
    a, b = (a or "").lower(), (b or "").lower()
    score = jaro(a, b)
    if score < 0.7:
        return score
    prefix = 0
    for x, y in zip(a[:4], b[:4]):
        if x != y:
            break
        prefix += 1
    return score + prefix * prefix_weight * (1 - score)


_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def token_set_ratio(a: str, b: str) -> float:
    """Order-insensitive token overlap (Jaccard). Suits addresses."""
    ta = set(t.lower() for t in _TOKEN_RE.findall(a or ""))
    tb = set(t.lower() for t in _TOKEN_RE.findall(b or ""))
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def exact(a: str, b: str) -> float:
    return 1.0 if (a or "").strip().lower() == (b or "").strip().lower() and a else 0.0


COMPARATORS: dict[str, Callable[[str, str], float]] = {
    "exact": exact,
    "jaro_winkler": jaro_winkler,
    "token_set_ratio": token_set_ratio,
}


def soundex(value: str) -> str:
    """Classic Soundex, used as a name blocking key."""
    text = re.sub(r"[^A-Za-z]", "", value or "").upper()
    if not text:
        return ""
    codes = {**dict.fromkeys("BFPV", "1"), **dict.fromkeys("CGJKQSXZ", "2"),
             **dict.fromkeys("DT", "3"), "L": "4", **dict.fromkeys("MN", "5"), "R": "6"}
    out = text[0]
    previous = codes.get(text[0], "")
    for ch in text[1:]:
        code = codes.get(ch, "")
        if code and code != previous:
            out += code
        if ch not in "HW":
            previous = code
    return (out + "000")[:4]


# -------------------------------------------------------------- blocking

def blocking_value(row: dict[str, Any], key: str) -> str | None:
    """Compute one blocking key. Supports a few derived keys beyond raw fields."""
    if key.endswith("_soundex"):
        base = key[: -len("_soundex")]
        value = row.get(base)
        return soundex(str(value)) if value else None
    if key == "email_domain":
        email = row.get("email")
        return str(email).rpartition("@")[2].lower() if email and "@" in str(email) else None
    value = row.get(key)
    if value in (None, ""):
        return None
    return str(value).strip().lower()


@dataclass
class Candidate:
    left: str
    right: str
    score: float
    detail: dict[str, float] = field(default_factory=dict)
    block: str = ""


class Matcher:
    """Builds blocks during the scan, then emits scored candidate pairs.

    The index holds only the id and the fields the comparators need, so its
    footprint is a function of the comparator set rather than the row width.
    A run that exceeds `max_index_records` stops indexing and says so — it
    never silently compares a subset and reports the result as a full pass.
    """

    def __init__(
        self,
        blocking_keys: list[str],
        comparators: list[dict[str, Any]],
        auto_merge_above: float,
        review_below: float,
        max_index_records: int = 500_000,
        max_block_size: int = 500,
    ) -> None:
        if review_below > auto_merge_above:
            raise ValueError("review_below must not exceed auto_merge_above (C3)")
        self.blocking_keys = blocking_keys
        self.comparators = comparators or [{"field": "email", "method": "exact", "weight": 1.0}]
        self.auto_merge_above = auto_merge_above
        self.review_below = review_below
        self.max_index_records = max_index_records
        self.max_block_size = max_block_size

        self._fields = sorted({c["field"] for c in self.comparators})
        self._rows: dict[str, dict[str, Any]] = {}
        self._blocks: dict[str, list[str]] = {}
        self.indexed = 0
        self.dropped_over_capacity = 0
        self.oversized_blocks: list[tuple[str, int]] = []

    def index(self, record_id: str, row: dict[str, Any]) -> None:
        if self.indexed >= self.max_index_records:
            self.dropped_over_capacity += 1
            return
        self._rows[record_id] = {f: row.get(f) for f in self._fields}
        for key in self.blocking_keys:
            value = blocking_value(row, key)
            if value:
                self._blocks.setdefault(f"{key}={value}", []).append(record_id)
        self.indexed += 1

    def score(self, left: dict[str, Any], right: dict[str, Any]) -> tuple[float, dict[str, float]]:
        """Weighted mean over comparators.

        A comparator whose field is absent on *both* sides is dropped from the
        denominator rather than scored zero: two records that both lack a phone
        number are not evidence against a match.
        """
        total = 0.0
        weight_sum = 0.0
        detail: dict[str, float] = {}
        for comparator in self.comparators:
            field_name = comparator["field"]
            method = COMPARATORS.get(comparator["method"])
            if method is None:
                raise ValueError(f"unknown comparator method {comparator['method']!r}")
            a, b = left.get(field_name), right.get(field_name)
            if a in (None, "") and b in (None, ""):
                continue
            weight = float(comparator.get("weight", 1.0))
            value = method(str(a or ""), str(b or ""))
            detail[field_name] = round(value, 4)
            total += value * weight
            weight_sum += weight
        return (total / weight_sum if weight_sum else 0.0), detail

    def candidates(self) -> Iterable[Candidate]:
        """Yield each distinct pair once, highest score first within a block."""
        seen: set[tuple[str, str]] = set()
        for block, members in sorted(self._blocks.items()):
            if len(members) < 2:
                continue
            if len(members) > self.max_block_size:
                # A block this large is a bad blocking key, not a real cluster.
                self.oversized_blocks.append((block, len(members)))
                continue
            for left, right in itertools.combinations(sorted(set(members)), 2):
                pair = (left, right)
                if pair in seen:
                    continue
                seen.add(pair)
                score, detail = self.score(self._rows[left], self._rows[right])
                if score < self.review_below:
                    continue
                yield Candidate(left=left, right=right, score=score, detail=detail, block=block)

    def classify(self, candidate: Candidate) -> str:
        """'merge' above the high threshold, 'review' in the band between (C3)."""
        return "merge" if candidate.score >= self.auto_merge_above else "review"
