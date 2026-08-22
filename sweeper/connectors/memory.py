"""In-memory connector: the test double, with fault injection (R1.9.1, R1.9.3)."""

from __future__ import annotations

from typing import Any, Iterable

from ..errors import InfrastructureError, RecordError
from . import Batch, Capabilities, Connector, Mutation, Record, register


class WorkerKilled(InfrastructureError):
    """Simulates a worker dying mid-batch, to prove resumability."""


@register("memory")
class MemoryConnector(Connector):
    """Serves rows from a seeded list.

    Config:
      rows:          list of dicts, each with an `id`
      partition_by:  field to partition on
      fail_ids:      ids that raise RecordError on read
      kill_after:    raise WorkerKilled once, after this many reads
    """

    def __init__(self, config: dict[str, Any] | None = None, auth: Any = None) -> None:
        super().__init__(config, auth)
        self.rows: list[dict[str, Any]] = list(self.config.get("rows", []))
        self.fail_ids = set(self.config.get("fail_ids", []))
        self.kill_after = self.config.get("kill_after")
        self.reads = 0
        self.killed = False
        self.applied: list[Mutation] = []
        self.upserted: list[dict[str, Any]] = []

    def capabilities(self) -> Capabilities:
        return Capabilities(
            incremental=True,
            filter_pushdown=True,
            writable=True,
            field_update=True,
            hard_delete=True,
        )

    def _key(self, row: dict[str, Any]) -> str:
        return str(row["id"])

    def partitions(self, scope: dict[str, Any]) -> list[str]:
        field = scope.get("partition_by") or self.config.get("partition_by")
        if not field:
            return ["default"]
        return sorted({str(row.get(field, "")) for row in self.rows})

    def _rows_for(self, partition: str, scope: dict[str, Any], watermark: Any) -> list[dict[str, Any]]:
        field = scope.get("partition_by") or self.config.get("partition_by")
        rows = self.rows if not field else [r for r in self.rows if str(r.get(field, "")) == partition]
        for key, value in (scope.get("filter") or {}).items():
            rows = [r for r in rows if r.get(key) == value]
        wm_field = scope.get("watermark_field")
        if watermark is not None and wm_field:
            rows = [r for r in rows if str(r.get(wm_field, "")) > str(watermark)]
        return sorted(rows, key=self._key)

    def enumerate(
        self,
        partition: str,
        cursor: Any,
        batch_size: int,
        scope: dict[str, Any],
        watermark: Any = None,
    ) -> Batch:
        rows = self._rows_for(partition, scope, watermark)
        offset = int(cursor or 0)
        window = rows[offset : offset + batch_size]
        records = [Record(id=self._key(r), payload=dict(r), cursor=offset + i + 1) for i, r in enumerate(window)]
        nxt = offset + len(window)
        return Batch(records=records, next_cursor=nxt, exhausted=nxt >= len(rows))

    def read(self, record: Record) -> Record:
        self.reads += 1
        if self.kill_after and not self.killed and self.reads > int(self.kill_after):
            self.killed = True
            raise WorkerKilled(f"simulated worker loss after {self.kill_after} reads")
        if record.id in self.fail_ids:
            raise RecordError(f"injected failure for record {record.id}")
        return record

    def fetch(self, record_id: str) -> Record:
        for row in self.rows:
            if self._key(row) == record_id:
                return Record(id=record_id, payload=dict(row))
        raise RecordError(f"no such record: {record_id}")

    def apply(self, mutation: Mutation) -> None:
        self.applied.append(mutation)
        if mutation.kind == "upsert":
            values = {**(mutation.values or {}), "id": mutation.record_id}
            for row in self.rows:
                if self._key(row) == mutation.record_id:
                    row.update(values)
                    return
            self.rows.append(values)
            return
        for row in self.rows:
            if self._key(row) == mutation.record_id:
                if mutation.kind == "delete":
                    self.rows.remove(row)
                elif mutation.values:
                    row.update(mutation.values)
                return

    def upsert(self, rows: Iterable[dict[str, Any]], key: list[str], policy: str) -> int:
        count = 0
        for row in rows:
            self.upserted.append(dict(row))
            count += 1
        return count
