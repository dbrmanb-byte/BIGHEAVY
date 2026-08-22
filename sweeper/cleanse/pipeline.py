"""Mode C pipeline: normalise and validate per record, then dedupe as a phase.

Normalisation is per-record and streams. Dedupe cannot: it needs to see the
population before it can propose a pair. So the pipeline indexes during the
scan and does its matching in `finalise`, which is the engine's hook for
exactly this shape of work.
"""

from __future__ import annotations

from typing import Any

from ..connectors import Connector, Mutation, Record
from ..core import Committer, Decision, Pipeline, PipelineStats
from ..errors import RecordError
from ..spec import Spec
from .matching import Matcher
from .rules import RuleSpec, apply_rules
from .survivorship import merge_records

INTERNAL_PREFIX = "_"


class CleansePipeline(Pipeline):
    def __init__(self, spec: Spec, source: Connector, *, key: str = "id") -> None:
        self.spec = spec
        self.source = source
        self.key = key
        self.stats = PipelineStats()
        self.system = spec.source.get("system") or spec.source["connector"]

        action = spec.action
        self.rules = [RuleSpec.from_dict(r) for r in action["rules"]]
        self.on_invalid = str(action.get("on_invalid", "flag"))
        self.survivorship = action.get("survivorship") or []
        self.merge_rule_id = next(
            (r.id for r in self.rules if r.type == "merge" and r.enabled), None
        )

        matching = action.get("matching")
        self.matcher = (
            Matcher(
                blocking_keys=matching["blocking_keys"],
                comparators=matching.get("comparators") or [],
                auto_merge_above=float(matching["auto_merge_above"]),
                review_below=float(matching["review_below"]),
            )
            if matching and self.merge_rule_id
            else None
        )

    # ------------------------------------------------------------ plan

    def plan(self, record: Record) -> Decision:
        row = record.payload
        if row is None:
            raise RecordError(f"record {record.id} was not hydrated by the connector")

        normalised, problems = apply_rules(row, self.rules)
        if self.matcher is not None:
            self.matcher.index(record.id, normalised)

        if problems:
            self.stats.bump("validation_problems", len(problems))
            if self.on_invalid == "exclude":
                return Decision(
                    record_id=record.id,
                    decision="excluded",
                    action="none",
                    reason="; ".join(problems),
                    before=row,
                    system=self.system,
                )

        changed = {
            k: v
            for k, v in normalised.items()
            if not k.startswith(INTERNAL_PREFIX) and row.get(k) != v
        }
        if not changed:
            return Decision(
                record_id=record.id,
                decision="no_match",
                action="none",
                reason="; ".join(problems) if problems else "already normalised",
                system=self.system,
            )

        self.stats.bump("fields_changed", len(changed))
        return Decision(
            record_id=record.id,
            decision="match",
            action="update",
            reason=("normalise: " + ", ".join(sorted(changed)))
            + ("; " + "; ".join(problems) if problems else ""),
            before={k: row.get(k) for k in changed},
            after=changed,
            carry={"changed": changed},
            system=self.system,
        )

    def apply(self, decision: Decision) -> None:
        self.source.apply(
            Mutation(kind="update", record_id=decision.record_id, values=decision.carry["changed"])
        )

    # -------------------------------------------------------- dedupe

    def finalise(self, committer: Committer) -> None:
        if self.matcher is None:
            return
        matcher = self.matcher

        if matcher.dropped_over_capacity:
            # Never let a bounded index read as a complete pass (no silent caps).
            committer.note(
                f"dedupe index capped at {matcher.max_index_records} rows; "
                f"{matcher.dropped_over_capacity} record(s) were not compared"
            )

        for candidate in matcher.candidates():
            verdict = matcher.classify(candidate)
            try:
                left = self._normalised(candidate.left)
                right = self._normalised(candidate.right)
            except RecordError as exc:
                committer.note(f"skipping pair {candidate.left}/{candidate.right}: {exc}")
                self.stats.bump("pairs_unreadable")
                continue

            merged, discarded = merge_records(
                [left, right], self.survivorship, key=self.key
            )
            survivor_id = str(merged[self.key])
            loser = right if survivor_id == str(left[self.key]) else left
            loser_id = str(loser[self.key])
            proposal = {
                "survivor": survivor_id,
                "absorbed": loser_id,
                "merged": merged,
                "discarded": discarded,
                "score": round(candidate.score, 4),
                "field_scores": candidate.detail,
                "block": candidate.block,
            }

            if verdict == "review":
                # The uncertainty band goes to a human, not to a coin flip (C3).
                committer.review(
                    self.merge_rule_id or "merge", candidate.score, [left, right], proposal
                )
                self.stats.bump("review_tasks")
                continue

            survivor_before = left if survivor_id == str(left[self.key]) else right
            changes = {
                k: v
                for k, v in merged.items()
                if k != self.key and survivor_before.get(k) != v
            }
            self.stats.bump("auto_merges")
            committer.commit(
                Decision(
                    record_id=survivor_id,
                    decision="match",
                    action="merge",
                    reason=f"merge {loser_id} into {survivor_id} at {candidate.score:.4f}",
                    before=survivor_before,
                    after=merged,
                    carry={"changes": changes, "discarded": discarded},
                    system=self.system,
                ),
                apply_fn=lambda sid=survivor_id, ch=changes: self.source.apply(
                    Mutation(kind="update", record_id=sid, values=ch)
                ),
            )
            committer.commit(
                Decision(
                    record_id=loser_id,
                    decision="match",
                    action="delete",
                    reason=f"absorbed into {survivor_id}",
                    before=loser,
                    after=None,
                    system=self.system,
                ),
                apply_fn=lambda lid=loser_id: self.source.apply(
                    Mutation(kind="delete", record_id=lid)
                ),
            )

        for block, size in matcher.oversized_blocks:
            committer.note(f"blocking key produced an oversized block, not compared: {block} ({size} rows)")

    def _normalised(self, record_id: str) -> dict[str, Any]:
        record = self.source.fetch(record_id)
        if record.payload is None:
            raise RecordError(f"record {record_id} could not be read")
        row, _problems = apply_rules(record.payload, self.rules)
        row.setdefault(self.key, record_id)
        return row
