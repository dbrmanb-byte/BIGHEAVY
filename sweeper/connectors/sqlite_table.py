"""SQLite table connector: mode C source of record, and mode A destination.

Stands in for the relational source a real deployment would point at. The SQL
is deliberately plain so the same shape ports to Postgres.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Iterable

from ..errors import CapabilityError, RecordError, SpecInvalid
from . import Batch, Capabilities, Connector, Mutation, Record, register

_IDENT_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def ident(name: str) -> str:
    """Whitelist an identifier. Table and column names cannot be bound."""
    if not name or not set(name) <= _IDENT_OK:
        raise SpecInvalid(f"unsafe SQL identifier: {name!r}")
    return name


@register("sqlite-table")
class SqliteTableConnector(Connector):
    """Config: path, table, key (default 'id'), columns (optional allowlist)."""

    def __init__(self, config: dict[str, Any] | None = None, auth: Any = None) -> None:
        super().__init__(config, auth)
        self.path = str(self.config.get("path") or ":memory:")
        self.table = ident(str(self.config.get("table", "records")))
        self.key = ident(str(self.config.get("key", "id")))
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row

    def capabilities(self) -> Capabilities:
        return Capabilities(
            incremental=True,
            filter_pushdown=True,
            writable=True,
            field_update=True,
            hard_delete=True,
            transactional_batch=True,
        )

    def columns(self) -> list[str]:
        with self._lock:
            return [r["name"] for r in self._conn.execute(f"PRAGMA table_info({self.table})")]

    # --------------------------------------------------------- reading

    def partitions(self, scope: dict[str, Any]) -> list[str]:
        field = scope.get("partition_by")
        if not field:
            return ["default"]
        col = ident(field)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT DISTINCT {col} AS p FROM {self.table} ORDER BY 1"
            ).fetchall()
        return [str(r["p"]) for r in rows] or ["default"]

    def _where(self, partition: str, scope: dict[str, Any], watermark: Any) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        args: list[Any] = []
        field = scope.get("partition_by")
        if field:
            clauses.append(f"{ident(field)} = ?")
            args.append(partition)
        for key, value in (scope.get("filter") or {}).items():
            clauses.append(f"{ident(key)} = ?")
            args.append(value)
        wm_field = scope.get("watermark_field")
        if watermark is not None and wm_field:
            clauses.append(f"{ident(wm_field)} > ?")
            args.append(watermark)
        return (" WHERE " + " AND ".join(clauses) if clauses else ""), args

    def enumerate(
        self,
        partition: str,
        cursor: Any,
        batch_size: int,
        scope: dict[str, Any],
        watermark: Any = None,
    ) -> Batch:
        where, args = self._where(partition, scope, watermark)
        # Keyset pagination on the primary key: stable under concurrent writes
        # in a way that OFFSET is not.
        if cursor is not None:
            where = (where + " AND " if where else " WHERE ") + f"{self.key} > ?"
            args = [*args, cursor]
        sql = f"SELECT * FROM {self.table}{where} ORDER BY {self.key} LIMIT ?"
        with self._lock:
            rows = self._conn.execute(sql, [*args, batch_size]).fetchall()
        records = [Record(id=str(r[self.key]), payload=dict(r), cursor=r[self.key]) for r in rows]
        next_cursor = records[-1].cursor if records else cursor
        return Batch(records=records, next_cursor=next_cursor, exhausted=len(rows) < batch_size)

    def read(self, record: Record) -> Record:
        if record.payload is not None:
            return record
        with self._lock:
            row = self._conn.execute(
                f"SELECT * FROM {self.table} WHERE {self.key} = ?", (record.id,)
            ).fetchone()
        if row is None:
            raise RecordError(f"record {record.id} vanished between enumerate and read")
        record.payload = dict(row)
        return record

    # --------------------------------------------------------- writing

    def apply(self, mutation: Mutation) -> None:
        with self._lock:
            try:
                if mutation.kind == "delete":
                    self._conn.execute(
                        f"DELETE FROM {self.table} WHERE {self.key} = ?", (mutation.record_id,)
                    )
                elif mutation.kind == "update":
                    values = mutation.values or {}
                    if not values:
                        return
                    sets = ", ".join(f"{ident(c)} = ?" for c in values)
                    self._conn.execute(
                        f"UPDATE {self.table} SET {sets} WHERE {self.key} = ?",
                        [*values.values(), mutation.record_id],
                    )
                elif mutation.kind == "upsert":
                    self._conn.commit()
                    self.upsert([{**(mutation.values or {}), self.key: mutation.record_id}],
                                [self.key], "last_wins")
                    return
                else:
                    raise CapabilityError(f"unsupported mutation kind: {mutation.kind}")
                self._conn.commit()
            except sqlite3.Error as exc:
                self._conn.rollback()
                raise RecordError(f"mutation failed for {mutation.record_id}: {exc}") from exc

    def ensure_table(self, columns: list[str]) -> None:
        """Create the destination table if absent. Mode A writes JSON-ish rows."""
        cols = ", ".join(f"{ident(c)} TEXT" for c in columns if c != self.key)
        with self._lock:
            self._conn.execute(
                f"CREATE TABLE IF NOT EXISTS {self.table} ({ident(self.key)} TEXT PRIMARY KEY"
                + (", " + cols if cols else "")
                + ")"
            )
            self._conn.commit()

    def upsert(self, rows: Iterable[dict[str, Any]], key: list[str], policy: str) -> int:
        """Destination write for mode A, honouring the dedupe conflict policy (A4)."""
        rows = list(rows)
        if not rows:
            return 0
        columns = sorted({c for row in rows for c in row})
        self.ensure_table(columns)
        existing = set(self.columns())
        for column in columns:
            if column not in existing:
                with self._lock:
                    self._conn.execute(
                        f"ALTER TABLE {self.table} ADD COLUMN {ident(column)} TEXT"
                    )
        conflict_cols = [ident(c) for c in (key or [self.key])]
        if policy == "first_wins":
            action = "DO NOTHING"
        else:  # last_wins and merge both overwrite; merge coalesces nulls
            assignments = []
            for column in columns:
                if column in conflict_cols:
                    continue
                if policy == "merge":
                    assignments.append(
                        f"{ident(column)} = COALESCE(excluded.{ident(column)}, {ident(column)})"
                    )
                else:
                    assignments.append(f"{ident(column)} = excluded.{ident(column)}")
            action = "DO UPDATE SET " + ", ".join(assignments) if assignments else "DO NOTHING"
        placeholders = ", ".join("?" for _ in columns)
        sql = (
            f"INSERT INTO {self.table} ({', '.join(ident(c) for c in columns)})"
            f" VALUES ({placeholders})"
            f" ON CONFLICT({', '.join(conflict_cols)}) {action}"
        )
        payload = [
            [
                v if isinstance(v, (str, int, float, type(None))) else json.dumps(v, sort_keys=True)
                for v in (row.get(c) for c in columns)
            ]
            for row in rows
        ]
        with self._lock:
            try:
                self._conn.executemany(sql, payload)
                self._conn.commit()
            except sqlite3.Error as exc:
                self._conn.rollback()
                raise RecordError(f"upsert failed: {exc}") from exc
        return len(rows)

    def close(self) -> None:
        with self._lock:
            self._conn.close()
