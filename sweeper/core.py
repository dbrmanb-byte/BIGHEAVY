"""Shared vocabulary between the engine and the mode pipelines."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from .connectors import Record

# Mirrors the record_action enum in docs/data-model.sql.
ACTIONS = {"insert", "update", "delete", "anonymise", "crypto_shred", "merge", "skip", "none"}


@dataclass
class Decision:
    """What a pipeline decided about one record, before anything is applied."""

    record_id: str
    decision: str  # 'match' | 'no_match' | 'excluded'
    action: str = "none"
    reason: str | None = None
    before: Any = None
    after: Any = None
    carry: Any = None  # pipeline-private payload for apply()
    system: str | None = None

    def __post_init__(self) -> None:
        if self.action not in ACTIONS:
            raise ValueError(f"unknown action {self.action!r}")
        if self.decision not in ("match", "no_match", "excluded"):
            raise ValueError(f"unknown decision {self.decision!r}")

    @property
    def is_match(self) -> bool:
        return self.decision == "match"

    def action_hash(self) -> str:
        """Stable fingerprint of the intended mutation, for idempotency (R1.4.3)."""
        blob = json.dumps(
            {"action": self.action, "after": self.after}, sort_keys=True, default=str
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


class Committer(Protocol):
    """The engine's side of the contract, handed to pipelines."""

    dry_run: bool

    def commit(self, decision: Decision, apply_fn: Callable[[], None] | None = None) -> bool: ...
    def review(self, rule_id: str, score: float | None, candidates: Any, proposal: Any) -> int: ...
    def note(self, message: str) -> None: ...


@dataclass
class PipelineStats:
    detail: dict[str, int] = field(default_factory=dict)

    def bump(self, name: str, by: int = 1) -> None:
        self.detail[name] = self.detail.get(name, 0) + by


class Pipeline(Protocol):
    """A mode implementation. The engine drives it; it never drives itself."""

    system: str
    stats: PipelineStats

    def plan(self, record: Record) -> Decision: ...
    def apply(self, decision: Decision) -> None: ...
    def finalise(self, committer: Committer) -> None: ...
