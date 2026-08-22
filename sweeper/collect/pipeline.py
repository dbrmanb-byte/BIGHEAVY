"""Mode A pipeline: land, detect change, parse, validate, dedupe, write."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..connectors import Connector, Record, build
from ..core import Committer, Decision, Pipeline, PipelineStats
from ..errors import RecordError, SpecInvalid
from ..spec import Spec
from ..store import Store
from .landing import LandingZone, content_hash
from .parsers import ParseError, get_parser

SCHEMA_DIR = Path(__file__).resolve().parent.parent.parent / "schemas"


def load_destination_schema(schema_ref: str, schema_dir: Path | None = None) -> dict[str, Any]:
    """Resolve a versioned destination contract (A7)."""
    directory = schema_dir or SCHEMA_DIR
    path = directory / f"{schema_ref}.json"
    if not path.exists():
        known = ", ".join(sorted(p.stem for p in directory.glob("*.json"))) or "none"
        raise SpecInvalid(f"unknown destination schema_ref {schema_ref!r}; known: {known}")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class CollectPipeline(Pipeline):
    """Harvest records from a source into a destination store.

    Order matters: the raw payload is landed before it is parsed, and the
    content hash is checked before either, so an unchanged payload costs one
    fetch and nothing else (A3).
    """

    def __init__(
        self,
        spec: Spec,
        source: Connector,
        store: Store,
        *,
        landing_root: str | Path | None = None,
        destination: Connector | None = None,
        schema_dir: Path | None = None,
    ) -> None:
        self.spec = spec
        self.source = source
        self.store = store
        self.stats = PipelineStats()
        action = spec.action

        self.system = spec.source.get("system") or spec.source["connector"]
        parser_cfg = action["parser"]
        self.parser_name = parser_cfg["name"]
        self.parser_version = parser_cfg["version"]
        self.parser = get_parser(self.parser_name, self.parser_version)

        dest_cfg = action["destination"]
        self.schema = load_destination_schema(dest_cfg["schema_ref"], schema_dir)
        self.destination = destination or build(
            dest_cfg["connector"],
            {"table": dest_cfg.get("table", "collected"), "key": "_key", **dest_cfg.get("config", {})},
        )

        dedupe = action.get("dedupe") or {}
        self.dedupe_key: list[str] = dedupe.get("key") or []
        self.conflict_policy: str = dedupe.get("conflict_policy", "last_wins")

        landing_cfg = action.get("landing_zone")
        root = landing_root or (landing_cfg or {}).get("bucket")
        self.landing = (
            LandingZone(root, (landing_cfg or {}).get("retention_days")) if root else None
        )

        self._validator = self._build_validator()

    def _build_validator(self) -> Any:
        import jsonschema

        return jsonschema.Draft202012Validator(self.schema)

    # ------------------------------------------------------------ plan

    def plan(self, record: Record) -> Decision:
        if record.raw is None:
            raise RecordError(f"record {record.id} was not hydrated by the connector")

        digest = content_hash(record.raw)
        previous = self.store.content_hash_for(self.system, record.id)
        if previous == digest:
            self.stats.bump("unchanged")
            return Decision(
                record_id=record.id,
                decision="no_match",
                action="none",
                reason="content unchanged",
                system=self.system,
            )

        meta = {"system": self.system, **record.meta}
        try:
            rows = self.parser(record.raw, meta)
        except ParseError as exc:
            raise RecordError(f"parse failed ({self.parser_name}@{self.parser_version}): {exc}") from exc

        prepared: list[dict[str, Any]] = []
        problems: list[str] = []
        for index, row in enumerate(rows):
            row = dict(row)
            row.setdefault("_source_record_id", record.id)
            row["_parser"] = f"{self.parser_name}@{self.parser_version}"
            row["_content_hash"] = digest
            row["_key"] = self._dedupe_key_for(row, record.id, index)
            errors = sorted(self._validator.iter_errors(row), key=lambda e: list(e.path))
            if errors:
                problems.extend(
                    f"row {index} {'/'.join(str(p) for p in e.path) or '<root>'}: {e.message}"
                    for e in errors
                )
                continue
            prepared.append(row)

        if problems:
            # Schema violations go to the DLQ, never to the destination (A7).
            raise RecordError("destination schema violation: " + "; ".join(problems[:5]))

        return Decision(
            record_id=record.id,
            decision="match",
            action="insert",
            reason=f"{len(prepared)} row(s)",
            before={"content_hash": previous},
            after={"content_hash": digest, "rows": prepared},
            carry={"raw": record.raw, "meta": meta, "rows": prepared, "digest": digest},
            system=self.system,
        )

    def _dedupe_key_for(self, row: dict[str, Any], record_id: str, index: int) -> str:
        if not self.dedupe_key:
            return f"{record_id}#{index}"
        missing = [k for k in self.dedupe_key if row.get(k) in (None, "")]
        if missing:
            raise RecordError(f"row {index} is missing dedupe key field(s): {', '.join(missing)}")
        return "|".join(str(row[k]) for k in self.dedupe_key)

    # ----------------------------------------------------------- apply

    def apply(self, decision: Decision) -> None:
        carry = decision.carry or {}
        landing_ref = None
        if self.landing is not None:
            landing_ref = str(self.landing.put(carry["raw"], carry["meta"]))
        written = self.destination.upsert(carry["rows"], ["_key"], self.conflict_policy)
        self.stats.bump("rows_written", written)
        self.store.remember_content(
            self.system,
            decision.record_id,
            carry["digest"],
            landing_ref,
            f"{self.parser_name}@{self.parser_version}",
        )

    def finalise(self, committer: Committer) -> None:
        return None
